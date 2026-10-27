import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { broadcastTransaction, isTransactionInBlock } from "./broadcast";
import { TRONGRID_RETRY } from "./retry";

const env = { TRONGRID_BASE_URL: "https://trongrid.test", TRONGRID_API_KEY: "key-1" };
const originalFetch = globalThis.fetch;
const hex = (text: string) => Buffer.from(text).toString("hex");

type FetchCall = { url: string; headers: Record<string, string> };

function mockFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next();
  }) as typeof fetch;
  return calls;
}

beforeAll(() => {
  TRONGRID_RETRY.initialDelayMs = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("broadcastTransaction", () => {
  test("accepts result:true and sends the API key", async () => {
    const calls = mockFetch([() => Response.json({ result: true, txid: "abc" })]);

    await expect(broadcastTransaction(env, { txID: "abc" })).resolves.toEqual({
      status: "accepted",
    });
    expect(calls[0].url).toBe("https://trongrid.test/wallet/broadcasttransaction");
    expect(calls[0].headers["TRON-PRO-API-KEY"]).toBe("key-1");
  });

  test("treats the store-level duplicate as accepted", async () => {
    mockFetch([
      () => Response.json({ code: "DUP_TRANSACTION_ERROR", message: hex("Dup transaction.") }),
    ]);

    await expect(broadcastTransaction(env, {})).resolves.toEqual({ status: "accepted" });
  });

  test("treats the txID-cache duplicate as unknown", async () => {
    mockFetch([
      () =>
        Response.json({
          code: "DUP_TRANSACTION_ERROR",
          message: hex("Transaction already exists."),
        }),
    ]);

    await expect(broadcastTransaction(env, {})).resolves.toMatchObject({
      status: "unknown",
      code: "DUP_TRANSACTION_ERROR",
    });
  });

  test("decodes pre-pool rejections", async () => {
    mockFetch([
      () =>
        Response.json({
          code: "CONTRACT_VALIDATE_ERROR",
          txid: "abc",
          message: hex("balance is not sufficient"),
        }),
    ]);

    await expect(broadcastTransaction(env, {})).resolves.toEqual({
      status: "rejected",
      code: "CONTRACT_VALIDATE_ERROR",
      message: "balance is not sufficient",
      raw: {
        code: "CONTRACT_VALIDATE_ERROR",
        txid: "abc",
        message: hex("balance is not sufficient"),
      },
    });
  });

  test("treats codes that can follow the pending pool as unknown", async () => {
    mockFetch([
      () =>
        Response.json({
          code: "NOT_ENOUGH_EFFECTIVE_CONNECTION",
          message: hex("P2P broadcast failed."),
        }),
    ]);
    await expect(broadcastTransaction(env, {})).resolves.toMatchObject({
      status: "unknown",
    });

    mockFetch([() => Response.json({ code: "OTHER_ERROR", message: hex("boom") })]);
    await expect(broadcastTransaction(env, {})).resolves.toMatchObject({
      status: "unknown",
    });
  });

  test("does not trust node codes on non-200 responses", async () => {
    mockFetch([() => Response.json({ code: "SERVER_BUSY" }, { status: 504 })]);

    await expect(broadcastTransaction(env, {})).resolves.toMatchObject({
      status: "unknown",
    });
  });

  test("retries 429s, then reports RATE_LIMITED as a rejection", async () => {
    const calls = mockFetch([
      () => new Response('{"Error":"allowed_rps(3)"}', { status: 429 }),
    ]);

    const outcome = await broadcastTransaction(env, {});
    expect(outcome).toMatchObject({ status: "rejected", code: "RATE_LIMITED" });
    expect(calls.length).toBe(TRONGRID_RETRY.attempts);
  });

  test("recovers when a retry after a rate-limit 403 succeeds", async () => {
    mockFetch([
      () => new Response("Too Many Requests - Rate Limit Exceeded", { status: 403 }),
      () => Response.json({ result: true }),
    ]);

    await expect(broadcastTransaction(env, {})).resolves.toEqual({ status: "accepted" });
  });

  test("does not retry a 403 that is not a rate limit", async () => {
    const calls = mockFetch([() => new Response("Forbidden", { status: 403 })]);

    await expect(broadcastTransaction(env, {})).resolves.toMatchObject({
      status: "unknown",
    });
    expect(calls.length).toBe(1);
  });

  test("reports unknown outcome for network errors and non-JSON bodies", async () => {
    mockFetch([
      () => {
        throw new TypeError("Network connection lost");
      },
    ]);
    await expect(broadcastTransaction(env, {})).resolves.toMatchObject({
      status: "unknown",
    });

    mockFetch([() => new Response("<html>Bad Gateway</html>", { status: 502 })]);
    await expect(broadcastTransaction(env, {})).resolves.toMatchObject({
      status: "unknown",
    });
  });
});

describe("isTransactionInBlock", () => {
  test("finds a transaction included in a block on the full node", async () => {
    const calls = mockFetch([() => Response.json({ id: "abc", blockNumber: 70000000 })]);

    await expect(isTransactionInBlock(env, "abc")).resolves.toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "https://trongrid.test/wallet/gettransactioninfobyid",
    ]);
  });

  test("checks the solidity node before reporting not found", async () => {
    const calls = mockFetch([() => Response.json({})]);

    await expect(isTransactionInBlock(env, "abc")).resolves.toBe(false);
    expect(calls.map((call) => call.url)).toEqual([
      "https://trongrid.test/wallet/gettransactioninfobyid",
      "https://trongrid.test/walletsolidity/gettransactioninfobyid",
    ]);
  });

  test("throws when TronGrid cannot answer", async () => {
    mockFetch([() => new Response("oops", { status: 500 })]);

    await expect(isTransactionInBlock(env, "abc")).rejects.toThrow("status code 500");
  });

  test("throws on a java-tron error body instead of reporting not found", async () => {
    mockFetch([() => Response.json({ Error: "class java.lang.NullPointerException : null" })]);

    await expect(isTransactionInBlock(env, "abc")).rejects.toThrow("Unexpected answer");
  });

  test("does not count a pending-pool answer without a block as included", async () => {
    mockFetch([() => Response.json({ txID: "abc", raw_data: {} })]);

    await expect(isTransactionInBlock(env, "abc")).rejects.toThrow("Unexpected answer");
  });
});

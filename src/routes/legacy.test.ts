import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../env";
import { doErrorResponse, handleAppError, RateLimitError } from "../lib/errors";
import { TRONGRID_RETRY } from "../lib/tron/retry";
import { createNamespace, createSigner } from "../test/harness";
import { registerLegacyRoutes } from "./legacy";

const FROM = "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9";
const TO = "TGMgmByQGAyk7uFwJbnsVmzdcjNFjSgxVE";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const QUERY = "appId=0&purpose=0&asset=0&stage=0&index=29";
const originalFetch = globalThis.fetch;
const hex = (text: string) => Buffer.from(text).toString("hex");

type Reply = () => Response | Promise<Response>;

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

async function createHarness() {
  const state = {
    trxBalance: "100000000",
    tokenBalance: "32000000000",
    registryFailure: undefined as Response | undefined,
    builds: 0,
    // Expiration of built transactions relative to now (TRON default: +60 s).
    expiresInMs: 60_000,
    beforeSign: undefined as (() => Promise<void>) | undefined,
    broadcastReplies: [() => Response.json({ result: true })] as Reply[],
    broadcasts: [] as string[],
    onChain: new Set<string>(),
    // Answer for a transaction that is not on-chain; java-tron uses "{}".
    notFoundBody: {} as Record<string, unknown>,
    solidifiedAt: () => Date.now(),
  };
  const { signer, storage } = await createSigner();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.endsWith("/gettransactioninfobyid")) {
      return Response.json(
        state.onChain.has(body.value)
          ? { id: body.value, blockNumber: 1 }
          : state.notFoundBody
      );
    }

    if (url.endsWith("/walletsolidity/getblock")) {
      return Response.json({ block_header: { raw_data: { timestamp: state.solidifiedAt() } } });
    }

    state.broadcasts.push(body.txID);
    const reply =
      state.broadcastReplies[
        Math.min(state.broadcasts.length - 1, state.broadcastReplies.length - 1)
      ];
    return reply();
  }) as typeof fetch;

  const env = {
    TRONGRID_BASE_URL: "https://trongrid.test",
    EVM_NETWORKS: "[]",
    REGISTRY: createNamespace((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/getAddress") {
        return Response.json({ address: FROM });
      }
      if (state.registryFailure) {
        return state.registryFailure.clone();
      }
      return Response.json({
        value: url.searchParams.get("contractAddress")
          ? state.tokenBalance
          : state.trxBalance,
      });
    }),
    GAS_CALCULATOR: createNamespace(() => Response.json({ totalFeeTRX: 13.3 })),
    TX_BUILDER: createNamespace(async () => {
      state.builds += 1;
      await state.beforeSign?.();
      return Response.json({
        ok: true,
        transaction: {
          txID: `tx-${state.builds}`,
          raw_data: { expiration: Date.now() + state.expiresInMs },
        },
      });
    }),
    SIGNER: createNamespace((req) => signer.fetch(req)),
  };

  const app = new Hono<Env>();
  app.onError(handleAppError);
  registerLegacyRoutes(app);

  const sendRaw = (rawBody: string, headers: Record<string, string> = {}) =>
    app.request(
      `/transaction?${QUERY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: rawBody,
      },
      env
    );
  const send = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    sendRaw(JSON.stringify(body), headers);

  return { state, storage, send, sendRaw };
}

const usdtPayout = { to: TO, amount: "32000.000000", contractAddress: USDT };
const networkError: Reply = () => {
  throw new TypeError("Network connection lost");
};

beforeAll(() => {
  TRONGRID_RETRY.initialDelayMs = 0;
  // handleAppError logs every upstream failure; keep the test output readable.
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Legacy POST /transaction", () => {
  test("sends a USDT payout of exactly the full balance", async () => {
    const { state, send } = await createHarness();
    const response = await send(usdtPayout);

    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual({ txId: "tx-1", fee: 13.3 });
    // USDT decimals come from the built-in table: only the broadcast hits TronGrid.
    expect(state.broadcasts).toEqual(["tx-1"]);
  });

  test("reports a real shortfall with USDT's 6 decimals", async () => {
    const { state, send } = await createHarness();
    state.tokenBalance = "31999999999";

    const response = await send(usdtPayout);
    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      error: "Insufficient TRC20 balance",
      shortfall: "1",
      token: "USDT",
      decimals: 6,
    });
  });

  test("returns JSON naming the failed stage instead of a bare 500", async () => {
    const { state, send } = await createHarness();
    state.registryFailure = doErrorResponse(
      new RateLimitError(429, "request rate exceeded the allowed_rps(3)")
    );

    const response = await send(usdtPayout);
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      stage: "REGISTRY/getBalance",
      retryable: true,
    });
  });

  test("marks other failures before signing as 502 and safe to retry", async () => {
    const { state, send } = await createHarness();
    state.registryFailure = doErrorResponse(new Error("socket hang up"));

    const response = await send(usdtPayout);
    expect(response.status).toBe(502);
    expect(await readJson(response)).toMatchObject({
      error: "socket hang up",
      stage: "REGISTRY/getBalance",
      retryable: true,
    });
  });

  test("rejects a TRX amount with too many decimals as a 400", async () => {
    const { send } = await createHarness();
    const response = await send({ to: TO, amount: "1.1234567" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: "Too many decimal places (max 6)",
    });
  });

  test("rejects an address with a bad checksum as a 400", async () => {
    const { state, send } = await createHarness();
    const response = await send({ ...usdtPayout, to: `${TO.slice(0, -1)}F` });

    expect(response.status).toBe(400);
    expect(state.builds).toBe(0);
  });

  test("answers malformed JSON with a JSON error", async () => {
    const { sendRaw } = await createHarness();
    const response = await sendRaw("{not json");

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await readJson(response)).toMatchObject({ retryable: false });
  });

  test("returns txId and expiry when the broadcast outcome is unknown", async () => {
    const { state, send } = await createHarness();
    state.broadcastReplies = [networkError];

    const response = await send(usdtPayout);
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body).toMatchObject({
      error: "Broadcast outcome unknown",
      txId: "tx-1",
      retryable: false,
    });
    expect(typeof body.expiresAt).toBe("string");
  });

  test("marks a definitive node rejection as safe to retry", async () => {
    const { state, send } = await createHarness();
    state.broadcastReplies = [
      () =>
        Response.json({
          code: "CONTRACT_VALIDATE_ERROR",
          message: hex("balance is not sufficient"),
        }),
    ];

    const response = await send(usdtPayout);
    expect(response.status).toBe(502);
    expect(await readJson(response)).toMatchObject({
      error: "Failed to broadcast transaction",
      txId: "tx-1",
      retryable: true,
      // The node's raw answer is kept as before, plus the decoded text.
      details: {
        code: "CONTRACT_VALIDATE_ERROR",
        message: hex("balance is not sufficient"),
        decodedMessage: "balance is not sufficient",
      },
    });
  });

  test("marks a signature rejection as not worth retrying", async () => {
    const { state, send } = await createHarness();
    state.broadcastReplies = [() => Response.json({ code: "SIGERROR", message: hex("bad sig") })];

    const response = await send(usdtPayout);
    expect(response.status).toBe(502);
    expect(await readJson(response)).toMatchObject({ txId: "tx-1", retryable: false });
  });
});

describe("Legacy POST /transaction with Idempotency-Key", () => {
  const key = { "Idempotency-Key": "payout-29-0001" };

  test("replays a completed payout without sending a new transaction", async () => {
    const { state, send } = await createHarness();

    const first = await send(usdtPayout, key);
    expect(first.status).toBe(201);

    // The balance is gone after the payout; the replay must not re-check it.
    state.tokenBalance = "0";
    const second = await send({ ...usdtPayout, amount: "32000" }, key);
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({ txId: "tx-1", fee: 13.3, replayed: true });
    expect(state.builds).toBe(1);
    expect(state.broadcasts).toEqual(["tx-1"]);
  });

  test("rejects reusing a key for a different payout", async () => {
    const { send } = await createHarness();
    await send(usdtPayout, key);

    const response = await send({ ...usdtPayout, amount: "10" }, key);
    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ txId: "tx-1", retryable: false });
  });

  test("resends the same signed transaction after an unknown outcome", async () => {
    const { state, send } = await createHarness();
    state.broadcastReplies = [
      networkError,
      () => Response.json({ code: "DUP_TRANSACTION_ERROR", message: hex("Dup transaction.") }),
    ];

    const first = await send(usdtPayout, key);
    expect(first.status).toBe(502);
    expect(await readJson(first)).toMatchObject({ txId: "tx-1", retryable: true });

    const second = await send(usdtPayout, key);
    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({ txId: "tx-1", replayed: true });
    expect(state.builds).toBe(1);
    expect(state.broadcasts).toEqual(["tx-1", "tx-1"]);
  });

  test("keeps the key on a rejection so a retry resends the same transaction", async () => {
    const { state, send } = await createHarness();
    state.broadcastReplies = [
      () => Response.json({ code: "SERVER_BUSY", message: "" }),
      () => Response.json({ result: true }),
    ];

    const first = await send(usdtPayout, key);
    expect(first.status).toBe(502);
    expect(await readJson(first)).toMatchObject({ txId: "tx-1", retryable: true });

    const second = await send(usdtPayout, key);
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({ txId: "tx-1", fee: 13.3, replayed: true });
    expect(state.builds).toBe(1);
  });

  test("a rejection racing a concurrent resend never leads to a second transaction", async () => {
    const { state, send } = await createHarness();
    // R1 is rejected; R2 (same key) resends and is accepted; then R1's client retries.
    state.broadcastReplies = [
      () => Response.json({ code: "SERVER_BUSY", message: "" }),
      () => Response.json({ result: true }),
      () => Response.json({ code: "DUP_TRANSACTION_ERROR", message: hex("Dup transaction.") }),
    ];

    expect((await send(usdtPayout, key)).status).toBe(502);
    expect((await send(usdtPayout, key)).status).toBe(200);
    const retry = await send(usdtPayout, key);

    expect(retry.status).toBe(200);
    expect(await readJson(retry)).toMatchObject({ txId: "tx-1", replayed: true });
    expect(state.builds).toBe(1);
  });

  test("reports success when an expired transaction is found on-chain", async () => {
    const { state, send } = await createHarness();
    state.expiresInMs = -10_000;
    state.broadcastReplies = [networkError];

    expect((await send(usdtPayout, key)).status).toBe(502);

    state.onChain.add("tx-1");
    const retry = await send(usdtPayout, key);
    expect(retry.status).toBe(200);
    expect(await readJson(retry)).toMatchObject({ txId: "tx-1", replayed: true });
    expect(state.builds).toBe(1);
  });

  test("asks to wait while a missing transaction only recently expired", async () => {
    const { state, send } = await createHarness();
    state.expiresInMs = -10_000;
    state.broadcastReplies = [networkError];

    await send(usdtPayout, key);
    const retry = await send(usdtPayout, key);

    expect(retry.status).toBe(503);
    expect(await readJson(retry)).toMatchObject({ txId: "tx-1", retryable: true });
    expect(state.builds).toBe(1);
  });

  test("sends a new transaction once the old one provably never landed", async () => {
    const { state, storage, send } = await createHarness();
    state.expiresInMs = -6 * 60_000;
    state.broadcastReplies = [networkError, () => Response.json({ result: true })];

    await send(usdtPayout, key);
    const retry = await send(usdtPayout, key);

    expect(retry.status).toBe(201);
    expect(await readJson(retry)).toEqual({ txId: "tx-2", fee: 13.3 });
    const record = storage.map.get("idempotency:0:payout-29-0001") as Record<string, unknown>;
    expect(record).toMatchObject({ txId: "tx-2", status: "broadcast" });
  });

  test("never declares a transaction dead on a node error answer", async () => {
    const { state, send } = await createHarness();
    state.expiresInMs = -6 * 60_000;
    state.broadcastReplies = [networkError];
    // java-tron reports its own failures as HTTP 200 {"Error": ...}.
    state.notFoundBody = { Error: "class java.lang.NullPointerException : null" };

    await send(usdtPayout, key);
    const retry = await send(usdtPayout, key);

    expect(retry.status).toBe(503);
    expect(await readJson(retry)).toMatchObject({ txId: "tx-1", retryable: true });
    expect(state.builds).toBe(1);
  });

  test("waits until solidified blocks cover the expiration", async () => {
    const { state, send } = await createHarness();
    state.expiresInMs = -6 * 60_000;
    state.broadcastReplies = [networkError];
    // The solidity node is still behind the transaction's expiration.
    state.solidifiedAt = () => Date.now() - 7 * 60_000;

    await send(usdtPayout, key);
    const retry = await send(usdtPayout, key);

    expect(retry.status).toBe(503);
    expect(state.builds).toBe(1);
  });

  test("scopes idempotency keys by appId", async () => {
    const { storage, send } = await createHarness();
    await send(usdtPayout, key);

    expect([...storage.map.keys()]).toEqual(["idempotency:0:payout-29-0001"]);
  });

  test("a concurrent request with the same payout settles the first request's transaction", async () => {
    const { state, storage, send } = await createHarness();
    state.beforeSign = async () => {
      await storage.put("idempotency:0:payout-29-0001", {
        fingerprint: JSON.stringify([0, 0, 0, 0, 29, TO, "32000", USDT]),
        txId: "tx-concurrent",
        status: "signed",
        signedTx: { txID: "tx-concurrent" },
        expiresAt: Date.now() + 60_000,
        createdAt: 0,
      });
    };

    const response = await send(usdtPayout, key);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ txId: "tx-concurrent", replayed: true });
    expect(state.broadcasts).toEqual(["tx-concurrent"]);
  });
});

import { beforeAll, describe, expect, test } from "bun:test";
import { TronWeb } from "tronweb";
import { InputError, TokenInfoUnavailableError } from "../errors";
import { TRONGRID_RETRY } from "./retry";
import { getTrc20TokenInfo } from "./token";

const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const UNKNOWN_TOKEN = "TUdbkixK7zU4ua7YC2oNz6ujsfZxb98GFb";
const NOT_A_TOKEN = "TVj7RNVHy6thbM7BWdSe9G6gXwKhjhdNZS";

const uint = (value: number) => value.toString(16).padStart(64, "0");
const abiString = (value: string) => {
  const hex = Buffer.from(value, "utf8").toString("hex");
  return uint(32) + uint(value.length) + hex.padEnd(64, "0");
};

type ConstantHandler = (selector: string) => Promise<unknown>;

/** Real TronWeb (address/ABI utils) with a scripted triggerConstantContract. */
function createFakeTronWeb(handler: ConstantHandler) {
  const tronWeb = new TronWeb({ fullHost: "http://127.0.0.1:1" });
  const calls: string[] = [];
  tronWeb.transactionBuilder.triggerConstantContract = (async (
    _contract: string,
    selector: string
  ) => {
    calls.push(selector);
    return handler(selector);
  }) as typeof tronWeb.transactionBuilder.triggerConstantContract;
  return { tronWeb, calls };
}

beforeAll(() => {
  TRONGRID_RETRY.initialDelayMs = 0;
});

describe("getTrc20TokenInfo", () => {
  test("resolves USDT from the built-in table without network calls", async () => {
    const { tronWeb, calls } = createFakeTronWeb(async () => {
      throw new Error("must not be called");
    });

    await expect(getTrc20TokenInfo(tronWeb, USDT)).resolves.toEqual({
      name: "Tether USD",
      symbol: "USDT",
      decimals: 6,
    });
    expect(calls).toEqual([]);
  });

  test("throws instead of caching a guessed decimals value", async () => {
    let healthy = false;
    const { tronWeb } = createFakeTronWeb(async (selector) => {
      if (!healthy) {
        throw new Error("Request failed with status code 500");
      }
      const outputs: Record<string, string> = {
        "decimals()": uint(8),
        "symbol()": abiString("TKN"),
        "name()": abiString("Token"),
      };
      return { constant_result: [outputs[selector]] };
    });

    await expect(getTrc20TokenInfo(tronWeb, UNKNOWN_TOKEN)).rejects.toBeInstanceOf(
      TokenInfoUnavailableError
    );

    // The failure was not cached: once TronGrid recovers, the real value is read.
    healthy = true;
    await expect(getTrc20TokenInfo(tronWeb, UNKNOWN_TOKEN)).resolves.toEqual({
      name: "Token",
      symbol: "TKN",
      decimals: 8,
    });
  });

  test("retries rate-limited decimals() calls", async () => {
    let attempts = 0;
    const token = "TGMgmByQGAyk7uFwJbnsVmzdcjNFjSgxVE";
    const { tronWeb } = createFakeTronWeb(async (selector) => {
      if (selector === "decimals()") {
        attempts += 1;
        if (attempts === 1) {
          throw { response: { status: 429 }, message: "status code 429" };
        }
        return { constant_result: [uint(18)] };
      }
      return { constant_result: [abiString("X")] };
    });

    const info = await getTrc20TokenInfo(tronWeb, token);
    expect(info.decimals).toBe(18);
    expect(attempts).toBe(2);
  });

  test("reports a non-token address as an input error, not a retryable one", async () => {
    const { tronWeb } = createFakeTronWeb(async () => {
      throw new Error("Smart contract is not exist.");
    });

    await expect(getTrc20TokenInfo(tronWeb, NOT_A_TOKEN)).rejects.toBeInstanceOf(
      InputError
    );
  });

  test("keeps decimals but does not cache when symbol/name fail", async () => {
    const token = "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9";
    let symbolCalls = 0;
    const { tronWeb } = createFakeTronWeb(async (selector) => {
      if (selector === "decimals()") {
        return { constant_result: [uint(6)] };
      }
      if (selector === "symbol()") {
        symbolCalls += 1;
      }
      throw new Error("Request failed with status code 500");
    });

    const first = await getTrc20TokenInfo(tronWeb, token);
    expect(first).toEqual({ name: "Unknown Token", symbol: "UNKNOWN", decimals: 6 });
    await getTrc20TokenInfo(tronWeb, token);
    expect(symbolCalls).toBe(2);
  });
});

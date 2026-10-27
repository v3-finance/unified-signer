import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../env";
import { handleAppError } from "../lib/errors";
import { createNamespace } from "../test/harness";
import { registerLegacyRoutes } from "./legacy";

const FROM = "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const QUERY = "appId=0&purpose=1&asset=0&stage=0&index=42";

function createApp() {
  const seen = { paths: [] as string[], queries: [] as string[] };
  const env = {
    TRONGRID_BASE_URL: "https://trongrid.test",
    EVM_NETWORKS: "[]",
    REGISTRY: createNamespace((req) => {
      const url = new URL(req.url);
      seen.paths.push(url.pathname);
      seen.queries.push(url.searchParams.get("path") ?? "");

      if (url.pathname === "/getAddress") {
        return Response.json({ address: FROM });
      }
      if (url.pathname === "/getBalance") {
        return Response.json({ value: "15000000" });
      }
      return Response.json([
        {
          txID: "a".repeat(64),
          timestamp: 1,
          from: FROM,
          to: FROM,
          amountSun: "1",
          direction: "in",
        },
      ]);
    }),
  };

  const app = new Hono<Env>();
  app.onError(handleAppError);
  registerLegacyRoutes(app);

  const get = (path: string) => app.request(path, {}, env);
  return { get, seen };
}

describe("Legacy wallet endpoints", () => {
  test("derives addresses on the hardened legacy tree", async () => {
    const { get, seen } = createApp();
    const response = await get(`/wallet/address?${QUERY}`);

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toEqual({ address: FROM });
    // The legacy scheme maps to the ORIGINAL hardened derivation path.
    expect(seen.queries).toEqual(["m/44'/195'/0'/1/0/0/42"]);
  });

  test("returns balances in the legacy shape", async () => {
    const { get } = createApp();

    const trx = await get(`/wallet/balance?${QUERY}`);
    expect((await trx.json()) as Record<string, unknown>).toEqual({ asset: "TRX", value: "15000000" });

    const token = await get(`/wallet/balance?${QUERY}&contractAddress=${USDT}`);
    expect((await token.json()) as Record<string, unknown>).toEqual({ asset: USDT, value: "15000000" });
  });

  test("serves wallet history again", async () => {
    const { get, seen } = createApp();
    const response = await get(`/wallet/history?${QUERY}&contractAddress=${USDT}`);

    expect(response.status).toBe(200);
    expect(((await response.json()) as unknown[]).length).toBe(1);
    expect(seen.paths).toEqual(["/getHistory"]);
  });

  test("accepts uint32 indexes at unhardened levels like the old service", async () => {
    const { get, seen } = createApp();
    const response = await get(
      `/wallet/address?appId=0&purpose=0&asset=0&stage=0&index=2147483648`
    );

    expect(response.status).toBe(200);
    expect(seen.queries).toEqual(["m/44'/195'/0'/0/0/0/2147483648"]);
  });

  test("still rejects a hardened appId above 2^31", async () => {
    const { get } = createApp();
    const response = await get(
      `/wallet/address?appId=2147483648&purpose=0&asset=0&stage=0&index=0`
    );

    expect(response.status).toBe(400);
  });
});

import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { Env } from "../env";
import { handleAppError } from "../lib/errors";
import { createNamespace, createSigner } from "../test/harness";
import { registerTransactionRoutes } from "./transaction";

const SENDER = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const TO = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const PATH = "44/60/0/0/29";
const RPC_URL = "https://rpc.test";
const originalFetch = globalThis.fetch;

const readJson = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

type SendRawMode =
  | "ok"
  | "neterr"
  | "already_known"
  | "nonce_too_low"
  | "pool_full"
  | "intrinsic_gas";

function fullReceipt(hash: string) {
  return {
    transactionHash: hash,
    transactionIndex: "0x0",
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: "0x1",
    from: SENDER.toLowerCase(),
    to: TO.toLowerCase(),
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
    status: "0x1",
    effectiveGasPrice: "0x3b9aca00",
    type: "0x0",
  };
}

async function createEvmHarness() {
  const state = {
    nativeBalance: "1000000000000000000",
    builds: 0,
    baseNonce: 5,
    sendRawMode: "ok" as SendRawMode,
    receipts: new Set<string>(),
    pendingNonce: 5,
    finalizedNonce: 5,
    rawSent: [] as string[],
    // Raw bytes a real node would reject with "nonce too low" (dead nonce).
    deadRaw: undefined as string | undefined,
  };
  const { signer, storage } = await createSigner();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (!url.startsWith(RPC_URL)) {
      throw new TypeError(`Unexpected fetch to ${url}`);
    }

    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params?: unknown[];
    };
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: body.id, result });
    const rpcError = (message: string) =>
      Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32000, message },
      });

    switch (body.method) {
      case "eth_sendRawTransaction": {
        const raw = String(body.params?.[0]);
        state.rawSent.push(raw);

        if (state.deadRaw && raw === state.deadRaw) {
          return rpcError("nonce too low");
        }

        switch (state.sendRawMode) {
          case "ok":
            return reply(`0x${"ab".repeat(32)}`);
          case "already_known":
            return rpcError("already known");
          case "nonce_too_low":
            return rpcError("nonce too low");
          case "pool_full":
            return rpcError("txpool is full");
          case "intrinsic_gas":
            return rpcError("intrinsic gas too low");
          case "neterr":
            throw new TypeError("Network connection lost");
        }
        break;
      }
      case "eth_getTransactionReceipt": {
        const hash = String(body.params?.[0]);
        return reply(state.receipts.has(hash) ? fullReceipt(hash) : null);
      }
      case "eth_getTransactionCount": {
        const tag = String(body.params?.[1]);
        const count =
          tag === "pending" ? state.pendingNonce : state.finalizedNonce;
        return reply(`0x${count.toString(16)}`);
      }
      case "eth_chainId":
        return reply("0x3e7");
    }

    throw new TypeError(`Unhandled RPC method ${body.method}`);
  }) as typeof fetch;

  const env = {
    TRONGRID_BASE_URL: "https://trongrid.test",
    EVM_NETWORKS: JSON.stringify([
      {
        key: "testnet",
        name: "Testnet",
        chainId: 999,
        rpcUrl: RPC_URL,
        nativeSymbol: "TST",
        nativeDecimals: 18,
        feeType: "legacy",
      },
    ]),
    REGISTRY: createNamespace((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/getAddress") {
        return Response.json({ address: SENDER });
      }
      return Response.json({ value: state.nativeBalance });
    }),
    GAS_CALCULATOR: createNamespace(() =>
      Response.json({
        totalFeeNative: "0.000021",
        totalFeeWei: "21000000000000",
        gasLimit: "21000",
        feeType: "legacy",
        gasPrice: "1000000000",
        transactionType: "NATIVE_TRANSFER",
        timestamp: 1,
      })
    ),
    TX_BUILDER: createNamespace(async () => {
      state.builds += 1;
      return Response.json({
        ok: true,
        transaction: {
          feeType: "legacy",
          chainId: 999,
          nonce: state.baseNonce + state.builds - 1,
          to: TO,
          value: "50000000000000000",
          gas: "21000",
          gasPrice: "1000000000",
        },
      });
    }),
    SIGNER: createNamespace((req) => signer.fetch(req)),
  };

  const app = new Hono<Env>();
  app.onError(handleAppError);
  registerTransactionRoutes(app);

  const send = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request(
      `/transaction/${PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
      env
    );

  return { state, storage, send };
}

const payout = { chainId: 999, to: TO, amount: "0.05" };
const key = { "Idempotency-Key": "evm-payout-0001" };

beforeAll(() => {
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("POST /transaction/{path} (EVM) with Idempotency-Key", () => {
  test("sends a payout and marks the record broadcast", async () => {
    const { state, storage, send } = await createEvmHarness();
    const response = await send(payout, key);

    expect(response.status).toBe(201);
    const body = await readJson(response);
    expect(String(body.txId)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.fee).toBe("0.000021");
    expect(state.builds).toBe(1);

    const record = storage.map.get("idempotency:evm-payout-0001") as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ txId: body.txId, status: "broadcast", nonce: 5 });
  });

  test("replays a completed payout without re-checking balances", async () => {
    const { state, send } = await createEvmHarness();
    const first = await send(payout, key);
    const firstBody = await readJson(first);

    state.nativeBalance = "0";
    const second = await send(payout, key);

    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({
      txId: firstBody.txId,
      fee: "0.000021",
      replayed: true,
    });
    expect(state.builds).toBe(1);
  });

  test("rejects reusing a key for a different payout", async () => {
    const { send } = await createEvmHarness();
    await send(payout, key);

    const response = await send({ ...payout, amount: "0.06" }, key);
    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ retryable: false });
  });

  test("resends the exact same bytes after an unknown outcome", async () => {
    const { state, send } = await createEvmHarness();
    state.sendRawMode = "neterr";

    const first = await send(payout, key);
    expect(first.status).toBe(502);
    const firstBody = await readJson(first);
    expect(firstBody).toMatchObject({
      error: "Broadcast outcome unknown",
      retryable: true,
    });

    // The pool answers "already known": the first broadcast did land.
    state.sendRawMode = "already_known";
    const second = await send(payout, key);

    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({
      txId: firstBody.txId,
      replayed: true,
    });
    expect(state.builds).toBe(1);
    // Every broadcast attempt carried the identical signed bytes.
    expect(new Set(state.rawSent).size).toBe(1);
  });

  test("stays pending while the recorded nonce is still open", async () => {
    const { state, send } = await createEvmHarness();
    state.sendRawMode = "neterr";

    await send(payout, key);
    const retry = await send(payout, key);

    expect(retry.status).toBe(503);
    expect(await readJson(retry)).toMatchObject({ retryable: true });
    expect(state.builds).toBe(1);
  });

  test("replays as sent once the receipt appears", async () => {
    const { state, send } = await createEvmHarness();
    state.sendRawMode = "neterr";

    const first = await send(payout, key);
    const firstBody = await readJson(first);

    state.receipts.add(String(firstBody.txId));
    const retry = await send(payout, key);

    expect(retry.status).toBe(200);
    expect(await readJson(retry)).toMatchObject({
      txId: firstBody.txId,
      replayed: true,
    });
    expect(state.builds).toBe(1);
  });

  test("sends a replacement only after the nonce is finalized by another transaction", async () => {
    const { state, storage, send } = await createEvmHarness();
    state.sendRawMode = "nonce_too_low";

    const first = await send(payout, key);
    expect(first.status).toBe(502);
    const firstBody = await readJson(first);

    // The nonce is consumed on-chain by a different transaction and finalized;
    // our transaction has no receipt, so it can never land. A real node keeps
    // rejecting its bytes with "nonce too low". The dead verdict additionally
    // waits out a 5-minute grace window, so age the record past it.
    state.deadRaw = state.rawSent[0];
    state.finalizedNonce = 6;
    state.sendRawMode = "ok";
    const recordKey = "idempotency:evm-payout-0001";
    const staleRecord = storage.map.get(recordKey) as { createdAt: number };
    storage.map.set(recordKey, {
      ...staleRecord,
      createdAt: Date.now() - 6 * 60_000,
    });
    const retry = await send(payout, key);

    expect(retry.status).toBe(201);
    const retryBody = await readJson(retry);
    expect(retryBody.txId).not.toBe(firstBody.txId);
    expect(state.builds).toBe(2);

    const record = storage.map.get("idempotency:evm-payout-0001") as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ txId: retryBody.txId, status: "broadcast" });
  });

  test("keyless unknown outcome is not retryable and keeps the nonce reserved", async () => {
    const { state, send } = await createEvmHarness();
    state.sendRawMode = "neterr";

    const response = await send(payout);

    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body).toMatchObject({
      error: "Broadcast outcome unknown",
      retryable: false,
    });
    expect(String(body.txId)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("keyless rejection releases the abandoned nonce and is retryable", async () => {
    const { state, send } = await createEvmHarness();
    state.sendRawMode = "pool_full";

    const response = await send(payout);

    expect(response.status).toBe(502);
    expect(await readJson(response)).toMatchObject({
      error: "Failed to broadcast transaction",
      retryable: true,
      details: { code: "POOL_FULL" },
    });
  });

  test("keyless deterministic rejection is flagged not retryable", async () => {
    const { state, send } = await createEvmHarness();
    state.sendRawMode = "intrinsic_gas";

    const response = await send(payout);

    expect(response.status).toBe(502);
    expect(await readJson(response)).toMatchObject({
      retryable: false,
      details: { code: "INTRINSIC_GAS_TOO_LOW" },
    });
  });

  test("rejects an unknown chainId with the configured list", async () => {
    const { state, send } = await createEvmHarness();
    const response = await send({ ...payout, chainId: 1 }, key);

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: "Unknown chainId 1",
      availableChainIds: [999],
    });
    expect(state.builds).toBe(0);
  });
});

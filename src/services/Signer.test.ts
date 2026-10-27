import { describe, expect, test } from "bun:test";
import { createSigner } from "../test/harness";

const path = "m/44/195/0/0/0/0/29";
const tx = (txID: string) => ({ txID, raw_data: { expiration: 1_000_000 } });

function post(route: string, body: unknown) {
  return new Request(`https://do${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Signer idempotency", () => {
  test("signs without a key and returns the txId", async () => {
    const { signer, storage } = await createSigner();
    const response = await signer.fetch(
      post("/sign", { path, transaction: tx("tx-1") })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, txId: "tx-1" });
    expect(storage.map.size).toBe(0);
  });

  test("refuses to sign a second transaction for the same key", async () => {
    const { signer } = await createSigner();
    const idempotency = { key: "payout-1", fingerprint: "fp", fee: "13.3" };

    const first = await signer.fetch(
      post("/sign", { path, transaction: tx("tx-1"), idempotency })
    );
    expect(first.status).toBe(200);

    const second = await signer.fetch(
      post("/sign", { path, transaction: tx("tx-2"), idempotency })
    );
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ txId: "tx-1", status: "signed" });

    const lookup = await signer.fetch(new Request("https://do/idempotency?key=payout-1"));
    expect(await lookup.json()).toMatchObject({
      record: {
        txId: "tx-1",
        status: "signed",
        fee: "13.3",
        fingerprint: "fp",
        expiresAt: 1_000_000,
      },
    });
  });

  test("replaces a signed record only when it still holds the expected tx", async () => {
    const { signer, storage } = await createSigner();
    const idempotency = { key: "k", fingerprint: "fp" };
    await signer.fetch(post("/sign", { path, transaction: tx("tx-1"), idempotency }));

    const stale = await signer.fetch(
      post("/sign", {
        path,
        transaction: tx("tx-3"),
        idempotency: { ...idempotency, replaceTxId: "tx-other" },
      })
    );
    expect(stale.status).toBe(409);

    const replaced = await signer.fetch(
      post("/sign", {
        path,
        transaction: tx("tx-2"),
        idempotency: { ...idempotency, replaceTxId: "tx-1" },
      })
    );
    expect(replaced.status).toBe(200);
    expect((storage.map.get("idempotency:k") as { txId: string }).txId).toBe("tx-2");
  });

  test("lets exactly one of two concurrent requests claim a key", async () => {
    const { signer, storage } = await createSigner();
    const idempotency = { key: "k", fingerprint: "fp" };

    const [a, b] = await Promise.all([
      signer.fetch(post("/sign", { path, transaction: tx("tx-a"), idempotency })),
      signer.fetch(post("/sign", { path, transaction: tx("tx-b"), idempotency })),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? "tx-a" : "tx-b";
    expect((storage.map.get("idempotency:k") as { txId: string }).txId).toBe(winner);
  });

  test("marking as broadcast drops the stored transaction and blocks replacement", async () => {
    const { signer, storage } = await createSigner();
    const idempotency = { key: "k", fingerprint: "fp" };
    await signer.fetch(post("/sign", { path, transaction: tx("tx-1"), idempotency }));

    const marked = await signer.fetch(
      post("/idempotency/broadcast", { key: "k", txId: "tx-1" })
    );
    expect(marked.status).toBe(200);

    const record = storage.map.get("idempotency:k") as Record<string, unknown>;
    expect(record.status).toBe("broadcast");
    expect(record.signedTx).toBeUndefined();

    const replace = await signer.fetch(
      post("/sign", {
        path,
        transaction: tx("tx-2"),
        idempotency: { ...idempotency, replaceTxId: "tx-1" },
      })
    );
    expect(replace.status).toBe(409);
  });

  test("refuses to store a transaction without an expiration", async () => {
    const { signer, storage } = await createSigner();
    const response = await signer.fetch(
      post("/sign", {
        path,
        transaction: { txID: "tx-1", raw_data: {} },
        idempotency: { key: "k", fingerprint: "fp" },
      })
    );

    expect(response.status).toBe(500);
    expect(storage.map.size).toBe(0);
  });

  test("signs and stores an EVM transaction with its nonce", async () => {
    const { signer, storage } = await createSigner();
    const response = await signer.fetch(
      post("/evmSign", {
        path: "m/44/60/0/0/0",
        transaction: {
          feeType: "eip1559",
          chainId: 8453,
          nonce: 7,
          to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          value: "1000",
          gas: "21000",
          maxFeePerGas: "1000000000",
          maxPriorityFeePerGas: "1000000",
        },
        idempotency: { key: "evm-1", fingerprint: "fp", fee: "0.0001" },
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(String(body.txId)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(String(body.rawTransaction)).toMatch(/^0x02/);

    const record = storage.map.get("idempotency:evm-1") as Record<string, unknown>;
    expect(record).toMatchObject({
      txId: body.txId,
      status: "signed",
      nonce: 7,
      signedTx: body.rawTransaction,
    });
    expect(record.expiresAt).toBeUndefined();

    const second = await signer.fetch(
      post("/evmSign", {
        path: "m/44/60/0/0/0",
        transaction: {
          feeType: "legacy",
          chainId: 56,
          nonce: 8,
          to: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          value: "1000",
          gas: "21000",
          gasPrice: "1000000000",
        },
        idempotency: { key: "evm-1", fingerprint: "fp" },
      })
    );
    expect(second.status).toBe(409);
  });
});

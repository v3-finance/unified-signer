import { describe, expect, test } from "bun:test";
import { TronWeb, utils } from "tronweb";

const FROM = "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9";
const TO = "TGMgmByQGAyk7uFwJbnsVmzdcjNFjSgxVE";

type Tx = { txID: string; raw_data: { timestamp: number; expiration: number } };

describe("TxBuilder", () => {
  test("gives equal TRX payouts built in the same block distinct txIDs", async () => {
    const { TxBuilder } = await import("./TxBuilder");
    const builder = new TxBuilder({} as DurableObjectState, {
      TRONGRID_BASE_URL: "http://127.0.0.1:1",
      EVM_NETWORKS: "[]",
    });

    // What tronweb produces for two equal transfers within one block: the
    // header (and so the txID) comes from the head block.
    const offline = new TronWeb({ fullHost: "http://127.0.0.1:1" });
    const sameBlockTx = await offline.transactionBuilder.sendTrx(TO, 1_000_000, FROM, {
      blockHeader: {
        ref_block_bytes: "1234",
        ref_block_hash: "0123456789abcdef",
        expiration: 1_790_000_060_000,
        timestamp: 1_790_000_000_000,
      },
    });
    (
      builder as unknown as {
        tronWeb: { transactionBuilder: { sendTrx: () => Promise<unknown> } };
      }
    ).tronWeb.transactionBuilder.sendTrx = async () => structuredClone(sameBlockTx);

    const build = async () => {
      const response = await builder.fetch(
        new Request("https://do/tronTxBuild", {
          method: "POST",
          body: JSON.stringify({ type: "TRX", from: FROM, to: TO, amount: "1" }),
        })
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { transaction: Tx }).transaction;
    };

    const first = await build();
    const second = await build();

    expect(first.txID).not.toBe(second.txID);
    expect(second.raw_data.timestamp).toBeGreaterThan(first.raw_data.timestamp);
    expect(first.raw_data.expiration).toBe(1_790_000_060_000);
    expect(utils.transaction.txCheck(first)).toBe(true);
    expect(utils.transaction.txCheck(second)).toBe(true);
  });
});

import { DurableObject } from "cloudflare:workers";
import { utils } from "tronweb";
import type { PublicClient } from "viem";
import { doErrorResponse } from "../lib/errors";
import { createEvmClient } from "../lib/evm/client";
import { estimateEvmFees } from "../lib/evm/fees";
import {
  nextNonce,
  STUCK_RESERVATION_MS,
  type NonceReservation,
} from "../lib/evm/nonce";
import {
  parseEvmNetworks,
  type EvmNetworkConfig,
} from "../lib/networks";
import * as schemas from "../lib/schemas/do";
import type { EvmUnsignedTx } from "../lib/schemas/evm";
import { createTronWeb } from "../lib/tron/client";
import { withTronGridRetry } from "../lib/tron/retry";
import { getTrc20TokenInfo } from "../lib/tron/token";
import { json, normalizeTrc20Amount, trxToSunStr } from "../lib/utils";

type TxBuilderEnv = {
  TRONGRID_BASE_URL: string;
  TRONGRID_API_KEY?: string;
  EVM_NETWORKS: string;
};

type BuiltTransaction = {
  txID: string;
  raw_data: Record<string, unknown>;
  raw_data_hex: string;
};

export class TxBuilder extends DurableObject<TxBuilderEnv> {
  private readonly tronWeb;
  private readonly evmClients = new Map<string, PublicClient>();
  private lastTimestamp = 0;

  constructor(ctx: DurableObjectState, env: TxBuilderEnv) {
    super(ctx, env);
    this.tronWeb = createTronWeb(env);
  }

  /**
   * Gives every transaction a unique raw_data.timestamp. tronweb stamps TRX
   * transfers with the head block time, so two equal payouts within one block
   * would otherwise be byte-identical (same txID) and only one would execute.
   * Each network's TxBuilder is a singleton, so a per-instance counter is
   * enough.
   */
  private withUniqueTimestamp<T extends BuiltTransaction>(tx: T): T {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    const restamped = {
      ...tx,
      raw_data: { ...tx.raw_data, timestamp: this.lastTimestamp },
    };
    const pb = utils.transaction.txJsonToPb(restamped);
    restamped.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, "");
    restamped.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).toLowerCase();
    return restamped;
  }

  private getEvmClient(config: EvmNetworkConfig): PublicClient {
    const cached = this.evmClients.get(config.key);

    if (cached) {
      return cached;
    }

    const client = createEvmClient(config);
    this.evmClients.set(config.key, client);
    return client;
  }

  private nonceStorageKey(chainId: number, address: `0x${string}`): string {
    return `nonce:${chainId}:${address.toLowerCase()}`;
  }

  // Serializes nonce assignment for concurrent sends from one address: the
  // chain's pending count does not reflect transactions this service built but
  // has not yet broadcast, so reservations are tracked in DO storage. The
  // final get/put pair runs with no intervening await, so the DO input gate
  // keeps it atomic.
  private async reserveNonce(
    client: PublicClient,
    config: EvmNetworkConfig,
    address: `0x${string}`
  ): Promise<number> {
    const chainNonce = await client.getTransactionCount({
      address,
      blockTag: "pending",
    });
    const storageKey = this.nonceStorageKey(config.chainId, address);
    let reservation = await this.ctx.storage.get<NonceReservation>(storageKey);
    let finalized: number | undefined;

    // A stale queue may only be reset with proof that the address is fully
    // settled. The finalized lookup awaits, so re-read the reservation after
    // it to keep the decision/put pair atomic under the input gate.
    if (
      reservation &&
      chainNonce <= reservation.nonce &&
      Date.now() - reservation.reservedAt >= STUCK_RESERVATION_MS
    ) {
      try {
        finalized = await client.getTransactionCount({
          address,
          blockTag: "finalized",
        });
      } catch {
        finalized = undefined;
      }

      reservation = await this.ctx.storage.get<NonceReservation>(storageKey);
    }

    const now = Date.now();
    const nonce = nextNonce(chainNonce, reservation, now, finalized);
    await this.ctx.storage.put<NonceReservation>(storageKey, {
      nonce,
      reservedAt: now,
    });
    return nonce;
  }

  /**
   * Rolls the reservation back when the transaction that took the slot was
   * abandoned before any node could have seen it. Only exact tail matches are
   * rolled back: once another build reserved past this nonce, the queue keeps
   * its shape and the keyed-retry / settled-reset paths heal the gap instead.
   */
  private async releaseNonce(body: unknown): Promise<Response> {
    const parsed = schemas.EvmNonceReleaseRequestSchema.parse(body);
    const config = parseEvmNetworks(this.env.EVM_NETWORKS).find(
      (network) => network.key === parsed.network
    );

    if (!config) {
      return json(
        { ok: false, error: `Unknown EVM network "${parsed.network}"` },
        400
      );
    }

    const storageKey = this.nonceStorageKey(
      config.chainId,
      parsed.address as `0x${string}`
    );
    const reservation =
      await this.ctx.storage.get<NonceReservation>(storageKey);

    if (reservation?.nonce !== parsed.nonce) {
      return json({ ok: false }, 200);
    }

    if (parsed.nonce === 0) {
      await this.ctx.storage.delete(storageKey);
    } else {
      await this.ctx.storage.put<NonceReservation>(storageKey, {
        nonce: parsed.nonce - 1,
        reservedAt: Date.now(),
      });
    }

    return json({ ok: true });
  }

  private async buildTron(body: unknown): Promise<Response> {
    const parsed = schemas.TronTxBuildRequestSchema.parse(body);
    const isAddress = (address: string) =>
      this.tronWeb.utils.address.isAddress(address);

    if (!isAddress(parsed.from) || !isAddress(parsed.to)) {
      return json(
        { ok: false, error: "Invalid sender or recipient address" },
        400
      );
    }

    if (parsed.type === "TRX") {
      const amountInSun = Number(trxToSunStr(parsed.amount));

      if (!Number.isSafeInteger(amountInSun)) {
        return json({ ok: false, error: "TRX amount too large" }, 400);
      }

      const tx = await withTronGridRetry("sendTrx", () =>
        this.tronWeb.transactionBuilder.sendTrx(parsed.to, amountInSun, parsed.from)
      );

      return json(
        schemas.TronTxBuildResponseSchema.parse({
          ok: true,
          transaction: this.withUniqueTimestamp(tx as unknown as BuiltTransaction),
        })
      );
    }

    if (!isAddress(parsed.contractAddress)) {
      return json({ ok: false, error: "Invalid TRC20 contract address" }, 400);
    }

    const tokenInfo = await getTrc20TokenInfo(this.tronWeb, parsed.contractAddress);
    const amountRaw = normalizeTrc20Amount(parsed.amount, tokenInfo.decimals);
    const feeLimit = 100_000_000;
    const ownerHex = this.tronWeb.address.toHex(parsed.from);

    const wrappedTransaction = await withTronGridRetry("triggerSmartContract", () =>
      this.tronWeb.transactionBuilder.triggerSmartContract(
        parsed.contractAddress,
        "transfer(address,uint256)",
        { feeLimit, callValue: 0 },
        [
          { type: "address", value: parsed.to },
          { type: "uint256", value: amountRaw },
        ],
        ownerHex
      )
    );

    if (!wrappedTransaction?.transaction) {
      return json(
        {
          ok: false,
          error: "Failed to build TRC20 transaction",
        },
        400
      );
    }

    return json(
      schemas.TronTxBuildResponseSchema.parse({
        ok: true,
        transaction: this.withUniqueTimestamp(
          wrappedTransaction.transaction as unknown as BuiltTransaction
        ),
      })
    );
  }

  private async buildEvm(body: unknown): Promise<Response> {
    const parsed = schemas.EvmTxBuildRequestSchema.parse(body);
    const config = parseEvmNetworks(this.env.EVM_NETWORKS).find(
      (network) => network.key === parsed.network
    );

    if (!config) {
      return json(
        { ok: false, error: `Unknown EVM network "${parsed.network}"` },
        400
      );
    }

    const client = this.getEvmClient(config);
    const { estimate, plan } = await estimateEvmFees(client, config, {
      from: parsed.from,
      to: parsed.to,
      amount: parsed.amount,
      contractAddress:
        parsed.type === "ERC20" ? parsed.contractAddress : undefined,
    });
    const nonce = await this.reserveNonce(client, config, parsed.from);

    const base = {
      chainId: config.chainId,
      nonce,
      to: plan.skeleton.to,
      value: plan.skeleton.value.toString(),
      data: plan.skeleton.data,
      gas: estimate.gasLimit.toString(),
    };

    const transaction: EvmUnsignedTx =
      estimate.feeType === "eip1559"
        ? {
            ...base,
            feeType: "eip1559",
            maxFeePerGas: (estimate.maxFeePerGas ?? 0n).toString(),
            maxPriorityFeePerGas: (
              estimate.maxPriorityFeePerGas ?? 0n
            ).toString(),
          }
        : {
            ...base,
            feeType: "legacy",
            gasPrice: (estimate.gasPrice ?? 0n).toString(),
          };

    return json(
      schemas.EvmTxBuildResponseSchema.parse({
        ok: true,
        transaction,
      })
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (req.method === "POST" && url.pathname === "/tronTxBuild") {
        return await this.buildTron(await req.json());
      }

      if (req.method === "POST" && url.pathname === "/evmTxBuild") {
        return await this.buildEvm(await req.json());
      }

      if (req.method === "POST" && url.pathname === "/evmReleaseNonce") {
        return await this.releaseNonce(await req.json());
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return doErrorResponse(error);
    }
  }
}

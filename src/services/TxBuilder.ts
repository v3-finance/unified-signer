import { DurableObject } from "cloudflare:workers";
import type { PublicClient } from "viem";
import { z } from "zod";
import { publicErrorMessage } from "../lib/errors";
import { createEvmClient } from "../lib/evm/client";
import { estimateEvmFees } from "../lib/evm/fees";
import {
  nextNonce,
  type NonceReservation,
} from "../lib/evm/nonce";
import {
  parseEvmNetworks,
  type EvmNetworkConfig,
} from "../lib/networks";
import * as schemas from "../lib/schemas/do";
import type { EvmUnsignedTx } from "../lib/schemas/evm";
import { createTronWeb } from "../lib/tron/client";
import { getTrc20TokenInfo } from "../lib/tron/token";
import { json, normalizeTrc20Amount, trxToSunStr } from "../lib/utils";

type TxBuilderEnv = {
  TRONGRID_BASE_URL: string;
  EVM_NETWORKS: string;
};

export class TxBuilder extends DurableObject<TxBuilderEnv> {
  private readonly tronWeb;
  private readonly evmClients = new Map<string, PublicClient>();

  constructor(ctx: DurableObjectState, env: TxBuilderEnv) {
    super(ctx, env);
    this.tronWeb = createTronWeb(env.TRONGRID_BASE_URL);
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

  // Serializes nonce assignment for concurrent sends from one address: the
  // chain's pending count does not reflect transactions this service built but
  // has not yet broadcast, so reservations are tracked in DO storage. The
  // get/put pair runs with no intervening await, so the DO input gate keeps it
  // atomic.
  private async reserveNonce(
    client: PublicClient,
    config: EvmNetworkConfig,
    address: `0x${string}`
  ): Promise<number> {
    const chainNonce = await client.getTransactionCount({
      address,
      blockTag: "pending",
    });
    const storageKey = `nonce:${config.chainId}:${address.toLowerCase()}`;
    const reservation =
      await this.ctx.storage.get<NonceReservation>(storageKey);
    const now = Date.now();
    const nonce = nextNonce(chainNonce, reservation, now);
    await this.ctx.storage.put<NonceReservation>(storageKey, {
      nonce,
      reservedAt: now,
    });
    return nonce;
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

    this.tronWeb.setAddress(parsed.from);

    if (parsed.type === "TRX") {
      const amountInSun = Number(trxToSunStr(parsed.amount));

      if (!Number.isSafeInteger(amountInSun)) {
        return json({ ok: false, error: "TRX amount too large" }, 400);
      }

      const tx = await this.tronWeb.transactionBuilder.sendTrx(
        parsed.to,
        amountInSun,
        parsed.from
      );

      return json(
        schemas.TronTxBuildResponseSchema.parse({
          ok: true,
          transaction: tx,
        })
      );
    }

    if (!isAddress(parsed.contractAddress)) {
      return json({ ok: false, error: "Invalid TRC20 contract address" }, 400);
    }

    const tokenInfo = await getTrc20TokenInfo(
      this.tronWeb,
      parsed.contractAddress
    );
    const amountRaw = normalizeTrc20Amount(parsed.amount, tokenInfo.decimals);
    const feeLimit = 100_000_000;
    const ownerHex = this.tronWeb.address.toHex(parsed.from);

    const wrappedTransaction =
      await this.tronWeb.transactionBuilder.triggerSmartContract(
        parsed.contractAddress,
        "transfer(address,uint256)",
        { feeLimit, callValue: 0 },
        [
          { type: "address", value: parsed.to },
          { type: "uint256", value: amountRaw },
        ],
        ownerHex
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
        transaction: wrappedTransaction.transaction,
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

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return json(
          {
            ok: false,
            error: "Validation Error",
            details: error.issues,
          },
          400
        );
      }

      return json(
        {
          ok: false,
          error: publicErrorMessage(error),
        },
        400
      );
    }
  }
}

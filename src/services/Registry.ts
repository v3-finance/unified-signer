import { DurableObject } from "cloudflare:workers";
import type { BIP32Interface } from "bip32";
import type { TronWeb } from "tronweb";
import { ContractFunctionExecutionError, erc20Abi, type PublicClient } from "viem";
import { createDerivationRoot } from "../lib/derivation";
import { doErrorResponse, InputError, publicErrorMessage } from "../lib/errors";
import { createEvmClient } from "../lib/evm/client";
import { callConstant, decodeUint } from "../lib/tron/constant";
import { withTronGridRetry } from "../lib/tron/retry";
import { deriveEvmAddressFromPath } from "../lib/evm/derivation";
import {
  resolveNetwork,
  type EvmNetworkConfig,
  type NetworkRef,
} from "../lib/networks";
import * as schemas from "../lib/schemas/do";
import { EvmAddressSchema, TronAddressSchema } from "../lib/schemas/shared";
import { createTronWeb } from "../lib/tron/client";
import { deriveTronAddressFromPath } from "../lib/tron/derivation";
import { json } from "../lib/utils";

type RegistryEnv = {
  mnemonic: string;
  TRONGRID_BASE_URL: string;
  TRONGRID_API_KEY?: string;
  EVM_NETWORKS: string;
};

type TrxTransfer = {
  txID: string;
  timestamp: number;
  from: string;
  to: string;
  amountSun: string;
  direction: "in" | "out";
};

type TRC20Transfer = {
  txID: string;
  timestamp: number;
  from: string;
  to: string;
  amountSun: string;
  contractAddress: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  direction: "in" | "out";
};

type TronGridPage<T> = {
  data?: T[];
  meta?: {
    fingerprint?: string;
  };
};

type TronGridTrxTransaction = {
  txID: string;
  block_timestamp: number;
  raw_data?: {
    contract?: Array<{
      type?: string;
      parameter?: {
        value?: {
          owner_address?: string;
          to_address?: string;
          amount?: string | number | bigint;
        };
      };
    }>;
  };
};

type TronGridTRC20Transfer = {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: string;
  token_info?: {
    address?: string;
    symbol?: string;
    decimals?: string | number;
  };
};

export class Registry extends DurableObject<RegistryEnv> {
  private readonly tronWeb: TronWeb;
  private readonly root: BIP32Interface;
  private readonly evmClients = new Map<string, PublicClient>();

  constructor(ctx: DurableObjectState, env: RegistryEnv) {
    super(ctx, env);
    this.root = createDerivationRoot(env.mnemonic);
    this.tronWeb = createTronWeb(env);
  }

  private resolveNetworkOrThrow(key: string): NetworkRef {
    const network = resolveNetwork(key, this.env.EVM_NETWORKS);

    if (!network) {
      throw new UnknownNetworkError(key);
    }

    return network;
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

  private getAddress(network: NetworkRef, path: string): string {
    if (network.family === "tron") {
      return deriveTronAddressFromPath(this.root, this.tronWeb, path);
    }

    return deriveEvmAddressFromPath(this.root, path);
  }

  private toBigIntSafe(value: unknown): bigint {
    if (typeof value === "bigint") {
      return value;
    }

    if (typeof value === "number") {
      return BigInt(value);
    }

    if (typeof value === "string") {
      return BigInt(value);
    }

    if (
      value &&
      typeof value === "object" &&
      "toString" in value &&
      typeof value.toString === "function"
    ) {
      return BigInt(value.toString());
    }

    throw new Error("Unsupported balance type");
  }

  private async getTRC20Balance(
    tokenAddress: string,
    walletAddress: string
  ): Promise<bigint> {
    const output = await withTronGridRetry(`balanceOf(${tokenAddress})`, () =>
      callConstant(
        this.tronWeb,
        tokenAddress,
        "balanceOf(address)",
        [{ type: "address", value: walletAddress }],
        walletAddress
      )
    );
    return decodeUint(output);
  }

  private toBase58(address: string): string {
    if (address.startsWith("T")) {
      return address;
    }

    return this.tronWeb.address.fromHex(address) as string;
  }

  private async getTrxHistory(
    address: string,
    options?: { limit?: number; maxPages?: number }
  ): Promise<TrxTransfer[]> {
    const base58Address = this.toBase58(address);
    const limit = options?.limit ?? 200;
    const maxPages = options?.maxPages ?? 5;

    const history: TrxTransfer[] = [];
    let fingerprint: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const query: Record<string, string | number> = {
        only_confirmed: "true",
        limit,
        order_by: "block_timestamp,desc",
      };

      if (fingerprint) {
        query.fingerprint = fingerprint;
      }

      const response = (await withTronGridRetry("trx history", () =>
        this.tronWeb.eventServer!.request(
          `v1/accounts/${base58Address}/transactions`,
          query
        )
      )) as TronGridPage<TronGridTrxTransaction>;

      const transactions = response.data ?? [];
      fingerprint = response.meta?.fingerprint;

      for (const transaction of transactions) {
        try {
          const contract = transaction.raw_data?.contract?.[0];
          if (!contract || contract.type !== "TransferContract") {
            continue;
          }

          const params = contract.parameter?.value;
          if (!params?.owner_address || !params.to_address || params.amount === undefined) {
            continue;
          }

          const from = this.toBase58(params.owner_address);
          const to = this.toBase58(params.to_address);
          const direction: "in" | "out" = to === base58Address ? "in" : "out";

          history.push({
            txID: transaction.txID,
            timestamp: transaction.block_timestamp,
            from,
            to,
            amountSun: BigInt(params.amount).toString(),
            direction,
          });
        } catch {
          continue;
        }
      }

      if (!fingerprint) {
        break;
      }
    }

    return history;
  }

  private async getTRC20History(
    holderAddress: string,
    contractAddress: string,
    options?: { limit?: number; maxPages?: number }
  ): Promise<TRC20Transfer[]> {
    const holder = this.toBase58(holderAddress);
    const contract = this.toBase58(contractAddress);
    const limit = options?.limit ?? 200;
    const maxPages = options?.maxPages ?? 5;

    const history: TRC20Transfer[] = [];
    let fingerprint: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const query: Record<string, string | number> = {
        only_confirmed: "true",
        limit,
        order_by: "block_timestamp,desc",
        contract_address: contract,
      };

      if (fingerprint) {
        query.fingerprint = fingerprint;
      }

      const response = (await withTronGridRetry("trc20 history", () =>
        this.tronWeb.eventServer!.request(
          `v1/accounts/${holder}/transactions/trc20`,
          query
        )
      )) as TronGridPage<TronGridTRC20Transfer>;

      const transfers = response.data ?? [];
      fingerprint = response.meta?.fingerprint;

      for (const transfer of transfers) {
        const direction: "in" | "out" = transfer.to === holder ? "in" : "out";
        const decimals = Number(transfer.token_info?.decimals ?? 18);

        history.push({
          txID: transfer.transaction_id,
          timestamp: transfer.block_timestamp,
          from: transfer.from,
          to: transfer.to,
          amountSun: BigInt(transfer.value).toString(),
          contractAddress: transfer.token_info?.address ?? contract,
          tokenSymbol: transfer.token_info?.symbol,
          tokenDecimals: Number.isFinite(decimals) ? decimals : 18,
          direction,
        });
      }

      if (!fingerprint) {
        break;
      }
    }

    return history;
  }

  private async getTronBalance(
    address: string,
    contractAddress?: string
  ): Promise<bigint> {
    if (contractAddress) {
      const tokenAddress = TronAddressSchema.parse(contractAddress);
      return this.getTRC20Balance(tokenAddress, address);
    }

    const balance = await withTronGridRetry("getBalance", () =>
      this.tronWeb.trx.getBalance(address)
    );
    return this.toBigIntSafe(balance);
  }

  private async getEvmBalance(
    config: EvmNetworkConfig,
    address: `0x${string}`,
    contractAddress?: string
  ): Promise<bigint> {
    const client = this.getEvmClient(config);

    if (contractAddress) {
      const tokenAddress = EvmAddressSchema.parse(contractAddress);

      try {
        return await client.readContract({
          address: tokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        });
      } catch (error) {
        // Execution/decode failures mean the address is not a readable ERC20
        // contract; transport errors keep propagating as internal failures.
        if (error instanceof ContractFunctionExecutionError) {
          throw new InputError(
            `Unable to read token contract: ${publicErrorMessage(error)}`
          );
        }

        throw error;
      }
    }

    return client.getBalance({ address });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (req.method === "GET" && url.pathname === "/getAddress") {
        const query = schemas.RegistryAddressQuerySchema.parse({
          network: url.searchParams.get("network"),
          path: url.searchParams.get("path"),
        });

        const network = this.resolveNetworkOrThrow(query.network);
        const response = schemas.AddressResponseSchema.parse({
          address: this.getAddress(network, query.path),
        });
        return json(response);
      }

      if (req.method === "GET" && url.pathname === "/getBalance") {
        const query = schemas.RegistryBalanceQuerySchema.parse({
          network: url.searchParams.get("network"),
          path: url.searchParams.get("path"),
          contractAddress: url.searchParams.get("contractAddress"),
        });

        const network = this.resolveNetworkOrThrow(query.network);
        const address = this.getAddress(network, query.path);

        const balance =
          network.family === "tron"
            ? await this.getTronBalance(address, query.contractAddress)
            : await this.getEvmBalance(
                network.config,
                address as `0x${string}`,
                query.contractAddress
              );

        return json({ value: balance.toString() });
      }

      if (req.method === "GET" && url.pathname === "/getHistory") {
        const query = schemas.RegistryBalanceQuerySchema.parse({
          network: url.searchParams.get("network"),
          path: url.searchParams.get("path"),
          contractAddress: url.searchParams.get("contractAddress"),
        });

        const network = this.resolveNetworkOrThrow(query.network);

        if (network.family !== "tron") {
          throw new InputError("History is only available for the tron network");
        }

        const address = this.getAddress(network, query.path);

        if (query.contractAddress) {
          return json(await this.getTRC20History(address, query.contractAddress));
        }

        return json(await this.getTrxHistory(address));
      }

      return json({ error: "Not Found" }, 404);
    } catch (error) {
      if (error instanceof UnknownNetworkError) {
        return json({ ok: false, error: error.message }, 400);
      }

      return doErrorResponse(error, 500);
    }
  }
}

class UnknownNetworkError extends Error {
  constructor(key: string) {
    super(`Unknown network "${key}"`);
    this.name = "UnknownNetworkError";
  }
}

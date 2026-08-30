import { DurableObject } from "cloudflare:workers";
import type { BIP32Interface } from "bip32";
import type { TronWeb } from "tronweb";
import { ContractFunctionExecutionError, erc20Abi, type PublicClient } from "viem";
import { z } from "zod";
import { createDerivationRoot } from "../lib/derivation";
import { publicErrorMessage } from "../lib/errors";
import { createEvmClient } from "../lib/evm/client";
import { deriveEvmAddressFromRoot } from "../lib/evm/derivation";
import {
  resolveNetwork,
  type EvmNetworkConfig,
  type NetworkRef,
} from "../lib/networks";
import * as schemas from "../lib/schemas/do";
import { EvmAddressSchema, TronAddressSchema } from "../lib/schemas/shared";
import { createTronWeb } from "../lib/tron/client";
import { deriveTronAddressFromRoot } from "../lib/tron/derivation";
import { json } from "../lib/utils";
import type { WalletDerivationParams } from "../lib/derivation";

type RegistryEnv = {
  mnemonic: string;
  TRONGRID_BASE_URL: string;
  EVM_NETWORKS: string;
};

export class Registry extends DurableObject<RegistryEnv> {
  private readonly tronWeb: TronWeb;
  private readonly root: BIP32Interface;
  private readonly evmClients = new Map<string, PublicClient>();

  constructor(ctx: DurableObjectState, env: RegistryEnv) {
    super(ctx, env);
    this.root = createDerivationRoot(env.mnemonic);
    this.tronWeb = createTronWeb(env.TRONGRID_BASE_URL);
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

  private getAddress(
    network: NetworkRef,
    params: WalletDerivationParams
  ): string {
    if (network.family === "tron") {
      return deriveTronAddressFromRoot(this.root, this.tronWeb, params);
    }

    return deriveEvmAddressFromRoot(this.root, params);
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
    this.tronWeb.setAddress(walletAddress);

    let contract;

    try {
      contract = await this.tronWeb.contract().at(tokenAddress);
    } catch (error) {
      throw new TokenContractError(publicErrorMessage(error));
    }

    const rawBalance = await contract.balanceOf(walletAddress).call();
    return this.toBigIntSafe(rawBalance);
  }

  private async getTronBalance(
    address: string,
    contractAddress?: string
  ): Promise<bigint> {
    if (contractAddress) {
      const tokenAddress = TronAddressSchema.parse(contractAddress);
      return this.getTRC20Balance(tokenAddress, address);
    }

    const balance = await this.tronWeb.trx.getBalance(address);
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
          throw new TokenContractError(publicErrorMessage(error));
        }

        throw error;
      }
    }

    return client.getBalance({ address });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (req.method === "GET" && url.pathname === "/getAddressByIndex") {
        const query = schemas.RegistryAddressQuerySchema.parse({
          network: url.searchParams.get("network"),
          appId: url.searchParams.get("appId"),
          purpose: url.searchParams.get("purpose"),
          asset: url.searchParams.get("asset"),
          stage: url.searchParams.get("stage"),
          index: url.searchParams.get("index"),
        });

        const network = this.resolveNetworkOrThrow(query.network);
        const response = schemas.AddressResponseSchema.parse({
          address: this.getAddress(network, query),
        });
        return json(response);
      }

      if (req.method === "GET" && url.pathname === "/getBalance") {
        const query = schemas.RegistryBalanceQuerySchema.parse({
          network: url.searchParams.get("network"),
          appId: url.searchParams.get("appId"),
          purpose: url.searchParams.get("purpose"),
          asset: url.searchParams.get("asset"),
          stage: url.searchParams.get("stage"),
          index: url.searchParams.get("index"),
          contractAddress: url.searchParams.get("contractAddress"),
        });

        const network = this.resolveNetworkOrThrow(query.network);
        const address = this.getAddress(network, query);

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

      return json({ error: "Not Found" }, 404);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return json(
          {
            error: "Validation Error",
            details: error.issues,
          },
          400
        );
      }

      if (error instanceof UnknownNetworkError) {
        return json({ error: error.message }, 400);
      }

      if (error instanceof TokenContractError) {
        return json(
          {
            error: "Unable to read token contract",
            message: error.message,
          },
          400
        );
      }

      return json(
        {
          error: "Internal Server Error",
          message: publicErrorMessage(error),
        },
        500
      );
    }
  }
}

class UnknownNetworkError extends Error {
  constructor(key: string) {
    super(`Unknown network "${key}"`);
    this.name = "UnknownNetworkError";
  }
}

class TokenContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenContractError";
  }
}

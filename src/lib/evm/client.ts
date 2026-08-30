import {
  createPublicClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
} from "viem";
import type { EvmNetworkConfig } from "../networks";

const REQUEST_TIMEOUT_MS = 10_000;

export function toViemChain(config: EvmNetworkConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: {
      name: config.nativeSymbol,
      symbol: config.nativeSymbol,
      decimals: config.nativeDecimals,
    },
    rpcUrls: {
      default: { http: [config.rpcUrl] },
    },
  });
}

export function createEvmClient(config: EvmNetworkConfig): PublicClient {
  return createPublicClient({
    chain: toViemChain(config),
    transport: http(config.rpcUrl, { timeout: REQUEST_TIMEOUT_MS }),
  });
}

export async function broadcastEvmTransaction(
  client: PublicClient,
  rawTransaction: `0x${string}`
): Promise<`0x${string}`> {
  return client.sendRawTransaction({ serializedTransaction: rawTransaction });
}

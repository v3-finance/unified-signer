import { z } from "zod";

export const TRON_NETWORK_KEY = "tron";

const NetworkKeyPattern = /^[a-z][a-z0-9-]*$/;

export const EvmNetworkConfigSchema = z.object({
  key: z
    .string()
    .regex(NetworkKeyPattern, "Network key must be lowercase kebab-case"),
  name: z.string().min(1),
  chainId: z.number().int().positive(),
  rpcUrl: z.string().url(),
  nativeSymbol: z.string().min(1),
  nativeDecimals: z.number().int().positive().max(36).default(18),
  feeType: z.enum(["eip1559", "legacy"]).default("eip1559"),
});

export type EvmNetworkConfig = z.infer<typeof EvmNetworkConfigSchema>;

export type NetworkRef =
  | { family: "tron"; key: typeof TRON_NETWORK_KEY }
  | { family: "evm"; key: string; config: EvmNetworkConfig };

export function parseEvmNetworks(input: unknown): EvmNetworkConfig[] {
  if (input === undefined || input === null || input === "") {
    return [];
  }

  let raw: unknown = input;

  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new Error("EVM_NETWORKS is not valid JSON");
    }
  }

  const networks = z.array(EvmNetworkConfigSchema).parse(raw);
  const seenKeys = new Set<string>();
  const seenChainIds = new Set<number>();

  for (const network of networks) {
    if (network.key === TRON_NETWORK_KEY) {
      throw new Error(`Network key "${TRON_NETWORK_KEY}" is reserved`);
    }

    if (seenKeys.has(network.key)) {
      throw new Error(`Duplicate network key "${network.key}"`);
    }

    if (seenChainIds.has(network.chainId)) {
      throw new Error(`Duplicate chainId ${network.chainId}`);
    }

    seenKeys.add(network.key);
    seenChainIds.add(network.chainId);
  }

  return networks;
}

export function listNetworkKeys(evmNetworksInput: unknown): string[] {
  return [
    TRON_NETWORK_KEY,
    ...parseEvmNetworks(evmNetworksInput).map((network) => network.key),
  ];
}

export function resolveEvmNetworkByChainId(
  chainId: number,
  evmNetworksInput: unknown
): EvmNetworkConfig | undefined {
  return parseEvmNetworks(evmNetworksInput).find(
    (network) => network.chainId === chainId
  );
}

export function listEvmChainIds(evmNetworksInput: unknown): number[] {
  return parseEvmNetworks(evmNetworksInput).map((network) => network.chainId);
}

export function resolveNetwork(
  key: string,
  evmNetworksInput: unknown
): NetworkRef | undefined {
  if (key === TRON_NETWORK_KEY) {
    return { family: "tron", key: TRON_NETWORK_KEY };
  }

  const config = parseEvmNetworks(evmNetworksInput).find(
    (network) => network.key === key
  );

  if (!config) {
    return undefined;
  }

  return { family: "evm", key: config.key, config };
}

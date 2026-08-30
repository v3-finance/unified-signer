import type { TronWeb } from "tronweb";
import { cleanString } from "../utils";

export type Trc20TokenInfo = {
  name: string;
  symbol: string;
  decimals: number;
};

const DEFAULT_TOKEN_NAME = "Unknown Token";
const DEFAULT_TOKEN_SYMBOL = "UNKNOWN";

const tokenInfoCache = new Map<string, Trc20TokenInfo>();

function toCleanString(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return cleanString(value) || fallback;
  }

  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    return cleanString(value.toString()) || fallback;
  }

  return fallback;
}

export async function getTrc20TokenInfo(
  tronWeb: TronWeb,
  contractAddress: string
): Promise<Trc20TokenInfo> {
  const cached = tokenInfoCache.get(contractAddress);

  if (cached) {
    return cached;
  }

  // Decimals scale transfer amounts, so a token whose decimals cannot be read
  // is rejected instead of silently defaulted — and failures are never cached,
  // so a transient TronGrid error cannot poison later requests.
  const contract = await tronWeb.contract().at(contractAddress);
  const [nameAny, symbolAny, decimalsAny] = await Promise.all([
    contract
      .name()
      .call()
      .catch(() => DEFAULT_TOKEN_NAME),
    contract
      .symbol()
      .call()
      .catch(() => DEFAULT_TOKEN_SYMBOL),
    contract
      .decimals()
      .call()
      .catch(() => {
        throw new Error(
          `Unable to read decimals for TRC20 contract ${contractAddress}`
        );
      }),
  ]);

  const decimals = Number(
    typeof decimalsAny === "bigint"
      ? decimalsAny
      : decimalsAny?.toString?.() ?? decimalsAny
  );

  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(
      `TRC20 contract ${contractAddress} reported invalid decimals`
    );
  }

  const tokenInfo: Trc20TokenInfo = {
    name: toCleanString(nameAny, DEFAULT_TOKEN_NAME),
    symbol: toCleanString(symbolAny, DEFAULT_TOKEN_SYMBOL),
    decimals,
  };

  tokenInfoCache.set(contractAddress, tokenInfo);
  return tokenInfo;
}

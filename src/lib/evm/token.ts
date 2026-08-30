import { erc20Abi, type PublicClient } from "viem";
import { cleanString } from "../utils";

export type Erc20TokenInfo = {
  name: string;
  symbol: string;
  decimals: number;
};

const DEFAULT_TOKEN_NAME = "Unknown Token";
const DEFAULT_TOKEN_SYMBOL = "UNKNOWN";

const tokenInfoCache = new Map<string, Erc20TokenInfo>();

export async function getErc20TokenInfo(
  client: PublicClient,
  chainId: number,
  contractAddress: `0x${string}`
): Promise<Erc20TokenInfo> {
  const cacheKey = `${chainId}:${contractAddress.toLowerCase()}`;
  const cached = tokenInfoCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  // Unlike name/symbol, decimals are load-bearing for amount scaling, so a
  // token that does not expose them is rejected instead of silently defaulted.
  const [name, symbol, decimals] = await Promise.all([
    client
      .readContract({
        address: contractAddress,
        abi: erc20Abi,
        functionName: "name",
      })
      .then((value) => cleanString(String(value)) || DEFAULT_TOKEN_NAME)
      .catch(() => DEFAULT_TOKEN_NAME),
    client
      .readContract({
        address: contractAddress,
        abi: erc20Abi,
        functionName: "symbol",
      })
      .then((value) => cleanString(String(value)) || DEFAULT_TOKEN_SYMBOL)
      .catch(() => DEFAULT_TOKEN_SYMBOL),
    client
      .readContract({
        address: contractAddress,
        abi: erc20Abi,
        functionName: "decimals",
      })
      .catch(() => {
        throw new Error(
          `Unable to read decimals for ERC20 contract ${contractAddress}`
        );
      }),
  ]);

  const tokenInfo: Erc20TokenInfo = {
    name,
    symbol,
    decimals: Number(decimals),
  };

  tokenInfoCache.set(cacheKey, tokenInfo);
  return tokenInfo;
}

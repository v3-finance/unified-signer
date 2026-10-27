import { ContractFunctionExecutionError, erc20Abi, type PublicClient } from "viem";
import { InputError, TokenInfoUnavailableError } from "../errors";
import { cleanString } from "../utils";

export type Erc20TokenInfo = {
  name: string;
  symbol: string;
  decimals: number;
};

const DEFAULT_TOKEN_NAME = "Unknown Token";
const DEFAULT_TOKEN_SYMBOL = "UNKNOWN";

// 10^77 is the largest power of ten that fits in uint256.
const MAX_DECIMALS = 77;

const tokenInfoCache = new Map<string, Erc20TokenInfo>();

/**
 * Resolves ERC20 metadata. `decimals` is required: an address that is not a
 * readable token throws InputError (400), a transient transport failure throws
 * TokenInfoUnavailableError (503, retryable) — never a guessed value, because
 * a wrong one scales every amount by a power of ten. Only complete results are
 * cached, so a transient failure never sticks to the isolate.
 */
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

  let decimals: number;

  try {
    decimals = Number(
      await client.readContract({
        address: contractAddress,
        abi: erc20Abi,
        functionName: "decimals",
      })
    );
  } catch (error) {
    // Execution/decode failures mean the address is not a readable ERC20
    // contract; transport errors stay retryable.
    if (error instanceof ContractFunctionExecutionError) {
      throw new InputError(
        `Unable to read token contract ${contractAddress}: it does not expose decimals()`
      );
    }

    throw new TokenInfoUnavailableError(contractAddress, error);
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new InputError(
      `${contractAddress} reports unsupported decimals value ${decimals}`
    );
  }

  const [name, symbol] = await Promise.all([
    client
      .readContract({
        address: contractAddress,
        abi: erc20Abi,
        functionName: "name",
      })
      .then((value) => cleanString(String(value)) || DEFAULT_TOKEN_NAME)
      .catch(() => null),
    client
      .readContract({
        address: contractAddress,
        abi: erc20Abi,
        functionName: "symbol",
      })
      .then((value) => cleanString(String(value)) || DEFAULT_TOKEN_SYMBOL)
      .catch(() => null),
  ]);

  const tokenInfo: Erc20TokenInfo = {
    name: name ?? DEFAULT_TOKEN_NAME,
    symbol: symbol ?? DEFAULT_TOKEN_SYMBOL,
    decimals,
  };

  if (name !== null && symbol !== null) {
    tokenInfoCache.set(cacheKey, tokenInfo);
  }

  return tokenInfo;
}

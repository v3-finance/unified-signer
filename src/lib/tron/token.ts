import type { TronWeb } from "tronweb";
import { TRON_CONSTANTS } from "../constants";
import { errorMessage, InputError, TokenInfoUnavailableError } from "../errors";
import { cleanString } from "../utils";
import { callConstant, decodeString, decodeUint } from "./constant";
import { withTronGridRetry } from "./retry";

export type Trc20TokenInfo = {
  name: string;
  symbol: string;
  decimals: number;
};

// 10^77 is the largest power of ten that fits in uint256.
const MAX_DECIMALS = 77;

// Answers that retrying cannot change: the address is not a TRC20 token.
const NOT_A_TOKEN =
  /Smart contract is not exist|REVERT opcode|returned no usable result|Invalid contract address/i;

/** Tokens this service handles in production: resolved without network calls. */
const KNOWN_TOKENS: Record<string, Trc20TokenInfo> = {
  [TRON_CONSTANTS.CONTRACTS.USDT_MAINNET]: {
    name: "Tether USD",
    symbol: "USDT",
    decimals: 6,
  },
  [TRON_CONSTANTS.CONTRACTS.USDT_NILE]: {
    name: "Tether USD",
    symbol: "USDT",
    decimals: 6,
  },
  [TRON_CONSTANTS.CONTRACTS.A7A5_MAINNET]: {
    name: "A7A5",
    symbol: "A7A5",
    decimals: 6,
  },
};

const tokenInfoCache = new Map<string, Trc20TokenInfo>();

async function readString(
  tronWeb: TronWeb,
  contractAddress: string,
  functionSelector: string,
  ownerAddress: string
): Promise<string | null> {
  try {
    const output = await withTronGridRetry(
      `${functionSelector}(${contractAddress})`,
      () => callConstant(tronWeb, contractAddress, functionSelector, [], ownerAddress)
    );
    return cleanString(decodeString(tronWeb, output));
  } catch {
    return null;
  }
}

/**
 * Resolves TRC20 metadata. `decimals` is required: a transient failure throws
 * TokenInfoUnavailableError (retryable) and a non-token address throws
 * InputError, never a guess. Only complete results are cached, so a transient
 * TronGrid failure never sticks to the isolate.
 */
export async function getTrc20TokenInfo(
  tronWeb: TronWeb,
  contractAddress: string
): Promise<Trc20TokenInfo> {
  const known = KNOWN_TOKENS[contractAddress] ?? tokenInfoCache.get(contractAddress);

  if (known) {
    return known;
  }

  const ownerAddress = tronWeb.defaultAddress.base58 || contractAddress;
  let decimals: number;

  try {
    const output = await withTronGridRetry(`decimals(${contractAddress})`, () =>
      callConstant(tronWeb, contractAddress, "decimals()", [], ownerAddress)
    );
    decimals = Number(decodeUint(output));
  } catch (error) {
    if (NOT_A_TOKEN.test(errorMessage(error))) {
      throw new InputError(
        `${contractAddress} is not a TRC20 token: ${errorMessage(error)}`
      );
    }

    throw new TokenInfoUnavailableError(contractAddress, error);
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new InputError(
      `${contractAddress} reports unsupported decimals value ${decimals}`
    );
  }

  // Sequential on purpose: parallel bursts trip keyless TronGrid's ~3 req/s.
  const symbol = await readString(tronWeb, contractAddress, "symbol()", ownerAddress);
  const name = await readString(tronWeb, contractAddress, "name()", ownerAddress);
  const tokenInfo: Trc20TokenInfo = {
    name: name || "Unknown Token",
    symbol: symbol || "UNKNOWN",
    decimals,
  };

  if (symbol !== null && name !== null) {
    tokenInfoCache.set(contractAddress, tokenInfo);
  }

  return tokenInfo;
}

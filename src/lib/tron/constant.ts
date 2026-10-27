import type { TronWeb } from "tronweb";

const REVERT_SELECTOR = "08c379a0";

/**
 * Runs a read-only contract call and returns the raw ABI-encoded output.
 * Calls triggerconstantcontract directly, so no ABI download is needed
 * (contract().at() fetches the whole ABI, ~37 KB for USDT, on every call).
 */
export async function callConstant(
  tronWeb: TronWeb,
  contractAddress: string,
  functionSelector: string,
  parameters: Array<{ type: string; value: unknown }> = [],
  ownerAddress = contractAddress
): Promise<string> {
  const result = await tronWeb.transactionBuilder.triggerConstantContract(
    contractAddress,
    functionSelector,
    {},
    parameters,
    tronWeb.address.toHex(ownerAddress)
  );
  const output = (result as { constant_result?: string[] }).constant_result?.[0];

  if (!output || output.length % 64 !== 0 || output.startsWith(REVERT_SELECTOR)) {
    throw new Error(
      `${functionSelector} on ${contractAddress} returned no usable result`
    );
  }

  return output;
}

export function decodeUint(output: string): bigint {
  return BigInt(`0x${output.slice(0, 64)}`);
}

/** Decodes an ABI string, falling back to bytes32 (used by some older tokens). */
export function decodeString(tronWeb: TronWeb, output: string): string {
  try {
    const [value] = tronWeb.utils.abi.decodeParams([], ["string"], `0x${output}`);

    if (typeof value === "string") {
      return value;
    }
  } catch {
    // Not an ABI string; treat it as bytes32 below.
  }

  return Buffer.from(output.slice(0, 64), "hex").toString("utf8");
}

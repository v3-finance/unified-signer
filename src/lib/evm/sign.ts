import type { TransactionSerializable } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmUnsignedTx } from "../schemas/evm";

export function toSerializableEvmTx(
  transaction: EvmUnsignedTx
): TransactionSerializable {
  const base = {
    chainId: transaction.chainId,
    nonce: transaction.nonce,
    to: transaction.to,
    value: BigInt(transaction.value),
    data: transaction.data as `0x${string}` | undefined,
    gas: BigInt(transaction.gas),
  };

  if (transaction.feeType === "eip1559") {
    return {
      ...base,
      type: "eip1559",
      maxFeePerGas: BigInt(transaction.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas),
    };
  }

  return {
    ...base,
    type: "legacy",
    gasPrice: BigInt(transaction.gasPrice),
  };
}

export async function signEvmTransaction(
  privateKey: `0x${string}`,
  transaction: EvmUnsignedTx
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(privateKey);
  return account.signTransaction(toSerializableEvmTx(transaction));
}

import { encodeFunctionData, erc20Abi, type PublicClient } from "viem";
import { EVM_CONSTANTS } from "../constants";
import type { EvmNetworkConfig } from "../networks";
import { toBaseUnits } from "../utils";
import { getErc20TokenInfo, type Erc20TokenInfo } from "./token";

export type EvmTransferRequest = {
  from: `0x${string}`;
  to: `0x${string}`;
  amount: string;
  contractAddress?: `0x${string}`;
};

export type EvmTxSkeleton = {
  to: `0x${string}`;
  value: bigint;
  data?: `0x${string}`;
};

export type EvmFeeEstimate = {
  feeType: "eip1559" | "legacy";
  gasLimit: bigint;
  baseFeePerGas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  totalFeeWei: bigint;
};

export type EvmTransferPlan = {
  skeleton: EvmTxSkeleton;
  amountRaw: bigint;
  tokenInfo?: Erc20TokenInfo;
};

export async function buildEvmTransferPlan(
  client: PublicClient,
  config: EvmNetworkConfig,
  request: EvmTransferRequest
): Promise<EvmTransferPlan> {
  if (request.contractAddress) {
    const tokenInfo = await getErc20TokenInfo(
      client,
      config.chainId,
      request.contractAddress
    );
    const amountRaw = BigInt(toBaseUnits(request.amount, tokenInfo.decimals));

    return {
      skeleton: {
        to: request.contractAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [request.to, amountRaw],
        }),
      },
      amountRaw,
      tokenInfo,
    };
  }

  const amountRaw = BigInt(toBaseUnits(request.amount, config.nativeDecimals));

  return {
    skeleton: {
      to: request.to,
      value: amountRaw,
    },
    amountRaw,
  };
}

export async function estimateEvmFees(
  client: PublicClient,
  config: EvmNetworkConfig,
  request: EvmTransferRequest
): Promise<{ estimate: EvmFeeEstimate; plan: EvmTransferPlan }> {
  const plan = await buildEvmTransferPlan(client, config, request);

  const gasEstimate = await client.estimateGas({
    account: request.from,
    to: plan.skeleton.to,
    value: plan.skeleton.value,
    data: plan.skeleton.data,
  });
  const gasLimit =
    gasEstimate +
    (gasEstimate * BigInt(EVM_CONSTANTS.GAS_LIMIT_BUFFER_PERCENT)) / 100n;

  if (config.feeType === "eip1559") {
    const block = await client.getBlock();
    const baseFeePerGas = block.baseFeePerGas;

    if (baseFeePerGas !== null && baseFeePerGas !== undefined) {
      let maxPriorityFeePerGas: bigint;

      try {
        maxPriorityFeePerGas = await client.estimateMaxPriorityFeePerGas();
      } catch {
        maxPriorityFeePerGas = EVM_CONSTANTS.DEFAULT_PRIORITY_FEE_WEI;
      }

      const maxFeePerGas =
        baseFeePerGas * EVM_CONSTANTS.BASE_FEE_MULTIPLIER + maxPriorityFeePerGas;

      return {
        estimate: {
          feeType: "eip1559",
          gasLimit,
          baseFeePerGas,
          maxFeePerGas,
          maxPriorityFeePerGas,
          totalFeeWei: gasLimit * maxFeePerGas,
        },
        plan,
      };
    }
    // The chain reports no base fee: fall through to legacy gas pricing.
  }

  const gasPrice = await client.getGasPrice();

  return {
    estimate: {
      feeType: "legacy",
      gasLimit,
      gasPrice,
      totalFeeWei: gasLimit * gasPrice,
    },
    plan,
  };
}

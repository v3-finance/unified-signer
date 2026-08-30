import { DurableObject } from "cloudflare:workers";
import type { TronWeb } from "tronweb";
import type { PublicClient } from "viem";
import { z } from "zod";
import {
  type CalculateTronFeeResult,
  TransactionType,
  type TronAccountResource,
} from "../lib/interfaces/tron";
import { TRON_CONSTANTS } from "../lib/constants";
import { publicErrorMessage } from "../lib/errors";
import { createEvmClient } from "../lib/evm/client";
import { estimateEvmFees } from "../lib/evm/fees";
import {
  parseEvmNetworks,
  type EvmNetworkConfig,
} from "../lib/networks";
import {
  EvmCalculateDoRequestSchema,
  evmCalculateResponseSchema,
} from "../lib/schemas/evm";
import { calculateSchema } from "../lib/schemas/tron";
import { buildTronGridUrl, createTronWeb } from "../lib/tron/client";
import { getTrc20TokenInfo } from "../lib/tron/token";
import {
  formatBaseUnits,
  json,
  normalizeTrc20Amount,
  roundToDecimals,
  trxToSunStr,
} from "../lib/utils";

type Trc20TransactionsResponse = {
  data?: Array<{
    token_info?: {
      address?: string;
    };
  }>;
};

type TronAccount = {
  address?: unknown;
};

type ChainParameter = {
  key?: string;
  value?: number | string;
};

type TriggerSmartContractResult = {
  transaction?: {
    raw_data_hex?: string;
  };
};

type SendTrxResult = {
  raw_data_hex?: string;
};

type GasCalculatorEnv = {
  TRONGRID_BASE_URL: string;
  EVM_NETWORKS: string;
};

export class GasCalculator extends DurableObject<GasCalculatorEnv> {
  private readonly tronWeb: TronWeb;
  private readonly tronGridBaseUrl: string;
  private readonly evmClients = new Map<string, PublicClient>();

  private readonly ACTIVATION_BANDWIDTH = 200;
  private readonly BANDWIDTH_PROTOBUF_EXTRA = 2;
  private readonly BANDWIDTH_MAX_RESULT_SIZE = 65;
  private readonly BANDWIDTH_SIGNATURE = 67;

  constructor(ctx: DurableObjectState, env: GasCalculatorEnv) {
    super(ctx, env);
    this.tronGridBaseUrl = env.TRONGRID_BASE_URL;
    this.tronWeb = createTronWeb(this.tronGridBaseUrl);
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

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    operationName = "operation",
    maxRetries = 3,
    initialDelayMs = 1_000
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        const message = lastError.message || "Unknown error";

        if (message.includes("429") || message.includes("Too Many Requests")) {
          const delayMs = initialDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw error;
      }
    }

    throw new Error(
      `Failed after ${maxRetries} retries on "${operationName}": ${lastError?.message || "Unknown error"}`
    );
  }

  private async getAccountResources(
    address: string
  ): Promise<TronAccountResource> {
    const resources = (await this.retryWithBackoff(
      () => this.tronWeb.trx.getAccountResources(address),
      `getAccountResources(${address})`
    )) as TronAccountResource;

    return {
      freeNetLimit:
        resources.freeNetLimit || TRON_CONSTANTS.BANDWIDTH.FREE_DAILY_LIMIT,
      freeNetUsed: resources.freeNetUsed || 0,
      NetLimit: resources.NetLimit || 0,
      NetUsed: resources.NetUsed || 0,
      EnergyLimit: resources.EnergyLimit || 0,
      EnergyUsed: resources.EnergyUsed || 0,
      TotalNetLimit:
        resources.TotalNetLimit || TRON_CONSTANTS.NETWORK.TOTAL_BANDWIDTH_LIMIT,
      TotalEnergyLimit:
        resources.TotalEnergyLimit || TRON_CONSTANTS.NETWORK.TOTAL_ENERGY_LIMIT,
    };
  }

  private calculateBandwidthCoverage(
    required: number,
    fromStaking: number,
    fromFree: number
  ) {
    const coverage = {
      fromStaking: 0,
      fromFree: 0,
      needsToBurn: 0,
    };

    let remaining = required;

    if (fromStaking >= remaining) {
      coverage.fromStaking = remaining;
      return coverage;
    }

    coverage.fromStaking = fromStaking;
    remaining -= fromStaking;

    if (remaining > 0 && fromFree > 0) {
      coverage.fromFree = Math.min(remaining, fromFree);
      remaining -= coverage.fromFree;
    }

    coverage.needsToBurn = remaining;
    return coverage;
  }

  private calculateEnergyCoverage(required: number, available: number) {
    if (required === 0) {
      return {
        fromStaking: 0,
        needsToBurn: 0,
      };
    }

    if (available >= required) {
      return {
        fromStaking: required,
        needsToBurn: 0,
      };
    }

    return {
      fromStaking: available,
      needsToBurn: required - available,
    };
  }

  private async isAddressActivated(address: string): Promise<boolean> {
    const account = (await this.retryWithBackoff(
      () => this.tronWeb.trx.getAccount(address),
      `getAccount(${address})`
    )) as TronAccount;

    return Boolean(account?.address);
  }

  private async getEnergyPrice(): Promise<number> {
    try {
      const chainParameters = (await this.retryWithBackoff(
        () => this.tronWeb.trx.getChainParameters(),
        "getChainParameters"
      )) as ChainParameter[];
      const energyFeeParam = chainParameters.find(
        (parameter: ChainParameter) => parameter.key === "getEnergyFee"
      );

      if (
        energyFeeParam &&
        typeof energyFeeParam.value === "number" &&
        energyFeeParam.value > 0
      ) {
        return energyFeeParam.value / 1_000_000;
      }
    } catch {
      return TRON_CONSTANTS.PRICES.ENERGY_IN_TRX;
    }

    return TRON_CONSTANTS.PRICES.ENERGY_IN_TRX;
  }

  private async estimateTRC20Bandwidth(
    senderAddress: string,
    recipientAddress: string,
    amount: string,
    contractAddress: string
  ): Promise<number> {
    const tokenInfo = await this.retryWithBackoff(
      () => getTrc20TokenInfo(this.tronWeb, contractAddress),
      `getTrc20TokenInfo(${contractAddress})`
    );
    const amountRaw = normalizeTrc20Amount(amount, tokenInfo.decimals);

    const transaction = (await this.retryWithBackoff(
      () =>
        this.tronWeb.transactionBuilder.triggerSmartContract(
          contractAddress,
          "transfer(address,uint256)",
          {
            feeLimit: 100_000_000,
            callValue: 0,
          },
          [
            { type: "address", value: recipientAddress },
            { type: "uint256", value: amountRaw },
          ],
          senderAddress
        ),
      `triggerSmartContract(${contractAddress})`
    )) as TriggerSmartContractResult;

    if (!transaction?.transaction?.raw_data_hex) {
      throw new Error("Failed to build TRC20 transaction for bandwidth estimate");
    }

    const rawDataBytes = transaction.transaction.raw_data_hex.length / 2;

    return Math.ceil(
      rawDataBytes +
        this.BANDWIDTH_PROTOBUF_EXTRA +
        this.BANDWIDTH_MAX_RESULT_SIZE +
        this.BANDWIDTH_SIGNATURE
    );
  }

  private async estimateTRXBandwidth(
    senderAddress: string,
    recipientAddress: string,
    amount: string
  ): Promise<number> {
    const amountInSun = Number(trxToSunStr(amount));

    if (!Number.isSafeInteger(amountInSun)) {
      throw new Error("TRX amount is too large to estimate safely");
    }

    const transaction = (await this.retryWithBackoff(
      () =>
        this.tronWeb.transactionBuilder.sendTrx(
          recipientAddress,
          amountInSun,
          senderAddress
        ),
      `sendTrx(${recipientAddress})`
    )) as SendTrxResult;

    if (!transaction?.raw_data_hex) {
      throw new Error("Failed to build TRX transaction for bandwidth estimate");
    }

    const rawDataBytes = transaction.raw_data_hex.length / 2;

    return Math.ceil(
      rawDataBytes +
        this.BANDWIDTH_PROTOBUF_EXTRA +
        this.BANDWIDTH_MAX_RESULT_SIZE +
        this.BANDWIDTH_SIGNATURE
    );
  }

  private async isAddressHasContractTransactions(
    address: string,
    contractAddress: string
  ): Promise<boolean> {
    try {
      const response = await this.retryWithBackoff(
        () =>
          fetch(
            buildTronGridUrl(
              `/v1/accounts/${address}/transactions/trc20?contract_address=${contractAddress}`,
              this.tronGridBaseUrl
            )
          ).then((result) => result.json() as Promise<Trc20TransactionsResponse>),
        `checkContractTransactions(${address})`
      );

      return Boolean(
        response.data?.some(
          (transaction) => transaction.token_info?.address === contractAddress
        )
      );
    } catch {
      return false;
    }
  }

  private async calculateTronFee(
    senderAddress: string,
    recipientAddress: string,
    amount: string,
    contractAddress?: string
  ): Promise<CalculateTronFeeResult> {
    if (!senderAddress || !recipientAddress || !amount) {
      throw new Error("Missing required parameters");
    }

    if (senderAddress === recipientAddress) {
      throw new Error("Sender and recipient must be different");
    }

    const transactionType = contractAddress
      ? TransactionType.TRC20_TRANSFER
      : TransactionType.TRX_TRANSFER;
    const accountResources = await this.getAccountResources(senderAddress);
    const isRecipientActivated = await this.isAddressActivated(recipientAddress);

    const availableBandwidthFromStaking = Math.max(
      (accountResources.NetLimit ?? 0) - (accountResources.NetUsed ?? 0),
      0
    );
    const availableFreeBandwidth = Math.max(
      (accountResources.freeNetLimit ??
        TRON_CONSTANTS.BANDWIDTH.FREE_DAILY_LIMIT) -
        (accountResources.freeNetUsed ?? 0),
      0
    );
    const availableEnergy = Math.max(
      (accountResources.EnergyLimit ?? 0) - (accountResources.EnergyUsed ?? 0),
      0
    );

    let requiredBandwidth = 0;

    if (transactionType === TransactionType.TRC20_TRANSFER && contractAddress) {
      requiredBandwidth = await this.estimateTRC20Bandwidth(
        senderAddress,
        recipientAddress,
        amount,
        contractAddress
      );
    } else {
      requiredBandwidth = await this.estimateTRXBandwidth(
        senderAddress,
        recipientAddress,
        amount
      );

      if (!isRecipientActivated) {
        requiredBandwidth += this.ACTIVATION_BANDWIDTH;
      }
    }

    let requiredEnergy = 0;
    let recipientHasTransactions = false;

    if (transactionType === TransactionType.TRC20_TRANSFER && contractAddress) {
      const tokenInfo = await this.retryWithBackoff(
        () => getTrc20TokenInfo(this.tronWeb, contractAddress),
        `getTrc20TokenInfo(${contractAddress})`
      );
      recipientHasTransactions = await this.isAddressHasContractTransactions(
        recipientAddress,
        contractAddress
      );

      if (tokenInfo.symbol === "A7A5") {
        requiredEnergy = recipientHasTransactions
          ? TRON_CONSTANTS.ENERGY.A7A5.DEFAULT
          : TRON_CONSTANTS.ENERGY.A7A5.WITHOUT_CONTRACT_TRANSACTIONS;
      } else {
        requiredEnergy = recipientHasTransactions
          ? TRON_CONSTANTS.ENERGY.TRC20.DEFAULT
          : TRON_CONSTANTS.ENERGY.TRC20.WITHOUT_CONTRACT_TRANSACTIONS;
      }
    }

    const bandwidthCoverage = this.calculateBandwidthCoverage(
      requiredBandwidth,
      availableBandwidthFromStaking,
      availableFreeBandwidth
    );
    const energyCoverage = this.calculateEnergyCoverage(
      requiredEnergy,
      availableEnergy
    );
    const energyPrice = await this.getEnergyPrice();
    const bandwidthCostTRX = roundToDecimals(
      bandwidthCoverage.needsToBurn * TRON_CONSTANTS.PRICES.BANDWIDTH_PER_UNIT,
      6
    );
    const energyCostTRX = roundToDecimals(
      energyCoverage.needsToBurn * energyPrice,
      6
    );
    const totalFeeTRX = roundToDecimals(
      bandwidthCostTRX + energyCostTRX,
      6
    );

    return {
      totalFeeTRX,
      bandwidth: {
        required: requiredBandwidth,
        available: {
          fromStaking: availableBandwidthFromStaking,
          fromFree: availableFreeBandwidth,
          total: availableBandwidthFromStaking + availableFreeBandwidth,
        },
        coverage: {
          fromStaking: bandwidthCoverage.fromStaking,
          fromFree: bandwidthCoverage.fromFree,
          needsToBurn: bandwidthCoverage.needsToBurn,
          total:
            bandwidthCoverage.fromStaking +
            bandwidthCoverage.fromFree +
            bandwidthCoverage.needsToBurn,
        },
        costTRX: bandwidthCostTRX,
      },
      energy: {
        required: requiredEnergy,
        available: availableEnergy,
        coverage: energyCoverage,
        costTRX: energyCostTRX,
        baseEnergy: requiredEnergy,
        energyFactor: energyPrice,
        recipientHasTransactions,
      },
      transactionType,
      timestamp: Date.now(),
    };
  }

  private async calculateTron(body: unknown): Promise<Response> {
    const parsed = calculateSchema.parse(body);

    this.tronWeb.setAddress(parsed.from);

    return json(
      await this.calculateTronFee(
        parsed.from,
        parsed.to,
        parsed.amount,
        parsed.contract
      )
    );
  }

  private async calculateEvm(body: unknown): Promise<Response> {
    const parsed = EvmCalculateDoRequestSchema.parse(body);
    const config = parseEvmNetworks(this.env.EVM_NETWORKS).find(
      (network) => network.key === parsed.network
    );

    if (!config) {
      return json(
        { ok: false, error: `Unknown EVM network "${parsed.network}"` },
        400
      );
    }

    const client = this.getEvmClient(config);
    const { estimate } = await estimateEvmFees(client, config, {
      from: parsed.from,
      to: parsed.to,
      amount: parsed.amount,
      contractAddress: parsed.contract,
    });

    return json(
      evmCalculateResponseSchema.parse({
        totalFeeNative: formatBaseUnits(
          estimate.totalFeeWei,
          config.nativeDecimals
        ),
        totalFeeWei: estimate.totalFeeWei.toString(),
        gasLimit: estimate.gasLimit.toString(),
        feeType: estimate.feeType,
        baseFeePerGas: estimate.baseFeePerGas?.toString(),
        maxFeePerGas: estimate.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: estimate.maxPriorityFeePerGas?.toString(),
        gasPrice: estimate.gasPrice?.toString(),
        transactionType: parsed.contract ? "ERC20_TRANSFER" : "NATIVE_TRANSFER",
        timestamp: Date.now(),
      })
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (req.method === "POST" && url.pathname === "/calculate") {
        return await this.calculateTron(await req.json());
      }

      if (req.method === "POST" && url.pathname === "/evmCalculate") {
        return await this.calculateEvm(await req.json());
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return json(
          {
            ok: false,
            error: "Validation Error",
            details: error.issues,
          },
          400
        );
      }

      return json(
        {
          ok: false,
          error: publicErrorMessage(error),
        },
        400
      );
    }
  }
}

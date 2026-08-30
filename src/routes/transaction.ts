import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { inferFamilyFromPath } from "../lib/derivation";
import { publicErrorMessage } from "../lib/errors";
import { broadcastEvmTransaction, createEvmClient } from "../lib/evm/client";
import { getErc20TokenInfo } from "../lib/evm/token";
import {
  listEvmChainIds,
  resolveEvmNetworkByChainId,
  TRON_NETWORK_KEY,
  type EvmNetworkConfig,
} from "../lib/networks";
import { createDOClient } from "../lib/orm";
import {
  CalculateEvmFeesByChainBodySchema,
  CalculateTronFeesByPathBodySchema,
  CreateEvmTransactionByChainBodySchema,
  CreateTronTransactionBodySchema,
  type CreateEvmTransactionBody,
  type CreateTronTransactionBody,
} from "../lib/schemas/api";
import {
  createTronWeb,
  getTronGridBroadcastUrl,
} from "../lib/tron/client";
import { getTrc20TokenInfo } from "../lib/tron/token";
import { normalizeTrc20Amount, toBaseUnits, trxToSunStr } from "../lib/utils";
import {
  extractRawDerivationPath,
  FAMILY_INFERENCE_HINT,
} from "./derivation-path";
import { convertAmountOr400, parseJsonBodyOr400 } from "./validation";

const BroadcastTransactionResponseSchema = z.object({
  result: z.boolean().optional(),
  txid: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

async function executeTronTransaction(
  c: Context<Env, string>,
  path: string,
  body: CreateTronTransactionBody
): Promise<Response> {
  const wallet = createDOClient(c, TRON_NETWORK_KEY);
  const registryParams = { network: TRON_NETWORK_KEY, path };

  const amountConversion = convertAmountOr400(c, () =>
    trxToSunStr(body.amount)
  );

  if (!amountConversion.ok) {
    return amountConversion.response;
  }

  const { address } = await wallet.registry().getAddress(registryParams);
  const trxBalance = await wallet.registry().getBalance(registryParams);
  const availableTrxSun = BigInt(trxBalance.value);
  const amountTrxSun = amountConversion.value;

  if (!body.contractAddress && availableTrxSun <= amountTrxSun) {
    return c.json(
      {
        error: "Insufficient TRX balance",
        shortfallSun: (amountTrxSun - availableTrxSun).toString(),
      },
      400
    );
  }

  if (body.contractAddress) {
    const tronWeb = createTronWeb(c.env.TRONGRID_BASE_URL, address);

    let tokenInfo;

    try {
      tokenInfo = await getTrc20TokenInfo(tronWeb, body.contractAddress);
    } catch (error) {
      return c.json(
        {
          error: "Unable to read token contract",
          message: publicErrorMessage(error),
        },
        400
      );
    }

    const tokenAmountConversion = convertAmountOr400(c, () =>
      normalizeTrc20Amount(body.amount, tokenInfo.decimals)
    );

    if (!tokenAmountConversion.ok) {
      return tokenAmountConversion.response;
    }

    const requiredTokenAmount = tokenAmountConversion.value;
    const tokenBalance = await wallet.registry().getBalance({
      ...registryParams,
      contractAddress: body.contractAddress,
    });
    const availableTokenAmount = BigInt(tokenBalance.value);

    if (availableTokenAmount <= requiredTokenAmount) {
      return c.json(
        {
          error: "Insufficient TRC20 balance",
          shortfall: (requiredTokenAmount - availableTokenAmount).toString(),
          token: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
        },
        400
      );
    }
  }

  let feeQuote;

  if (!body.gasFree) {
    feeQuote = await wallet.calculator().calculate({
      amount: body.amount,
      from: address,
      to: body.to,
      contract: body.contractAddress,
    });
    const feeInSun = BigInt(trxToSunStr(feeQuote.totalFeeTRX.toFixed(6)));
    const totalRequiredTrxSun =
      feeInSun + (body.contractAddress ? 0n : amountTrxSun);

    if (availableTrxSun <= totalRequiredTrxSun) {
      return c.json(
        {
          error: "Insufficient TRX balance to cover amount and fees",
          shortfallSun: (totalRequiredTrxSun - availableTrxSun).toString(),
          feeSun: feeInSun.toString(),
        },
        400
      );
    }
  }

  const txBuilder = await wallet.txBuilder().build(
    body.contractAddress
      ? {
          type: "TRC20",
          from: address,
          to: body.to,
          amount: body.amount,
          contractAddress: body.contractAddress,
        }
      : {
          type: "TRX",
          from: address,
          to: body.to,
          amount: body.amount,
        }
  );

  if (!txBuilder.ok || !txBuilder.transaction) {
    return c.json(
      {
        error: txBuilder.error ?? "Failed to build transaction",
      },
      400
    );
  }

  const signed = await wallet.signer().sign({
    path,
    transaction: txBuilder.transaction,
  });

  if (!signed.ok || !signed.signedTx) {
    return c.json(
      {
        error: signed.error ?? "Failed to sign transaction",
      },
      400
    );
  }

  const response = await fetch(
    getTronGridBroadcastUrl(c.env.TRONGRID_BASE_URL),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed.signedTx),
    }
  );
  const broadcastResult = BroadcastTransactionResponseSchema.parse(
    await response.json()
  );

  if (!response.ok || !broadcastResult.result || !broadcastResult.txid) {
    return c.json(
      {
        error: "Failed to broadcast transaction",
        details: broadcastResult,
      },
      502
    );
  }

  return c.json(
    {
      txId: broadcastResult.txid,
      fee: body.gasFree ? "0" : String(feeQuote?.totalFeeTRX),
    },
    201
  );
}

async function executeEvmTransaction(
  c: Context<Env, string>,
  config: EvmNetworkConfig,
  path: string,
  body: CreateEvmTransactionBody
): Promise<Response> {
  const wallet = createDOClient(c, config.key);
  const registryParams = { network: config.key, path };
  const client = createEvmClient(config);

  const amountConversion = body.contractAddress
    ? ({ ok: true, value: 0n } as const)
    : convertAmountOr400(c, () =>
        toBaseUnits(body.amount, config.nativeDecimals)
      );

  if (!amountConversion.ok) {
    return amountConversion.response;
  }

  const { address } = await wallet.registry().getAddress(registryParams);
  const senderAddress = address as `0x${string}`;
  const nativeBalance = BigInt(
    (await wallet.registry().getBalance(registryParams)).value
  );
  const amountWei = amountConversion.value;

  if (!body.contractAddress && nativeBalance < amountWei) {
    return c.json(
      {
        error: `Insufficient ${config.nativeSymbol} balance`,
        shortfallWei: (amountWei - nativeBalance).toString(),
      },
      400
    );
  }

  if (body.contractAddress) {
    let tokenInfo;

    try {
      tokenInfo = await getErc20TokenInfo(
        client,
        config.chainId,
        body.contractAddress
      );
    } catch (error) {
      return c.json(
        {
          error: "Unable to read token contract",
          message: publicErrorMessage(error),
        },
        400
      );
    }

    const tokenAmountConversion = convertAmountOr400(c, () =>
      toBaseUnits(body.amount, tokenInfo.decimals)
    );

    if (!tokenAmountConversion.ok) {
      return tokenAmountConversion.response;
    }

    const requiredTokenAmount = tokenAmountConversion.value;
    const tokenBalance = await wallet.registry().getBalance({
      ...registryParams,
      contractAddress: body.contractAddress,
    });
    const availableTokenAmount = BigInt(tokenBalance.value);

    if (availableTokenAmount < requiredTokenAmount) {
      return c.json(
        {
          error: "Insufficient ERC20 balance",
          shortfall: (requiredTokenAmount - availableTokenAmount).toString(),
          token: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
        },
        400
      );
    }
  }

  let feeQuote;

  if (!body.gasFree) {
    feeQuote = await wallet.calculator().calculateEvm({
      network: config.key,
      from: senderAddress,
      to: body.to,
      amount: body.amount,
      contract: body.contractAddress,
    });
    const feeWei = BigInt(feeQuote.totalFeeWei);
    const totalRequiredWei = feeWei + amountWei;

    if (nativeBalance < totalRequiredWei) {
      return c.json(
        {
          error: `Insufficient ${config.nativeSymbol} balance to cover amount and fees`,
          shortfallWei: (totalRequiredWei - nativeBalance).toString(),
          feeWei: feeWei.toString(),
        },
        400
      );
    }
  }

  const txBuilder = await wallet.txBuilder().buildEvm(
    body.contractAddress
      ? {
          type: "ERC20",
          network: config.key,
          from: senderAddress,
          to: body.to,
          amount: body.amount,
          contractAddress: body.contractAddress,
        }
      : {
          type: "NATIVE",
          network: config.key,
          from: senderAddress,
          to: body.to,
          amount: body.amount,
        }
  );

  if (!txBuilder.ok || !txBuilder.transaction) {
    return c.json(
      {
        error: txBuilder.error ?? "Failed to build transaction",
      },
      400
    );
  }

  const signed = await wallet.signer().signEvm({
    path,
    transaction: txBuilder.transaction,
  });

  if (!signed.ok || !signed.rawTransaction) {
    return c.json(
      {
        error: signed.error ?? "Failed to sign transaction",
      },
      400
    );
  }

  let txId: `0x${string}`;

  try {
    txId = await broadcastEvmTransaction(
      client,
      signed.rawTransaction as `0x${string}`
    );
  } catch (error) {
    return c.json(
      {
        error: "Failed to broadcast transaction",
        details: {
          message: publicErrorMessage(error),
        },
      },
      502
    );
  }

  return c.json(
    {
      txId,
      fee: body.gasFree ? "0" : feeQuote?.totalFeeNative,
    },
    201
  );
}

export function registerTransactionRoutes(app: Hono<Env>) {
  // The chain family comes from the path's coin type (44/195 -> tron,
  // 44/60 -> EVM); for EVM the concrete network is selected by `chainId`
  // in the body.
  app.post("/transaction/*", async (c) => {
    const pathResolution = extractRawDerivationPath(c, "/transaction/");

    if (!pathResolution.ok) {
      return pathResolution.response;
    }

    const family = inferFamilyFromPath(pathResolution.path);

    if (!family) {
      return c.json(
        { error: FAMILY_INFERENCE_HINT, path: pathResolution.path },
        400
      );
    }

    if (family === "tron") {
      const body = await parseJsonBodyOr400(c, CreateTronTransactionBodySchema);

      if (!body.ok) {
        return body.response;
      }

      return executeTronTransaction(c, pathResolution.path, body.data);
    }

    const body = await parseJsonBodyOr400(
      c,
      CreateEvmTransactionByChainBodySchema
    );

    if (!body.ok) {
      return body.response;
    }

    const config = resolveEvmNetworkByChainId(
      body.data.chainId,
      c.env.EVM_NETWORKS
    );

    if (!config) {
      return c.json(
        {
          error: `Unknown chainId ${body.data.chainId}`,
          availableChainIds: listEvmChainIds(c.env.EVM_NETWORKS),
        },
        400
      );
    }

    const { chainId: _chainId, ...evmBody } = body.data;
    return executeEvmTransaction(c, config, pathResolution.path, evmBody);
  });

  app.post("/calculate/fees/*", async (c) => {
    const pathResolution = extractRawDerivationPath(c, "/calculate/fees/");

    if (!pathResolution.ok) {
      return pathResolution.response;
    }

    const family = inferFamilyFromPath(pathResolution.path);

    if (!family) {
      return c.json(
        { error: FAMILY_INFERENCE_HINT, path: pathResolution.path },
        400
      );
    }

    if (family === "tron") {
      const body = await parseJsonBodyOr400(
        c,
        CalculateTronFeesByPathBodySchema
      );

      if (!body.ok) {
        return body.response;
      }

      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const { address } = await wallet.registry().getAddress({
        network: TRON_NETWORK_KEY,
        path: pathResolution.path,
      });
      const result = await wallet.calculator().calculate({
        from: address,
        to: body.data.to,
        amount: body.data.amount,
        contract: body.data.contract,
      });
      return c.json(result, 200);
    }

    const body = await parseJsonBodyOr400(c, CalculateEvmFeesByChainBodySchema);

    if (!body.ok) {
      return body.response;
    }

    const config = resolveEvmNetworkByChainId(
      body.data.chainId,
      c.env.EVM_NETWORKS
    );

    if (!config) {
      return c.json(
        {
          error: `Unknown chainId ${body.data.chainId}`,
          availableChainIds: listEvmChainIds(c.env.EVM_NETWORKS),
        },
        400
      );
    }

    const wallet = createDOClient(c, config.key);
    const { address } = await wallet.registry().getAddress({
      network: config.key,
      path: pathResolution.path,
    });
    const result = await wallet.calculator().calculateEvm({
      network: config.key,
      from: address as `0x${string}`,
      to: body.data.to,
      amount: body.data.amount,
      contract: body.data.contract,
    });
    return c.json(result, 200);
  });
}

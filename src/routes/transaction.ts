import { zValidator } from "@hono/zod-validator";
import type { Context, Hono } from "hono";
import { z, type ZodIssue } from "zod";
import type { Env } from "../env";
import { buildDerivationPath } from "../lib/derivation";
import { publicErrorMessage } from "../lib/errors";
import { broadcastEvmTransaction, createEvmClient } from "../lib/evm/client";
import { getErc20TokenInfo } from "../lib/evm/token";
import {
  TRON_NETWORK_KEY,
  type EvmNetworkConfig,
} from "../lib/networks";
import { createDOClient } from "../lib/orm";
import {
  CalculateEvmFeesByPathBodySchema,
  CalculateTronFeesByPathBodySchema,
  CreateEvmTransactionBodySchema,
  CreateTronTransactionBodySchema,
  type CreateEvmTransactionBody,
  type CreateTronTransactionBody,
} from "../lib/schemas/api";
import { evmCalculateSchema } from "../lib/schemas/evm";
import { calculateSchema } from "../lib/schemas/tron";
import { WalletDerivationQuerySchema } from "../lib/schemas/shared";
import {
  createTronWeb,
  getTronGridBroadcastUrl,
} from "../lib/tron/client";
import { getTrc20TokenInfo } from "../lib/tron/token";
import { normalizeTrc20Amount, toBaseUnits, trxToSunStr } from "../lib/utils";
import { extractRawDerivationPath } from "./derivation-path";
import { resolveEvmNetworkParam } from "./network";
import { convertAmountOr400, validationHook } from "./validation";

const BroadcastTransactionResponseSchema = z.object({
  result: z.boolean().optional(),
  txid: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

function feesValidationHook(
  result: { success: boolean; error?: unknown },
  c: Context<any, string>
) {
  if (!result.success) {
    const error = result.error as z.ZodError | undefined;
    return c.json(
      {
        success: false,
        error: {
          message: "Validation error",
          issues: (error?.issues ?? []).map((issue: ZodIssue) => ({
            field: issue.path.join("."),
            message: issue.message,
            code: issue.code,
          })),
        },
      },
      400
    );
  }
}

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
  // Tron routes are registered before the `:network` routes so the static
  // `/tron` prefix wins for Tron requests.
  app.post(
    "/tron/transaction",
    zValidator("query", WalletDerivationQuerySchema, validationHook),
    zValidator("json", CreateTronTransactionBodySchema, validationHook),
    async (c) => {
      const params = c.req.valid("query");
      return executeTronTransaction(
        c,
        buildDerivationPath("tron", params),
        c.req.valid("json")
      );
    }
  );

  app.post(
    "/tron/transaction/*",
    zValidator("json", CreateTronTransactionBodySchema, validationHook),
    async (c) => {
      const resolution = extractRawDerivationPath(
        c,
        "/tron/transaction/",
        "tron"
      );

      if (!resolution.ok) {
        return resolution.response;
      }

      return executeTronTransaction(c, resolution.path, c.req.valid("json"));
    }
  );

  app.post(
    "/tron/calculate/fees",
    zValidator("json", calculateSchema, feesValidationHook),
    async (c) => {
      const params = c.req.valid("json");
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const result = await wallet.calculator().calculate(params);
      return c.json(result, 200);
    }
  );

  app.post(
    "/tron/calculate/fees/*",
    zValidator("json", CalculateTronFeesByPathBodySchema, feesValidationHook),
    async (c) => {
      const resolution = extractRawDerivationPath(
        c,
        "/tron/calculate/fees/",
        "tron"
      );

      if (!resolution.ok) {
        return resolution.response;
      }

      const body = c.req.valid("json");
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const { address } = await wallet.registry().getAddress({
        network: TRON_NETWORK_KEY,
        path: resolution.path,
      });
      const result = await wallet.calculator().calculate({
        from: address,
        to: body.to,
        amount: body.amount,
        contract: body.contract,
      });
      return c.json(result, 200);
    }
  );

  app.post(
    "/:network/transaction",
    zValidator("query", WalletDerivationQuerySchema, validationHook),
    zValidator("json", CreateEvmTransactionBodySchema, validationHook),
    async (c) => {
      const resolution = resolveEvmNetworkParam(c);

      if (!resolution.ok) {
        return resolution.response;
      }

      const params = c.req.valid("query");
      return executeEvmTransaction(
        c,
        resolution.config,
        buildDerivationPath("evm", params),
        c.req.valid("json")
      );
    }
  );

  app.post(
    "/:network/transaction/*",
    zValidator("json", CreateEvmTransactionBodySchema, validationHook),
    async (c) => {
      const resolution = resolveEvmNetworkParam(c);

      if (!resolution.ok) {
        return resolution.response;
      }

      const pathResolution = extractRawDerivationPath(
        c,
        `/${resolution.config.key}/transaction/`,
        "evm"
      );

      if (!pathResolution.ok) {
        return pathResolution.response;
      }

      return executeEvmTransaction(
        c,
        resolution.config,
        pathResolution.path,
        c.req.valid("json")
      );
    }
  );

  app.post(
    "/:network/calculate/fees",
    zValidator("json", evmCalculateSchema, feesValidationHook),
    async (c) => {
      const resolution = resolveEvmNetworkParam(c);

      if (!resolution.ok) {
        return resolution.response;
      }

      const params = c.req.valid("json");
      const wallet = createDOClient(c, resolution.config.key);
      const result = await wallet.calculator().calculateEvm({
        network: resolution.config.key,
        ...params,
      });
      return c.json(result, 200);
    }
  );

  app.post(
    "/:network/calculate/fees/*",
    zValidator("json", CalculateEvmFeesByPathBodySchema, feesValidationHook),
    async (c) => {
      const resolution = resolveEvmNetworkParam(c);

      if (!resolution.ok) {
        return resolution.response;
      }

      const pathResolution = extractRawDerivationPath(
        c,
        `/${resolution.config.key}/calculate/fees/`,
        "evm"
      );

      if (!pathResolution.ok) {
        return pathResolution.response;
      }

      const body = c.req.valid("json");
      const wallet = createDOClient(c, resolution.config.key);
      const { address } = await wallet.registry().getAddress({
        network: resolution.config.key,
        path: pathResolution.path,
      });
      const result = await wallet.calculator().calculateEvm({
        network: resolution.config.key,
        from: address as `0x${string}`,
        to: body.to,
        amount: body.amount,
        contract: body.contract,
      });
      return c.json(result, 200);
    }
  );
}

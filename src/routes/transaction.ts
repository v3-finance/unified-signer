import type { Context, Hono } from "hono";
import type { Env } from "../env";
import { inferFamilyFromPath } from "../lib/derivation";
import { DOCallError, errorMessage, publicErrorMessage } from "../lib/errors";
import {
  broadcastEvmRaw,
  EVM_DETERMINISTIC_REJECTIONS,
  settleEvmTransaction,
  type EvmBroadcastOutcome,
} from "../lib/evm/broadcast";
import { createEvmClient } from "../lib/evm/client";
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
import type { IdempotencyRecord } from "../lib/schemas/do";
import { IdempotencyKeySchema } from "../lib/schemas/shared";
import {
  type BroadcastOutcome,
  broadcastTransaction,
  getSolidifiedBlockTimestamp,
  isTransactionInBlock,
} from "../lib/tron/broadcast";
import { createTronWeb } from "../lib/tron/client";
import { getTrc20TokenInfo } from "../lib/tron/token";
import {
  normalizeDecimalString,
  normalizeTrc20Amount,
  toBaseUnits,
  trxToSunStr,
} from "../lib/utils";
import {
  extractRawDerivationPath,
  FAMILY_INFERENCE_HINT,
} from "./derivation-path";
import { parseJsonBodyOr400 } from "./validation";

type Wallet = ReturnType<typeof createDOClient>;
type Bindings = Env["Bindings"];

/**
 * A TRON transaction that expired without landing is only declared dead after
 * this long: covers node lag, block propagation and clock skew.
 */
const DEAD_AFTER_EXPIRATION_MS = 5 * 60_000;
/** The solidified chain must reach this far past expiration before "absent" counts. */
const SOLIDIFIED_PAST_EXPIRATION_MS = 30_000;
/** TRON rejections that repeat identically on every retry. */
const TRON_DETERMINISTIC_REJECTIONS = new Set([
  "SIGERROR",
  "TOO_BIG_TRANSACTION_ERROR",
]);

export type TronTransferRequest = {
  path: string;
  body: CreateTronTransactionBody;
  /** Full storage key as the Signer stores it (legacy keys are appId-scoped). */
  idempotencyKey?: string;
  fingerprint: string;
  /** Legacy endpoints return `fee` as a number, like the original service. */
  legacyFee?: boolean;
};

type EvmTransferRequest = {
  path: string;
  body: CreateEvmTransactionBody;
  config: EvmNetworkConfig;
  idempotencyKey?: string;
  fingerprint: string;
};

function readExpiration(signedTx: unknown): number | undefined {
  const expiration = (signedTx as { raw_data?: { expiration?: unknown } } | null)
    ?.raw_data?.expiration;
  return typeof expiration === "number" ? expiration : undefined;
}

function toIso(timestamp?: number): string | undefined {
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

/** Keeps the node's raw answer (txid, code, hex message) as before, plus decoded text. */
function broadcastDetails(outcome: Exclude<BroadcastOutcome, { status: "accepted" }>) {
  return outcome.raw
    ? { ...outcome.raw, decodedMessage: outcome.message }
    : { code: outcome.code, message: outcome.message };
}

/** Idempotency bookkeeping must never turn a sent payout into an error. */
async function markBroadcast(wallet: Wallet, key: string, txId: string) {
  try {
    await wallet.signer().markIdempotencyBroadcast({ key, txId });
  } catch (error) {
    if (error instanceof DOCallError && error.status === 404) {
      // The record now holds another transaction although this one is on-chain.
      console.error(
        `[transaction] ALERT: idempotency key ${key} was re-used after ${txId} was sent; check for a duplicate payout`
      );
      return;
    }

    console.error("[transaction] mark idempotency key as broadcast failed", error);
  }
}

/** Reads and validates the Idempotency-Key header; undefined when absent. */
function readIdempotencyKey(
  c: Context<Env, string>
): { ok: true; key?: string } | { ok: false; response: Response } {
  const raw = c.req.header("Idempotency-Key");

  if (raw === undefined) {
    return { ok: true };
  }

  const parsed = IdempotencyKeySchema.safeParse(raw);

  if (!parsed.success) {
    return {
      ok: false,
      response: c.json(
        {
          error: "Invalid Idempotency-Key header",
          details: parsed.error.issues,
          retryable: false,
        },
        400
      ),
    };
  }

  return { ok: true, key: parsed.data };
}

// ---------------------------------------------------------------------------
// TRON
// ---------------------------------------------------------------------------

type TronSettlement =
  | { status: "sent" }
  | { status: "dead" }
  | { status: "pending"; code?: string; message: string };

/**
 * Decides what happened to a signed TRON transaction whose broadcast was never
 * confirmed. While it has not expired it can still land, so it is resent (the
 * same bytes, never a new transaction). After expiration only block inclusion
 * counts: a copy left in some node's pending pool can no longer land, and if
 * the chain does not have it by then, it never will.
 */
async function settleTronTransaction(
  env: Bindings,
  record: IdempotencyRecord
): Promise<TronSettlement> {
  const expiresAt = record.expiresAt ?? 0;
  const lookup = async (): Promise<boolean | Error> => {
    try {
      return await isTransactionInBlock(env, record.txId);
    } catch (error) {
      return error instanceof Error ? error : new Error(errorMessage(error));
    }
  };

  if (Date.now() < expiresAt) {
    const outcome = await broadcastTransaction(env, record.signedTx);

    if (outcome.status === "accepted" || (await lookup()) === true) {
      return { status: "sent" };
    }

    return {
      status: "pending",
      code: outcome.code,
      message: outcome.message ?? outcome.code ?? "Transaction was not accepted",
    };
  }

  const found = await lookup();

  if (found === true) {
    return { status: "sent" };
  }

  if (found instanceof Error) {
    return { status: "pending", message: found.message };
  }

  if (Date.now() < expiresAt + DEAD_AFTER_EXPIRATION_MS) {
    return {
      status: "pending",
      message: "Transaction expired recently; waiting before treating it as not sent",
    };
  }

  // Only trust "absent" once irreversible blocks cover the whole window in
  // which the transaction could have been included, then look once more.
  try {
    const solidifiedAt = await getSolidifiedBlockTimestamp(env);

    if (solidifiedAt < expiresAt + SOLIDIFIED_PAST_EXPIRATION_MS) {
      return { status: "pending", message: "Waiting for solidified blocks" };
    }
  } catch (error) {
    return { status: "pending", message: errorMessage(error) };
  }

  const recheck = await lookup();

  if (recheck === true) {
    return { status: "sent" };
  }

  if (recheck instanceof Error) {
    return { status: "pending", message: recheck.message };
  }

  return { status: "dead" };
}

/**
 * A retry with a key that already has a record. Returns undefined when the
 * recorded transaction is provably dead and a new one should be sent.
 */
export async function replayTronRequest(
  c: Context<Env, string>,
  wallet: Wallet,
  request: TronTransferRequest,
  record: IdempotencyRecord
) {
  const key = request.idempotencyKey as string;

  if (record.fingerprint !== request.fingerprint) {
    return c.json(
      {
        error: "Idempotency key was already used for a different transaction",
        txId: record.txId,
        retryable: false,
      },
      409
    );
  }

  if (record.status === "broadcast") {
    return c.json({ txId: record.txId, fee: record.fee, replayed: true }, 200);
  }

  const settlement = await settleTronTransaction(c.env, record);

  if (settlement.status === "sent") {
    await markBroadcast(wallet, key, record.txId);
    return c.json({ txId: record.txId, fee: record.fee, replayed: true }, 200);
  }

  if (settlement.status === "dead") {
    return undefined;
  }

  return c.json(
    {
      error:
        "Transaction for this idempotency key is not confirmed yet. Retry later with the same Idempotency-Key.",
      txId: record.txId,
      expiresAt: toIso(record.expiresAt),
      retryable: true,
      details: { code: settlement.code, message: settlement.message },
    },
    503
  );
}

export async function sendNewTronTransaction(
  c: Context<Env, string>,
  wallet: Wallet,
  request: TronTransferRequest,
  replaceTxId?: string
) {
  const { path, body, idempotencyKey, fingerprint } = request;
  const registryParams = { network: TRON_NETWORK_KEY, path };
  const { address } = await wallet.registry().getAddress(registryParams);
  const trxBalance = await wallet.registry().getBalance(registryParams);
  const availableTrxSun = BigInt(trxBalance.value);
  const amountTrxSun = body.contractAddress
    ? 0n
    : BigInt(trxToSunStr(body.amount));

  if (!body.contractAddress && availableTrxSun < amountTrxSun) {
    return c.json(
      {
        error: "Insufficient TRX balance",
        shortfallSun: (amountTrxSun - availableTrxSun).toString(),
      },
      400
    );
  }

  if (body.contractAddress) {
    const tronWeb = createTronWeb(c.env, address);
    const tokenInfo = await getTrc20TokenInfo(tronWeb, body.contractAddress);
    const requiredTokenAmount = BigInt(
      normalizeTrc20Amount(body.amount, tokenInfo.decimals)
    );
    const tokenBalance = await wallet.registry().getBalance({
      ...registryParams,
      contractAddress: body.contractAddress,
    });
    const availableTokenAmount = BigInt(tokenBalance.value);

    if (availableTokenAmount < requiredTokenAmount) {
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
    const totalRequiredTrxSun = feeInSun + amountTrxSun;

    if (availableTrxSun < totalRequiredTrxSun) {
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

  const fee = body.gasFree
    ? "0"
    : request.legacyFee
      ? feeQuote?.totalFeeTRX
      : String(feeQuote?.totalFeeTRX);

  const txBuilder = await wallet.txBuilder().build(
    body.contractAddress
      ? {
          type: "TRC20",
          from: address,
          to: body.to,
          amount: body.amount,
          contractAddress: body.contractAddress,
        }
      : { type: "TRX", from: address, to: body.to, amount: body.amount }
  );

  if (!txBuilder.ok || !txBuilder.transaction) {
    return c.json(
      {
        error: txBuilder.error ?? "Failed to build transaction",
      },
      400
    );
  }

  let signed;

  try {
    signed = await wallet.signer().sign({
      path,
      transaction: txBuilder.transaction,
      idempotency: idempotencyKey
        ? { key: idempotencyKey, fingerprint, fee, replaceTxId }
        : undefined,
    });
  } catch (error) {
    // Another request with the same key got to the signer first. Its
    // transaction is the one for this key: settle that one instead.
    if (idempotencyKey && error instanceof DOCallError && error.status === 409) {
      const { record } = await wallet
        .signer()
        .getIdempotencyRecord({ key: idempotencyKey });

      if (record) {
        const replay = await replayTronRequest(c, wallet, request, record);

        if (replay) {
          return replay;
        }
      }

      return c.json(
        {
          error: "Idempotency key is being used by another request. Retry later.",
          txId: record?.txId,
          retryable: true,
        },
        409
      );
    }

    throw error;
  }

  if (!signed.ok || !signed.signedTx || !signed.txId) {
    return c.json(
      {
        error: signed.error ?? "Failed to sign transaction",
      },
      400
    );
  }

  const txId = signed.txId;
  const expiresAt = toIso(readExpiration(signed.signedTx));
  const outcome = await broadcastTransaction(c.env, signed.signedTx);

  if (outcome.status === "accepted") {
    if (idempotencyKey) {
      await markBroadcast(wallet, idempotencyKey, txId);
    }

    return c.json({ txId, fee }, 201);
  }

  if (outcome.status === "rejected") {
    // No node took this attempt. Without a key a retry sends a new transaction,
    // which is safe. With a key the record is kept: a retry resends these
    // exact bytes until they expire, so a concurrent resend can't double pay.
    return c.json(
      {
        error: "Failed to broadcast transaction",
        txId,
        expiresAt,
        retryable: !TRON_DETERMINISTIC_REJECTIONS.has(outcome.code),
        details: broadcastDetails(outcome),
      },
      outcome.code === "RATE_LIMITED" ? 503 : 502
    );
  }

  // The transaction may already be on-chain. Only a retry with the same
  // idempotency key is safe: it resends this exact transaction.
  return c.json(
    {
      error: "Broadcast outcome unknown",
      txId,
      expiresAt,
      retryable: Boolean(idempotencyKey),
      details: broadcastDetails(outcome),
    },
    502
  );
}

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

/**
 * A retry with a key that already has a record. Returns undefined when the
 * recorded transaction is provably dead and a new one should be sent.
 */
async function replayEvmRequest(
  c: Context<Env, string>,
  wallet: Wallet,
  request: EvmTransferRequest,
  record: IdempotencyRecord,
  from: `0x${string}`
) {
  const key = request.idempotencyKey as string;

  if (record.fingerprint !== request.fingerprint) {
    return c.json(
      {
        error: "Idempotency key was already used for a different transaction",
        txId: record.txId,
        retryable: false,
      },
      409
    );
  }

  if (record.status === "broadcast") {
    return c.json({ txId: record.txId, fee: record.fee, replayed: true }, 200);
  }

  const client = createEvmClient(request.config);
  let settlement;

  try {
    settlement = await settleEvmTransaction(client, record, from);
  } catch (error) {
    settlement = { status: "pending" as const, message: publicErrorMessage(error) };
  }

  if (settlement.status === "sent") {
    await markBroadcast(wallet, key, record.txId);
    return c.json({ txId: record.txId, fee: record.fee, replayed: true }, 200);
  }

  if (settlement.status === "dead") {
    return undefined;
  }

  return c.json(
    {
      error:
        "Transaction for this idempotency key is not confirmed yet. Retry later with the same Idempotency-Key.",
      txId: record.txId,
      retryable: true,
      details: { message: settlement.message },
    },
    503
  );
}

function evmBroadcastFailure(
  c: Context<Env, string>,
  outcome: Exclude<EvmBroadcastOutcome, { status: "accepted" }>,
  txId: string,
  idempotencyKey?: string
) {
  if (outcome.status === "rejected") {
    return c.json(
      {
        error: "Failed to broadcast transaction",
        txId,
        retryable: !EVM_DETERMINISTIC_REJECTIONS.has(outcome.code),
        details: { code: outcome.code, message: outcome.message },
      },
      outcome.code === "RATE_LIMITED" ? 503 : 502
    );
  }

  // The transaction may already be in the pool or on-chain. Only a retry with
  // the same idempotency key is safe: it resends this exact transaction.
  return c.json(
    {
      error: "Broadcast outcome unknown",
      txId,
      retryable: Boolean(idempotencyKey),
      details: { message: outcome.message },
    },
    502
  );
}

async function sendNewEvmTransaction(
  c: Context<Env, string>,
  wallet: Wallet,
  request: EvmTransferRequest,
  replaceTxId?: string
) {
  const { path, body, config, idempotencyKey, fingerprint } = request;
  const registryParams = { network: config.key, path };
  const client = createEvmClient(config);

  const { address } = await wallet.registry().getAddress(registryParams);
  const senderAddress = address as `0x${string}`;
  const nativeBalance = BigInt(
    (await wallet.registry().getBalance(registryParams)).value
  );
  const amountWei = body.contractAddress
    ? 0n
    : BigInt(toBaseUnits(body.amount, config.nativeDecimals));

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
    const tokenInfo = await getErc20TokenInfo(
      client,
      config.chainId,
      body.contractAddress
    );
    const requiredTokenAmount = BigInt(
      toBaseUnits(body.amount, tokenInfo.decimals)
    );
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

  const fee = body.gasFree ? "0" : feeQuote?.totalFeeNative;

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

  let signed;

  try {
    signed = await wallet.signer().signEvm({
      path,
      transaction: txBuilder.transaction,
      idempotency: idempotencyKey
        ? { key: idempotencyKey, fingerprint, fee, replaceTxId }
        : undefined,
    });
  } catch (error) {
    if (idempotencyKey && error instanceof DOCallError && error.status === 409) {
      const { record } = await wallet
        .signer()
        .getIdempotencyRecord({ key: idempotencyKey });

      if (record) {
        const replay = await replayEvmRequest(
          c,
          wallet,
          request,
          record,
          senderAddress
        );

        if (replay) {
          return replay;
        }
      }

      return c.json(
        {
          error: "Idempotency key is being used by another request. Retry later.",
          txId: record?.txId,
          retryable: true,
        },
        409
      );
    }

    throw error;
  }

  if (!signed.ok || !signed.rawTransaction || !signed.txId) {
    return c.json(
      {
        error: signed.error ?? "Failed to sign transaction",
      },
      400
    );
  }

  const txId = signed.txId;
  const outcome = await broadcastEvmRaw(
    client,
    signed.rawTransaction as `0x${string}`
  );

  if (outcome.status === "accepted") {
    if (idempotencyKey) {
      await markBroadcast(wallet, idempotencyKey, txId);
    }

    return c.json({ txId, fee }, 201);
  }


  return evmBroadcastFailure(c, outcome, txId, idempotencyKey);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

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

    const header = readIdempotencyKey(c);

    if (!header.ok) {
      return header.response;
    }

    if (family === "tron") {
      const body = await parseJsonBodyOr400(c, CreateTronTransactionBodySchema);

      if (!body.ok) {
        return body.response;
      }

      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const request: TronTransferRequest = {
        path: pathResolution.path,
        body: body.data,
        idempotencyKey: header.key,
        fingerprint: JSON.stringify([
          pathResolution.path,
          body.data.to,
          normalizeDecimalString(body.data.amount),
          body.data.contractAddress ?? null,
        ]),
      };

      if (header.key) {
        const { record } = await wallet
          .signer()
          .getIdempotencyRecord({ key: header.key });

        if (record) {
          const replay = await replayTronRequest(c, wallet, request, record);

          if (replay) {
            return replay;
          }

          // The recorded transaction expired without landing: send a new one,
          // replacing the record only if nobody else has done so meanwhile.
          return sendNewTronTransaction(c, wallet, request, record.txId);
        }
      }

      return sendNewTronTransaction(c, wallet, request);
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
          retryable: false,
        },
        400
      );
    }

    const { chainId, ...evmBody } = body.data;
    const wallet = createDOClient(c, config.key);
    const request: EvmTransferRequest = {
      path: pathResolution.path,
      body: evmBody,
      config,
      idempotencyKey: header.key,
      fingerprint: JSON.stringify([
        pathResolution.path,
        chainId,
        evmBody.to,
        normalizeDecimalString(evmBody.amount),
        evmBody.contractAddress ?? null,
      ]),
    };

    if (header.key) {
      const { record } = await wallet
        .signer()
        .getIdempotencyRecord({ key: header.key });

      if (record) {
        const registryParams = { network: config.key, path: request.path };
        const { address } = await wallet.registry().getAddress(registryParams);
        const replay = await replayEvmRequest(
          c,
          wallet,
          request,
          record,
          address as `0x${string}`
        );

        if (replay) {
          return replay;
        }

        // The recorded transaction's nonce was consumed by another transaction:
        // send a new one, replacing the record only if nobody else has.
        return sendNewEvmTransaction(c, wallet, request, record.txId);
      }
    }

    return sendNewEvmTransaction(c, wallet, request);
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
          retryable: false,
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

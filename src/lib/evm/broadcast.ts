import { TransactionReceiptNotFoundError, type PublicClient } from "viem";
import { errorMessage, isRateLimitError, publicErrorMessage } from "../errors";

/**
 * A payout is declared dead no sooner than this after signing: shields the
 * verdict from load-balanced nodes that lag behind finality right after the
 * broadcast (the TRON path keeps the same 5-minute margin).
 */
const EVM_DEAD_GRACE_MS = 5 * 60_000;

/** Only a definitive "this node cannot serve the tag" answer allows fallback. */
const UNSUPPORTED_BLOCK_TAG =
  /not support|unsupported|invalid (param|argument)|unknown block|cannot query/i;

/**
 * Outcome of one EVM broadcast attempt:
 * - accepted: the node took the transaction (or already has it in its pool).
 * - rejected: this attempt did not put it into any node's pool.
 * - unknown:  it may or may not have reached the network.
 */
export type EvmBroadcastOutcome =
  | { status: "accepted" }
  | { status: "rejected"; code: string; message: string }
  | { status: "unknown"; code?: string; message: string };

/** The pool already holds these exact bytes: a resend proves acceptance. */
const ALREADY_KNOWN =
  /already known|already exists|known transaction|AlreadyKnown|transaction is in mempool/i;

/**
 * A transaction with this nonce has been mined — possibly ours. Only a receipt
 * lookup can tell, so the outcome is unknown, never a plain rejection.
 */
const NONCE_TOO_LOW = /nonce too low|nonce is too low|OldNonce|tx already in chain/i;

/**
 * Another transaction occupies the nonce in the pool. Ours may be that very
 * transaction (then a resend races itself) or may have been displaced, so the
 * outcome is unknown and settlement must decide by receipt/nonce.
 */
const SAME_NONCE_PENDING = /replacement transaction underpriced|already imported|future transaction tries to replace pending/i;

/** Rejections that repeat identically on every retry of the same bytes. */
const DETERMINISTIC = [
  { pattern: /intrinsic gas too low/i, code: "INTRINSIC_GAS_TOO_LOW" },
  { pattern: /exceeds block gas limit|gas limit reached/i, code: "GAS_LIMIT" },
  { pattern: /oversized data|max initcode size/i, code: "OVERSIZED" },
  { pattern: /invalid sender|invalid signature|invalid chain id/i, code: "INVALID" },
  { pattern: /transaction type not supported/i, code: "UNSUPPORTED_TYPE" },
] as const;

/** Rejections that a later retry of the same bytes may get past. */
const TRANSIENT = [
  { pattern: /insufficient funds/i, code: "INSUFFICIENT_FUNDS" },
  { pattern: /fee cap less than block base fee|max fee per gas less than block base fee|underpriced/i, code: "UNDERPRICED" },
  { pattern: /txpool is full|pool limit/i, code: "POOL_FULL" },
] as const;

export const EVM_DETERMINISTIC_REJECTIONS = new Set<string>(
  DETERMINISTIC.map((entry) => entry.code)
);

/**
 * Broadcasts raw signed bytes and classifies the node's answer. Resending the
 * same bytes is always safe: the transaction hash is derived from them, so the
 * network can hold at most one copy.
 */
export async function broadcastEvmRaw(
  client: PublicClient,
  rawTransaction: `0x${string}`
): Promise<EvmBroadcastOutcome> {
  try {
    await client.sendRawTransaction({ serializedTransaction: rawTransaction });
    return { status: "accepted" };
  } catch (error) {
    const message = errorMessage(error);

    if (ALREADY_KNOWN.test(message)) {
      return { status: "accepted" };
    }

    if (NONCE_TOO_LOW.test(message) || SAME_NONCE_PENDING.test(message)) {
      return { status: "unknown", message: publicErrorMessage(error) };
    }

    for (const entry of DETERMINISTIC) {
      if (entry.pattern.test(message)) {
        return {
          status: "rejected",
          code: entry.code,
          message: publicErrorMessage(error),
        };
      }
    }

    for (const entry of TRANSIENT) {
      if (entry.pattern.test(message)) {
        return {
          status: "rejected",
          code: entry.code,
          message: publicErrorMessage(error),
        };
      }
    }

    if (isRateLimitError(error)) {
      // The gateway never forwarded the request, so no node saw it.
      return {
        status: "rejected",
        code: "RATE_LIMITED",
        message: publicErrorMessage(error),
      };
    }

    // Timeout, dropped connection, gateway error page: it may have landed.
    return { status: "unknown", message: publicErrorMessage(error) };
  }
}

/**
 * Whether the transaction is mined. Only viem's structural "receipt not
 * found" counts as absence; transport or gateway failures propagate so the
 * caller answers "pending" instead of reading them as a death certificate.
 */
async function hasReceipt(
  client: PublicClient,
  txId: `0x${string}`
): Promise<boolean> {
  try {
    const receipt = await client.getTransactionReceipt({ hash: txId });
    return receipt !== null && typeof receipt.blockNumber === "bigint";
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return false;
    }

    throw error;
  }
}

/**
 * The account's transaction count at the strongest finality the chain offers:
 * once it passes a stored transaction's nonce, that nonce slot is irreversibly
 * settled by SOME transaction.
 */
async function finalizedNonce(
  client: PublicClient,
  address: `0x${string}`
): Promise<number> {
  try {
    return await client.getTransactionCount({ address, blockTag: "finalized" });
  } catch (error) {
    // Falling back on a transient failure would base a death verdict on
    // reorg-able data; only a chain that genuinely lacks the tag may degrade.
    if (UNSUPPORTED_BLOCK_TAG.test(errorMessage(error))) {
      return client.getTransactionCount({ address, blockTag: "latest" });
    }

    throw error;
  }
}

export type EvmSettlement =
  | { status: "sent" }
  | { status: "dead" }
  | { status: "pending"; message: string };

/**
 * Decides what happened to a signed EVM transaction whose broadcast was never
 * confirmed. Unlike TRON, a signed EVM transaction never expires: it is dead
 * only once its nonce slot has been irreversibly taken by a different
 * transaction. Until then the same bytes are resent — never a new transaction.
 */
export async function settleEvmTransaction(
  client: PublicClient,
  record: { txId: string; signedTx?: unknown; nonce?: number; createdAt?: number },
  from: `0x${string}`
): Promise<EvmSettlement> {
  const txId = record.txId as `0x${string}`;

  if (await hasReceipt(client, txId)) {
    return { status: "sent" };
  }

  if (typeof record.signedTx === "string") {
    const outcome = await broadcastEvmRaw(
      client,
      record.signedTx as `0x${string}`
    );

    if (outcome.status === "accepted") {
      return { status: "sent" };
    }
  }

  if (typeof record.nonce !== "number") {
    return {
      status: "pending",
      message: "Transaction is not confirmed yet",
    };
  }

  const settledNonce = await finalizedNonce(client, from);

  if (settledNonce <= record.nonce) {
    return {
      status: "pending",
      message: "Transaction is not confirmed yet and its nonce is still open",
    };
  }

  // The nonce slot is finalized by some transaction. Hold the death verdict
  // through a grace window so one stale load-balanced read cannot bury a
  // payout that mined moments ago.
  if (
    typeof record.createdAt === "number" &&
    Date.now() - record.createdAt < EVM_DEAD_GRACE_MS
  ) {
    return {
      status: "pending",
      message:
        "Nonce was finalized recently; waiting before treating the transaction as not sent",
    };
  }

  // Look once more before declaring the payout dead: the receipt may have
  // appeared between the two checks.
  if (await hasReceipt(client, txId)) {
    return { status: "sent" };
  }

  return { status: "dead" };
}

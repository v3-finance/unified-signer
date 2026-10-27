import { z } from "zod";
import { errorMessage, isRateLimitError } from "../errors";
import { type TronGridEnv, tronGridFetch } from "./client";

const BroadcastResponseSchema = z.object({
  result: z.boolean().optional(),
  txid: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  Error: z.string().optional(),
});

/**
 * Outcome of one broadcast attempt:
 * - accepted: the node took the transaction (or already has it).
 * - rejected: this attempt did not put it into any node's pool.
 * - unknown:  it may or may not have reached the network.
 */
export type BroadcastOutcome =
  | { status: "accepted" }
  | { status: "rejected"; code: string; message?: string; raw?: NodeResponse }
  | { status: "unknown"; code?: string; message: string; raw?: NodeResponse };

/** The node's own answer, passed through for clients that read it. */
export type NodeResponse = z.infer<typeof BroadcastResponseSchema>;

/**
 * java-tron (Wallet.broadcastTransaction) returns these before the transaction
 * enters the pending pool. Others, e.g. OTHER_ERROR or
 * NOT_ENOUGH_EFFECTIVE_CONNECTION "P2P broadcast failed.", can come after it.
 */
const PRE_POOL_CODES = new Set([
  "SIGERROR",
  "CONTRACT_VALIDATE_ERROR",
  "CONTRACT_EXE_ERROR",
  "BANDWITH_ERROR",
  "TAPOS_ERROR",
  "TOO_BIG_TRANSACTION_ERROR",
  "TRANSACTION_EXPIRATION_ERROR",
  "SERVER_BUSY",
  "NO_CONNECTION",
  "BLOCK_UNSOLIDIFIED",
  "NOT_ENOUGH_EFFECTIVE_CONNECTION",
]);

// TronGrid hex-encodes node error messages.
function decodeNodeMessage(message?: string): string | undefined {
  if (message && /^(?:[0-9a-f]{2})+$/i.test(message)) {
    return Buffer.from(message, "hex").toString("utf8");
  }

  return message;
}

function classifyNodeCode(raw: NodeResponse & { code: string }): BroadcastOutcome {
  const { code } = raw;
  const message = decodeNodeMessage(raw.message);

  // "Dup transaction." comes from the store check: the node already has it.
  // "Transaction already exists." comes from an optional txID cache that is
  // filled before validation, so it does not prove the transaction was valid.
  if (code === "DUP_TRANSACTION_ERROR") {
    return message?.startsWith("Dup transaction")
      ? { status: "accepted" }
      : { status: "unknown", code, message: message ?? code, raw };
  }

  const afterPool =
    code === "NOT_ENOUGH_EFFECTIVE_CONNECTION" && message?.includes("P2P broadcast failed");

  if (PRE_POOL_CODES.has(code) && !afterPool) {
    return { status: "rejected", code, message, raw };
  }

  return { status: "unknown", code, message: message ?? code, raw };
}

export async function broadcastTransaction(
  env: TronGridEnv,
  signedTx: unknown
): Promise<BroadcastOutcome> {
  let response: Response;

  try {
    response = await tronGridFetch(
      env,
      "/wallet/broadcasttransaction",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signedTx),
      },
      "broadcasttransaction"
    );
  } catch (error) {
    // Every attempt was rate limited at the gateway, so no node saw it.
    if (isRateLimitError(error)) {
      return { status: "rejected", code: "RATE_LIMITED", message: errorMessage(error) };
    }

    // Timeout or dropped connection: the request may have been processed.
    return { status: "unknown", message: errorMessage(error) };
  }

  const text = await response.text().catch(() => "");
  let parsed: z.infer<typeof BroadcastResponseSchema>;

  try {
    parsed = BroadcastResponseSchema.parse(JSON.parse(text));
  } catch {
    return {
      status: "unknown",
      message: `HTTP ${response.status}: ${text.slice(0, 300)}`,
    };
  }

  // Only a direct node answer is trustworthy; a gateway error page is not.
  if (response.status === 200) {
    if (parsed.result === true) {
      return { status: "accepted" };
    }

    if (parsed.code) {
      return classifyNodeCode({ ...parsed, code: parsed.code });
    }

    if (parsed.Error && isRateLimitError(parsed.Error)) {
      return { status: "rejected", code: "RATE_LIMITED", message: parsed.Error };
    }
  }

  return {
    status: "unknown",
    code: parsed.code,
    message: `HTTP ${response.status}: ${text.slice(0, 300)}`,
  };
}

async function postTronGrid(
  env: TronGridEnv,
  path: string,
  body: unknown,
  operation: string
): Promise<unknown> {
  const response = await tronGridFetch(
    env,
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    operation
  );

  if (!response.ok) {
    throw new Error(`TronGrid ${path} failed with status code ${response.status}`);
  }

  return response.json();
}

/**
 * Strict block-inclusion lookup on one node. gettransactioninfobyid only
 * knows transactions that are in a block (gettransactionbyid also returns
 * ones still waiting in that node's pending pool). True if included, false
 * only for the exact "{}" not-found answer. java-tron reports its own
 * failures as HTTP 200 {"Error": ...}, so anything else throws rather than
 * reading as "absent".
 */
async function lookupTransaction(
  env: TronGridEnv,
  path: string,
  txId: string
): Promise<boolean> {
  const payload = await postTronGrid(
    env,
    path,
    { value: txId },
    "gettransactioninfobyid"
  );

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const info = payload as { id?: unknown; blockNumber?: unknown };

    if (info.id === txId && typeof info.blockNumber === "number") {
      return true;
    }

    if (Object.keys(payload).length === 0) {
      return false;
    }
  }

  throw new Error(
    `Unexpected answer from ${path}: ${JSON.stringify(payload).slice(0, 200)}`
  );
}

/**
 * Whether a transaction is in a block: checks the full node (latest blocks),
 * then the solidity node. Throws when either answer is not conclusive.
 */
export async function isTransactionInBlock(
  env: TronGridEnv,
  txId: string
): Promise<boolean> {
  return (
    (await lookupTransaction(env, "/wallet/gettransactioninfobyid", txId)) ||
    (await lookupTransaction(env, "/walletsolidity/gettransactioninfobyid", txId))
  );
}

/** Timestamp of the latest solidified (irreversible) block. */
export async function getSolidifiedBlockTimestamp(env: TronGridEnv): Promise<number> {
  const payload = (await postTronGrid(
    env,
    "/walletsolidity/getblock",
    { detail: false },
    "solidity getblock"
  )) as { block_header?: { raw_data?: { timestamp?: unknown } } } | null;
  const timestamp = payload?.block_header?.raw_data?.timestamp;

  if (typeof timestamp !== "number") {
    throw new Error("TronGrid /walletsolidity/getblock returned no timestamp");
  }

  return timestamp;
}

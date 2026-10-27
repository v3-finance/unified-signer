import { DurableObject } from "cloudflare:workers";
import type { BIP32Interface } from "bip32";
import { keccak256 } from "viem";
import { createDerivationRoot } from "../lib/derivation";
import { doErrorResponse } from "../lib/errors";
import { deriveEvmPrivateKeyFromPath } from "../lib/evm/derivation";
import { signEvmTransaction } from "../lib/evm/sign";
import * as schemas from "../lib/schemas/do";
import { createTronWeb } from "../lib/tron/client";
import { deriveTronPrivateKeyFromPath } from "../lib/tron/derivation";
import { json } from "../lib/utils";

type SignerEnv = {
  mnemonic: string;
  TRONGRID_BASE_URL: string;
  TRONGRID_API_KEY?: string;
};

const IDEMPOTENCY_PREFIX = "idempotency:";

function idempotencyStorageKey(key: string): string {
  return `${IDEMPOTENCY_PREFIX}${key}`;
}

type IdempotencyClaim = NonNullable<schemas.TronTxSignRequest["idempotency"]>;

/** What a family-specific signer produces for one transaction. */
type SignedPayload = {
  /** Response body fields ({signedTx} for TRON, {rawTransaction} for EVM). */
  body: Record<string, unknown>;
  txId: string;
  /** What a retry must resend byte-identically. */
  storedTx: unknown;
  /** TRON only: raw_data.expiration. */
  expiresAt?: number;
  /** EVM only: the nonce the transaction occupies. */
  nonce?: number;
};

export class Signer extends DurableObject<SignerEnv> {
  private readonly tronWeb;
  private readonly root: BIP32Interface;

  constructor(ctx: DurableObjectState, env: SignerEnv) {
    super(ctx, env);
    this.root = createDerivationRoot(env.mnemonic);
    this.tronWeb = createTronWeb(env);
  }

  private async signTron(
    parsed: schemas.TronTxSignRequest
  ): Promise<SignedPayload> {
    const privateKey = deriveTronPrivateKeyFromPath(this.root, parsed.path);
    const transaction = parsed.transaction as Parameters<
      typeof this.tronWeb.trx.sign
    >[0];
    const signed = await this.tronWeb.trx.sign(transaction, privateKey);
    const txId = (signed as { txID?: string }).txID;
    const expiresAt = (signed as { raw_data?: { expiration?: unknown } }).raw_data
      ?.expiration;

    if (!txId) {
      throw new Error("Signed transaction has no txID");
    }

    return {
      body: { signedTx: signed },
      txId,
      storedTx: signed,
      expiresAt: typeof expiresAt === "number" ? expiresAt : undefined,
    };
  }

  private async signEvm(
    parsed: schemas.EvmTxSignRequest
  ): Promise<SignedPayload> {
    const privateKey = deriveEvmPrivateKeyFromPath(this.root, parsed.path);
    const rawTransaction = await signEvmTransaction(
      privateKey,
      parsed.transaction
    );

    return {
      body: { rawTransaction },
      txId: keccak256(rawTransaction),
      storedTx: rawTransaction,
      nonce: parsed.transaction.nonce,
    };
  }

  /**
   * Check, sign and store as one unit (under blockConcurrencyWhile) so no
   * other request can claim the key in between.
   */
  private async signIdempotent(
    idempotency: IdempotencyClaim,
    sign: () => Promise<SignedPayload>,
    requireExpiration: boolean
  ): Promise<Response> {
    const storageKey = idempotencyStorageKey(idempotency.key);
    const existing =
      await this.ctx.storage.get<schemas.IdempotencyRecord>(storageKey);
    const replacing =
      existing?.status === "signed" && existing.txId === idempotency.replaceTxId;

    if (existing && !replacing) {
      return json(
        {
          ok: false,
          error: "Idempotency key is already in use",
          txId: existing.txId,
          status: existing.status,
        },
        409
      );
    }

    const payload = await sign();

    if (requireExpiration && typeof payload.expiresAt !== "number") {
      throw new Error("Signed transaction has no expiration");
    }

    const record: schemas.IdempotencyRecord = {
      fingerprint: idempotency.fingerprint,
      txId: payload.txId,
      status: "signed",
      signedTx: payload.storedTx,
      expiresAt: payload.expiresAt,
      nonce: payload.nonce,
      fee: idempotency.fee,
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(storageKey, record);

    return json({ ok: true, ...payload.body, txId: payload.txId });
  }

  private async handleSign(
    idempotency: IdempotencyClaim | undefined,
    sign: () => Promise<SignedPayload>,
    requireExpiration: boolean
  ): Promise<Response> {
    if (idempotency) {
      // Errors are turned into responses inside: an exception escaping
      // blockConcurrencyWhile would reset the object.
      return this.ctx.blockConcurrencyWhile(async () => {
        try {
          return await this.signIdempotent(idempotency, sign, requireExpiration);
        } catch (error) {
          return doErrorResponse(error, 500);
        }
      });
    }

    const payload = await sign();
    return json({ ok: true, ...payload.body, txId: payload.txId });
  }

  private async getIdempotencyRecord(url: URL): Promise<Response> {
    const { key } = schemas.IdempotencyLookupQuerySchema.parse({
      key: url.searchParams.get("key"),
    });
    const record = await this.ctx.storage.get<schemas.IdempotencyRecord>(
      idempotencyStorageKey(key)
    );

    return json({ record: record ?? null });
  }

  private async markBroadcast(req: Request): Promise<Response> {
    const { key, txId } = schemas.IdempotencyBroadcastRequestSchema.parse(
      await req.json()
    );
    const storageKey = idempotencyStorageKey(key);
    const record =
      await this.ctx.storage.get<schemas.IdempotencyRecord>(storageKey);

    if (!record || record.txId !== txId) {
      return json({ ok: false }, 404);
    }

    const updated: schemas.IdempotencyRecord = {
      fingerprint: record.fingerprint,
      txId: record.txId,
      status: "broadcast",
      expiresAt: record.expiresAt,
      nonce: record.nonce,
      fee: record.fee,
      createdAt: record.createdAt,
    };
    await this.ctx.storage.put(storageKey, updated);

    return json({ ok: true });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (req.method === "POST" && url.pathname === "/sign") {
        const parsed = schemas.TronTxSignRequestSchema.parse(await req.json());
        return await this.handleSign(
          parsed.idempotency,
          () => this.signTron(parsed),
          true
        );
      }

      if (req.method === "POST" && url.pathname === "/evmSign") {
        const parsed = schemas.EvmTxSignRequestSchema.parse(await req.json());
        return await this.handleSign(
          parsed.idempotency,
          () => this.signEvm(parsed),
          false
        );
      }

      if (req.method === "GET" && url.pathname === "/idempotency") {
        return await this.getIdempotencyRecord(url);
      }

      if (req.method === "POST" && url.pathname === "/idempotency/broadcast") {
        return await this.markBroadcast(req);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return doErrorResponse(error, 500);
    }
  }
}

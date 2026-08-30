import { DurableObject } from "cloudflare:workers";
import type { BIP32Interface } from "bip32";
import { z } from "zod";
import { createDerivationRoot } from "../lib/derivation";
import { publicErrorMessage } from "../lib/errors";
import { deriveEvmPrivateKeyFromRoot } from "../lib/evm/derivation";
import { signEvmTransaction } from "../lib/evm/sign";
import * as schemas from "../lib/schemas/do";
import { createTronWeb } from "../lib/tron/client";
import { deriveTronPrivateKeyFromRoot } from "../lib/tron/derivation";
import { json } from "../lib/utils";

type SignerEnv = {
  mnemonic: string;
  TRONGRID_BASE_URL: string;
};

export class Signer extends DurableObject<SignerEnv> {
  private readonly tronWeb;
  private readonly root: BIP32Interface;

  constructor(ctx: DurableObjectState, env: SignerEnv) {
    super(ctx, env);
    this.root = createDerivationRoot(env.mnemonic);
    this.tronWeb = createTronWeb(env.TRONGRID_BASE_URL);
  }

  private async signTron(body: unknown): Promise<Response> {
    const parsed = schemas.TronTxSignRequestSchema.parse(body);
    const privateKey = deriveTronPrivateKeyFromRoot(this.root, parsed);
    const transaction = parsed.transaction as Parameters<
      typeof this.tronWeb.trx.sign
    >[0];
    const signed = await this.tronWeb.trx.sign(transaction, privateKey);

    const response = schemas.TronTxSignResponseSchema.parse({
      ok: true,
      signedTx: signed,
    });
    return json(response);
  }

  private async signEvm(body: unknown): Promise<Response> {
    const parsed = schemas.EvmTxSignRequestSchema.parse(body);
    const privateKey = deriveEvmPrivateKeyFromRoot(this.root, parsed);
    const rawTransaction = await signEvmTransaction(
      privateKey,
      parsed.transaction
    );

    const response = schemas.EvmTxSignResponseSchema.parse({
      ok: true,
      rawTransaction,
    });
    return json(response);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (req.method === "POST" && url.pathname === "/sign") {
        return await this.signTron(await req.json());
      }

      if (req.method === "POST" && url.pathname === "/evmSign") {
        return await this.signEvm(await req.json());
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

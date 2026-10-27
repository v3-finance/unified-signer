import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z, type ZodIssue } from "zod";
import type { Env } from "../env";
import {
  buildDerivationPath,
  type WalletDerivationParams,
} from "../lib/derivation";
import { TRON_NETWORK_KEY } from "../lib/networks";
import { createDOClient } from "../lib/orm";
import {
  LegacyBalanceQuerySchema,
  LegacyDerivationQuerySchema,
  LegacyHistoryQuerySchema,
  LegacyTransactionBodySchema,
  LegacyTransactionHeadersSchema,
  MonitorWalletRequestSchema,
  WebhookPayloadSchema,
  type LegacyTransactionBody,
} from "../lib/schemas/legacy";
import { calculateSchema } from "../lib/schemas/tron";
import { normalizeDecimalString } from "../lib/utils";
import {
  replayTronRequest,
  sendNewTronTransaction,
  type TronTransferRequest,
} from "./transaction";

/**
 * Byte-compatible API of the original cloud-tron-wallet service, so existing
 * clients keep working unchanged. Wallets are addressed by the legacy
 * five-field query scheme over the HARDENED tree
 * m/44'/195'/{appId}'/{purpose}/{asset}/{stage}/{index} — the tree every
 * previously issued deposit address lives on. These routes must be registered
 * BEFORE the global raw-path routes so the exact paths win.
 */

function legacyPath(params: WalletDerivationParams): string {
  return buildDerivationPath("tron", params);
}

/** Identifies the payout an idempotency key was first used for. */
function legacyFingerprint(
  params: WalletDerivationParams,
  body: LegacyTransactionBody
): string {
  return JSON.stringify([
    params.appId,
    params.purpose,
    params.asset,
    params.stage,
    params.index,
    body.to,
    normalizeDecimalString(body.amount),
    body.contractAddress ?? null,
  ]);
}

const MonitorClientSchema = z.object({
  ok: z.boolean(),
  client: z.object({
    id: z.string(),
    webhookUrl: z.string().optional(),
    addresses: z.array(z.string()),
  }),
});

function buildMonitorClientsUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/clients${path.startsWith("/") ? path : `/${path}`}`;
}

async function updateMonitoredWallet(
  clientsBaseUrl: string,
  apiKey: string,
  clientId: string,
  action: "add" | "remove",
  address: string
) {
  const response = await fetch(
    buildMonitorClientsUrl(clientsBaseUrl, `/${clientId}/addresses/${action}`),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ addresses: [address] }),
    }
  );

  const payload = MonitorClientSchema.parse(await response.json());

  if (!response.ok || !payload.ok) {
    throw new Error(`Monitoring service rejected wallet ${action} request`);
  }

  return {
    ok: payload.ok,
    receivers: payload.client.addresses,
  };
}

export function registerLegacyRoutes(app: Hono<Env>) {
  app.get(
    "/wallet/address",
    zValidator("query", LegacyDerivationQuerySchema),
    async (c) => {
      const params = c.req.valid("query");
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const { address } = await wallet.registry().getAddress({
        network: TRON_NETWORK_KEY,
        path: legacyPath(params),
      });
      return c.json({ address }, 200);
    }
  );

  app.get(
    "/wallet/balance",
    zValidator("query", LegacyBalanceQuerySchema),
    async (c) => {
      const params = c.req.valid("query");
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const { value } = await wallet.registry().getBalance({
        network: TRON_NETWORK_KEY,
        path: legacyPath(params),
        contractAddress: params.contractAddress,
      });

      return c.json(
        {
          asset: params.contractAddress ?? "TRX",
          value,
        },
        200
      );
    }
  );

  app.get(
    "/wallet/history",
    zValidator("query", LegacyHistoryQuerySchema),
    async (c) => {
      const params = c.req.valid("query");
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const history = await wallet.registry().getHistory({
        network: TRON_NETWORK_KEY,
        path: legacyPath(params),
        contractAddress: params.contractAddress,
      });
      return c.json(history, 200);
    }
  );

  app.post(
    "/transaction",
    zValidator("query", LegacyDerivationQuerySchema),
    zValidator("json", LegacyTransactionBodySchema),
    zValidator("header", LegacyTransactionHeadersSchema),
    async (c) => {
      const params = c.req.valid("query");
      const body = c.req.valid("json");
      const clientKey = c.req.valid("header")["idempotency-key"];
      // Keys are chosen per client app; scope them so apps cannot collide.
      const idempotencyKey = clientKey ? `${params.appId}:${clientKey}` : undefined;
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const request: TronTransferRequest = {
        path: legacyPath(params),
        body,
        idempotencyKey,
        fingerprint: legacyFingerprint(params, body),
        legacyFee: true,
      };

      if (idempotencyKey) {
        const { record } = await wallet
          .signer()
          .getIdempotencyRecord({ key: idempotencyKey });

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
  );

  app.post(
    "/calculate/fees",
    zValidator("json", calculateSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            success: false,
            error: {
              message: "Validation error",
              issues: result.error.issues.map((issue: ZodIssue) => ({
                field: issue.path.join("."),
                message: issue.message,
                code: issue.code,
              })),
            },
          },
          400
        );
      }
    }),
    async (c) => {
      const params = c.req.valid("json");
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const result = await wallet.calculator().calculate(params);
      return c.json(result, 200);
    }
  );

  const monitorEnv = (c: { env: Env["Bindings"] }) => {
    const baseUrl = c.env.MONITOR_CLIENTS_BASE_URL;
    const apiKey = c.env.MONITOR_API_KEY;

    if (!baseUrl || !apiKey) {
      return undefined;
    }

    return { baseUrl, apiKey };
  };

  app.post(
    "/monitor/:id/wallets",
    zValidator("json", MonitorWalletRequestSchema),
    async (c) => {
      const config = monitorEnv(c);

      if (!config) {
        return c.json({ error: "Monitoring is not configured" }, 503);
      }

      const { id } = c.req.param();
      const { address } = c.req.valid("json");
      const payload = await updateMonitoredWallet(
        config.baseUrl,
        config.apiKey,
        id,
        "add",
        address
      );
      return c.json(payload, 201);
    }
  );

  app.delete(
    "/monitor/:id/wallets",
    zValidator("json", MonitorWalletRequestSchema),
    async (c) => {
      const config = monitorEnv(c);

      if (!config) {
        return c.json({ error: "Monitoring is not configured" }, 503);
      }

      const { id } = c.req.param();
      const { address } = c.req.valid("json");
      const payload = await updateMonitoredWallet(
        config.baseUrl,
        config.apiKey,
        id,
        "remove",
        address
      );
      return c.json(payload, 200);
    }
  );

  app.get(
    "/monitor/:id/add/wallet",
    zValidator("query", MonitorWalletRequestSchema),
    async (c) => {
      const config = monitorEnv(c);

      if (!config) {
        return c.json({ error: "Monitoring is not configured" }, 503);
      }

      const { id } = c.req.param();
      const { address } = c.req.valid("query");
      const payload = await updateMonitoredWallet(
        config.baseUrl,
        config.apiKey,
        id,
        "add",
        address
      );
      return c.json(payload, 201);
    }
  );

  app.get(
    "/monitor/:id/remove/wallet",
    zValidator("query", MonitorWalletRequestSchema),
    async (c) => {
      const config = monitorEnv(c);

      if (!config) {
        return c.json({ error: "Monitoring is not configured" }, 503);
      }

      const { id } = c.req.param();
      const { address } = c.req.valid("query");
      const payload = await updateMonitoredWallet(
        config.baseUrl,
        config.apiKey,
        id,
        "remove",
        address
      );
      return c.json(payload, 200);
    }
  );

  app.post("/webhook", async (c) => {
    try {
      const payload = await c.req.json();
      const validated = WebhookPayloadSchema.parse(payload);

      return c.json(
        {
          ok: true,
          id: validated.id,
        },
        201
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(
          {
            ok: false,
            error: "Validation Error",
            details: error.issues,
          },
          400
        );
      }

      return c.json(
        {
          ok: false,
          error: "Webhook processing failed",
        },
        500
      );
    }
  });
}

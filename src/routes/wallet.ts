import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { Env } from "../env";
import { TRON_NETWORK_KEY } from "../lib/networks";
import { createDOClient } from "../lib/orm";
import {
  EvmWalletBalanceQuerySchema,
  TronWalletBalanceQuerySchema,
  WalletDerivationQuerySchema,
} from "../lib/schemas/shared";
import { resolveEvmNetworkParam } from "./network";
import { validationHook } from "./validation";

export function registerWalletRoutes(app: Hono<Env>) {
  // Tron routes are registered before the `:network` routes so the static
  // `/tron` prefix wins for Tron requests.
  app.get(
    "/tron/wallet/address",
    zValidator("query", WalletDerivationQuerySchema, validationHook),
    async (c) => {
      const params = c.req.valid("query");
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const response = await wallet.registry().getAddressByIndex({
        network: TRON_NETWORK_KEY,
        ...params,
      });
      return c.json(response, 200);
    }
  );

  app.get(
    "/tron/wallet/balance",
    zValidator("query", TronWalletBalanceQuerySchema, validationHook),
    async (c) => {
      const params = c.req.valid("query");
      const wallet = createDOClient(c, TRON_NETWORK_KEY);
      const { value } = await wallet.registry().getBalance({
        network: TRON_NETWORK_KEY,
        ...params,
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
    "/:network/wallet/address",
    zValidator("query", WalletDerivationQuerySchema, validationHook),
    async (c) => {
      const resolution = resolveEvmNetworkParam(c);

      if (!resolution.ok) {
        return resolution.response;
      }

      const params = c.req.valid("query");
      const wallet = createDOClient(c, resolution.config.key);
      const response = await wallet.registry().getAddressByIndex({
        network: resolution.config.key,
        ...params,
      });
      return c.json(response, 200);
    }
  );

  app.get(
    "/:network/wallet/balance",
    zValidator("query", EvmWalletBalanceQuerySchema, validationHook),
    async (c) => {
      const resolution = resolveEvmNetworkParam(c);

      if (!resolution.ok) {
        return resolution.response;
      }

      const params = c.req.valid("query");
      const wallet = createDOClient(c, resolution.config.key);
      const { value } = await wallet.registry().getBalance({
        network: resolution.config.key,
        ...params,
      });

      return c.json(
        {
          asset: params.contractAddress ?? resolution.config.nativeSymbol,
          value,
        },
        200
      );
    }
  );
}

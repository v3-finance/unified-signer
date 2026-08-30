import { zValidator } from "@hono/zod-validator";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { buildDerivationPath, inferFamilyFromPath } from "../lib/derivation";
import { parseEvmNetworks, TRON_NETWORK_KEY } from "../lib/networks";
import { createDOClient } from "../lib/orm";
import {
  EvmWalletBalanceQuerySchema,
  OptionalEvmContractAddressSchema,
  OptionalTronContractAddressSchema,
  TronWalletBalanceQuerySchema,
  WalletDerivationQuerySchema,
} from "../lib/schemas/shared";
import { extractRawDerivationPath } from "./derivation-path";
import { resolveEvmNetworkParam } from "./network";
import { validationHook } from "./validation";

const TronBalanceByPathQuerySchema = z.object({
  contractAddress: OptionalTronContractAddressSchema,
});

const EvmBalanceByPathQuerySchema = z.object({
  contractAddress: OptionalEvmContractAddressSchema,
});

async function respondAddress(
  c: Context<Env, string>,
  networkKey: string,
  path: string,
  includePath: boolean
): Promise<Response> {
  const wallet = createDOClient(c, networkKey);
  const { address } = await wallet.registry().getAddress({
    network: networkKey,
    path,
  });

  return c.json(includePath ? { address, path } : { address }, 200);
}

async function respondBalance(
  c: Context<Env, string>,
  networkKey: string,
  nativeAsset: string,
  path: string,
  contractAddress: string | undefined
): Promise<Response> {
  const wallet = createDOClient(c, networkKey);
  const { value } = await wallet.registry().getBalance({
    network: networkKey,
    path,
    contractAddress,
  });

  return c.json(
    {
      asset: contractAddress ?? nativeAsset,
      value,
    },
    200
  );
}

export function registerWalletRoutes(app: Hono<Env>) {
  // Global address lookup by raw derivation path. The chain family is
  // inferred from the BIP44 coin type (44/60/... -> EVM, 44/195/... -> tron);
  // the resulting EVM address is identical across all EVM networks.
  app.get("/wallet/address/*", async (c) => {
    const resolution = extractRawDerivationPath(c, "/wallet/address/");

    if (!resolution.ok) {
      return resolution.response;
    }

    const family = inferFamilyFromPath(resolution.path);

    if (!family) {
      return c.json(
        {
          error:
            "Cannot infer the network family from this path. Use a BIP44-shaped path (44/60/... or 44/195/...) or the network-scoped endpoint /{network}/wallet/address/<path>.",
          path: resolution.path,
        },
        400
      );
    }

    if (family === "tron") {
      return respondAddress(c, TRON_NETWORK_KEY, resolution.path, true);
    }

    const firstEvmNetwork = parseEvmNetworks(c.env.EVM_NETWORKS)[0];

    if (!firstEvmNetwork) {
      return c.json({ error: "No EVM networks are configured" }, 400);
    }

    return respondAddress(c, firstEvmNetwork.key, resolution.path, true);
  });

  // Tron routes are registered before the `:network` routes so the static
  // `/tron` prefix wins for Tron requests.
  app.get(
    "/tron/wallet/address",
    zValidator("query", WalletDerivationQuerySchema, validationHook),
    async (c) => {
      const params = c.req.valid("query");
      return respondAddress(
        c,
        TRON_NETWORK_KEY,
        buildDerivationPath("tron", params),
        false
      );
    }
  );

  app.get("/tron/wallet/address/*", async (c) => {
    const resolution = extractRawDerivationPath(
      c,
      "/tron/wallet/address/",
      "tron"
    );

    if (!resolution.ok) {
      return resolution.response;
    }

    return respondAddress(c, TRON_NETWORK_KEY, resolution.path, true);
  });

  app.get(
    "/tron/wallet/balance",
    zValidator("query", TronWalletBalanceQuerySchema, validationHook),
    async (c) => {
      const params = c.req.valid("query");
      return respondBalance(
        c,
        TRON_NETWORK_KEY,
        "TRX",
        buildDerivationPath("tron", params),
        params.contractAddress
      );
    }
  );

  app.get(
    "/tron/wallet/balance/*",
    zValidator("query", TronBalanceByPathQuerySchema, validationHook),
    async (c) => {
      const resolution = extractRawDerivationPath(
        c,
        "/tron/wallet/balance/",
        "tron"
      );

      if (!resolution.ok) {
        return resolution.response;
      }

      return respondBalance(
        c,
        TRON_NETWORK_KEY,
        "TRX",
        resolution.path,
        c.req.valid("query").contractAddress
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
      return respondAddress(
        c,
        resolution.config.key,
        buildDerivationPath("evm", params),
        false
      );
    }
  );

  app.get("/:network/wallet/address/*", async (c) => {
    const resolution = resolveEvmNetworkParam(c);

    if (!resolution.ok) {
      return resolution.response;
    }

    const pathResolution = extractRawDerivationPath(
      c,
      `/${resolution.config.key}/wallet/address/`,
      "evm"
    );

    if (!pathResolution.ok) {
      return pathResolution.response;
    }

    return respondAddress(
      c,
      resolution.config.key,
      pathResolution.path,
      true
    );
  });

  app.get(
    "/:network/wallet/balance",
    zValidator("query", EvmWalletBalanceQuerySchema, validationHook),
    async (c) => {
      const resolution = resolveEvmNetworkParam(c);

      if (!resolution.ok) {
        return resolution.response;
      }

      const params = c.req.valid("query");
      return respondBalance(
        c,
        resolution.config.key,
        resolution.config.nativeSymbol,
        buildDerivationPath("evm", params),
        params.contractAddress
      );
    }
  );

  app.get(
    "/:network/wallet/balance/*",
    zValidator("query", EvmBalanceByPathQuerySchema, validationHook),
    async (c) => {
      const resolution = resolveEvmNetworkParam(c);

      if (!resolution.ok) {
        return resolution.response;
      }

      const pathResolution = extractRawDerivationPath(
        c,
        `/${resolution.config.key}/wallet/balance/`,
        "evm"
      );

      if (!pathResolution.ok) {
        return pathResolution.response;
      }

      return respondBalance(
        c,
        resolution.config.key,
        resolution.config.nativeSymbol,
        pathResolution.path,
        c.req.valid("query").contractAddress
      );
    }
  );
}

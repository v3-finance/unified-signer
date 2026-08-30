import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { inferFamilyFromPath } from "../lib/derivation";
import {
  listEvmChainIds,
  parseEvmNetworks,
  resolveEvmNetworkByChainId,
  TRON_NETWORK_KEY,
} from "../lib/networks";
import { createDOClient } from "../lib/orm";
import {
  OptionalEvmContractAddressSchema,
  OptionalTronContractAddressSchema,
} from "../lib/schemas/shared";
import {
  extractRawDerivationPath,
  FAMILY_INFERENCE_HINT,
} from "./derivation-path";

const TronBalanceQuerySchema = z.object({
  contractAddress: OptionalTronContractAddressSchema,
});

const EvmBalanceQuerySchema = z.object({
  contractAddress: OptionalEvmContractAddressSchema,
});

async function respondAddress(
  c: Context<Env, string>,
  networkKey: string,
  path: string
): Promise<Response> {
  const wallet = createDOClient(c, networkKey);
  const { address } = await wallet.registry().getAddress({
    network: networkKey,
    path,
  });

  return c.json({ address, path }, 200);
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
  // Address by raw derivation path. The chain family is inferred from the
  // BIP44 coin type (44/60/... -> EVM, 44/195/... -> tron); the EVM address
  // is identical across all configured EVM networks.
  app.get("/wallet/address/*", async (c) => {
    const resolution = extractRawDerivationPath(c, "/wallet/address/");

    if (!resolution.ok) {
      return resolution.response;
    }

    const family = inferFamilyFromPath(resolution.path);

    if (!family) {
      return c.json(
        { error: FAMILY_INFERENCE_HINT, path: resolution.path },
        400
      );
    }

    if (family === "tron") {
      return respondAddress(c, TRON_NETWORK_KEY, resolution.path);
    }

    const firstEvmNetwork = parseEvmNetworks(c.env.EVM_NETWORKS)[0];

    if (!firstEvmNetwork) {
      return c.json({ error: "No EVM networks are configured" }, 400);
    }

    return respondAddress(c, firstEvmNetwork.key, resolution.path);
  });

  // Balance by raw path: family from the coin type; for EVM the network is
  // selected by the `chainId` query parameter.
  app.get("/wallet/balance/*", async (c) => {
    const resolution = extractRawDerivationPath(c, "/wallet/balance/");

    if (!resolution.ok) {
      return resolution.response;
    }

    const family = inferFamilyFromPath(resolution.path);

    if (!family) {
      return c.json(
        { error: FAMILY_INFERENCE_HINT, path: resolution.path },
        400
      );
    }

    if (family === "tron") {
      const query = TronBalanceQuerySchema.safeParse({
        contractAddress: c.req.query("contractAddress"),
      });

      if (!query.success) {
        return c.json(
          { error: "Validation Error", details: query.error.issues },
          400
        );
      }

      return respondBalance(
        c,
        TRON_NETWORK_KEY,
        "TRX",
        resolution.path,
        query.data.contractAddress
      );
    }

    const chainIdResult = z.coerce
      .number()
      .int()
      .positive()
      .safeParse(c.req.query("chainId"));

    if (!chainIdResult.success) {
      return c.json(
        {
          error:
            "The chainId query parameter is required for EVM balances",
          availableChainIds: listEvmChainIds(c.env.EVM_NETWORKS),
        },
        400
      );
    }

    const config = resolveEvmNetworkByChainId(
      chainIdResult.data,
      c.env.EVM_NETWORKS
    );

    if (!config) {
      return c.json(
        {
          error: `Unknown chainId ${chainIdResult.data}`,
          availableChainIds: listEvmChainIds(c.env.EVM_NETWORKS),
        },
        400
      );
    }

    const query = EvmBalanceQuerySchema.safeParse({
      contractAddress: c.req.query("contractAddress"),
    });

    if (!query.success) {
      return c.json(
        { error: "Validation Error", details: query.error.issues },
        400
      );
    }

    return respondBalance(
      c,
      config.key,
      config.nativeSymbol,
      resolution.path,
      query.data.contractAddress
    );
  });
}

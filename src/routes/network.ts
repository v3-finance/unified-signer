import type { Context } from "hono";
import type { Env } from "../env";
import {
  listNetworkKeys,
  resolveNetwork,
  type EvmNetworkConfig,
} from "../lib/networks";

export type EvmNetworkResolution =
  | { ok: true; config: EvmNetworkConfig }
  | { ok: false; response: Response };

// Tron is served by dedicated static routes, so the `:network` param routes
// only ever resolve EVM networks here.
export function resolveEvmNetworkParam(
  c: Context<Env, string>
): EvmNetworkResolution {
  const key = c.req.param("network");
  const network = key
    ? resolveNetwork(key, c.env.EVM_NETWORKS)
    : undefined;

  if (!network || network.family !== "evm") {
    return {
      ok: false,
      response: c.json(
        {
          error: `Unknown network "${key}"`,
          availableNetworks: listNetworkKeys(c.env.EVM_NETWORKS),
        },
        404
      ),
    };
  }

  return { ok: true, config: network.config };
}

import { providers, TronWeb } from "tronweb";
import { isRateLimitResponse, RateLimitError } from "../errors";
import { withTronGridRetry } from "./retry";

const DEFAULT_TRONGRID_BASE_URL = "https://api.trongrid.io";
const REQUEST_TIMEOUT_MS = 10_000;

export type TronGridEnv = {
  TRONGRID_BASE_URL?: string;
  TRONGRID_API_KEY?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function getTronGridBaseUrl(baseUrl = DEFAULT_TRONGRID_BASE_URL): string {
  return normalizeBaseUrl(baseUrl);
}

export function buildTronGridUrl(path: string, baseUrl?: string): string {
  return `${getTronGridBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getTronGridHeaders(apiKey?: string): Record<string, string> {
  const key = apiKey?.trim();
  return key ? { "TRON-PRO-API-KEY": key } : {};
}

export function createTronWeb(env: TronGridEnv, address?: string): TronWeb {
  // Headers go to the provider directly: TronWeb's own `headers` option
  // rebuilds the providers with a hardcoded 30 s timeout.
  const http = new providers.HttpProvider(
    getTronGridBaseUrl(env.TRONGRID_BASE_URL),
    REQUEST_TIMEOUT_MS,
    "",
    "",
    getTronGridHeaders(env.TRONGRID_API_KEY)
  );

  const tronweb = new TronWeb({
    fullNode: http,
    solidityNode: http,
    eventServer: http,
  });

  if (address) {
    tronweb.setAddress(address);
  }

  return tronweb;
}

/**
 * fetch() against TronGrid with the API key, a timeout, and retries while the
 * gateway rate limits us. A rate-limit rejection means the request was never
 * forwarded to a node, so retrying is safe even for broadcasts.
 */
export async function tronGridFetch(
  env: TronGridEnv,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  operation = path
): Promise<Response> {
  return withTronGridRetry(operation, async () => {
    const response = await fetch(buildTronGridUrl(path, env.TRONGRID_BASE_URL), {
      method: init.method,
      body: init.body,
      headers: { ...getTronGridHeaders(env.TRONGRID_API_KEY), ...init.headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 429 || response.status === 403) {
      const body = await response.clone().text().catch(() => "");

      if (isRateLimitResponse(response.status, body)) {
        throw new RateLimitError(
          response.status,
          `TronGrid ${operation} failed with status code ${response.status}: ${body.slice(0, 300)}`
        );
      }
    }

    return response;
  });
}

import { providers, TronWeb } from "tronweb";

const DEFAULT_TRONGRID_BASE_URL = "https://api.trongrid.io";
const REQUEST_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function getTronGridBaseUrl(baseUrl = DEFAULT_TRONGRID_BASE_URL): string {
  return normalizeBaseUrl(baseUrl);
}

export function buildTronGridUrl(path: string, baseUrl?: string): string {
  return `${getTronGridBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getTronGridBroadcastUrl(baseUrl?: string): string {
  return buildTronGridUrl("/wallet/broadcasttransaction", baseUrl);
}

export function createTronWeb(baseUrl?: string, address?: string): TronWeb {
  const http = new providers.HttpProvider(
    getTronGridBaseUrl(baseUrl),
    REQUEST_TIMEOUT_MS
  );

  const tronWeb = new TronWeb({
    fullNode: http,
    solidityNode: http,
    eventServer: http,
  });

  if (address) {
    tronWeb.setAddress(address);
  }

  return tronWeb;
}

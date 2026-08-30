const URL_PATTERN = /https?:\/\/\S+/g;

// Upstream client errors (viem, TronWeb) embed the full RPC endpoint in their
// messages; that URL may carry a provider API key and must never reach an API
// client.
export function publicErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
      : "Unknown error";
  const cleaned = raw.replace(URL_PATTERN, "[redacted-url]").trim();
  return cleaned || "Unknown error";
}

export class DOFailureError extends Error {
  constructor(
    readonly namespaceRoute: string,
    readonly status: number,
    readonly payload: unknown
  ) {
    super(
      `${namespaceRoute} failed with ${status}: ${
        typeof payload === "string" ? payload : JSON.stringify(payload)
      }`
    );
    this.name = "DOFailureError";
  }
}

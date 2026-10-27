import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/** Invalid input: retrying the same request will not help. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** The upstream gateway rejected the request because of rate limiting (HTTP 429/403). */
export class RateLimitError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Token metadata could not be read. Raised instead of guessing `decimals`,
 * because a wrong value scales every amount by a power of ten.
 */
export class TokenInfoUnavailableError extends Error {
  constructor(
    readonly contractAddress: string,
    cause: unknown
  ) {
    super(
      `Unable to read TRC20 token info for ${contractAddress}: ${errorMessage(cause)}`,
      { cause }
    );
    this.name = "TokenInfoUnavailableError";
  }
}

/** A Durable Object answered with a non-2xx status. */
export class DOCallError extends Error {
  constructor(
    readonly stage: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(
      `${stage} failed with ${status}: ${
        typeof body === "string" ? body : JSON.stringify(body)
      }`
    );
    this.name = "DOCallError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const { message, error: inner } = error as {
      message?: unknown;
      error?: unknown;
    };

    if (typeof message === "string") {
      return message;
    }

    if (typeof inner === "string") {
      return inner;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error";
    }
  }

  return "Unknown error";
}

const URL_PATTERN = /https?:\/\/\S+/g;

// Upstream client errors (viem, TronWeb) embed the full RPC endpoint in their
// messages; that URL may carry a provider API key and must never reach an API
// client.
export function publicErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? ((error as { shortMessage?: string }).shortMessage ?? error.message)
      : errorMessage(error);
  const cleaned = raw.replace(URL_PATTERN, "[redacted-url]").trim();
  return cleaned || "Unknown error";
}

const RATE_LIMIT_TEXT = /too many requests|allowed_rps|rate limit/i;

/** A 403 is only a rate limit when its body says so; otherwise it is a real denial. */
export function isRateLimitResponse(status: number, body: unknown): boolean {
  if (status === 429) {
    return true;
  }

  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return status === 403 && RATE_LIMIT_TEXT.test(text);
}

/**
 * Keyless TronGrid answers HTTP 429 `request rate exceeded the allowed_rps(3)`
 * and, under heavier bursts, HTTP 403 `Too Many Requests`. tronweb surfaces
 * these as AxiosErrors (with `response.status`) or as wrapped messages.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }

  const response = (error as { response?: { status?: unknown; data?: unknown } } | null)
    ?.response;

  if (typeof response?.status === "number" && isRateLimitResponse(response.status, response.data)) {
    return true;
  }

  const message = errorMessage(error);
  return /status code 429\b/.test(message) || RATE_LIMIT_TEXT.test(message);
}

function isRetryableUpstreamError(error: unknown): boolean {
  return error instanceof TokenInfoUnavailableError || isRateLimitError(error);
}

/** Error response for Durable Objects; the Worker maps the status back. */
export function doErrorResponse(error: unknown, fallbackStatus = 502): Response {
  if (error instanceof z.ZodError) {
    return Response.json(
      { ok: false, error: "Validation Error", details: error.issues },
      { status: 400 }
    );
  }

  if (error instanceof InputError) {
    return Response.json({ ok: false, error: error.message }, { status: 400 });
  }

  if (isRetryableUpstreamError(error)) {
    return Response.json(
      { ok: false, error: publicErrorMessage(error), retryable: true },
      { status: 503 }
    );
  }

  return Response.json(
    { ok: false, error: publicErrorMessage(error) },
    { status: fallbackStatus }
  );
}

function readString(value: unknown, key: string): string | undefined {
  if (value && typeof value === "object" && key in value) {
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : undefined;
  }

  return undefined;
}

/**
 * Worker-level error handler: always answers JSON and says which stage failed.
 * Nothing thrown here happened after a broadcast (post-broadcast code never
 * throws), so every 5xx is safe to retry.
 */
export function handleAppError(error: Error, c: Context) {
  if (error instanceof HTTPException) {
    return error.res
      ? error.getResponse()
      : c.json({ error: error.message, retryable: false }, error.status);
  }

  if (error instanceof InputError) {
    return c.json({ error: error.message, retryable: false }, 400);
  }

  console.error(error);

  if (error instanceof DOCallError) {
    const status = (
      [400, 409, 500, 503].includes(error.status) ? error.status : 502
    ) as 400 | 409 | 500 | 502 | 503;
    const details =
      error.body && typeof error.body === "object" && "details" in error.body
        ? (error.body as { details?: unknown }).details
        : undefined;

    return c.json(
      {
        error:
          readString(error.body, "error") ??
          (typeof error.body === "string" ? error.body : "Upstream service error"),
        stage: error.stage,
        retryable: status >= 500,
        ...(details === undefined ? {} : { details }),
      },
      status
    );
  }

  if (isRetryableUpstreamError(error)) {
    return c.json({ error: publicErrorMessage(error), retryable: true }, 503);
  }

  return c.json(
    {
      error: "Internal Server Error",
      message: publicErrorMessage(error),
      retryable: true,
    },
    500
  );
}

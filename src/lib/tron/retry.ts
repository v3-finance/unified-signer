import { isRateLimitError } from "../errors";

/**
 * Keyless TronGrid suspends a caller for 1-5 s after it exceeds ~3 req/s, so
 * the default schedule (1 s, 2 s, 4 s) outlasts one suspension. Mutable so
 * tests can shorten the delays.
 */
export const TRONGRID_RETRY = {
  attempts: 4,
  initialDelayMs: 1_000,
};

export type RetryOptions = {
  attempts?: number;
  initialDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
};

/** Retries a TronGrid call that was rejected by rate limiting. */
export async function withTronGridRetry<T>(
  operation: string,
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    attempts = TRONGRID_RETRY.attempts,
    initialDelayMs = TRONGRID_RETRY.initialDelayMs,
    shouldRetry = isRateLimitError,
  } = options;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = initialDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[TronGrid] ${operation} rate limited, retry ${attempt}/${attempts - 1} in ${delayMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

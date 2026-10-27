import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  doErrorResponse,
  InputError,
  isRateLimitError,
  RateLimitError,
  TokenInfoUnavailableError,
} from "./errors";
import { TRONGRID_RETRY, withTronGridRetry } from "./tron/retry";

describe("isRateLimitError", () => {
  test("recognises TronGrid throttling in its different shapes", () => {
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
    expect(
      isRateLimitError({
        response: { status: 403, data: "Too Many Requests - Rate Limit Exceeded" },
      })
    ).toBe(true);
    expect(
      isRateLimitError(new Error("AxiosError: Request failed with status code 429"))
    ).toBe(true);
    expect(
      isRateLimitError(
        new Error(
          "request rate exceeded the allowed_rps(3), and the query server is suspended for 5 s"
        )
      )
    ).toBe(true);
    expect(isRateLimitError(new RateLimitError(403, "Too Many Requests"))).toBe(true);
  });

  test("ignores unrelated failures", () => {
    expect(isRateLimitError(new Error("Invalid address provided"))).toBe(false);
    expect(isRateLimitError({ response: { status: 500 } })).toBe(false);
    // A 403 without rate-limit text is a real denial (e.g. key restrictions).
    expect(isRateLimitError({ response: { status: 403, data: "Forbidden" } })).toBe(false);
    expect(isRateLimitError(new Error("Request failed with status code 403"))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe("doErrorResponse", () => {
  test("maps error kinds to statuses", async () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    if (parsed.success) {
      throw new Error("expected a validation error");
    }
    const zodError = parsed.error;

    expect(doErrorResponse(zodError).status).toBe(400);
    expect(doErrorResponse(new InputError("bad amount")).status).toBe(400);
    expect(
      doErrorResponse(new TokenInfoUnavailableError("TX", new Error("boom"))).status
    ).toBe(503);
    expect(
      doErrorResponse(new Error("Request failed with status code 429")).status
    ).toBe(503);
    expect(doErrorResponse(new Error("boom")).status).toBe(502);
    expect(doErrorResponse(new Error("boom"), 500).status).toBe(500);

    const body = await doErrorResponse(new Error("status code 429")).json();
    expect(body).toMatchObject({ ok: false, retryable: true });
  });
});

describe("withTronGridRetry", () => {
  const originalDelay = TRONGRID_RETRY.initialDelayMs;
  TRONGRID_RETRY.initialDelayMs = 0;

  test("retries rate-limited calls until they succeed", async () => {
    let calls = 0;
    const result = await withTronGridRetry("op", async () => {
      calls += 1;
      if (calls < 3) {
        throw new RateLimitError(429, "status code 429");
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("gives up after the configured attempts with the original error", async () => {
    let calls = 0;
    const promise = withTronGridRetry("op", async () => {
      calls += 1;
      throw new RateLimitError(429, "status code 429");
    });

    await expect(promise).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(TRONGRID_RETRY.attempts);
  });

  test("does not retry other errors", async () => {
    let calls = 0;
    const promise = withTronGridRetry("op", async () => {
      calls += 1;
      throw new Error("Invalid address provided");
    });

    await expect(promise).rejects.toThrow("Invalid address provided");
    expect(calls).toBe(1);
    TRONGRID_RETRY.initialDelayMs = originalDelay;
  });
});

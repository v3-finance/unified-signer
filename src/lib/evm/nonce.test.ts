import { describe, expect, test } from "bun:test";
import { NONCE_RESERVATION_TTL_MS, nextNonce } from "./nonce";

const now = 1_700_000_000_000;

describe("nonce reservation", () => {
  test("uses the chain nonce when nothing is reserved", () => {
    expect(nextNonce(5, undefined, now)).toBe(5);
  });

  test("advances past a fresh reservation", () => {
    expect(nextNonce(5, { nonce: 5, reservedAt: now - 1_000 }, now)).toBe(6);
    expect(nextNonce(5, { nonce: 7, reservedAt: now - 1_000 }, now)).toBe(8);
  });

  test("never goes below the chain nonce", () => {
    expect(nextNonce(10, { nonce: 3, reservedAt: now - 1_000 }, now)).toBe(10);
  });

  test("ignores stale reservations to avoid nonce gaps", () => {
    expect(
      nextNonce(5, { nonce: 9, reservedAt: now - NONCE_RESERVATION_TTL_MS }, now)
    ).toBe(5);
  });
});

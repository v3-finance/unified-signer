import { describe, expect, test } from "bun:test";
import { nextNonce, STUCK_RESERVATION_MS } from "./nonce";

const now = 1_700_000_000_000;

describe("nonce reservation", () => {
  test("uses the chain nonce when nothing is reserved", () => {
    expect(nextNonce(5, undefined, now)).toBe(5);
  });

  test("advances past a reservation the chain has consumed", () => {
    expect(nextNonce(10, { nonce: 3, reservedAt: now - 1_000 }, now)).toBe(10);
  });

  test("queues behind a fresh reservation", () => {
    expect(nextNonce(5, { nonce: 5, reservedAt: now - 1_000 }, now)).toBe(6);
    expect(nextNonce(5, { nonce: 7, reservedAt: now - 1_000 }, now)).toBe(8);
  });

  test("never releases a slot by wall clock alone", () => {
    // The old TTL behavior would hand nonce 5 to a second payout while the
    // first one can still mine — a silent lost payment.
    expect(
      nextNonce(5, { nonce: 9, reservedAt: now - 10 * STUCK_RESERVATION_MS }, now)
    ).toBe(10);
  });

  test("reuses a stuck slot only when the address is provably settled", () => {
    const stale = { nonce: 9, reservedAt: now - STUCK_RESERVATION_MS };

    // pending != finalized: something may still be in flight.
    expect(nextNonce(5, stale, now, 4)).toBe(10);
    // No finalized count available: keep queueing.
    expect(nextNonce(5, stale, now)).toBe(10);
    // Stale AND pending == finalized: nothing is in flight anywhere.
    expect(nextNonce(5, stale, now, 5)).toBe(5);
    // Fresh reservation never resets even when settled.
    expect(nextNonce(5, { nonce: 9, reservedAt: now - 1_000 }, now, 5)).toBe(10);
  });
});

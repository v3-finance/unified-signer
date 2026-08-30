export type NonceReservation = {
  nonce: number;
  reservedAt: number;
};

// A reservation older than this is considered stale: either its transaction
// reached the mempool (and the chain's pending count has caught up), or it was
// never broadcast and holding the slot would create a nonce gap.
export const NONCE_RESERVATION_TTL_MS = 5 * 60_000;

export function nextNonce(
  chainPendingNonce: number,
  reservation: NonceReservation | undefined,
  now: number
): number {
  if (!reservation || now - reservation.reservedAt >= NONCE_RESERVATION_TTL_MS) {
    return chainPendingNonce;
  }

  return Math.max(chainPendingNonce, reservation.nonce + 1);
}

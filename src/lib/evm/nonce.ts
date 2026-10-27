export type NonceReservation = {
  nonce: number;
  reservedAt: number;
};

/**
 * A reservation queue with no visible progress is considered stuck after this
 * long — and even then a slot is reused only with proof that the address is
 * fully settled (pending count == finalized count), so a live, pooled or
 * recently acknowledged payout can never have its nonce handed to another
 * transaction.
 */
export const STUCK_RESERVATION_MS = 30 * 60_000;

/**
 * Picks the nonce for a new transaction. Reservations never expire by wall
 * clock alone: a signed payout stays valid indefinitely, so blindly releasing
 * its slot would let a later payout replace it in the pool. The queue advances
 * past a reservation only when the chain's pending count has consumed it, or
 * when the queue is stale AND the chain proves the address has nothing in
 * flight at any finality (pending == finalized).
 */
export function nextNonce(
  chainPendingNonce: number,
  reservation: NonceReservation | undefined,
  now: number,
  chainFinalizedNonce?: number
): number {
  if (!reservation || chainPendingNonce > reservation.nonce) {
    return chainPendingNonce;
  }

  const stale = now - reservation.reservedAt >= STUCK_RESERVATION_MS;
  const provablySettled =
    chainFinalizedNonce !== undefined &&
    chainFinalizedNonce === chainPendingNonce;

  if (stale && provablySettled) {
    return chainPendingNonce;
  }

  return reservation.nonce + 1;
}

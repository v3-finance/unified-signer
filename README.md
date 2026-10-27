# unified-signer

Cloudflare Workers API for deterministic wallet derivation, fee estimation, and transaction execution across TRON and EVM networks.

## What it does

- Derives TRON and EVM addresses from a single mnemonic by a raw derivation path in the URL.
- Reads native (TRX, ETH, BNB, ...) and token (TRC20 / ERC20) balances.
- Estimates transaction costs before sending: bandwidth/energy for TRON, gas for EVM.
- Builds, signs, and broadcasts transactions in every configured network.
- Exposes a compact OpenAPI document at `/doc` and a Markdown version at `/llms.txt`.

## API surface

Four endpoints plus docs. The wallet is addressed by a derivation path in the URL; the chain family comes from the path's coin type (`44/60/...` — EVM, `44/195/...` — TRON), and the concrete EVM network is selected by `chainId`:

```
GET  /wallet/address/{path}
GET  /wallet/balance/{path}?chainId=1[&contractAddress=...]
POST /transaction/{path}          # {"chainId": 1, ...} in the body for EVM
POST /calculate/fees/{path}       # `from` is derived from the path
GET  /  /doc  /llms.txt           # Scalar UI, OpenAPI JSON, Markdown docs
```

TRON paths need no `chainId`; an unknown `chainId` returns 400 with the configured `availableChainIds`.

## Derivation paths

All keys derive from one mnemonic by the path given in the URL:

- Paths are **always non-hardened**: segments are plain indexes, hardening markers (`h`/`'`) are rejected. `/44/60/0` derives `m/44/60/0`.
- 1-10 levels, indexes below 2^31; a leading `m` segment is optional; percent-encoded separators (`44%2F60%2F0`) are accepted.
- The first level must be `44` and the second the coin type: `60` (EVM) or `195` (TRON); anything else is rejected with 400.
- Deeper levels are your own structure, e.g. `/44/60/{purpose}/{userId}`.
- The EVM address is identical across all configured EVM networks for the same path.

## Networks

`EVM_NETWORKS` is a JSON array of network definitions:

```json
[
  {
    "key": "ethereum",
    "name": "Ethereum",
    "chainId": 1,
    "rpcUrl": "https://ethereum-rpc.publicnode.com",
    "nativeSymbol": "ETH",
    "nativeDecimals": 18,
    "feeType": "eip1559"
  }
]
```

`feeType` selects the fee mode: `eip1559` (`maxFeePerGas`/`maxPriorityFeePerGas`) or `legacy` (`gasPrice`). Networks configured as `eip1559` automatically fall back to legacy pricing when the chain reports no base fee.

The default configuration in `wrangler.jsonc` ships `ethereum` (1), `bsc` (56), `polygon` (137), and `base` (8453). Adding another EVM chain is a config-only change: append an entry to `EVM_NETWORKS` and redeploy — no code changes required. TRON runs via TronGrid (`TRONGRID_BASE_URL`).

## Architecture

- `Registry` Durable Object derives addresses and reads balances.
- `TxBuilder` Durable Object builds TRON and EVM transactions. EVM nonces come straight from the chain's pending count, like a regular wallet: fire payouts from one wallet sequentially — two truly concurrent sends may take the same nonce and one will replace the other.
- `Signer` Durable Object signs transactions directly from the mnemonic without exposing private keys.
- `GasCalculator` Durable Object estimates fees.
- Worker routes in `src/routes` provide the public HTTP API.

## Legacy compatibility API

The full API of the original cloud-tron-wallet service is served byte-compatibly for existing TRON clients: `GET /wallet/address|balance|history?appId&purpose&asset&stage&index`, `POST /transaction` (Idempotency-Key scoped by appId, numeric `fee`), `POST /calculate/fees` with an explicit `from`, the `/monitor/*` proxy routes (require `MONITOR_CLIENTS_BASE_URL` + `MONITOR_API_KEY`) and `POST /webhook`. These endpoints derive on the ORIGINAL hardened tree `m/44'/195'/{appId}'/{purpose}/{asset}/{stage}/{index}`, so every previously issued deposit address keeps working. The original service's own test suite runs unchanged against this layer.

## Payout safety

- **Idempotency**: send an `Idempotency-Key` header with every payout. A retry with the same key never sends a second transaction while the first can still land — the service re-broadcasts the same signed bytes, replays completed payouts as `200 {"txId", "fee", "replayed": true}`, answers `409` when a key is reused with different parameters, and `503 retryable: true` while the outcome is still unknown.
- **Broadcast classification**: node answers are classified accepted / rejected / unknown. Rejections carry `retryable` (`false` for deterministic failures such as a bad signature); unknown outcomes return the `txId` so the payout is never silently lost.
- **Settlement**: a TRON transaction is declared dead only after its expiration plus a 5-minute grace, with solidified blocks covering the inclusion window and no block containing it. An EVM transaction is declared dead only once its nonce is irreversibly consumed by a different transaction with no receipt for ours. Only then is a replacement signed, guarded by compare-and-swap on the stored record.
- **Unique txIDs**: equal TRON payouts built within one block are re-stamped so they never collapse into one transaction.
- Never auto-retry a `502` unless it says `retryable: true`. Without an `Idempotency-Key`, treat a `Broadcast outcome unknown` transaction as not sent only after checking its `txId` on-chain.

## Security notes

- The public API does not expose the mnemonic or raw private keys.
- Transactions are signed inside the `Signer` Durable Object.
- TRC20/ERC20 amount handling is decimal-aware; token decimals are read from the contract and read failures are never cached.
- Mixed-case EVM addresses are validated against the EIP-55 checksum.
- Authentication is expected to be enforced in front of the worker (Cloudflare Access).

## Development

```bash
bun install
bun run dev
```

## Quality checks

```bash
bun run typecheck
bun run test
bun run check
```

## Deploy

```bash
bun run deploy
```

## Worker types

```bash
bun run cf-typegen
```

## Required bindings

Set these bindings in your Worker environment:

- `baseUrl`: public deployment URL used in generated docs.
- `mnemonic`: seed phrase used for deterministic wallet derivation.
- `TRONGRID_BASE_URL`: TronGrid base URL.
- `TRONGRID_API_KEY` (optional secret): TronGrid API key, sent as `TRON-PRO-API-KEY`; without it TronGrid limits the caller to ~3 req/s. Rate-limited calls are retried automatically either way.
- `EVM_NETWORKS`: JSON array of EVM network definitions (see above).
- Durable Objects: `TX_BUILDER`, `SIGNER`, `REGISTRY`, `GAS_CALCULATOR`.

Set the wallet mnemonic phrase as a Cloudflare secret:

```bash
wrangler secret put mnemonic
```

## API cookbook

`$BASE_URL` is your deployment URL. Responses shown are shapes, not live values.

### Addresses

```bash
# EVM address (identical across all EVM networks)
curl "$BASE_URL/wallet/address/44/60/0"
```

```bash
# TRON address
curl "$BASE_URL/wallet/address/44/195/0"
```

Response: `{"address": "0x...", "path": "m/44/60/0"}`.

### Balances

Returned in smallest units (SUN / wei / token base units), as strings.

```bash
# Native coin: TRON needs no chainId, EVM selects the network by chainId
curl "$BASE_URL/wallet/balance/44/195/0"
curl "$BASE_URL/wallet/balance/44/60/0?chainId=8453"
```

```bash
# Token (TRC20 / ERC20) — add contractAddress (the token contract differs per network)
curl "$BASE_URL/wallet/balance/44/195/0?contractAddress=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
curl "$BASE_URL/wallet/balance/44/60/0?chainId=1&contractAddress=0xdAC17F958D2ee523a2206206994597C13D831ec7"
```

Response: `{"asset": "TRX" | "ETH" | "<contract>", "value": "15000000"}`.

### Transactions

One endpoint; the body decides native vs token, `chainId` picks the EVM network. `amount` is always a decimal string in the asset's own units — token decimals are read from the contract. Success: `201 {"txId": "...", "fee": "0.000315"}` (`fee` is a decimal string in the native coin, `"0"` when `gasFree`).

```bash
# ETH on Base
curl -X POST "$BASE_URL/transaction/44/60/0" \
  -H "Content-Type: application/json" \
  -d '{"chainId": 8453, "to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "amount": "0.05"}'
```

```bash
# USDT on Ethereum
curl -X POST "$BASE_URL/transaction/44/60/0" \
  -H "Content-Type: application/json" \
  -d '{"chainId": 1, "to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "amount": "100.5", "contractAddress": "0xdAC17F958D2ee523a2206206994597C13D831ec7"}'
```

```bash
# TRX — no chainId
curl -X POST "$BASE_URL/transaction/44/195/0" \
  -H "Content-Type: application/json" \
  -d '{"to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "amount": "1.5"}'
```

```bash
# USDT payout with an idempotency key (recommended for every payout)
curl -X POST "$BASE_URL/transaction/44/195/0" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: payout-12345" \
  -d '{"to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "amount": "100.5", "contractAddress": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}'
```

Retrying with the same `Idempotency-Key` never sends a second transaction while the first one can still land; a completed payout replays as `200 {"txId", "fee", "replayed": true}`.

```bash
# USDT on TRON with delegated energy — skip the fee pre-check
curl -X POST "$BASE_URL/transaction/44/195/0" \
  -H "Content-Type: application/json" \
  -d '{"to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "amount": "100.5", "contractAddress": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "gasFree": true}'
```

### Fees (no broadcast)

`from` is derived from the path; the body carries only `to`, `amount`, optionally `contract`, and `chainId` for EVM.

```bash
curl -X POST "$BASE_URL/calculate/fees/44/195/0" \
  -H "Content-Type: application/json" \
  -d '{"to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "amount": "1.5"}'
```

```bash
curl -X POST "$BASE_URL/calculate/fees/44/60/0" \
  -H "Content-Type: application/json" \
  -d '{"chainId": 1, "to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "amount": "100", "contract": "0xdAC17F958D2ee523a2206206994597C13D831ec7"}'
```

Note: EVM fee estimation simulates the transfer via `estimateGas`, so the derived wallet must actually hold the transferred asset; otherwise the RPC revert is returned as a 400.

### Recipes

**Deposit address per user.** Dedicate a path level to the purpose and use the user id as the last index — addresses are deterministic, no address database needed: `GET /wallet/address/44/195/1/<userId>`.

**Send the whole balance.** Fees are paid on top of `amount`:

- EVM native: `amount = balance − totalFeeWei` (from `/calculate/fees`; equality is allowed, and `totalFeeWei` is a ceiling so some dust normally remains)
- TRON native: `amount = balance − fee − 1 SUN` (strict comparisons require 1 SUN of headroom)
- Tokens: send the full token balance as is — fees are paid in the native coin

**Fee preview before sending.** Call `/calculate/fees/{path}`, show the quote, then `POST /transaction/{path}`. The transaction endpoint re-checks everything itself, so the preview call is optional.

### Error reference

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error": "Validation Error", "details": [...]}` | Invalid body/query: addresses, checksum, missing chainId field |
| 400 | `{"error": "Unknown chainId ...", "availableChainIds": [...]}` | chainId does not match any configured EVM network |
| 400 | `{"error": "Invalid path segment ..."}` | Malformed derivation path (non-numeric segment, hardening marker, depth, range) |
| 400 | `{"error": "Cannot infer the network family ..."}` | Path does not start with 44/60 or 44/195 |
| 400 | `{"error": "Too many decimal places (max N)"}` | `amount` more precise than the asset's decimals |
| 400 | `{"error": "Insufficient ... balance", "shortfallSun"/"shortfallWei"/"shortfall"}` | Not enough native coin or token |
| 400 | `{"error": "Insufficient ... to cover amount and fees", "feeSun"/"feeWei"}` | Amount fits, amount + fee does not |
| 400 | `{"error": "Unable to read token contract", "message"}` | `contractAddress` is not a readable token |
| 400/502 | `{"error", "stage", "retryable"[, "details"]}` | A pipeline stage failed (Registry/TxBuilder/Signer/GasCalculator); `stage` names it, `retryable` says whether to retry |
| 409 | `{"error": "Idempotency key ...", "txId", "retryable"}` | Key reused with different parameters, or in use by a concurrent request |
| 502 | `{"error": "Failed to broadcast transaction", "txId", "retryable", "details"}` | The node rejected the transaction; `retryable: false` means a deterministic failure |
| 502 | `{"error": "Broadcast outcome unknown", "txId", "retryable", "details"}` | The transaction may be on-chain: retry only with the same `Idempotency-Key` |
| 503 | `{"error": "... not confirmed yet ...", "txId", "retryable": true}` | Payout for this key is in flight; retry later with the same key |
| 503 | `{"error": "Failed to broadcast transaction", "details": {"code": "RATE_LIMITED"}}` | The gateway rate-limited the broadcast before any node saw it — safe to retry |
| 500 | `{"error": "Internal Server Error", "message", "retryable": true}` | Unexpected pre-sign failure — safe to retry; details in worker logs |

# unified-signer

Cloudflare Workers API for deterministic wallet derivation, fee estimation, and transaction execution across TRON and EVM networks.

## What it does

- Derives TRON and EVM addresses from a single mnemonic using a fixed HD path per chain family.
- Reads native (TRX, ETH, BNB, ...) and token (TRC20 / ERC20) balances.
- Estimates transaction costs before sending: bandwidth/energy for TRON, gas for EVM.
- Builds, signs, and broadcasts transactions in every configured network.
- Exposes a compact OpenAPI document at `/doc` and a Markdown version at `/llms.txt`.

## Networks

The network is selected by the first path segment: `/{network}/...`.

- `tron` — the TRON network via TronGrid.
- Any other key — an EVM network from the `EVM_NETWORKS` configuration.

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

The default configuration in `wrangler.jsonc` ships `ethereum`, `bsc`, `polygon`, and `base`. Adding another EVM chain is a config-only change: append an entry to `EVM_NETWORKS` and redeploy — no code changes required.

## Derivation

All networks share one HD tree derived from one mnemonic:

```
TRON: m/44'/195'/{appId}'/{purpose}/{asset}/{stage}/{index}
EVM:  m/44'/60'/{appId}'/{purpose}/{asset}/{stage}/{index}
```

The EVM address is identical across all configured EVM networks for the same derivation tuple.

### Raw derivation paths

Every endpoint also accepts a raw derivation path directly in the URL, as an alternative to the `appId/purpose/asset/stage/index` parameters:

```
GET  /wallet/address/44/60/0               # family inferred from the coin type
GET  /{network}/wallet/address/44/60/0
GET  /{network}/wallet/balance/44/60/0?contractAddress=...
POST /{network}/transaction/44/60/0
POST /{network}/calculate/fees/44/60/0     # `from` is derived from the path
```

Raw paths are always non-hardened: segments are plain indexes, hardening markers (`h`/`'`) are not supported and rejected. `/44/60/0` derives `m/44/60/0` (not BIP44's hardened `m/44'/60'/0'`). Paths are 1-10 levels deep with indexes below 2^31; a leading `m` segment is optional, and percent-encoded separators (`44%2F60%2F0`) are accepted. On BIP44-shaped paths (first level 44) any coin type that differs from the network family is rejected with 400 (`44/195/...` or `44/0/...` on EVM endpoints, and vice versa).

## Architecture

- `Registry` Durable Object derives addresses and reads balances.
- `TxBuilder` Durable Object builds TRON and EVM transactions.
- `Signer` Durable Object signs transactions directly from the mnemonic without exposing private keys.
- `GasCalculator` Durable Object estimates fees.
- Worker routes in `src/routes` provide the public HTTP API.

## Security notes

- The public API does not expose the mnemonic or raw private keys.
- Transactions are signed inside the `Signer` Durable Object.
- TRC20/ERC20 amount handling is decimal-aware; token decimals are read from the contract.
- Mixed-case EVM addresses are validated against the EIP-55 checksum.

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
- `EVM_NETWORKS`: JSON array of EVM network definitions (see above).
- Durable Objects: `TX_BUILDER`, `SIGNER`, `REGISTRY`, `GAS_CALCULATOR`.

Set the wallet mnemonic phrase as a Cloudflare secret:

```bash
wrangler secret put mnemonic
```

## API cookbook

Every request variant, grouped by task. `$BASE_URL` is your deployment URL. Two addressing schemes exist everywhere: derivation query parameters (hardened tree) and raw non-hardened paths — see [Derivation](#derivation). Responses shown are shapes, not live values.

### Addresses

```bash
# By derivation parameters (hardened tree m/44'/coin'/appId'/purpose/asset/stage/index)
curl "$BASE_URL/tron/wallet/address?appId=0&purpose=0&asset=0&stage=0&index=0"
curl "$BASE_URL/ethereum/wallet/address?appId=0&purpose=0&asset=0&stage=0&index=0"
```

```bash
# By raw path (non-hardened), network-scoped
curl "$BASE_URL/tron/wallet/address/44/195/0"
curl "$BASE_URL/base/wallet/address/44/60/0"
```

```bash
# By raw path, no network: the family is inferred from the coin type (60 = EVM, 195 = TRON)
curl "$BASE_URL/wallet/address/44/60/0"
```

Responses: `{"address": "..."}` for the query scheme, `{"address": "...", "path": "m/44/60/0"}` for path endpoints. The EVM address is identical across all EVM networks for the same path/tuple.

### Balances

Returned in smallest units (SUN / wei / token base units), as strings.

```bash
# Native coin
curl "$BASE_URL/tron/wallet/balance?appId=0&purpose=0&asset=0&stage=0&index=0"
curl "$BASE_URL/ethereum/wallet/balance?appId=0&purpose=0&asset=0&stage=0&index=0"
```

```bash
# Token (TRC20 / ERC20) — add contractAddress
curl "$BASE_URL/tron/wallet/balance?appId=0&purpose=0&asset=0&stage=0&index=0&contractAddress=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
curl "$BASE_URL/ethereum/wallet/balance?appId=0&purpose=0&asset=0&stage=0&index=0&contractAddress=0xdAC17F958D2ee523a2206206994597C13D831ec7"
```

```bash
# Same by raw path
curl "$BASE_URL/base/wallet/balance/44/60/0"
curl "$BASE_URL/base/wallet/balance/44/60/0?contractAddress=0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"
```

Response: `{"asset": "TRX" | "ETH" | "<contract>", "value": "15000000"}`.

### Transactions

One endpoint per network; the body decides native vs token. `amount` is always a decimal string in the asset's own units — token decimals are read from the contract. Success: `201 {"txId": "...", "fee": "0.000315"}` (`fee` is a decimal string in the native coin, `"0"` when `gasFree`).

```bash
# Native transfers
curl -X POST "$BASE_URL/tron/transaction?appId=0&purpose=0&asset=0&stage=0&index=0" \
  -H "Content-Type: application/json" \
  -d '{"to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "amount": "1.5"}'
```

```bash
curl -X POST "$BASE_URL/ethereum/transaction?appId=0&purpose=0&asset=0&stage=0&index=0" \
  -H "Content-Type: application/json" \
  -d '{"to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "amount": "0.05"}'
```

```bash
# Token transfers — the token contract differs per network (USDT shown)
curl -X POST "$BASE_URL/tron/transaction?appId=0&purpose=0&asset=0&stage=0&index=0" \
  -H "Content-Type: application/json" \
  -d '{"to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "amount": "100.5", "contractAddress": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"}'
```

```bash
curl -X POST "$BASE_URL/base/transaction?appId=0&purpose=0&asset=0&stage=0&index=0" \
  -H "Content-Type: application/json" \
  -d '{"to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "amount": "100.5", "contractAddress": "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"}'
```

```bash
# Skip the fee pre-check (delegated TRON energy/bandwidth, or you accept the gas risk)
curl -X POST "$BASE_URL/tron/transaction?appId=0&purpose=0&asset=0&stage=0&index=0" \
  -H "Content-Type: application/json" \
  -d '{"to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "amount": "100.5", "contractAddress": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "gasFree": true}'
```

```bash
# By raw path — same bodies, wallet addressed by the URL
curl -X POST "$BASE_URL/ethereum/transaction/44/60/0" \
  -H "Content-Type: application/json" \
  -d '{"to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "amount": "0.05"}'
```

### Fees (no broadcast)

```bash
# Explicit `from` in the body
curl -X POST "$BASE_URL/tron/calculate/fees" \
  -H "Content-Type: application/json" \
  -d '{"from": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "to": "TUdbkixK7zU4ua7YC2oNz6ujsfZxb98GFb", "amount": "1.5"}'
```

```bash
curl -X POST "$BASE_URL/ethereum/calculate/fees" \
  -H "Content-Type: application/json" \
  -d '{"from": "0xF977814e90dA44bFA03b6295A0616a897441aceC", "to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e", "amount": "0.05", "contract": "0xdAC17F958D2ee523a2206206994597C13D831ec7"}'
```

```bash
# `from` derived from the raw path; body has only to/amount/contract
curl -X POST "$BASE_URL/tron/calculate/fees/44/195/0" \
  -H "Content-Type: application/json" \
  -d '{"to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9", "amount": "1.5"}'
```

Note: EVM fee estimation simulates the transfer via `estimateGas`, so `from` must actually hold the transferred asset; otherwise the RPC revert is returned as a 400.

### Recipes

**Send the whole balance.** Fees are paid on top of `amount`:

- EVM native: `amount = balance − totalFeeWei` (from `/calculate/fees`; equality is allowed, and `totalFeeWei` is a ceiling so some dust normally remains)
- TRON native: `amount = balance − fee − 1 SUN` (strict comparisons require 1 SUN of headroom)
- Tokens: send the full token balance as is — fees are paid in the native coin

**Fee preview before sending.** Call `/calculate/fees`, show the quote, then `POST /transaction`. The transaction endpoint re-checks everything itself, so the preview call is optional.

**Deposit address per user.** Addresses are deterministic — no address database needed. Convention: `purpose=1` for deposits, `index` = user id: `GET /tron/wallet/address?appId=0&purpose=1&asset=0&stage=0&index=<userId>`.

### Error reference

| Status | Body | Meaning |
|---|---|---|
| 400 | `{"error": "Validation Error", "details": [...]}` | Invalid parameters, addresses, checksum |
| 400 | `{"success": false, "error": {"message", "issues"}}` | `/calculate/fees` body validation |
| 400 | `{"error": "Too many decimal places (max N)"}` | `amount` more precise than the asset's decimals |
| 400 | `{"error": "Insufficient ... balance", "shortfallSun"/"shortfallWei"/"shortfall"}` | Not enough native coin or token |
| 400 | `{"error": "Insufficient ... to cover amount and fees", "feeSun"/"feeWei"}` | Amount fits, amount + fee does not |
| 400 | `{"error": "Unable to read token contract", "message"}` | `contractAddress` is not a readable token |
| 400 | `{"error": "Invalid path segment ..."}` | Malformed raw derivation path |
| 400 | `{"error": "Derivation path coin type does not match ..."}` | BIP44 coin type contradicts the network family |
| 400 | `{"ok": false, "error": "..."}` | Build/sign/estimate rejected by the chain (bad base58, estimateGas revert, ...) |
| 404 | `{"error": "Unknown network ...", "availableNetworks": [...]}` | Unknown network key |
| 502 | `{"error": "Failed to broadcast transaction", "details"}` | The network refused the signed transaction |
| 500 | `{"error": "Internal Server Error"}` | Upstream RPC/TronGrid failure; details in worker logs |

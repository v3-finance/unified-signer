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

## API examples

Get a TRON address:

```bash
curl "$BASE_URL/tron/wallet/address?appId=0&purpose=0&asset=0&stage=0&index=0"
```

Get an Ethereum address (same tuple, EVM tree):

```bash
curl "$BASE_URL/ethereum/wallet/address?appId=0&purpose=0&asset=0&stage=0&index=0"
```

Get a TRX balance:

```bash
curl "$BASE_URL/tron/wallet/balance?appId=0&purpose=0&asset=0&stage=0&index=0"
```

Get a USDT (ERC20) balance:

```bash
curl "$BASE_URL/ethereum/wallet/balance?appId=0&purpose=0&asset=0&stage=0&index=0&contractAddress=0xdAC17F958D2ee523a2206206994597C13D831ec7"
```

Send TRX:

```bash
curl -X POST "$BASE_URL/tron/transaction?appId=0&purpose=0&asset=0&stage=0&index=0" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
    "amount": "1.5"
  }'
```

Send ETH:

```bash
curl -X POST "$BASE_URL/ethereum/transaction?appId=0&purpose=0&asset=0&stage=0&index=0" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    "amount": "0.05"
  }'
```

Estimate TRON fees:

```bash
curl -X POST "$BASE_URL/tron/calculate/fees" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
    "to": "TUdbkixK7zU4ua7YC2oNz6ujsfZxb98GFb",
    "amount": "1.5"
  }'
```

Estimate Ethereum fees:

```bash
curl -X POST "$BASE_URL/ethereum/calculate/fees" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "to": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    "amount": "0.05"
  }'
```

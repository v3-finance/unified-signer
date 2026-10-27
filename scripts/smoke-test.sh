#!/usr/bin/env bash
#
# Real-funds smoke test for unified-signer.
#
# Moves small amounts between two wallets of the SAME mnemonic (A -> B -> A),
# so only network fees are spent. Every send carries an Idempotency-Key tied
# to a persisted run id: re-running after a crash REPLAYS completed payouts
# instead of paying twice. Safe to re-run at any point.
#
# Requirements: bash, curl, jq, python3.
#
# Environment:
#   BASE_URL                     deployment URL (default: production)
#   CF_ACCESS_CLIENT_ID/SECRET   Cloudflare Access service token (recommended)
#   SMOKE_YES=1                  skip the interactive confirmation
#   SMOKE_SWEEP=1                sweep funds back from B to A at the end
#   SMOKE_I_UNDERSTAND_OPEN_API=1  allow running against an unauthenticated API
#
set -u

BASE_URL="${BASE_URL:-https://unified-signer.ezig.workers.dev}"
AUTH_ID="${CF_ACCESS_CLIENT_ID:-}"
AUTH_SECRET="${CF_ACCESS_CLIENT_SECRET:-}"

# Dedicated test wallets (never reuse client indexes).
IDX_A=777
IDX_B=778
LEGACY_A="appId=0&purpose=0&asset=0&stage=0&index=$IDX_A"
LEGACY_B="appId=0&purpose=0&asset=0&stage=0&index=$IDX_B"
EVM_PATH_A="44/60/$IDX_A"
EVM_PATH_B="44/60/$IDX_B"

CHAIN_ID="${SMOKE_CHAIN_ID:-8453}" # Base: cheapest fees
USDT_TRON="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
USDT_EVM="${SMOKE_USDT_EVM:-0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2}" # USDT on Base

# Amounts (decimal strings, in the asset's own units).
TRX_AMOUNT="${SMOKE_TRX_AMOUNT:-1}"
USDT_TRON_AMOUNT="${SMOKE_USDT_TRON_AMOUNT:-1}"
ETH_AMOUNT="${SMOKE_ETH_AMOUNT:-0.0001}"
USDT_EVM_AMOUNT="${SMOKE_USDT_EVM_AMOUNT:-1}"

# Funding requirements for wallet A (checked before anything is sent).
REQ_TRX_SUN=40000000        # 40 TRX: covers activation + USDT energy burn
REQ_USDT_TRON=2000000       # 2 USDT (6 decimals)
REQ_ETH_WEI=500000000000000 # 0.0005 ETH on Base
REQ_USDT_EVM=2000000        # 2 USDT (6 decimals)

# Delegated-energy mode: wallet A holds no TRX, its energy is delegated.
# Skips the TRX-transfer test, waives the TRX funding requirement and relies
# on free bandwidth + delegated energy for the USDT send (fee quote must show
# needsToBurn == 0). The TRON sweep is skipped: B stays unactivated.
TRON_DELEGATED="${SMOKE_TRON_DELEGATED:-0}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0
FAIL=0
TXLOG="$TMP/txlog"
: > "$TXLOG"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
die()  { printf '\n\033[31mSTOP:\033[0m %s\n' "$*"; exit 1; }
info() { printf '  · %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || die "requires '$1' (brew install $1)"; }
need curl; need jq; need python3

# Persisted run id: a re-run replays instead of double-paying.
RUN_FILE="${SMOKE_RUN_FILE:-$HOME/.unified-signer-smoke-run}"
if [ -f "$RUN_FILE" ]; then
  RUN_ID="$(cat "$RUN_FILE")"
  info_reused=1
else
  RUN_ID="smoke-$(date +%Y%m%d-%H%M%S)"
  printf '%s' "$RUN_ID" > "$RUN_FILE"
  info_reused=0
fi

# api METHOD PATH [JSON_BODY] [IDEMPOTENCY_KEY] -> RESP_CODE, RESP_BODY
api() {
  local method=$1 path=$2 data=${3:-} key=${4:-}
  local args=(-sS -m 90 -X "$method" "$BASE_URL$path" -o "$TMP/resp.json" -w '%{http_code}')
  if [ -n "$AUTH_ID" ]; then
    args+=(-H "CF-Access-Client-Id: $AUTH_ID" -H "CF-Access-Client-Secret: $AUTH_SECRET")
  fi
  if [ -n "$data" ]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  if [ -n "$key" ]; then
    args+=(-H "Idempotency-Key: $key")
  fi
  RESP_CODE="$(curl "${args[@]}" 2>"$TMP/curlerr")" || RESP_CODE=000
  RESP_BODY="$(cat "$TMP/resp.json" 2>/dev/null || true)"
}

field() { printf '%s' "$RESP_BODY" | jq -r "$1 // empty" 2>/dev/null; }

# send_and_replay LABEL URL JSON KEY EXPLORER_PREFIX -> sets TXID
send_and_replay() {
  local label=$1 url=$2 json=$3 key=$4 explorer=$5

  api POST "$url" "$json" "$key"
  if [ "$RESP_CODE" = "201" ]; then
    TXID="$(field .txId)"
    ok "$label: 201 txId=$TXID fee=$(field .fee)"
    printf '%s  %s%s\n' "$label" "$explorer" "$TXID" >> "$TXLOG"
  elif [ "$RESP_CODE" = "200" ] && [ "$(field .replayed)" = "true" ]; then
    TXID="$(field .txId)"
    ok "$label: already sent in a previous run (replayed) txId=$TXID"
    printf '%s  %s%s\n' "$label" "$explorer" "$TXID" >> "$TXLOG"
  elif [ "$RESP_CODE" = "503" ]; then
    bad "$label: 503 — payout for this key is still unconfirmed. Wait 30s and re-run the script (same key will settle it). Body: $RESP_BODY"
    return 1
  else
    bad "$label: unexpected $RESP_CODE: $RESP_BODY"
    [ "$RESP_CODE" = "502" ] && info "txId=$(field .txId) retryable=$(field .retryable) — if retryable, re-run the script: the same key resends the same bytes."
    return 1
  fi

  # The core guarantee: an immediate retry must replay, never pay twice.
  api POST "$url" "$json" "$key"
  if [ "$RESP_CODE" = "200" ] && [ "$(field .replayed)" = "true" ] && [ "$(field .txId)" = "$TXID" ]; then
    ok "$label: replay returned the SAME txId with replayed=true (no double pay)"
  else
    bad "$label: replay check failed ($RESP_CODE): $RESP_BODY"
    return 1
  fi
}

wait_balance_at_least() { # LABEL URL JQ_MIN  (polls up to 3 min)
  local label=$1 url=$2 min=$3 i=0
  while [ $i -lt 36 ]; do
    api GET "$url"
    local v
    v="$(field .value)"
    if [ -n "$v" ] && python3 -c "import sys; sys.exit(0 if int('$v') >= int('$min') else 1)"; then
      ok "$label: balance $v"
      return 0
    fi
    i=$((i + 1)); sleep 5
  done
  bad "$label: balance below $min after 3 minutes (last: ${v:-n/a})"
  return 1
}

# ---------------------------------------------------------------------------
say "unified-signer real-funds smoke — run id: $RUN_ID"
[ "$info_reused" = "1" ] && info "Re-using the previous run id from $RUN_FILE: completed payouts will replay. Delete that file to start a fresh run."

say "[0] Preflight"

# The API must not be open to the world before wallets are funded.
GATE_CODE="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' "$BASE_URL/wallet/address/44/195/1" 2>/dev/null || echo 000)"
if [ "$GATE_CODE" = "200" ] && [ "${SMOKE_I_UNDERSTAND_OPEN_API:-0}" != "1" ]; then
  die "The API answers WITHOUT authentication (anyone can spend these wallets). Configure Cloudflare Access first. To proceed anyway: SMOKE_I_UNDERSTAND_OPEN_API=1"
fi
[ "$GATE_CODE" = "200" ] || ok "unauthenticated request is blocked ($GATE_CODE)"

api GET "/doc"
[ "$RESP_CODE" = "200" ] || die "cannot reach $BASE_URL/doc with the provided credentials ($RESP_CODE)"
ok "API reachable with credentials"

say "[1] Wallets"
api GET "/wallet/address?$LEGACY_A";   A_TRON="$(field .address)"
api GET "/wallet/address?$LEGACY_B";   B_TRON="$(field .address)"
api GET "/wallet/address/$EVM_PATH_A"; A_EVM="$(field .address)"
api GET "/wallet/address/$EVM_PATH_B"; B_EVM="$(field .address)"
[ -n "$A_TRON" ] && [ -n "$B_TRON" ] && [ -n "$A_EVM" ] && [ -n "$B_EVM" ] || die "address derivation failed"
info "A tron (legacy index $IDX_A): $A_TRON"
info "B tron (legacy index $IDX_B): $B_TRON"
info "A evm  (path $EVM_PATH_A):    $A_EVM"
info "B evm  (path $EVM_PATH_B):    $B_EVM"

say "[2] Funding check (wallet A)"
FUND_OK=1
check_funding() { # LABEL URL MIN HUMAN
  api GET "$2"
  local v; v="$(field .value)"
  if [ -n "$v" ] && python3 -c "import sys; sys.exit(0 if int('$v') >= int('$3') else 1)"; then
    ok "$1: $v (>= $3)"
  else
    bad "$1: ${v:-error} — fund at least $4"
    FUND_OK=0
  fi
}
if [ "$TRON_DELEGATED" = "1" ]; then
  api GET "/wallet/balance?$LEGACY_A"
  info "TRX on A: $(field .value) (delegated-energy mode: TRX requirement waived)"
else
  check_funding "TRX on A"       "/wallet/balance?$LEGACY_A" "$REQ_TRX_SUN" "40 TRX -> $A_TRON"
fi
check_funding "USDT(tron) on A" "/wallet/balance?$LEGACY_A&contractAddress=$USDT_TRON" "$REQ_USDT_TRON" "2 USDT (TRC20) -> $A_TRON"
check_funding "ETH(Base) on A" "/wallet/balance/$EVM_PATH_A?chainId=$CHAIN_ID" "$REQ_ETH_WEI" "0.0005 ETH on Base -> $A_EVM"
check_funding "USDT(Base) on A" "/wallet/balance/$EVM_PATH_A?chainId=$CHAIN_ID&contractAddress=$USDT_EVM" "$REQ_USDT_EVM" "2 USDT on Base -> $A_EVM"

if [ "$FUND_OK" != "1" ]; then
  say "Fund the addresses above, then re-run this script. Nothing was sent."
  exit 2
fi

say "[3] Fee previews"
if [ "$TRON_DELEGATED" = "1" ]; then
  api POST "/calculate/fees" "{\"from\":\"$A_TRON\",\"to\":\"$B_TRON\",\"amount\":\"$USDT_TRON_AMOUNT\",\"contract\":\"$USDT_TRON\"}"
  if [ "$RESP_CODE" = "200" ]; then
    E_BURN="$(field .energy.coverage.needsToBurn)"
    B_BURN="$(field .bandwidth.coverage.needsToBurn)"
    if [ "$E_BURN" = "0" ] && [ "$B_BURN" = "0" ]; then
      ok "USDT quote: delegated energy covers the transfer (available=$(field .energy.available), required=$(field .energy.required), totalFeeTRX=$(field .totalFeeTRX))"
    else
      bad "USDT quote needs a TRX burn (energy=$E_BURN, bandwidth=$B_BURN) — with 0 TRX the send will fail. Delegate more energy or fund TRX."
      die "fix the TRON resources before sending"
    fi
  else
    bad "tron fee quote failed ($RESP_CODE): $RESP_BODY"
  fi
else
  api POST "/calculate/fees" "{\"from\":\"$A_TRON\",\"to\":\"$B_TRON\",\"amount\":\"$TRX_AMOUNT\"}"
  [ "$RESP_CODE" = "200" ] && ok "tron fee quote: totalFeeTRX=$(field .totalFeeTRX)" || bad "tron fee quote failed ($RESP_CODE): $RESP_BODY"
fi
api POST "/calculate/fees/$EVM_PATH_A" "{\"chainId\":$CHAIN_ID,\"to\":\"$B_EVM\",\"amount\":\"$ETH_AMOUNT\"}"
[ "$RESP_CODE" = "200" ] && ok "evm fee quote: totalFeeNative=$(field .totalFeeNative)" || bad "evm fee quote failed ($RESP_CODE): $RESP_BODY"

if [ "${SMOKE_YES:-0}" != "1" ]; then
  say "About to send REAL transactions (A -> B, same mnemonic): $TRX_AMOUNT TRX, $USDT_TRON_AMOUNT USDT(tron), $ETH_AMOUNT ETH(Base), $USDT_EVM_AMOUNT USDT(Base) + two micro ETH sends."
  printf 'Type SEND to proceed: '
  read -r CONFIRM
  [ "$CONFIRM" = "SEND" ] || die "aborted by user"
fi

say "[4] TRON via the legacy client API"
if [ "$TRON_DELEGATED" = "1" ]; then
  info "TRX transfer test skipped (delegated-energy mode, wallet holds no TRX)"
else
  send_and_replay "TRX $TRX_AMOUNT A->B" "/transaction?$LEGACY_A" \
    "{\"to\":\"$B_TRON\",\"amount\":\"$TRX_AMOUNT\"}" "$RUN_ID-trx" \
    "https://tronscan.org/#/transaction/" || true
fi

send_and_replay "USDT(tron) $USDT_TRON_AMOUNT A->B" "/transaction?$LEGACY_A" \
  "{\"to\":\"$B_TRON\",\"amount\":\"$USDT_TRON_AMOUNT\",\"contractAddress\":\"$USDT_TRON\"}" "$RUN_ID-usdt-tron" \
  "https://tronscan.org/#/transaction/" || true

# Key reuse with different parameters must be rejected, never paid.
api POST "/transaction?$LEGACY_A" \
  "{\"to\":\"$B_TRON\",\"amount\":\"0.5\",\"contractAddress\":\"$USDT_TRON\"}" "$RUN_ID-usdt-tron"
[ "$RESP_CODE" = "409" ] && ok "key reuse with different amount -> 409 (no payment)" \
  || bad "key-reuse guard: expected 409, got $RESP_CODE: $RESP_BODY"

say "[5] EVM (chainId $CHAIN_ID) via the global API"
send_and_replay "ETH $ETH_AMOUNT A->B" "/transaction/$EVM_PATH_A" \
  "{\"chainId\":$CHAIN_ID,\"to\":\"$B_EVM\",\"amount\":\"$ETH_AMOUNT\"}" "$RUN_ID-eth" \
  "https://basescan.org/tx/" || true

send_and_replay "USDT(Base) $USDT_EVM_AMOUNT A->B" "/transaction/$EVM_PATH_A" \
  "{\"chainId\":$CHAIN_ID,\"to\":\"$B_EVM\",\"amount\":\"$USDT_EVM_AMOUNT\",\"contractAddress\":\"$USDT_EVM\"}" "$RUN_ID-usdt-evm" \
  "https://basescan.org/tx/" || true

say "[6] Two back-to-back EVM payouts (distinct keys)"
send_and_replay "ETH micro #1 A->B" "/transaction/$EVM_PATH_A" \
  "{\"chainId\":$CHAIN_ID,\"to\":\"$B_EVM\",\"amount\":\"0.00001\"}" "$RUN_ID-par-1" \
  "https://basescan.org/tx/" || true
send_and_replay "ETH micro #2 A->B" "/transaction/$EVM_PATH_A" \
  "{\"chainId\":$CHAIN_ID,\"to\":\"$B_EVM\",\"amount\":\"0.00002\"}" "$RUN_ID-par-2" \
  "https://basescan.org/tx/" || true

say "[7] Arrival check on B"
if [ "$TRON_DELEGATED" = "1" ]; then
  info "TRX arrival on B skipped (delegated-energy mode)"
else
  wait_balance_at_least "TRX on B" "/wallet/balance?$LEGACY_B" 900000 || true
fi
wait_balance_at_least "USDT(tron) on B" "/wallet/balance?$LEGACY_B&contractAddress=$USDT_TRON" 1000000 || true
wait_balance_at_least "ETH(Base) on B" "/wallet/balance/$EVM_PATH_B?chainId=$CHAIN_ID" 100000000000000 || true
wait_balance_at_least "USDT(Base) on B" "/wallet/balance/$EVM_PATH_B?chainId=$CHAIN_ID&contractAddress=$USDT_EVM" 1000000 || true

if [ "${SMOKE_SWEEP:-0}" = "1" ]; then
  say "[8] Sweep B -> A (send-max recipe)"
  # Tokens: full balance. Native: balance minus the quoted fee (minus 1 SUN on tron).
  api GET "/wallet/balance?$LEGACY_B&contractAddress=$USDT_TRON"; USDT_B="$(field .value)"
  if [ "$TRON_DELEGATED" = "1" ]; then
    info "TRON sweep skipped: B is unactivated and has no resources; its USDT stays until B is activated/delegated."
    USDT_B=""
  fi
  if [ -n "$USDT_B" ] && [ "$USDT_B" != "0" ]; then
    AMT="$(python3 -c "print(f'{int(\"$USDT_B\")/10**6:.6f}'.rstrip('0').rstrip('.'))")"
    send_and_replay "sweep USDT(tron) B->A" "/transaction?$LEGACY_B" \
      "{\"to\":\"$A_TRON\",\"amount\":\"$AMT\",\"contractAddress\":\"$USDT_TRON\"}" "$RUN_ID-sweep-usdt-tron" "https://tronscan.org/#/transaction/" || true
  fi
  api GET "/wallet/balance/$EVM_PATH_B?chainId=$CHAIN_ID&contractAddress=$USDT_EVM"; USDT_EB="$(field .value)"
  if [ -n "$USDT_EB" ] && [ "$USDT_EB" != "0" ]; then
    AMT="$(python3 -c "print(f'{int(\"$USDT_EB\")/10**6:.6f}'.rstrip('0').rstrip('.'))")"
    send_and_replay "sweep USDT(Base) B->A" "/transaction/$EVM_PATH_B" \
      "{\"chainId\":$CHAIN_ID,\"to\":\"$A_EVM\",\"amount\":\"$AMT\",\"contractAddress\":\"$USDT_EVM\"}" "$RUN_ID-sweep-usdt-evm" "https://basescan.org/tx/" || true
  fi
  # The token sweep above pays its gas from B's ETH: wait until that gas is
  # actually deducted (tx mined) so the max-amount math uses the real balance.
  api GET "/wallet/balance/$EVM_PATH_B?chainId=$CHAIN_ID"; ETH_B="$(field .value)"
  i=0
  while [ $i -lt 24 ]; do
    sleep 5
    api GET "/wallet/balance/$EVM_PATH_B?chainId=$CHAIN_ID"
    NEW_B="$(field .value)"
    if [ -n "$NEW_B" ] && [ "$NEW_B" != "$ETH_B" ]; then
      ETH_B="$NEW_B"; break
    fi
    i=$((i + 1))
  done

  api POST "/calculate/fees/$EVM_PATH_B" "{\"chainId\":$CHAIN_ID,\"to\":\"$A_EVM\",\"amount\":\"0.00001\"}"
  FEE_WEI="$(field .totalFeeWei)"
  if [ -n "$ETH_B" ] && [ -n "$FEE_WEI" ]; then
    # 2x the quoted ceiling: the built transaction re-estimates fees a moment
    # later, and send-max must survive that drift (dust simply stays on B).
    AMT="$(python3 -c "
b=int('$ETH_B'); f=int('$FEE_WEI'); a=b-2*f
print(f'{a/10**18:.18f}'.rstrip('0').rstrip('.') if a>0 else '')")"
    if [ -n "$AMT" ]; then
      send_and_replay "sweep ETH(Base) B->A" "/transaction/$EVM_PATH_B" \
        "{\"chainId\":$CHAIN_ID,\"to\":\"$A_EVM\",\"amount\":\"$AMT\"}" "$RUN_ID-sweep-eth-$AMT" "https://basescan.org/tx/" || true
    fi
  fi
  info "TRX sweep is left for after the token sweeps confirm: re-run with SMOKE_SWEEP=1 or move it manually (amount = balance - fee - 0.000001)."
else
  info "[8] Sweep skipped (set SMOKE_SWEEP=1 to return funds from B to A)."
fi

say "Result: $PASS passed, $FAIL failed — run id $RUN_ID"
if [ -s "$TXLOG" ]; then
  say "Transactions to verify in the explorers (each key must map to EXACTLY ONE tx):"
  cat "$TXLOG"
fi
[ "$FAIL" = "0" ] && say "SMOKE PASSED ✅  (delete $RUN_FILE before a future fresh run)" || say "SMOKE HAS FAILURES ❌ — see above; re-running with the same run id is safe."
exit "$([ "$FAIL" = "0" ] && echo 0 || echo 1)"

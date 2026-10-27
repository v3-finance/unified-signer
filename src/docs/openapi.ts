import type { EvmNetworkConfig } from "../lib/networks";
import { TRON_NETWORK_KEY } from "../lib/networks";

const TRON_ADDRESS_PATTERN = "^T[A-Za-z0-9]{33}$";
const EVM_ADDRESS_PATTERN = "^0x[a-fA-F0-9]{40}$";
const USDT_TRON_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ETHEREUM_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDT_BASE_CONTRACT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const EXAMPLE_EVM_ADDRESS = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const EXAMPLE_EVM_RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

function createLegacyQueryParameters() {
  return ["appId", "purpose", "asset", "stage", "index"].map((name) => ({
    name,
    in: "query",
    required: true,
    description:
      name === "appId"
        ? "Hardened application level of the legacy tree (max 2^31-1)."
        : "Derivation level of the legacy tree (max 2^32-1).",
    schema: { type: "integer", minimum: 0, example: 0 },
  }));
}

function createDerivationPathParameter() {
  return {
    name: "path",
    in: "path",
    required: true,
    description:
      "Raw derivation path as slash-separated non-hardened indexes, e.g. `44/60/0/0/5`. Hardening markers are not supported. 1-10 levels, indexes below 2^31; a leading `m` segment is optional.",
    schema: {
      type: "string",
      example: "44/60/0/0/5",
    },
  };
}

function createErrorResponse(description: string, exampleError: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorResponse" },
        examples: {
          error: {
            value: {
              error: exampleError,
            },
          },
        },
      },
    },
  };
}

function createLegacyValidationResponse() {
  return {
    description:
      "Validation failed: the zValidator envelope with the zod issue list JSON-stringified inside `error.message`.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/LegacyValidationErrorResponse" },
      },
    },
  };
}

function createIdempotencyConflictResponse() {
  return {
    description:
      "Idempotency key conflict. `retryable: false` — the key was already used for a DIFFERENT transaction (the recorded `txId` is returned); do not retry. `retryable: true` — a concurrent request holds the same key right now; retry shortly with the SAME key.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/IdempotencyConflictResponse" },
        examples: {
          differentTransaction: {
            value: {
              error:
                "Idempotency key was already used for a different transaction",
              txId: "c5a2f77e8b3d4f1a9b6c8d7e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6",
              retryable: false,
            },
          },
          concurrentUse: {
            value: {
              error:
                "Idempotency key is being used by another request. Retry later.",
              retryable: true,
            },
          },
        },
      },
    },
  };
}

function createUnconfirmedOrRateLimitedResponse() {
  return {
    description:
      "Either the keyed payout is not confirmed yet (retry later with the SAME Idempotency-Key — the service re-broadcasts the same signed bytes), or the broadcast was rate-limited before reaching a node (the request never left the gateway; retrying is safe).",
    content: {
      "application/json": {
        schema: {
          oneOf: [
            { $ref: "#/components/schemas/PendingTransactionResponse" },
            { $ref: "#/components/schemas/BroadcastFailureResponse" },
          ],
        },
        examples: {
          notConfirmed: {
            value: {
              error:
                "Transaction for this idempotency key is not confirmed yet. Retry later with the same Idempotency-Key.",
              txId: "c5a2f77e8b3d4f1a9b6c8d7e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6",
              retryable: true,
            },
          },
          rateLimited: {
            value: {
              error: "Failed to broadcast transaction",
              txId: "c5a2f77e8b3d4f1a9b6c8d7e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6",
              retryable: true,
              details: { code: "RATE_LIMITED" },
            },
          },
        },
      },
    },
  };
}

function createBroadcastFailureResponse() {
  return {
    description:
      "Broadcast rejected by the node, or its outcome is unknown (the transaction may be on-chain — see `retryable`).",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/BroadcastFailureResponse" },
      },
    },
  };
}

function createIdempotencyKeyHeader(extraDescription = "") {
  return {
    name: "Idempotency-Key",
    in: "header",
    required: false,
    description:
      "Unique key per payout (recommended for every payout). 1-128 printable ASCII characters without spaces; anything else is rejected with 400. A retry with the same key never sends a second transaction while the first can still land: the service re-broadcasts the same signed bytes and replays completed payouts as 200 {replayed: true}." +
      extraDescription,
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[\\x21-\\x7E]+$",
      example: "payout-12345",
    },
  };
}

function createMonitorIdParameter() {
  return {
    name: "id",
    in: "path",
    required: true,
    description: "Monitoring client id whose address list is being changed.",
    schema: { type: "string" },
  };
}

function createMonitorResponses(successStatus: "200" | "201", action: string) {
  return {
    [successStatus]: {
      description: `Address ${action}; the monitoring service confirmed the change.`,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/MonitorWalletResponse" },
        },
      },
    },
    "400": createLegacyValidationResponse(),
    "503": {
      description:
        "Monitoring is not configured: the deployment lacks MONITOR_CLIENTS_BASE_URL or MONITOR_API_KEY.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
          examples: {
            unconfigured: { value: { error: "Monitoring is not configured" } },
          },
        },
      },
    },
    "500": {
      description:
        "The monitoring service rejected the change or answered with an unexpected shape (standard 500 envelope).",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ErrorResponse" },
          examples: {
            rejected: {
              value: {
                error: "Internal Server Error",
                message: "Monitoring service rejected wallet add request",
                retryable: true,
              },
            },
          },
        },
      },
    },
  };
}

export function createOpenApiDocument(
  baseUrl: string,
  evmNetworks: EvmNetworkConfig[]
) {
  const evmNetworkKeys = evmNetworks.map((network) => network.key);
  const networkList = [TRON_NETWORK_KEY, ...evmNetworkKeys]
    .map((key) => `\`${key}\``)
    .join(", ");

  return {
    openapi: "3.1.0",
    info: {
      title: "Unified Signer API",
      version: "1.0.0",
      description: `
# Unified Signer API

API для детерминированного управления кошельками и исполнения транзакций в сетях TRON и EVM поверх Cloudflare Workers и Durable Objects.

## Что умеет API

- Получать адреса кошельков из общего HD-дерева по набору derivation-параметров или по сырому пути
- Читать балансы нативных монет (TRX, ETH, BNB, ...) и токенов (TRC20 / ERC20)
- Рассчитывать стоимость транзакции до отправки: bandwidth/energy для TRON, gas для EVM
- Строить, подписывать и отправлять транзакции в любой сконфигурированной сети

## Быстрая карта API

Кошелёк адресуется derivation-путём прямо в URL; семья сети выводится из coin type пути (\`44/60/...\` — EVM, \`44/195/...\` — TRON), конкретная EVM-сеть выбирается \`chainId\`:

| Запрос | Что делает |
|---|---|
| \`GET /wallet/address/{path}\` | Адрес по пути (для EVM одинаков во всех сетях) |
| \`GET /wallet/balance/{path}?chainId=1[&contractAddress]\` | Баланс нативной монеты или токена; для EVM нужен \`chainId\` |
| \`POST /transaction/{path}\` | Перевод: проверки балансов → комиссия → build → sign → broadcast; для EVM \`chainId\` в теле |
| \`POST /calculate/fees/{path}\` | Расчёт комиссии без отправки; \`from\` из пути, для EVM \`chainId\` в теле |
| \`GET /\`, \`GET /doc\`, \`GET /llms.txt\` | Документация: Scalar UI, OpenAPI JSON, Markdown |

Доступные сети этого деплоя: ${networkList}.

- \`tron\` — сеть TRON поверх TronGrid, \`chainId\` не требуется
- Остальные — EVM-сети из конфигурации \`EVM_NETWORKS\` (chainId, RPC URL, нативная монета, режим комиссий). Добавление сети — только конфиг, без кода

## Derivation-пути

Все ключи выводятся из одной mnemonic по указанному в URL пути. Правила:

- Пути **всегда non-hardened**: сегменты — только числа, маркеры харденинга (\`h\`, \`'\`) не поддерживаются и отклоняются. \`/44/60/0\` даёт ключ \`m/44/60/0\`
- Глубина от 1 до 10 уровней, индексы < 2^31, ведущий сегмент \`m\` опционален, percent-кодирование разделителей (\`44%2F60%2F0\`) допустимо
- Первый уровень пути — 44, второй — coin type: \`60\` (EVM) или \`195\` (TRON); прочий coin type отклоняется с 400
- Дальнейшие уровни — ваша структура: например \`/44/60/{purpose}/{userId}\`
- Ответы адресных эндпоинтов возвращают канонический \`path\`
- Для одного пути EVM-адрес одинаков во всех EVM-сетях

## Сценарии использования

### Депозитный адрес для пользователя N

Выделите уровень пути под назначение (например \`1\` — депозиты) и используйте id пользователя как последний индекс; адрес детерминирован — БД для соответствия «пользователь → адрес» не обязательна:

\`\`\`
GET ${baseUrl}/wallet/address/44/195/1/42     — TRON-депозитный адрес пользователя 42
GET ${baseUrl}/wallet/address/44/60/1/42      — его же EVM-адрес (один на все EVM-сети)
\`\`\`

### Один EVM-адрес во всех EVM-сетях

Для одного пути адрес в ethereum, bsc, polygon, base идентичен:

\`\`\`
GET ${baseUrl}/wallet/address/44/60/42
\`\`\`

### Полный флоу вывода средств

1. Баланс токена: \`GET /wallet/balance/{path}?chainId=1&contractAddress=<token>\`
2. Баланс нативной монеты (хватит ли на комиссию): \`GET /wallet/balance/{path}?chainId=1\`
3. Предпросмотр комиссии для UI: \`POST /calculate/fees/{path}\` (опционально — шаг 4 сам всё проверит)
4. Отправка: \`POST /transaction/{path}\` с телом \`{"chainId", "to", "amount", "contractAddress"}\`

Ответ шага 4: \`201 {"txId": "...", "fee": "0.000315"}\`. Любая проблема (нехватка баланса, невалидный адрес, отказ сети) вернётся понятной ошибкой ДО отправки — сервис не бросает транзакцию в сеть, пока все проверки не пройдены.

### Отправить весь баланс

Комиссия платится сверх суммы, поэтому «отправить всё» = баланс минус комиссия:

- EVM: \`amount = balance − totalFeeWei\` (из \`/calculate/fees\`; равенство допустимо). \`totalFeeWei\` — потолок, фактическая комиссия обычно ниже, остаток пыли нормален
- TRON: \`amount = balance − fee − 1 SUN\` (строгие сравнения требуют минимум 1 SUN сверху)
- Токены: отправляется весь баланс токена как есть — комиссия платится нативной монетой

### TRC20 при делегированных ресурсах (gasFree)

Если energy/bandwidth делегированы кошельку, проверка «хватит ли TRX на комиссию» не нужна — добавьте \`"gasFree": true\` в тело \`/transaction\`. Проверка комиссии пропускается, \`fee\` в ответе — \`"0"\`. Работает и для EVM (пропуск предпроверки; параметры газа всё равно применяются к транзакции).

## Денежные единицы

- Балансы возвращаются в минимальных единицах: SUN для TRX (\`1 TRX = 1_000_000 SUN\`), wei для нативных EVM-монет, базовые единицы для токенов
- В request body суммы передаются десятичной строкой (например \`"1.5"\`), а не числом; decimals токена сервис читает из контракта сам
- Число дробных знаков не должно превышать decimals актива (6 для TRX, 18 для ETH, decimals токена), иначе 400
- \`fee\` в ответе \`/transaction\` — десятичная строка в нативной монете сети (\`"0"\` при \`gasFree\`)

## Legacy API (совместимость с cloud-tron-wallet)

Для существующих TRON-клиентов сервис байт-в-байт воспроизводит API оригинального cloud-tron-wallet — те же пути, параметры, формы ответов и идемпотентность с ключами, скоупленными по \`appId\`:

\`\`\`
GET  /wallet/address?appId&purpose&asset&stage&index
GET  /wallet/balance?{derivation}[&contractAddress]
GET  /wallet/history?{derivation}[&contractAddress]
POST /transaction?{derivation}            (+ Idempotency-Key; fee в ответе — число)
POST /calculate/fees                      ({from, to, amount[, contract]})
POST|DELETE /monitor/{id}/wallets, GET /monitor/{id}/add|remove/wallet
POST /webhook
\`\`\`

Эти эндпоинты работают на ИСХОДНОМ hardened-дереве \`m/44'/195'/{appId}'/{purpose}/{asset}/{stage}/{index}\` — все ранее выданные адреса остаются действительными. Новые интеграции должны использовать глобальные path-эндпоинты выше.

Роуты \`/monitor/*\` проксируют запросы во внешний сервис мониторинга и отвечают \`503 {"error": "Monitoring is not configured"}\`, пока в деплое не заданы \`MONITOR_CLIENTS_BASE_URL\` и \`MONITOR_API_KEY\`. \`POST /webhook\` принимает исходный контракт вебхука о TRON-пополнении и только подтверждает его получение.

## Идемпотентность и ретраи

Для КАЖДОЙ выплаты рекомендуется заголовок \`Idempotency-Key\` — уникальная строка из 1–128 печатных ASCII-символов без пробелов (иной формат отклоняется с \`400 Invalid Idempotency-Key header\`). Гарантии:

- Повтор запроса с тем же ключом **никогда не отправляет вторую транзакцию**, пока первая может исполниться: сервис переотправляет ровно те же подписанные байты
- Уже выполненная выплата отвечает \`200 {"txId", "fee", "replayed": true}\`
- Ключ, использованный с другими параметрами, отвечает \`409\` с \`retryable: false\`; конкурентный запрос, прямо сейчас держащий тот же ключ, — \`409\` с \`retryable: true\` (повторите чуть позже)
- Пока исход неизвестен — \`503\` с \`retryable: true\`: повторяйте позже с тем же ключом

Скоупинг ключей: записи хранятся отдельно для каждой сети (\`tron\` или конкретная EVM-сеть), а отпечаток выплаты включает путь, \`chainId\` (для EVM), получателя, нормализованную сумму и контракт. Один и тот же ключ в разных сетях — две независимые записи: конфликта не будет, но и защиты от дублей между сетями тоже. На legacy-эндпоинте ключи дополнительно скоуплены по \`appId\`.

Семантика «мёртвой» транзакции по семьям сетей:

- **TRON**: транзакция имеет \`expiration\` (~60 с). Новая транзакция по тому же ключу отправляется только когда старая истекла, прошло ещё 5 минут, solidified-блоки покрыли окно включения, и транзакции нет в блоке
- **EVM**: подписанная транзакция не истекает. Новая отправляется только когда её nonce финализированно занят другой транзакцией, а receipt отсутствует

Правила ретраев без ключа: \`502\` с \`retryable: false\` не повторять; \`Broadcast outcome unknown\` без ключа означает, что транзакция МОГЛА уйти в сеть — проверяйте \`txId\` в сканере, прежде чем слать новую.

## Справочник ошибок

| Код | Тело | Когда |
|---|---|---|
| 400 | \`{"error": "Validation Error", "details": [...], "retryable": false}\` | Невалидные параметры, адреса, checksum, сырой путь в query/body |
| 400 | \`{"error": "Request body must be valid JSON", "retryable": false}\` | Тело POST-запроса — не валидный JSON |
| 400 | \`{"error": "Invalid Idempotency-Key header", "details", "retryable": false}\` | Ключ не из 1–128 печатных ASCII-символов без пробелов |
| 400 | \`{"error": "Too many decimal places (max N)"}\` | Слишком много дробных знаков в \`amount\` |
| 400 | \`{"error": "Insufficient TRX balance", "shortfallSun"}\` | Не хватает TRX на сумму |
| 400 | \`{"error": "Insufficient <SYMBOL> balance", "shortfallWei"}\` | Не хватает нативной EVM-монеты на сумму |
| 400 | \`{"error": "Insufficient TRC20/ERC20 balance", "shortfall", "token", "decimals"}\` | Не хватает токена |
| 400 | \`{"error": "Insufficient ... to cover amount and fees", "feeSun"/"feeWei"}\` | Сумма проходит, сумма+комиссия — нет |
| 400 | \`{"error": "Unable to read token contract ..."}\` | \`contractAddress\` — не читаемый токен-контракт (детерминированный отказ) |
| 400 | \`{"error": "Invalid path segment ..."}\` | Ошибка в сыром пути (не число, маркер харденинга, глубина, диапазон) |
| 400 | \`{"error": "Unknown chainId ...", "availableChainIds": [...]}\` | \`chainId\` не соответствует ни одной сконфигурированной EVM-сети |
| 400/409/500/502/503 | \`{"error", "stage", "retryable"[, "details"]}\` | Отказ стадии пайплайна: \`stage\` — \`НЕЙМСПЕЙС/роут\` (например \`REGISTRY/getBalance\`, \`GAS_CALCULATOR/calculate\`); статус стадии сохраняется (прочие коды → 502), \`retryable: true\` только при статусе ≥ 500 |
| 404 | текст \`404 Not Found\` (не JSON) | Запрос на несуществующий путь |
| 409 | \`{"error": "Idempotency key was already used...", "txId", "retryable": false}\` | Ключ использован с другими параметрами выплаты |
| 409 | \`{"error": "Idempotency key is being used by another request...", "retryable": true}\` | Конкурентный запрос с тем же ключом подписывает прямо сейчас |
| 502 | \`{"error": "Failed to broadcast transaction", "txId", "retryable", "details"}\` | Нода отклонила транзакцию; \`retryable: false\` — детерминированный отказ |
| 502 | \`{"error": "Broadcast outcome unknown", "txId", "retryable", "details"}\` | Исход неизвестен: с ключом повторяйте (переотправятся те же байты), без ключа — проверяйте txId |
| 503 | \`{"error": "...not confirmed yet...", "txId", "retryable": true}\` | Транзакция по ключу ещё в полёте; повторите позже с тем же ключом |
| 503 | \`{"error": "Failed to broadcast transaction", "txId", "retryable": true, "details": {"code": "RATE_LIMITED"}}\` | Шлюз не пропустил broadcast из-за rate limit — до ноды запрос не дошёл, повтор безопасен |
| 503 | \`{"error": "Unable to read TRC20 token info for ...", "retryable": true}\` | Временный сбой чтения метаданных токена или rate limit RPC — повтор безопасен |
| 503 | \`{"error": "Monitoring is not configured"}\` | \`/monitor/*\` при незаданных \`MONITOR_CLIENTS_BASE_URL\`/\`MONITOR_API_KEY\` |
| 500 | \`{"error": "Internal Server Error", "message", "retryable": true}\` | Непредвиденный сбой до подписи — повтор безопасен; детали в логах воркера |

Форматы ошибок валидации различаются по слоям API:

- Глобальные path-эндпоинты: \`{"error": "Validation Error", "details": [...], "retryable": false}\`
- Legacy GET-эндпоинты, \`POST /transaction\` и \`/monitor/*\`: конверт zValidator \`{"success": false, "error": {"name": "ZodError", "message": "<JSON-строка с issues>"}}\`
- Legacy \`POST /calculate/fees\`: \`{"success": false, "error": {"message": "Validation error", "issues": [{"field", "message", "code"}]}}\`
- \`POST /webhook\`: \`{"ok": false, "error": "Validation Error", "details": [...]}\`

## Архитектура

Сервис использует Durable Objects, разделяя обязанности по четырём зонам:

- \`Registry\` отвечает за derivation адресов и балансы
- \`TxBuilder\` строит TRON и EVM транзакции. EVM-nonce берётся напрямую из pending-счётчика сети, как в обычном кошельке: выплаты с одного кошелька отправляйте последовательно — две строго одновременные могут взять один nonce, и одна вытеснит другую
- \`Signer\` подписывает транзакции, не раскрывая приватные ключи наружу
- \`GasCalculator\` оценивает стоимость исполнения

## Безопасность

- API не раскрывает mnemonic и приватные ключи; подпись выполняется внутри \`Signer\` Durable Object
- Смешанный регистр EVM-адресов проверяется по EIP-55 checksum
- Decimals токенов читаются строго из контракта; ошибки чтения не кэшируются
- Аутентификация выполняется на уровне Cloudflare (Access) перед воркером

## Интерактивная документация

- \`GET /\` открывает Scalar UI
- \`GET /doc\` возвращает OpenAPI JSON
- \`GET /llms.txt\` возвращает Markdown-версию API
      `,
      contact: {
        name: "API Support",
        email: "ilyakoz1996@gmail.com",
      },
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    servers: [
      {
        url: baseUrl,
        description: "Configured deployment URL",
      },
    ],
    tags: [
      {
        name: "Docs",
        description:
          "Endpoints that expose the interactive reference, raw OpenAPI JSON and Markdown docs.",
      },
      {
        name: "Wallet",
        description:
          "HD wallet derivation and raw balance retrieval for every configured network.",
      },
      {
        name: "Transaction",
        description:
          "High-level transaction execution flow: balance checks, fee estimation, build, sign and broadcast.",
      },
      {
        name: "Legacy",
        description:
          "Byte-compatible API of the original cloud-tron-wallet service (hardened derivation tree, TRON only). Existing clients keep working unchanged; new integrations should use the global raw-path endpoints.",
      },
      {
        name: "Fees",
        description:
          "Pure fee estimation endpoints that do not broadcast transactions.",
      },
    ],
    paths: {
      "/": {
        get: {
          tags: ["Docs"],
          summary: "Open the interactive API reference",
          description:
            "Serves Scalar UI configured against `/doc`. Use this in a browser for manual exploration and request testing.",
          responses: {
            "200": {
              description: "HTML page with the interactive reference UI.",
              content: {
                "text/html": {
                  schema: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
      },
      "/doc": {
        get: {
          tags: ["Docs"],
          summary: "Get the OpenAPI JSON document",
          description:
            "Returns the machine-readable OpenAPI 3.1 description of the current API deployment.",
          operationId: "getOpenApiDocument",
          responses: {
            "200": {
              description: "OpenAPI JSON document.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
      },
      "/llms.txt": {
        get: {
          tags: ["Docs"],
          summary: "Get the Markdown API description",
          description:
            "Returns a Markdown rendering of the OpenAPI spec, suitable for LLM ingestion or lightweight human-readable export.",
          operationId: "getMarkdownApiDocument",
          responses: {
            "200": {
              description: "Markdown representation of the API.",
              content: {
                "text/plain": {
                  schema: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
      },
      "/wallet/address": {
        get: {
          tags: ["Legacy"],
          summary: "Legacy: derive a TRON address (hardened tree)",
          description:
            "Original cloud-tron-wallet endpoint. Derives on m/44'/195'/{appId}'/{purpose}/{asset}/{stage}/{index} — the tree all previously issued addresses live on.",
          operationId: "legacyGetWalletAddress",
          parameters: createLegacyQueryParameters(),
          responses: {
            "200": {
              description: "Derived wallet address.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["address"],
                    properties: {
                      address: { $ref: "#/components/schemas/TronAddress" },
                    },
                  },
                },
              },
            },
            "400": createLegacyValidationResponse(),
          },
        },
      },
      "/wallet/balance": {
        get: {
          tags: ["Legacy"],
          summary: "Legacy: get a TRON wallet balance",
          operationId: "legacyGetWalletBalance",
          parameters: [
            ...createLegacyQueryParameters(),
            {
              name: "contractAddress",
              in: "query",
              required: false,
              schema: { $ref: "#/components/schemas/TronAddress" },
            },
          ],
          responses: {
            "200": {
              description: "Balance in smallest units (SUN or token base units).",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WalletBalanceResponse" },
                },
              },
            },
            "400": createLegacyValidationResponse(),
          },
        },
      },
      "/wallet/history": {
        get: {
          tags: ["Legacy"],
          summary: "Legacy: get TRX or TRC20 transfer history",
          operationId: "legacyGetWalletHistory",
          parameters: [
            ...createLegacyQueryParameters(),
            {
              name: "contractAddress",
              in: "query",
              required: false,
              description:
                "Optional TRC20 contract filter; without it native TRX history is returned.",
              schema: { $ref: "#/components/schemas/TronAddress" },
            },
          ],
          responses: {
            "200": {
              description:
                "Transfers, newest first: TRC20 items when contractAddress is given, TRX items otherwise.",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      oneOf: [
                        { $ref: "#/components/schemas/Trc20TransferItem" },
                        { $ref: "#/components/schemas/TrxTransferItem" },
                      ],
                    },
                  },
                },
              },
            },
            "400": createLegacyValidationResponse(),
          },
        },
      },
      "/transaction": {
        post: {
          tags: ["Legacy"],
          summary: "Legacy: build, sign and broadcast a TRON transaction",
          description:
            "Original cloud-tron-wallet endpoint with the full payout-safety contract: Idempotency-Key (scoped by appId), replay as 200 {replayed: true}, 409 on key conflicts, retryable broadcast errors, 503 while unconfirmed. `fee` in the 201 response is a NUMBER, as in the original service.",
          operationId: "legacyCreateTransaction",
          parameters: [
            ...createLegacyQueryParameters(),
            createIdempotencyKeyHeader(
              " Keys are additionally scoped by appId, so different apps can never collide."
            ),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CreateTronTransactionRequest",
                },
              },
            },
          },
          responses: {
            "201": {
              description:
                "Broadcast accepted. `fee` is a number (legacy shape).",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["txId", "fee"],
                    properties: {
                      txId: { type: "string" },
                      fee: {
                        oneOf: [{ type: "number" }, { type: "string" }],
                        description:
                          "Number for quoted fees; the string \"0\" when gasFree was requested.",
                      },
                    },
                  },
                },
              },
            },
            "200": {
              description: "Replay of an already-sent payout.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ReplayedTransactionResponse",
                  },
                },
              },
            },
            "400": {
              description:
                "Query/body/header validation failure (zValidator envelope), invalid Idempotency-Key, insufficient balance, or a build/sign failure.",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      {
                        $ref: "#/components/schemas/LegacyValidationErrorResponse",
                      },
                      {
                        $ref: "#/components/schemas/TronTransactionBalanceErrorResponse",
                      },
                      { $ref: "#/components/schemas/ErrorResponse" },
                      { $ref: "#/components/schemas/StageErrorResponse" },
                    ],
                  },
                },
              },
            },
            "409": createIdempotencyConflictResponse(),
            "502": createBroadcastFailureResponse(),
            "503": createUnconfirmedOrRateLimitedResponse(),
          },
        },
      },
      "/calculate/fees": {
        post: {
          tags: ["Legacy"],
          summary: "Legacy: calculate TRON fees with an explicit sender",
          operationId: "legacyCalculateFees",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/LegacyCalculateFeesRequest" },
                examples: {
                  trx: {
                    value: {
                      from: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      to: "TUdbkixK7zU4ua7YC2oNz6ujsfZxb98GFb",
                      amount: "1.5",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Detailed TRON fee calculation.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/TronCalculateFeesResponse" },
                },
              },
            },
            "400": {
              description:
                "Validation failed: missing/invalid fields, from == to, or contract equal to one of the parties.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/LegacyFeesValidationErrorResponse",
                  },
                },
              },
            },
          },
        },
      },
      "/monitor/{id}/wallets": {
        post: {
          tags: ["Legacy"],
          summary: "Legacy: start monitoring a TRON address",
          description:
            "Proxies to the monitoring service configured via MONITOR_CLIENTS_BASE_URL/MONITOR_API_KEY. Answers 503 while monitoring is not configured.",
          operationId: "legacyMonitorAddWalletBody",
          parameters: [createMonitorIdParameter()],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { $ref: "#/components/schemas/TronAddress" },
                  },
                },
              },
            },
          },
          responses: createMonitorResponses("201", "added to monitoring"),
        },
        delete: {
          tags: ["Legacy"],
          summary: "Legacy: stop monitoring a TRON address",
          description:
            "Proxies to the monitoring service. Answers 503 while monitoring is not configured.",
          operationId: "legacyMonitorRemoveWalletBody",
          parameters: [createMonitorIdParameter()],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["address"],
                  properties: {
                    address: { $ref: "#/components/schemas/TronAddress" },
                  },
                },
              },
            },
          },
          responses: createMonitorResponses("200", "removed from monitoring"),
        },
      },
      "/monitor/{id}/add/wallet": {
        get: {
          tags: ["Legacy"],
          summary: "Legacy: start monitoring a TRON address (query variant)",
          description:
            "GET variant of POST /monitor/{id}/wallets with the address in the query string.",
          operationId: "legacyMonitorAddWalletQuery",
          parameters: [
            createMonitorIdParameter(),
            {
              name: "address",
              in: "query",
              required: true,
              schema: { $ref: "#/components/schemas/TronAddress" },
            },
          ],
          responses: createMonitorResponses("201", "added to monitoring"),
        },
      },
      "/monitor/{id}/remove/wallet": {
        get: {
          tags: ["Legacy"],
          summary: "Legacy: stop monitoring a TRON address (query variant)",
          description:
            "GET variant of DELETE /monitor/{id}/wallets with the address in the query string.",
          operationId: "legacyMonitorRemoveWalletQuery",
          parameters: [
            createMonitorIdParameter(),
            {
              name: "address",
              in: "query",
              required: true,
              schema: { $ref: "#/components/schemas/TronAddress" },
            },
          ],
          responses: createMonitorResponses("200", "removed from monitoring"),
        },
      },
      "/webhook": {
        post: {
          tags: ["Legacy"],
          summary: "Legacy: receive a TRON top-up webhook",
          description:
            "Accepts the original monitoring webhook contract and acknowledges it. The payload is validated and acknowledged only — the service performs no further processing.",
          operationId: "legacyWebhook",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebhookPayload" },
              },
            },
          },
          responses: {
            "201": {
              description: "Payload accepted.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "id"],
                    properties: {
                      ok: { type: "boolean", const: true },
                      id: {
                        type: "string",
                        description: "The transaction id echoed back.",
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Payload failed validation.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "error", "details"],
                    properties: {
                      ok: { type: "boolean", const: false },
                      error: { type: "string", const: "Validation Error" },
                      details: {
                        type: "array",
                        items: { type: "object", additionalProperties: true },
                        description: "Zod issues.",
                      },
                    },
                  },
                },
              },
            },
            "500": {
              description: "Non-JSON body or processing failure.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "error"],
                    properties: {
                      ok: { type: "boolean", const: false },
                      error: {
                        type: "string",
                        const: "Webhook processing failed",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/wallet/address/{path}": {
        get: {
          tags: ["Wallet"],
          summary: "Derive an address by raw derivation path",
          description: `
Returns the address for a raw derivation path, without picking a network explicitly.

The chain family is inferred from the BIP44 coin type in the path:

- \`44/60/...\` — EVM (the address is identical across all configured EVM networks)
- \`44/195/...\` — TRON

Raw paths are always non-hardened (\`/44/60/0\` derives \`m/44/60/0\`); hardening markers are not supported. The path must start with 44/60 (EVM) or 44/195 (TRON).
          `,
          operationId: "getWalletAddressByPath",
          parameters: [createDerivationPathParameter()],
          responses: {
            "200": {
              description: "Derived address with the canonical path.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/WalletAddressByPathResponse",
                  },
                  examples: {
                    evm: {
                      value: {
                        address: EXAMPLE_EVM_ADDRESS,
                        path: "m/44/60/0/0/5",
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Malformed path (hardened marker, non-numeric segment, depth or index range), family not inferable, or no EVM networks configured.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ErrorResponse" },
                  examples: {
                    family: {
                      value: {
                        error:
                          "Cannot infer the network family from this path. The path must start with 44/60 (EVM) or 44/195 (TRON).",
                      },
                    },
                    hardened: {
                      value: {
                        error:
                          'Invalid path segment "44h": hardened segments are not supported, use plain indexes',
                      },
                    },
                    noEvmNetworks: {
                      value: { error: "No EVM networks are configured" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/wallet/balance/{path}": {
        get: {
          tags: ["Wallet"],
          summary: "Get a wallet balance by raw path (network via chainId)",
          description: `
The balance endpoint: the chain family is inferred from the path's coin type.

- TRON paths (\`44/195/...\`) need no extra parameters
- EVM paths (\`44/60/...\`) require the \`chainId\` query parameter to pick the network
- Add \`contractAddress\` for token balances
          `,
          operationId: "getWalletBalanceByPathGlobal",
          parameters: [
            createDerivationPathParameter(),
            {
              name: "chainId",
              in: "query",
              required: false,
              description:
                "EVM chain id (required for EVM paths). Must match a configured network.",
              schema: {
                type: "integer",
                enum: evmNetworks.map((network) => network.chainId),
                example: evmNetworks[0]?.chainId ?? 1,
              },
            },
            {
              name: "contractAddress",
              in: "query",
              required: false,
              description:
                "Token contract address (TRC20 for tron paths, ERC20 for EVM paths).",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Wallet balance in smallest units.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WalletBalanceResponse" },
                  examples: {
                    evm: {
                      summary: "GET /wallet/balance/44/60/0?chainId=8453",
                      value: { asset: "ETH", value: "1500000000000000000" },
                    },
                    tron: {
                      summary: "GET /wallet/balance/44/195/0",
                      value: { asset: "TRX", value: "15000000" },
                    },
                    token: {
                      summary:
                        "GET /wallet/balance/44/195/0?contractAddress=<USDT>",
                      value: { asset: USDT_TRON_CONTRACT, value: "100000000" },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Malformed path, missing or unknown chainId, or invalid contract address.",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/ErrorResponse" },
                      { $ref: "#/components/schemas/ChainIdErrorResponse" },
                    ],
                  },
                  examples: {
                    chainIdRequired: {
                      value: {
                        error:
                          "The chainId query parameter is required for EVM balances",
                        availableChainIds: evmNetworks.map(
                          (network) => network.chainId
                        ),
                      },
                    },
                    unknownChainId: {
                      value: {
                        error: "Unknown chainId 10",
                        availableChainIds: evmNetworks.map(
                          (network) => network.chainId
                        ),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/transaction/{path}": {
        post: {
          tags: ["Transaction"],
          summary: "Build, sign and broadcast a transaction (network via chainId)",
          description: `
The single transaction endpoint. The chain family is inferred from the path's coin type:

- \`/transaction/44/195/...\` — TRON: body with Base58 addresses, no \`chainId\`
- \`/transaction/44/60/...\` — EVM: body with 0x addresses plus \`chainId\` selecting the network

Execution flow: derive the wallet from the path, check the token and native balances, estimate fees, build, sign inside the Signer Durable Object, broadcast. \`gasFree: true\` skips the fee pre-check; success returns \`201 {"txId", "fee"}\` with \`fee\` as a decimal string in the native coin.
          `,
          operationId: "createTransactionGlobal",
          parameters: [
            createDerivationPathParameter(),
            createIdempotencyKeyHeader(
              " Records are kept per network: the same key on different chains is two independent records (no conflict, but no cross-chain replay protection either)."
            ),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      $ref: "#/components/schemas/CreateTronTransactionRequest",
                    },
                    {
                      $ref: "#/components/schemas/CreateEvmTransactionByChainRequest",
                    },
                  ],
                },
                examples: {
                  ethOnBase: {
                    summary: "POST /transaction/44/60/0 — ETH on Base",
                    value: {
                      chainId: 8453,
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "0.05",
                    },
                  },
                  usdtOnEthereum: {
                    summary: "POST /transaction/44/60/0 — USDT on Ethereum",
                    value: {
                      chainId: 1,
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "100.5",
                      contractAddress: USDT_ETHEREUM_CONTRACT,
                    },
                  },
                  usdtOnBase: {
                    summary:
                      "POST /transaction/44/60/0 — USDT on Base (per-network contract)",
                    value: {
                      chainId: 8453,
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "100.5",
                      contractAddress: USDT_BASE_CONTRACT,
                    },
                  },
                  trxTransfer: {
                    summary: "POST /transaction/44/195/0 — TRX (no chainId)",
                    value: {
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "1.5",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Transaction accepted by the network.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CreateTransactionResponse",
                  },
                },
              },
            },
            "200": {
              description:
                "Replay: this Idempotency-Key's payout is already sent or on-chain.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ReplayedTransactionResponse",
                  },
                },
              },
            },
            "409": createIdempotencyConflictResponse(),
            "503": createUnconfirmedOrRateLimitedResponse(),
            "400": {
              description:
                "Malformed path, family not inferable, non-JSON body, invalid Idempotency-Key, unknown chainId, validation, balance or build/sign failure.",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/ErrorResponse" },
                      { $ref: "#/components/schemas/ChainIdErrorResponse" },
                      {
                        $ref: "#/components/schemas/TronTransactionBalanceErrorResponse",
                      },
                      {
                        $ref: "#/components/schemas/EvmTransactionBalanceErrorResponse",
                      },
                      { $ref: "#/components/schemas/StageErrorResponse" },
                    ],
                  },
                  examples: {
                    invalidJson: {
                      value: {
                        error: "Request body must be valid JSON",
                        retryable: false,
                      },
                    },
                    validation: {
                      value: {
                        error: "Validation Error",
                        details: [
                          {
                            code: "invalid_type",
                            path: ["to"],
                            message:
                              "Invalid input: expected string, received undefined",
                          },
                        ],
                        retryable: false,
                      },
                    },
                    invalidIdempotencyKey: {
                      value: {
                        error: "Invalid Idempotency-Key header",
                        details: [
                          {
                            code: "invalid_format",
                            message:
                              "Idempotency key must be printable ASCII without spaces",
                          },
                        ],
                        retryable: false,
                      },
                    },
                    unknownChainId: {
                      value: {
                        error: "Unknown chainId 10",
                        availableChainIds: evmNetworks.map(
                          (network) => network.chainId
                        ),
                      },
                    },
                    nativeShortfall: {
                      value: {
                        error: "Insufficient ETH balance",
                        shortfallWei: "500000000000000",
                      },
                    },
                    tokenShortfall: {
                      value: {
                        error: "Insufficient ERC20 balance",
                        shortfall: "1000000",
                        token: "USDT",
                        decimals: 6,
                      },
                    },
                  },
                },
              },
            },
            "502": createBroadcastFailureResponse(),
          },
        },
      },
      "/calculate/fees/{path}": {
        post: {
          tags: ["Fees"],
          summary: "Calculate transaction fees (network via chainId)",
          description: `
The fee-calculation endpoint: \`from\` is derived from the path, the family from its coin type, and for EVM paths the network is selected by \`chainId\` in the body.
          `,
          operationId: "calculateFeesGlobal",
          parameters: [createDerivationPathParameter()],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/CalculateFeesByPathRequest" },
                    { $ref: "#/components/schemas/CalculateFeesByChainRequest" },
                  ],
                },
                examples: {
                  evm: {
                    summary: "POST /calculate/fees/44/60/0 — USDT on Ethereum",
                    value: {
                      chainId: 1,
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "100",
                      contract: USDT_ETHEREUM_CONTRACT,
                    },
                  },
                  tron: {
                    summary: "POST /calculate/fees/44/195/0 — TRX (no chainId)",
                    value: {
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "1.5",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Fee calculation result (TRON or EVM shape).",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/TronCalculateFeesResponse" },
                      { $ref: "#/components/schemas/EvmCalculateFeesResponse" },
                    ],
                  },
                },
              },
            },
            "400": {
              description:
                "Malformed path, family not inferable, non-JSON body, unknown chainId, or validation failure. Refinement violations (from == to, contract equal to a party) surface as a GAS_CALCULATOR stage envelope.",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/ErrorResponse" },
                      { $ref: "#/components/schemas/ChainIdErrorResponse" },
                      { $ref: "#/components/schemas/StageErrorResponse" },
                    ],
                  },
                  examples: {
                    unknownChainId: {
                      value: {
                        error: "Unknown chainId 10",
                        availableChainIds: evmNetworks.map(
                          (network) => network.chainId
                        ),
                        retryable: false,
                      },
                    },
                    stageRefinement: {
                      value: {
                        error: "Validation Error",
                        stage: "GAS_CALCULATOR/calculate",
                        retryable: false,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        TronAddress: {
          type: "string",
          pattern: TRON_ADDRESS_PATTERN,
          description: "TRON address in Base58 format.",
          example: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
        },
        EvmAddress: {
          type: "string",
          pattern: EVM_ADDRESS_PATTERN,
          description:
            "EVM address as 0x-prefixed hex. Mixed-case input is validated against EIP-55 checksum.",
          example: EXAMPLE_EVM_ADDRESS,
        },
        AmountString: {
          type: "string",
          pattern: "^\\d+(\\.\\d+)?$",
          description:
            "Positive decimal string. Used in request bodies to avoid floating-point ambiguity. The number of fractional digits must not exceed the asset's decimals (6 for TRX, the token's own decimals for TRC20/ERC20, the native coin's decimals for EVM networks); over-precise amounts are rejected with 400.",
          example: "1.5",
        },
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "string",
              description: "Human-readable error description.",
              example: "Validation Error",
            },
            details: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
              },
              description:
                "Optional list of validation issues when the error was produced by schema validation.",
            },
            retryable: {
              type: "boolean",
              description:
                "Present on most error bodies: whether repeating the same request may succeed.",
            },
            message: {
              type: "string",
              description:
                "Present on 500 responses: redacted description of the internal failure.",
            },
          },
        },
        ChainIdErrorResponse: {
          type: "object",
          required: ["error", "availableChainIds"],
          properties: {
            error: {
              type: "string",
              example: "The chainId query parameter is required for EVM balances",
            },
            availableChainIds: {
              type: "array",
              items: { type: "integer" },
              description: "Chain ids of every configured EVM network.",
            },
            retryable: { type: "boolean" },
          },
        },
        StageErrorResponse: {
          type: "object",
          required: ["error", "stage", "retryable"],
          description:
            "A pipeline stage refused the request. `stage` is `NAMESPACE/route`, e.g. `REGISTRY/getBalance`, `TX_BUILDER/evmTxBuild`, `SIGNER/sign`, `GAS_CALCULATOR/calculate`. The stage's own status (400, 409, 500, 503) is preserved; anything else maps to 502. `retryable` is true only for statuses >= 500.",
          properties: {
            error: { type: "string" },
            stage: { type: "string", example: "GAS_CALCULATOR/calculate" },
            retryable: { type: "boolean" },
            details: {
              description:
                "Optional issues forwarded from the stage (e.g. validation details).",
            },
          },
        },
        IdempotencyConflictResponse: {
          type: "object",
          required: ["error", "retryable"],
          description:
            "409 body. Variant 1: the key was already used for a DIFFERENT transaction — `txId` is the recorded transaction, `retryable: false`. Variant 2: a concurrent request holds the same key right now — `retryable: true`, retry shortly with the same key.",
          properties: {
            error: { type: "string" },
            txId: { type: "string" },
            retryable: { type: "boolean" },
          },
        },
        PendingTransactionResponse: {
          type: "object",
          required: ["error", "retryable"],
          description:
            "The keyed payout's outcome is not decided yet. Retry later with the SAME Idempotency-Key; the service re-broadcasts the same signed bytes.",
          properties: {
            error: { type: "string" },
            txId: { type: "string" },
            expiresAt: {
              type: "string",
              description: "TRON only: the recorded transaction's expiration.",
            },
            retryable: { type: "boolean", const: true },
          },
        },
        LegacyValidationErrorResponse: {
          type: "object",
          required: ["success", "error"],
          description:
            "Validation envelope of the legacy GET endpoints, POST /transaction (query, body and header) and the monitor routes: the zod error with the issue list JSON-stringified inside `error.message`.",
          properties: {
            success: { type: "boolean", const: false },
            error: {
              type: "object",
              required: ["name", "message"],
              properties: {
                name: { type: "string", const: "ZodError" },
                message: {
                  type: "string",
                  description: "JSON-stringified array of zod issues.",
                },
              },
            },
          },
        },
        LegacyFeesValidationErrorResponse: {
          type: "object",
          required: ["success", "error"],
          description: "Validation envelope of legacy POST /calculate/fees.",
          properties: {
            success: { type: "boolean", const: false },
            error: {
              type: "object",
              required: ["message", "issues"],
              properties: {
                message: { type: "string", const: "Validation error" },
                issues: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["field", "message", "code"],
                    properties: {
                      field: { type: "string" },
                      message: { type: "string" },
                      code: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        LegacyCalculateFeesRequest: {
          type: "object",
          required: ["from", "to", "amount"],
          description:
            "Legacy fee calculation with an explicit sender. `from` and `to` must differ, and `contract` must not equal either of them; violations are rejected with 400.",
          properties: {
            from: { $ref: "#/components/schemas/TronAddress" },
            to: { $ref: "#/components/schemas/TronAddress" },
            amount: { $ref: "#/components/schemas/AmountString" },
            contract: {
              allOf: [{ $ref: "#/components/schemas/TronAddress" }],
              description:
                "Optional TRC20 contract address. If omitted, the calculation is for a native TRX transfer.",
            },
          },
        },
        MonitorWalletResponse: {
          type: "object",
          required: ["ok", "receivers"],
          properties: {
            ok: { type: "boolean", const: true },
            receivers: {
              type: "array",
              items: { type: "string" },
              description:
                "Every address monitored for this client after the change.",
            },
          },
        },
        WebhookPayload: {
          type: "object",
          required: [
            "network",
            "asset",
            "contract",
            "type",
            "id",
            "block",
            "from",
            "to",
            "value",
            "timestamp",
          ],
          properties: {
            network: { type: "string", const: "TRON" },
            asset: { type: "string", enum: ["A7A5", "USDT", "TRX"] },
            contract: {
              type: "string",
              enum: [
                "TLeVfrdym8RoJreJ23dAGyfJDygRtiWKBZ",
                USDT_TRON_CONTRACT,
                "native",
              ],
              description:
                "Token contract of the transfer, or `native` for TRX.",
            },
            type: { type: "string", const: "TOPUP" },
            id: { type: "string", description: "Transaction id of the top-up." },
            block: { type: "number" },
            from: { $ref: "#/components/schemas/TronAddress" },
            to: { $ref: "#/components/schemas/TronAddress" },
            value: {
              type: "integer",
              minimum: 0,
              description: "Amount in base units of the asset.",
            },
            timestamp: { type: "number" },
          },
        },
        TrxTransferItem: {
          type: "object",
          required: ["txID", "timestamp", "from", "to", "amountSun", "direction"],
          properties: {
            txID: { type: "string" },
            timestamp: { type: "number" },
            from: { $ref: "#/components/schemas/TronAddress" },
            to: { $ref: "#/components/schemas/TronAddress" },
            amountSun: { type: "string", description: "Transfer amount in SUN." },
            direction: { type: "string", enum: ["in", "out"] },
          },
        },
        Trc20TransferItem: {
          type: "object",
          required: [
            "txID",
            "timestamp",
            "from",
            "to",
            "amountSun",
            "contractAddress",
            "direction",
          ],
          properties: {
            txID: { type: "string" },
            timestamp: { type: "number" },
            from: { $ref: "#/components/schemas/TronAddress" },
            to: { $ref: "#/components/schemas/TronAddress" },
            amountSun: {
              type: "string",
              description:
                "Transfer amount in token base units (legacy field name).",
            },
            contractAddress: { $ref: "#/components/schemas/TronAddress" },
            tokenSymbol: { type: "string" },
            tokenDecimals: { type: "integer" },
            direction: { type: "string", enum: ["in", "out"] },
          },
        },
        WalletAddressByPathResponse: {
          type: "object",
          required: ["address", "path"],
          properties: {
            address: {
              oneOf: [
                { $ref: "#/components/schemas/TronAddress" },
                { $ref: "#/components/schemas/EvmAddress" },
              ],
              description: "Derived wallet address in the network's format.",
            },
            path: {
              type: "string",
              description:
                "Canonical non-hardened derivation path.",
              example: "m/44/60/0/0/5",
            },
          },
        },
        CalculateFeesByPathRequest: {
          type: "object",
          required: ["to", "amount"],
          properties: {
            to: {
              type: "string",
              description:
                "Recipient address in the network's format (Base58 for tron, 0x hex for EVM).",
            },
            amount: { $ref: "#/components/schemas/AmountString" },
            contract: {
              type: "string",
              description:
                "Optional token contract address. If omitted, the calculation is for a native transfer.",
            },
          },
        },
        WalletBalanceResponse: {
          type: "object",
          required: ["asset", "value"],
          properties: {
            asset: {
              type: "string",
              description:
                "Native coin symbol (`TRX`, `ETH`, ...) or the token contract address requested.",
              example: "TRX",
            },
            value: {
              type: "string",
              description:
                "Raw balance in smallest units: SUN for TRX, wei for native EVM coins, base units for tokens.",
              example: "1000000",
            },
          },
        },
        CreateTronTransactionRequest: {
          type: "object",
          required: ["to", "amount"],
          properties: {
            to: { $ref: "#/components/schemas/TronAddress" },
            amount: { $ref: "#/components/schemas/AmountString" },
            contractAddress: {
              allOf: [{ $ref: "#/components/schemas/TronAddress" }],
              description:
                'Optional TRC20 contract address. Omit for native TRX transfers; the literal values `""`, `"undefined"` and `null` are tolerated and treated as absent.',
            },
            gasFree: {
              type: "boolean",
              default: false,
              description:
                "Skip the fee pre-check. Useful when bandwidth/energy is delegated to the wallet.",
            },
          },
        },
        CreateEvmTransactionByChainRequest: {
          type: "object",
          required: ["chainId", "to", "amount"],
          properties: {
            chainId: {
              type: "integer",
              description:
                "Chain id of a configured EVM network (e.g. 1, 56, 137, 8453).",
              enum: evmNetworks.map((network) => network.chainId),
            },
            to: { $ref: "#/components/schemas/EvmAddress" },
            amount: { $ref: "#/components/schemas/AmountString" },
            contractAddress: {
              allOf: [{ $ref: "#/components/schemas/EvmAddress" }],
              description:
                'Optional ERC20 contract address. Omit for native coin transfers; the literal values `""`, `"undefined"` and `null` are tolerated and treated as absent.',
            },
            gasFree: {
              type: "boolean",
              default: false,
              description: "Skip the fee pre-check.",
            },
          },
        },
        CalculateFeesByChainRequest: {
          type: "object",
          required: ["chainId", "to", "amount"],
          properties: {
            chainId: {
              type: "integer",
              description:
                "Chain id of a configured EVM network (e.g. 1, 56, 137, 8453).",
              enum: evmNetworks.map((network) => network.chainId),
            },
            to: { $ref: "#/components/schemas/EvmAddress" },
            amount: { $ref: "#/components/schemas/AmountString" },
            contract: {
              allOf: [{ $ref: "#/components/schemas/EvmAddress" }],
              description:
                "Optional ERC20 contract address. If omitted, the calculation is for a native transfer.",
            },
          },
        },
        CreateTransactionResponse: {
          type: "object",
          required: ["txId", "fee"],
          properties: {
            txId: {
              type: "string",
              description:
                "Broadcasted transaction id: TRON txID or EVM transaction hash.",
              example:
                "c5a2f77e8b3d4f1a9b6c8d7e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6",
            },
            fee: {
              type: "string",
              description:
                "Estimated fee used for the pre-check, as a decimal string in the network's native coin. `\"0\"` when `gasFree` was requested.",
              example: "0.345",
            },
          },
        },
        ReplayedTransactionResponse: {
          type: "object",
          required: ["txId", "fee", "replayed"],
          properties: {
            txId: {
              type: "string",
              description: "The transaction this Idempotency-Key resolved to.",
            },
            fee: {
              oneOf: [{ type: "string" }, { type: "number" }],
              description:
                "Fee recorded when the payout was first quoted: a decimal string on the global endpoint, a number on the legacy endpoint.",
            },
            replayed: { type: "boolean", const: true },
          },
        },
        TronTransactionBalanceErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            shortfallSun: {
              type: "string",
              description: "Missing TRX amount in SUN.",
            },
            shortfall: {
              type: "string",
              description: "Missing TRC20 amount in token base units.",
            },
            feeSun: {
              type: "string",
              description: "Fee estimate in SUN for fee-shortfall errors.",
            },
            token: {
              type: "string",
              description: "TRC20 symbol when a token balance is insufficient.",
            },
            decimals: {
              type: "integer",
              description:
                "TRC20 decimals for interpreting the shortfall amount.",
            },
          },
        },
        EvmTransactionBalanceErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            shortfallWei: {
              type: "string",
              description: "Missing native coin amount in wei.",
            },
            shortfall: {
              type: "string",
              description: "Missing ERC20 amount in token base units.",
            },
            feeWei: {
              type: "string",
              description: "Fee estimate in wei for fee-shortfall errors.",
            },
            token: {
              type: "string",
              description: "ERC20 symbol when a token balance is insufficient.",
            },
            decimals: {
              type: "integer",
              description:
                "ERC20 decimals for interpreting the shortfall amount.",
            },
          },
        },
        BroadcastFailureResponse: {
          type: "object",
          required: ["error", "txId", "retryable", "details"],
          properties: {
            error: {
              type: "string",
              enum: ["Failed to broadcast transaction", "Broadcast outcome unknown"],
            },
            txId: {
              type: "string",
              description: "Id of the signed transaction this attempt produced.",
            },
            expiresAt: {
              type: "string",
              format: "date-time",
              description:
                "TRON only: the transaction's expiration; after it plus the settlement window a keyed retry may send a replacement.",
            },
            retryable: {
              type: "boolean",
              description:
                "false for deterministic rejections; for 'Broadcast outcome unknown' it is true only when an Idempotency-Key was sent (a keyed retry resends the exact same bytes).",
            },
            details: {
              type: "object",
              additionalProperties: true,
              description:
                "Node/classifier answer: code, message, decodedMessage (TRON).",
            },
          },
        },
        TronCalculateFeesResponse: {
          type: "object",
          required: [
            "totalFeeTRX",
            "bandwidth",
            "energy",
            "transactionType",
            "timestamp",
          ],
          properties: {
            totalFeeTRX: {
              type: "number",
              description: "Total estimated cost in TRX.",
            },
            bandwidth: {
              type: "object",
              required: ["required", "available", "coverage", "costTRX"],
              properties: {
                required: { type: "number" },
                available: {
                  type: "object",
                  required: ["fromStaking", "fromFree", "total"],
                  properties: {
                    fromStaking: { type: "number" },
                    fromFree: { type: "number" },
                    total: { type: "number" },
                  },
                },
                coverage: {
                  type: "object",
                  required: ["fromStaking", "fromFree", "needsToBurn", "total"],
                  properties: {
                    fromStaking: { type: "number" },
                    fromFree: { type: "number" },
                    needsToBurn: { type: "number" },
                    total: { type: "number" },
                  },
                },
                costTRX: { type: "number" },
              },
            },
            energy: {
              type: "object",
              required: [
                "required",
                "available",
                "coverage",
                "costTRX",
                "baseEnergy",
                "energyFactor",
                "recipientHasTransactions",
              ],
              properties: {
                required: { type: "number" },
                available: { type: "number" },
                coverage: {
                  type: "object",
                  required: ["fromStaking", "needsToBurn"],
                  properties: {
                    fromStaking: { type: "number" },
                    needsToBurn: { type: "number" },
                  },
                },
                costTRX: { type: "number" },
                baseEnergy: { type: "number" },
                energyFactor: { type: "number" },
                recipientHasTransactions: { type: "boolean" },
              },
            },
            transactionType: {
              type: "string",
              enum: ["TRX_TRANSFER", "TRC20_TRANSFER"],
            },
            timestamp: {
              type: "integer",
              description: "Calculation timestamp in milliseconds.",
            },
          },
        },
        EvmCalculateFeesResponse: {
          type: "object",
          required: [
            "totalFeeNative",
            "totalFeeWei",
            "gasLimit",
            "feeType",
            "transactionType",
            "timestamp",
          ],
          properties: {
            totalFeeNative: {
              type: "string",
              description:
                "Total worst-case cost as a decimal string in the native coin.",
              example: "0.000315",
            },
            totalFeeWei: {
              type: "string",
              description: "Total worst-case cost in wei (`gasLimit * maxFeePerGas` or `gasLimit * gasPrice`).",
              example: "315000000000000",
            },
            gasLimit: {
              type: "string",
              description:
                "Estimated gas limit including the safety buffer, as an integer string.",
              example: "25200",
            },
            feeType: {
              type: "string",
              enum: ["eip1559", "legacy"],
              description: "Fee mode used for this calculation.",
            },
            baseFeePerGas: {
              type: "string",
              description:
                "Current base fee per gas in wei. Present for EIP-1559 calculations.",
            },
            maxPriorityFeePerGas: {
              type: "string",
              description:
                "Priority fee per gas in wei. Present for EIP-1559 calculations.",
            },
            maxFeePerGas: {
              type: "string",
              description:
                "Fee ceiling per gas in wei. Present for EIP-1559 calculations.",
            },
            gasPrice: {
              type: "string",
              description:
                "Gas price in wei. Present for legacy calculations.",
            },
            transactionType: {
              type: "string",
              enum: ["NATIVE_TRANSFER", "ERC20_TRANSFER"],
            },
            timestamp: {
              type: "integer",
              description: "Calculation timestamp in milliseconds.",
            },
          },
        },
      },
    },
  };
}

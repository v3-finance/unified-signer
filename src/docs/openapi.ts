import type { EvmNetworkConfig } from "../lib/networks";
import { TRON_NETWORK_KEY } from "../lib/networks";

const TRON_ADDRESS_PATTERN = "^T[A-Za-z0-9]{33}$";
const EVM_ADDRESS_PATTERN = "^0x[a-fA-F0-9]{40}$";
const USDT_TRON_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ETHEREUM_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDT_BASE_CONTRACT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const EXAMPLE_EVM_ADDRESS = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const EXAMPLE_EVM_RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

function createWalletQueryParameters() {
  return [
    {
      name: "appId",
      in: "query",
      required: true,
      description:
        "Application identifier inside the HD wallet tree. Use it to isolate addresses between products or business domains.",
      schema: { type: "integer", minimum: 0, maximum: 2147483647, example: 0 },
    },
    {
      name: "purpose",
      in: "query",
      required: true,
      description:
        "Derivation purpose within the application. Typical convention: `0` for hot payout wallets, `1` for deposit wallets.",
      schema: { type: "integer", minimum: 0, maximum: 2147483647, example: 0 },
    },
    {
      name: "asset",
      in: "query",
      required: true,
      description:
        "Asset branch in the derivation tree. The numeric meaning is defined by your own application, for example `0 = USDT`, `1 = USDC`.",
      schema: { type: "integer", minimum: 0, maximum: 2147483647, example: 0 },
    },
    {
      name: "stage",
      in: "query",
      required: true,
      description:
        "Additional derivation branch used to segment wallet groups, environments, or account families.",
      schema: { type: "integer", minimum: 0, maximum: 2147483647, example: 0 },
    },
    {
      name: "index",
      in: "query",
      required: true,
      description: "Concrete wallet index inside the selected derivation branch.",
      schema: { type: "integer", minimum: 0, maximum: 2147483647, example: 0 },
    },
  ];
}

function createEvmNetworkPathParameter(evmNetworks: EvmNetworkConfig[]) {
  return {
    name: "network",
    in: "path",
    required: true,
    description:
      "EVM network key from the service configuration. Every configured network shares the same HD tree and API contract.",
    schema: {
      type: "string",
      enum: evmNetworks.map((network) => network.key),
      example: evmNetworks[0]?.key ?? "ethereum",
    },
  };
}

function createAnyNetworkPathParameter(evmNetworks: EvmNetworkConfig[]) {
  return {
    name: "anyNetwork",
    in: "path",
    required: true,
    description:
      "Network key: `tron` or any configured EVM network. Addresses in the request/response follow this network's format.",
    schema: {
      type: "string",
      enum: [TRON_NETWORK_KEY, ...evmNetworks.map((network) => network.key)],
      example: TRON_NETWORK_KEY,
    },
  };
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

export function createOpenApiDocument(
  baseUrl: string,
  evmNetworks: EvmNetworkConfig[]
) {
  const walletQueryParameters = createWalletQueryParameters();
  const evmNetworkParameter = createEvmNetworkPathParameter(evmNetworks);
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

**Глобальные эндпоинты** — семья сети выводится из coin type пути (\`44/60/...\` — EVM, \`44/195/...\` — TRON), конкретная EVM-сеть выбирается \`chainId\`:

| Запрос | Что делает |
|---|---|
| \`GET /wallet/address/{path}\` | Адрес по пути (для EVM одинаков во всех сетях) |
| \`GET /wallet/balance/{path}?chainId=1[&contractAddress]\` | Баланс; для EVM нужен \`chainId\` в query |
| \`POST /transaction/{path}\` | Перевод; для EVM \`chainId\` в теле |
| \`POST /calculate/fees/{path}\` | Расчёт комиссии; \`from\` из пути, для EVM \`chainId\` в теле |

**Эндпоинты с сетью в пути** (\`{network}\`: ${networkList}):

| Запрос | Что делает |
|---|---|
| \`GET /{network}/wallet/address?appId&purpose&asset&stage&index\` | Адрес по derivation-параметрам |
| \`GET /{network}/wallet/address/{path}\` | Адрес по сырому пути |
| \`GET /{network}/wallet/balance?...[&contractAddress]\` | Баланс нативной монеты или токена |
| \`GET /{network}/wallet/balance/{path}[?contractAddress]\` | То же по сырому пути |
| \`POST /{network}/transaction?...\` | Перевод: проверки балансов → комиссия → build → sign → broadcast |
| \`POST /{network}/transaction/{path}\` | То же по сырому пути |
| \`POST /{network}/calculate/fees\` | Расчёт комиссии без отправки (\`from\` в теле) |
| \`POST /{network}/calculate/fees/{path}\` | То же, \`from\` выводится из пути |
| \`GET /\`, \`GET /doc\`, \`GET /llms.txt\` | Документация: Scalar UI, OpenAPI JSON, Markdown |

- \`tron\` — сеть TRON поверх TronGrid
- Остальные ключи — EVM-сети из конфигурации \`EVM_NETWORKS\` (chainId, RPC URL, нативная монета, режим комиссий). Добавление сети — только конфиг, без кода

## Два способа адресовать кошелёк

**1. Derivation-параметры** (\`appId/purpose/asset/stage/index\`) — структурированная схема поверх hardened-дерева:

\`\`\`
TRON: m/44'/195'/{appId}'/{purpose}/{asset}/{stage}/{index}
EVM:  m/44'/60'/{appId}'/{purpose}/{asset}/{stage}/{index}
\`\`\`

Все числа целые, от 0 до 2^31−1. Семантика уровней определяется вашим приложением; типичная конвенция: \`purpose=0\` — hot/payout кошельки, \`purpose=1\` — депозитные, \`index\` — идентификатор пользователя.

**2. Сырой derivation-путь** прямо в URL: \`/44/60/0\`, \`/44/195/0/0/7\` и т.п. Правила:

- Сырые пути **всегда non-hardened**: сегменты — только числа, маркеры харденинга (\`h\`, \`'\`) не поддерживаются и отклоняются. Путь \`/44/60/0\` даёт ключ \`m/44/60/0\` (не BIP44 \`m/44'/60'/0'\`)
- Глубина от 1 до 10 уровней, индексы < 2^31, ведущий сегмент \`m\` опционален, percent-кодирование разделителей (\`44%2F60%2F0\`) допустимо
- Для BIP44-образных путей (первый уровень 44) coin type сверяется с семьёй сети: любой coin type, не совпадающий с семьёй (например \`44/195/...\` или \`44/0/...\` на EVM-эндпоинте), отклоняется с 400
- Ответы path-эндпоинтов адреса дополнительно возвращают канонический \`path\`

**Важно:** две схемы адресуют РАЗНЫЕ ветки дерева (hardened против non-hardened) — \`?appId=0&...&index=0\` и \`/44/60/0/0/0/0/0\` дают разные адреса. Выберите одну схему и придерживайтесь её.

## Сценарии использования

### Депозитный адрес для пользователя N

Одна и та же пара запросов на любую сеть; адрес детерминирован — БД для соответствия «пользователь → адрес» не обязательна:

\`\`\`
GET ${baseUrl}/tron/wallet/address?appId=0&purpose=1&asset=0&stage=0&index=42
GET ${baseUrl}/ethereum/wallet/address?appId=0&purpose=1&asset=0&stage=0&index=42
\`\`\`

### Один EVM-адрес во всех EVM-сетях

Для одного пути/набора параметров адрес в ethereum, bsc, polygon, base идентичен. Достаточно спросить любую EVM-сеть или глобальный эндпоинт:

\`\`\`
GET ${baseUrl}/wallet/address/44/60/42
\`\`\`

### Полный флоу вывода средств

1. Баланс токена: \`GET /{network}/wallet/balance?...&contractAddress=<token>\`
2. Баланс нативной монеты (хватит ли на комиссию): \`GET /{network}/wallet/balance?...\`
3. Предпросмотр комиссии для UI: \`POST /{network}/calculate/fees\` (опционально — шаг 4 сам всё проверит)
4. Отправка: \`POST /{network}/transaction?...\` с телом \`{"to", "amount", "contractAddress"}\`

Ответ шага 4: \`201 {"txId": "...", "fee": "0.000315"}\`. Любая проблема (нехватка баланса, невалидный адрес, отказ сети) вернётся понятной ошибкой ДО отправки — сервис не бросает транзакцию в сеть, пока все проверки не пройдены.

### Отправить весь баланс

Комиссия платится сверх суммы, поэтому «отправить всё» = баланс минус комиссия:

- EVM: \`amount = balance − totalFeeWei\` (из \`/calculate/fees\`; равенство допустимо). \`totalFeeWei\` — потолок, фактическая комиссия обычно ниже, остаток пыли нормален
- TRON: \`amount = balance − fee − 1 SUN\` (строгие сравнения требуют минимум 1 SUN сверху)
- Токены: отправляется весь баланс токена как есть — комиссия платится нативной монетой

### TRC20 при делегированных ресурсах (gasFree)

Если energy/bandwidth делегированы кошельку, проверка «хватит ли TRX на комиссию» не нужна — добавьте \`"gasFree": true\` в тело \`/transaction\`. Проверка комиссии пропускается, \`fee\` в ответе — \`"0"\`. Работает и для EVM (пропуск предпроверки; параметры газа всё равно применяются к транзакции).

### Работа полностью по сырым путям

Все операции доступны глобально — без derivation-параметров и без сети в URL. Семью сети определяет coin type пути, конкретную EVM-сеть — \`chainId\`:

\`\`\`
GET  ${baseUrl}/wallet/address/44/60/7
GET  ${baseUrl}/wallet/balance/44/60/7?chainId=8453
POST ${baseUrl}/transaction/44/60/7        {"chainId": 8453, "to": "0x...", "amount": "0.05"}
POST ${baseUrl}/transaction/44/195/7       {"to": "T...", "amount": "1.5"}
POST ${baseUrl}/calculate/fees/44/60/7     {"chainId": 8453, "to": "0x...", "amount": "0.05"}
\`\`\`

Для TRON-путей (\`44/195/...\`) \`chainId\` не нужен. Неизвестный \`chainId\` вернёт 400 со списком \`availableChainIds\`. Те же операции доступны и с сетью в URL: \`/base/transaction/44/60/7\` и т.п.

## Денежные единицы

- Балансы возвращаются в минимальных единицах: SUN для TRX (\`1 TRX = 1_000_000 SUN\`), wei для нативных EVM-монет, базовые единицы для токенов
- В request body суммы передаются десятичной строкой (например \`"1.5"\`), а не числом; decimals токена сервис читает из контракта сам
- Число дробных знаков не должно превышать decimals актива (6 для TRX, 18 для ETH, decimals токена), иначе 400
- \`fee\` в ответе \`/transaction\` — десятичная строка в нативной монете сети (\`"0"\` при \`gasFree\`)

## Справочник ошибок

| Код | Тело | Когда |
|---|---|---|
| 400 | \`{"error": "Validation Error", "details": [...]}\` | Невалидные параметры, адреса, checksum, сырой путь в query/body |
| 400 | \`{"success": false, "error": {"message", "issues"}}\` | Ошибка валидации тела \`/calculate/fees\` |
| 400 | \`{"error": "Too many decimal places (max N)"}\` | Слишком много дробных знаков в \`amount\` |
| 400 | \`{"error": "Insufficient TRX balance", "shortfallSun"}\` | Не хватает TRX на сумму |
| 400 | \`{"error": "Insufficient <SYMBOL> balance", "shortfallWei"}\` | Не хватает нативной EVM-монеты на сумму |
| 400 | \`{"error": "Insufficient TRC20/ERC20 balance", "shortfall", "token", "decimals"}\` | Не хватает токена |
| 400 | \`{"error": "Insufficient ... to cover amount and fees", "feeSun"/"feeWei"}\` | Сумма проходит, сумма+комиссия — нет |
| 400 | \`{"error": "Unable to read token contract", "message"}\` | \`contractAddress\` — не читаемый токен-контракт |
| 400 | \`{"error": "Invalid path segment ..."}\` | Ошибка в сыром пути (не число, маркер харденинга, глубина, диапазон) |
| 400 | \`{"error": "Derivation path coin type does not match ..."}\` | Coin type пути противоречит семье сети |
| 400 | \`{"ok": false, "error": "..."}\` | Отказ построения/подписи/оценки на стороне сети (невалидный base58, revert estimateGas и т.п.) |
| 404 | \`{"error": "Unknown network ...", "availableNetworks": [...]}\` | Неизвестный ключ сети |
| 502 | \`{"error": "Failed to broadcast transaction", "details"}\` | Сеть не приняла подписанную транзакцию |
| 500 | \`{"error": "Internal Server Error"}\` | Сбой апстрима (RPC/TronGrid недоступен, rate limit); детали в логах воркера |

## Архитектура

Сервис использует Durable Objects, разделяя обязанности по четырём зонам:

- \`Registry\` отвечает за derivation адресов и балансы
- \`TxBuilder\` строит TRON и EVM транзакции; для EVM резервирует nonce в хранилище DO — параллельные отправки с одного адреса не конфликтуют
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
      "/tron/wallet/address": {
        get: {
          tags: ["Wallet"],
          summary: "Derive a TRON wallet address",
          description: `
Returns a TRON address derived from the HD wallet tree.

The address is deterministic for the same tuple:

- \`appId\`
- \`purpose\`
- \`asset\`
- \`stage\`
- \`index\`

Path used by the service:

\`\`\`
m/44'/195'/{appId}'/{purpose}/{asset}/{stage}/{index}
\`\`\`
          `,
          operationId: "getTronWalletAddress",
          parameters: walletQueryParameters,
          responses: {
            "200": {
              description: "Derived wallet address.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WalletAddressResponse" },
                  examples: {
                    address: {
                      value: {
                        address: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      },
                    },
                  },
                },
              },
            },
            "400": createErrorResponse(
              "Invalid derivation query parameters.",
              "Validation Error"
            ),
          },
        },
      },
      "/tron/wallet/balance": {
        get: {
          tags: ["Wallet"],
          summary: "Get a TRON wallet balance",
          description: `
Returns the raw balance for the derived wallet.

Rules:

- if \`contractAddress\` is omitted, the endpoint returns TRX balance in SUN
- if \`contractAddress\` is present, the endpoint returns TRC20 balance in the token's smallest unit

No formatting is applied. Clients are expected to interpret decimals on their side when presenting balances.
          `,
          operationId: "getTronWalletBalance",
          parameters: [
            ...walletQueryParameters,
            {
              name: "contractAddress",
              in: "query",
              required: false,
              description:
                "TRC20 contract address. Use it to request token balances instead of native TRX.",
              schema: { $ref: "#/components/schemas/TronAddress" },
            },
          ],
          responses: {
            "200": {
              description: "Wallet balance in smallest units.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WalletBalanceResponse" },
                  examples: {
                    trx: {
                      summary: "Native TRX balance",
                      value: {
                        asset: "TRX",
                        value: "15000000",
                      },
                    },
                    usdt: {
                      summary: "USDT balance",
                      value: {
                        asset: USDT_TRON_CONTRACT,
                        value: "100000000",
                      },
                    },
                  },
                },
              },
            },
            "400": createErrorResponse(
              "Invalid derivation parameters or invalid contract address.",
              "Validation Error"
            ),
            "500": createErrorResponse(
              "Upstream node failure while reading the balance.",
              "Internal Server Error"
            ),
          },
        },
      },
      "/tron/transaction": {
        post: {
          tags: ["Transaction"],
          summary: "Build, sign and broadcast a TRON transaction",
          description: `
Creates a transaction from the derived wallet and broadcasts it to TronGrid.

Execution flow:

1. derive wallet address from query params
2. load current TRX balance
3. optionally load TRC20 metadata and token balance
4. estimate fees with \`GasCalculator\`
5. build raw transaction with \`TxBuilder\`
6. sign it inside \`Signer\`
7. broadcast it through TronGrid

Important notes:

- \`amount\` must be sent as a string
- TRC20 transfers still require enough TRX to cover fees
- \`gasFree: true\` skips the fee pre-check (useful when resources are delegated)
- the endpoint returns success only when TronGrid confirms the broadcast request
          `,
          operationId: "createTronTransaction",
          parameters: walletQueryParameters,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CreateTronTransactionRequest",
                },
                examples: {
                  trxTransfer: {
                    summary: "TRX transfer",
                    value: {
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "1.5",
                    },
                  },
                  usdtTransfer: {
                    summary: "USDT transfer",
                    value: {
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "100.5",
                      contractAddress: USDT_TRON_CONTRACT,
                    },
                  },
                  gasFreeUsdtTransfer: {
                    summary:
                      "USDT transfer with delegated energy (skip fee pre-check)",
                    value: {
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "100.5",
                      contractAddress: USDT_TRON_CONTRACT,
                      gasFree: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Transaction broadcast accepted by TronGrid.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CreateTransactionResponse",
                  },
                  examples: {
                    success: {
                      value: {
                        txId: "c5a2f77e8b3d4f1a9b6c8d7e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6",
                        fee: "0.345",
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Balance check, validation, build, sign or fee-precheck failure.",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/ErrorResponse" },
                      {
                        $ref: "#/components/schemas/TronTransactionBalanceErrorResponse",
                      },
                    ],
                  },
                  examples: {
                    trxShortfall: {
                      value: {
                        error: "Insufficient TRX balance",
                        shortfallSun: "500000",
                      },
                    },
                    tokenShortfall: {
                      value: {
                        error: "Insufficient TRC20 balance",
                        shortfall: "1000000",
                        token: "USDT",
                        decimals: 6,
                      },
                    },
                    feeShortfall: {
                      value: {
                        error: "Insufficient TRX balance to cover amount and fees",
                        shortfallSun: "345000",
                        feeSun: "210000",
                      },
                    },
                  },
                },
              },
            },
            "502": {
              description:
                "Broadcast request reached TronGrid but was not accepted.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/BroadcastErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/tron/calculate/fees": {
        post: {
          tags: ["Fees"],
          summary: "Calculate TRON transaction fees",
          description: `
Calculates TRON transaction costs without broadcasting anything.

The result contains:

- total fee in TRX
- bandwidth requirements, availability and burn cost
- energy requirements, availability and burn cost
- whether the calculation was for TRX or TRC20
- whether the recipient already has contract transaction history for the token

Use this endpoint when:

- you want to show a fee preview before confirmation
- you need to validate that a wallet has enough TRX for a TRC20 transfer
- you want to analyze bandwidth vs energy consumption
          `,
          operationId: "calculateTronFees",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/TronCalculateFeesRequest",
                },
                examples: {
                  trx: {
                    summary: "TRX fee calculation",
                    value: {
                      from: "TFQWpzPkDuHQP9cM7zh8PNAUmgyQNj3FDj",
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "1.5",
                    },
                  },
                  usdt: {
                    summary: "USDT fee calculation",
                    value: {
                      from: "TFQWpzPkDuHQP9cM7zh8PNAUmgyQNj3FDj",
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "100",
                      contract: USDT_TRON_CONTRACT,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Detailed fee calculation result.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/TronCalculateFeesResponse",
                  },
                  examples: {
                    trxTransfer: {
                      summary: "TRX transfer with free bandwidth",
                      value: {
                        totalFeeTRX: 0,
                        bandwidth: {
                          required: 268,
                          available: {
                            fromStaking: 0,
                            fromFree: 1500,
                            total: 1500,
                          },
                          coverage: {
                            fromStaking: 0,
                            fromFree: 268,
                            needsToBurn: 0,
                            total: 268,
                          },
                          costTRX: 0,
                        },
                        energy: {
                          required: 0,
                          available: 0,
                          coverage: {
                            fromStaking: 0,
                            needsToBurn: 0,
                          },
                          costTRX: 0,
                          baseEnergy: 0,
                          energyFactor: 0.0001,
                          recipientHasTransactions: false,
                        },
                        transactionType: "TRX_TRANSFER",
                        timestamp: 1729872000000,
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Validation failed for the fee calculation request.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ValidationErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/{network}/wallet/address": {
        get: {
          tags: ["Wallet"],
          summary: "Derive an EVM wallet address",
          description: `
Returns an EVM address derived from the HD wallet tree.

The address is deterministic for the same tuple and identical across all configured EVM networks:

\`\`\`
m/44'/60'/{appId}'/{purpose}/{asset}/{stage}/{index}
\`\`\`
          `,
          operationId: "getEvmWalletAddress",
          parameters: [evmNetworkParameter, ...walletQueryParameters],
          responses: {
            "200": {
              description: "Derived wallet address.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WalletAddressResponse" },
                  examples: {
                    address: {
                      value: {
                        address: EXAMPLE_EVM_ADDRESS,
                      },
                    },
                  },
                },
              },
            },
            "400": createErrorResponse(
              "Invalid derivation query parameters.",
              "Validation Error"
            ),
            "404": createErrorResponse(
              "Unknown network key.",
              'Unknown network "goerli"'
            ),
          },
        },
      },
      "/{network}/wallet/balance": {
        get: {
          tags: ["Wallet"],
          summary: "Get an EVM wallet balance",
          description: `
Returns the raw balance for the derived wallet.

Rules:

- if \`contractAddress\` is omitted, the endpoint returns the native coin balance in wei
- if \`contractAddress\` is present, the endpoint returns the ERC20 balance in the token's smallest unit

No formatting is applied. Clients are expected to interpret decimals on their side when presenting balances.
          `,
          operationId: "getEvmWalletBalance",
          parameters: [
            evmNetworkParameter,
            ...walletQueryParameters,
            {
              name: "contractAddress",
              in: "query",
              required: false,
              description:
                "ERC20 contract address. Use it to request token balances instead of the native coin.",
              schema: { $ref: "#/components/schemas/EvmAddress" },
            },
          ],
          responses: {
            "200": {
              description: "Wallet balance in smallest units.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/WalletBalanceResponse" },
                  examples: {
                    native: {
                      summary: "Native coin balance",
                      value: {
                        asset: "ETH",
                        value: "1500000000000000000",
                      },
                    },
                    usdt: {
                      summary: "ERC20 balance",
                      value: {
                        asset: USDT_ETHEREUM_CONTRACT,
                        value: "100000000",
                      },
                    },
                  },
                },
              },
            },
            "400": createErrorResponse(
              "Invalid derivation parameters or invalid contract address.",
              "Validation Error"
            ),
            "404": createErrorResponse(
              "Unknown network key.",
              'Unknown network "goerli"'
            ),
            "500": createErrorResponse(
              "Upstream node failure while reading the balance.",
              "Internal Server Error"
            ),
          },
        },
      },
      "/{network}/transaction": {
        post: {
          tags: ["Transaction"],
          summary: "Build, sign and broadcast an EVM transaction",
          description: `
Creates a transaction from the derived wallet and broadcasts it through the configured RPC.

Execution flow:

1. derive wallet address from query params
2. load current native coin balance
3. optionally load ERC20 metadata and token balance
4. estimate gas and fees with \`GasCalculator\`
5. build the unsigned transaction with \`TxBuilder\` (nonce, gas limit, fee fields)
6. sign it inside \`Signer\`
7. broadcast the raw transaction through the network RPC

Important notes:

- \`amount\` must be sent as a string in the asset's decimal units
- ERC20 transfers still require enough native coin to cover gas
- \`gasFree: true\` skips the fee pre-check; gas parameters are still applied to the transaction
- fee fields follow the network's fee mode: EIP-1559 (\`maxFeePerGas\`/\`maxPriorityFeePerGas\`) or legacy (\`gasPrice\`)
          `,
          operationId: "createEvmTransaction",
          parameters: [evmNetworkParameter, ...walletQueryParameters],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CreateEvmTransactionRequest",
                },
                examples: {
                  nativeTransfer: {
                    summary: "Native coin transfer",
                    value: {
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "0.05",
                    },
                  },
                  usdtTransfer: {
                    summary: "ERC20 transfer (USDT on Ethereum)",
                    value: {
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "100.5",
                      contractAddress: USDT_ETHEREUM_CONTRACT,
                    },
                  },
                  usdtOnBaseTransfer: {
                    summary:
                      "ERC20 transfer (USDT on Base — the token contract differs per network)",
                    value: {
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "100.5",
                      contractAddress: USDT_BASE_CONTRACT,
                    },
                  },
                  gasFreeTransfer: {
                    summary: "Native transfer without the fee pre-check",
                    value: {
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "0.05",
                      gasFree: true,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Transaction accepted by the network RPC.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CreateTransactionResponse",
                  },
                  examples: {
                    success: {
                      value: {
                        txId: "0x1f0f13a2f7f43ba64c9c6a3c73b1a3df9ff29b3467c31b8e93e6de1988f6f0aa",
                        fee: "0.000315",
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Balance check, validation, build, sign or fee-precheck failure.",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/ErrorResponse" },
                      {
                        $ref: "#/components/schemas/EvmTransactionBalanceErrorResponse",
                      },
                    ],
                  },
                  examples: {
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
                    feeShortfall: {
                      value: {
                        error: "Insufficient ETH balance to cover amount and fees",
                        shortfallWei: "315000000000000",
                        feeWei: "315000000000000",
                      },
                    },
                  },
                },
              },
            },
            "404": createErrorResponse(
              "Unknown network key.",
              'Unknown network "goerli"'
            ),
            "502": {
              description:
                "Broadcast request reached the RPC but was not accepted.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/BroadcastErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/{network}/calculate/fees": {
        post: {
          tags: ["Fees"],
          summary: "Calculate EVM transaction fees",
          description: `
Calculates EVM transaction costs without broadcasting anything.

The result contains:

- total worst-case fee in wei and in the native coin
- estimated gas limit (with a safety buffer)
- fee mode used by the network: EIP-1559 or legacy
- per-gas prices: \`baseFeePerGas\`, \`maxPriorityFeePerGas\`, \`maxFeePerGas\` or \`gasPrice\`

Use this endpoint when:

- you want to show a fee preview before confirmation
- you need to validate that a wallet has enough native coin for an ERC20 transfer
- you want to analyze current network gas conditions
          `,
          operationId: "calculateEvmFees",
          parameters: [evmNetworkParameter],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/EvmCalculateFeesRequest",
                },
                examples: {
                  native: {
                    summary: "Native transfer fee calculation",
                    value: {
                      from: EXAMPLE_EVM_ADDRESS,
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "0.05",
                    },
                  },
                  usdt: {
                    summary: "ERC20 transfer fee calculation",
                    value: {
                      from: EXAMPLE_EVM_ADDRESS,
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "100",
                      contract: USDT_ETHEREUM_CONTRACT,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Detailed fee calculation result.",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/EvmCalculateFeesResponse",
                  },
                  examples: {
                    eip1559: {
                      summary: "EIP-1559 network",
                      value: {
                        totalFeeNative: "0.000315",
                        totalFeeWei: "315000000000000",
                        gasLimit: "25200",
                        feeType: "eip1559",
                        baseFeePerGas: "5500000000",
                        maxPriorityFeePerGas: "1500000000",
                        maxFeePerGas: "12500000000",
                        transactionType: "NATIVE_TRANSFER",
                        timestamp: 1729872000000,
                      },
                    },
                    legacy: {
                      summary: "Legacy gas price network",
                      value: {
                        totalFeeNative: "0.000105",
                        totalFeeWei: "105000000000000",
                        gasLimit: "21000",
                        feeType: "legacy",
                        gasPrice: "5000000000",
                        transactionType: "NATIVE_TRANSFER",
                        timestamp: 1729872000000,
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description: "Validation failed for the fee calculation request.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ValidationErrorResponse" },
                },
              },
            },
            "404": createErrorResponse(
              "Unknown network key.",
              'Unknown network "goerli"'
            ),
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

Raw paths are always non-hardened (\`/44/60/0\` derives \`m/44/60/0\`); hardening markers are not supported. Paths whose family cannot be inferred are rejected — use the network-scoped variant for non-BIP44 paths.
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
            "400": createErrorResponse(
              "Malformed path or family cannot be inferred.",
              "Cannot infer the network family from this path. Use a BIP44-shaped path (44/60/... or 44/195/...) or the network-scoped endpoint /{network}/wallet/address/<path>."
            ),
          },
        },
      },
      "/wallet/balance/{path}": {
        get: {
          tags: ["Wallet"],
          summary: "Get a wallet balance by raw path (network via chainId)",
          description: `
Global balance endpoint: the chain family is inferred from the path's coin type.

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
                  },
                },
              },
            },
            "400": createErrorResponse(
              "Malformed path, missing/unknown chainId, or invalid contract address.",
              "The chainId query parameter is required for EVM balances"
            ),
          },
        },
      },
      "/transaction/{path}": {
        post: {
          tags: ["Transaction"],
          summary: "Build, sign and broadcast a transaction (network via chainId)",
          description: `
Global transaction endpoint — the recommended way to send. The chain family is inferred from the path's coin type:

- \`/transaction/44/195/...\` — TRON: body with Base58 addresses, no \`chainId\`
- \`/transaction/44/60/...\` — EVM: body with 0x addresses plus \`chainId\` selecting the network

Execution flow, prechecks, \`gasFree\` and the response are identical to the network-scoped transaction endpoints.
          `,
          operationId: "createTransactionGlobal",
          parameters: [createDerivationPathParameter()],
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
            "400": createErrorResponse(
              "Malformed path, family not inferable, unknown chainId, validation, balance or build/sign failure.",
              "Unknown chainId 10"
            ),
            "502": {
              description: "Broadcast was not accepted by the network.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/BroadcastErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/calculate/fees/{path}": {
        post: {
          tags: ["Fees"],
          summary: "Calculate transaction fees (network via chainId)",
          description: `
Global fee-calculation endpoint: \`from\` is derived from the path, the family from its coin type, and for EVM paths the network is selected by \`chainId\` in the body.
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
            "400": createErrorResponse(
              "Malformed path, family not inferable, unknown chainId, or validation failure.",
              "Validation Error"
            ),
          },
        },
      },
      "/{anyNetwork}/wallet/address/{path}": {
        get: {
          tags: ["Wallet"],
          summary: "Derive an address by raw derivation path (network-scoped)",
          description: `
Returns the address for a raw derivation path in the given network's format.

Any path shape is accepted (BIP44 shape is not required), but a BIP44-shaped path whose coin type contradicts the network family (e.g. \`44/195/...\` on an EVM network) is rejected with 400.
          `,
          operationId: "getWalletAddressByPathScoped",
          parameters: [
            createAnyNetworkPathParameter(evmNetworks),
            createDerivationPathParameter(),
          ],
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
                      summary: "GET /ethereum/wallet/address/44/60/0",
                      value: {
                        address: EXAMPLE_EVM_ADDRESS,
                        path: "m/44/60/0",
                      },
                    },
                    tron: {
                      summary: "GET /tron/wallet/address/44/195/0",
                      value: {
                        address: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                        path: "m/44/195/0",
                      },
                    },
                  },
                },
              },
            },
            "400": createErrorResponse(
              "Malformed path or coin type conflicts with the network family.",
              "Derivation path coin type does not match the evm network family"
            ),
            "404": createErrorResponse(
              "Unknown network key.",
              'Unknown network "goerli"'
            ),
          },
        },
      },
      "/{anyNetwork}/wallet/balance/{path}": {
        get: {
          tags: ["Wallet"],
          summary: "Get a wallet balance by raw derivation path",
          description:
            "Same as the query-parameter balance endpoint, but the wallet is addressed by a raw derivation path. Add `contractAddress` as a query parameter for token balances.",
          operationId: "getWalletBalanceByPath",
          parameters: [
            createAnyNetworkPathParameter(evmNetworks),
            createDerivationPathParameter(),
            {
              name: "contractAddress",
              in: "query",
              required: false,
              description:
                "Token contract address (TRC20 for tron, ERC20 for EVM networks).",
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
                    native: {
                      summary: "GET /ethereum/wallet/balance/44/60/0",
                      value: {
                        asset: "ETH",
                        value: "1500000000000000000",
                      },
                    },
                    token: {
                      summary:
                        "GET /tron/wallet/balance/44/195/0?contractAddress=<USDT>",
                      value: {
                        asset: USDT_TRON_CONTRACT,
                        value: "100000000",
                      },
                    },
                  },
                },
              },
            },
            "400": createErrorResponse(
              "Malformed path, coin type conflict, or invalid contract address.",
              "Validation Error"
            ),
            "404": createErrorResponse(
              "Unknown network key.",
              'Unknown network "goerli"'
            ),
          },
        },
      },
      "/{anyNetwork}/transaction/{path}": {
        post: {
          tags: ["Transaction"],
          summary: "Build, sign and broadcast a transaction by raw derivation path",
          description: `
Same execution flow as the query-parameter transaction endpoint, but the sending wallet is addressed by a raw derivation path.

The request body matches the network family: TRON body with Base58 addresses under \`/tron/transaction/{path}\`, EVM body with 0x addresses under any configured EVM network.
          `,
          operationId: "createTransactionByPath",
          parameters: [
            createAnyNetworkPathParameter(evmNetworks),
            createDerivationPathParameter(),
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
                      $ref: "#/components/schemas/CreateEvmTransactionRequest",
                    },
                  ],
                },
                examples: {
                  trxTransfer: {
                    summary: "POST /tron/transaction/44/195/0 — TRX transfer",
                    value: {
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "1.5",
                    },
                  },
                  trc20Transfer: {
                    summary: "POST /tron/transaction/44/195/0 — USDT (TRC20)",
                    value: {
                      to: "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9",
                      amount: "100.5",
                      contractAddress: USDT_TRON_CONTRACT,
                    },
                  },
                  nativeTransfer: {
                    summary: "POST /ethereum/transaction/44/60/0 — ETH transfer",
                    value: {
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "0.05",
                    },
                  },
                  erc20Transfer: {
                    summary:
                      "POST /ethereum/transaction/44/60/0 — USDT (ERC20)",
                    value: {
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "100.5",
                      contractAddress: USDT_ETHEREUM_CONTRACT,
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
            "400": createErrorResponse(
              "Malformed path, validation, balance or build/sign failure.",
              "Insufficient ERC20 balance"
            ),
            "404": createErrorResponse(
              "Unknown network key.",
              'Unknown network "goerli"'
            ),
            "502": {
              description: "Broadcast was not accepted by the network.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/BroadcastErrorResponse" },
                },
              },
            },
          },
        },
      },
      "/{anyNetwork}/calculate/fees/{path}": {
        post: {
          tags: ["Fees"],
          summary: "Calculate transaction fees by raw derivation path",
          description:
            "Same as the fee-calculation endpoint, but `from` is derived from the raw path instead of being passed in the body. The body contains only `to`, `amount` and optionally `contract`.",
          operationId: "calculateFeesByPath",
          parameters: [
            createAnyNetworkPathParameter(evmNetworks),
            createDerivationPathParameter(),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CalculateFeesByPathRequest",
                },
                examples: {
                  evm: {
                    summary: "POST /ethereum/calculate/fees/44/60/0 — USDT",
                    value: {
                      to: EXAMPLE_EVM_RECIPIENT,
                      amount: "100",
                      contract: USDT_ETHEREUM_CONTRACT,
                    },
                  },
                  tron: {
                    summary: "POST /tron/calculate/fees/44/195/0 — TRX",
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
              description: "Malformed path or validation failure.",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      { $ref: "#/components/schemas/ErrorResponse" },
                      { $ref: "#/components/schemas/ValidationErrorResponse" },
                    ],
                  },
                },
              },
            },
            "404": createErrorResponse(
              "Unknown network key.",
              'Unknown network "goerli"'
            ),
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
          },
        },
        ValidationErrorResponse: {
          type: "object",
          required: ["success", "error"],
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            error: {
              type: "object",
              required: ["message", "issues"],
              properties: {
                message: {
                  type: "string",
                  example: "Validation error",
                },
                issues: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      field: { type: "string", example: "from" },
                      message: {
                        type: "string",
                        example:
                          "Sender and recipient addresses must be different",
                      },
                      code: { type: "string", example: "custom" },
                    },
                  },
                },
              },
            },
          },
        },
        WalletAddressResponse: {
          type: "object",
          required: ["address"],
          properties: {
            address: {
              oneOf: [
                { $ref: "#/components/schemas/TronAddress" },
                { $ref: "#/components/schemas/EvmAddress" },
              ],
              description: "Derived wallet address in the network's format.",
            },
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
                "Optional TRC20 contract address. Omit for native TRX transfers.",
            },
            gasFree: {
              type: "boolean",
              default: false,
              description:
                "Skip the fee pre-check. Useful when bandwidth/energy is delegated to the wallet.",
            },
          },
        },
        CreateEvmTransactionRequest: {
          type: "object",
          required: ["to", "amount"],
          properties: {
            to: { $ref: "#/components/schemas/EvmAddress" },
            amount: { $ref: "#/components/schemas/AmountString" },
            contractAddress: {
              allOf: [{ $ref: "#/components/schemas/EvmAddress" }],
              description:
                "Optional ERC20 contract address. Omit for native coin transfers.",
            },
            gasFree: {
              type: "boolean",
              default: false,
              description:
                "Skip the fee pre-check. Gas parameters are still estimated and applied to the transaction.",
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
                "Optional ERC20 contract address. Omit for native coin transfers.",
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
        BroadcastErrorResponse: {
          type: "object",
          required: ["error", "details"],
          properties: {
            error: {
              type: "string",
              example: "Failed to broadcast transaction",
            },
            details: {
              type: "object",
              properties: {
                result: { type: "boolean", nullable: true },
                txid: { type: "string", nullable: true },
                code: { type: "string", nullable: true },
                message: { type: "string", nullable: true },
              },
            },
          },
        },
        TronCalculateFeesRequest: {
          type: "object",
          required: ["from", "to", "amount"],
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
        EvmCalculateFeesRequest: {
          type: "object",
          required: ["from", "to", "amount"],
          properties: {
            from: { $ref: "#/components/schemas/EvmAddress" },
            to: { $ref: "#/components/schemas/EvmAddress" },
            amount: { $ref: "#/components/schemas/AmountString" },
            contract: {
              allOf: [{ $ref: "#/components/schemas/EvmAddress" }],
              description:
                "Optional ERC20 contract address. If omitted, the calculation is for a native coin transfer.",
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

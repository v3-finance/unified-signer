import { z } from "zod";
import {
  DecimalAmountSchema,
  IdempotencyKeySchema,
  NonNegativeIntSchema,
  OptionalTronContractAddressSchema,
  TronAddressSchema,
} from "./shared";

// The legacy cloud-tron-wallet query scheme, byte-compatible with what
// existing clients send. BIP32 accepts uint32 child indexes; the hardened
// level (appId) must stay below 2^31. Values 2^31..2^32-1 at unhardened
// levels have always worked.
const HardenedIndexSchema = NonNegativeIntSchema.max(2 ** 31 - 1);
const ChildIndexSchema = NonNegativeIntSchema.max(2 ** 32 - 1);

export const LegacyDerivationFieldsSchema = z.object({
  appId: HardenedIndexSchema,
  purpose: ChildIndexSchema,
  asset: ChildIndexSchema,
  stage: ChildIndexSchema,
  index: ChildIndexSchema,
});

export const LegacyDerivationQuerySchema = LegacyDerivationFieldsSchema;

export const LegacyBalanceQuerySchema = LegacyDerivationFieldsSchema.extend({
  contractAddress: OptionalTronContractAddressSchema,
});

export const LegacyHistoryQuerySchema = LegacyBalanceQuerySchema;

export const LegacyTransactionBodySchema = z.object({
  to: TronAddressSchema,
  amount: DecimalAmountSchema,
  contractAddress: OptionalTronContractAddressSchema,
  gasFree: z.boolean().default(false),
});

// Hono lowercases header names before validation.
export const LegacyTransactionHeadersSchema = z.object({
  "idempotency-key": IdempotencyKeySchema.optional(),
});

export const MonitorWalletRequestSchema = z.object({
  address: TronAddressSchema,
});

export const WebhookPayloadSchema = z.object({
  network: z.enum(["TRON"]),
  asset: z.enum(["A7A5", "USDT", "TRX"]),
  contract: z.enum([
    "TLeVfrdym8RoJreJ23dAGyfJDygRtiWKBZ",
    "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "native",
  ]),
  type: z.enum(["TOPUP"]),
  id: z.string(),
  block: z.number(),
  from: TronAddressSchema,
  to: TronAddressSchema,
  value: z.coerce.number().int().nonnegative(),
  timestamp: z.number(),
});

export type LegacyDerivationParams = z.infer<typeof LegacyDerivationFieldsSchema>;
export type LegacyTransactionBody = z.infer<typeof LegacyTransactionBodySchema>;

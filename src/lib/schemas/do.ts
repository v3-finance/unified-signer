import { z } from "zod";
import {
  AnyAddressSchema,
  DecimalAmountSchema,
  DerivationPathSchema,
  EvmAddressSchema,
  OptionalAnyContractAddressSchema,
  TronAddressSchema,
} from "./shared";
import { EvmUnsignedTxSchema, RawTransactionSchema } from "./evm";

export const TronTxTypeSchema = z.enum(["TRX", "TRC20"]);

export const TronTxBuildRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TRX"),
    from: TronAddressSchema,
    to: TronAddressSchema,
    amount: DecimalAmountSchema,
  }),
  z.object({
    type: z.literal("TRC20"),
    from: TronAddressSchema,
    to: TronAddressSchema,
    amount: DecimalAmountSchema,
    contractAddress: TronAddressSchema,
  }),
]);

export const TronTxBuildResponseSchema = z.object({
  ok: z.boolean(),
  transaction: z.unknown().optional(),
  error: z.string().optional(),
});

const FeeSchema = z.union([z.number(), z.string()]);

const IdempotencyClaimSchema = z.object({
  key: z.string().min(1).max(160),
  fingerprint: z.string().min(1),
  fee: FeeSchema.optional(),
  // Replace the record's transaction only if it is still this one.
  replaceTxId: z.string().optional(),
});

export const TronTxSignRequestSchema = z.object({
  path: DerivationPathSchema,
  transaction: z.unknown(),
  idempotency: IdempotencyClaimSchema.optional(),
});

export const TronTxSignResponseSchema = z.object({
  ok: z.boolean(),
  signedTx: z.unknown().optional(),
  txId: z.string().optional(),
  error: z.string().optional(),
});

export const IdempotencyRecordSchema = z.object({
  fingerprint: z.string(),
  txId: z.string(),
  status: z.enum(["signed", "broadcast"]),
  // Kept until the broadcast is confirmed, so a retry can resend the same tx:
  // the signed TRON transaction object, or the raw EVM transaction hex.
  signedTx: z.unknown().optional(),
  // TRON only — raw_data.expiration, after which the tx can never be included.
  expiresAt: z.number().optional(),
  // EVM only — the nonce the stored transaction occupies.
  nonce: z.number().int().nonnegative().optional(),
  fee: FeeSchema.optional(),
  createdAt: z.number(),
});

export const IdempotencyLookupQuerySchema = z.object({
  key: z.string().min(1).max(160),
});

export const IdempotencyLookupResponseSchema = z.object({
  record: IdempotencyRecordSchema.nullable(),
});

export const IdempotencyBroadcastRequestSchema = z.object({
  key: z.string().min(1).max(160),
  txId: z.string(),
});

export const IdempotencyMutationResponseSchema = z.object({
  ok: z.boolean(),
});

export const EvmTxTypeSchema = z.enum(["NATIVE", "ERC20"]);

export const EvmTxBuildRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("NATIVE"),
    network: z.string().min(1),
    from: EvmAddressSchema,
    to: EvmAddressSchema,
    amount: DecimalAmountSchema,
  }),
  z.object({
    type: z.literal("ERC20"),
    network: z.string().min(1),
    from: EvmAddressSchema,
    to: EvmAddressSchema,
    amount: DecimalAmountSchema,
    contractAddress: EvmAddressSchema,
  }),
]);

export const EvmTxBuildResponseSchema = z.object({
  ok: z.boolean(),
  transaction: EvmUnsignedTxSchema.optional(),
  error: z.string().optional(),
});

export const EvmTxSignRequestSchema = z.object({
  path: DerivationPathSchema,
  transaction: EvmUnsignedTxSchema,
  idempotency: IdempotencyClaimSchema.optional(),
});

export const EvmTxSignResponseSchema = z.object({
  ok: z.boolean(),
  rawTransaction: RawTransactionSchema.optional(),
  txId: z.string().optional(),
  error: z.string().optional(),
});

export const EvmNonceReleaseRequestSchema = z.object({
  network: z.string().min(1),
  address: EvmAddressSchema,
  nonce: z.number().int().nonnegative(),
});

export const RegistryAddressQuerySchema = z.object({
  network: z.string().min(1),
  path: DerivationPathSchema,
});

export const RegistryBalanceQuerySchema = RegistryAddressQuerySchema.extend({
  contractAddress: OptionalAnyContractAddressSchema,
});

export const AddressResponseSchema = z.object({
  address: AnyAddressSchema,
});

export const WalletBalanceResponse = z.object({
  value: z.string(),
});

const TRC20TransferSchema = z.object({
  txID: z.string(),
  timestamp: z.number(),
  from: z.string(),
  to: z.string(),
  amountSun: z.string(),
  contractAddress: z.string(),
  tokenSymbol: z.string().optional(),
  tokenDecimals: z.number().optional(),
  direction: z.enum(["in", "out"]),
});

const TrxTransferSchema = z.object({
  txID: z.string(),
  timestamp: z.number(),
  from: z.string(),
  to: z.string(),
  amountSun: z.string(),
  direction: z.enum(["in", "out"]),
});

export const WalletHistoryResponseSchema = z.array(
  z.union([TRC20TransferSchema, TrxTransferSchema])
);

export type TronTxBuildRequest = z.infer<typeof TronTxBuildRequestSchema>;
export type TronTxBuildResponse = z.infer<typeof TronTxBuildResponseSchema>;
export type TronTxSignRequest = z.infer<typeof TronTxSignRequestSchema>;
export type TronTxSignResponse = z.infer<typeof TronTxSignResponseSchema>;
export type EvmTxBuildRequest = z.infer<typeof EvmTxBuildRequestSchema>;
export type EvmTxBuildResponse = z.infer<typeof EvmTxBuildResponseSchema>;
export type EvmTxSignRequest = z.infer<typeof EvmTxSignRequestSchema>;
export type EvmTxSignResponse = z.infer<typeof EvmTxSignResponseSchema>;
export type RegistryAddressQuery = z.infer<typeof RegistryAddressQuerySchema>;
export type RegistryBalanceQuery = z.infer<typeof RegistryBalanceQuerySchema>;
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;
export type IdempotencyLookupQuery = z.infer<typeof IdempotencyLookupQuerySchema>;
export type IdempotencyBroadcastRequest = z.infer<
  typeof IdempotencyBroadcastRequestSchema
>;
export type EvmNonceReleaseRequest = z.infer<typeof EvmNonceReleaseRequestSchema>;

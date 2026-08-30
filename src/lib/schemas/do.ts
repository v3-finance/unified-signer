import { z } from "zod";
import {
  AnyAddressSchema,
  DecimalAmountSchema,
  EvmAddressSchema,
  OptionalAnyContractAddressSchema,
  TronAddressSchema,
  WalletDerivationFieldsSchema,
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

export const TronTxSignRequestSchema = WalletDerivationFieldsSchema.extend({
  transaction: z.unknown(),
});

export const TronTxSignResponseSchema = z.object({
  ok: z.boolean(),
  signedTx: z.unknown().optional(),
  error: z.string().optional(),
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

export const EvmTxSignRequestSchema = WalletDerivationFieldsSchema.extend({
  transaction: EvmUnsignedTxSchema,
});

export const EvmTxSignResponseSchema = z.object({
  ok: z.boolean(),
  rawTransaction: RawTransactionSchema.optional(),
  error: z.string().optional(),
});

export const RegistryAddressQuerySchema = WalletDerivationFieldsSchema.extend({
  network: z.string().min(1),
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
export type WalletDerivationParams = z.infer<typeof WalletDerivationFieldsSchema>;

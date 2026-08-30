import { getAddress, isAddress } from "viem";
import { z } from "zod";

export const NonNegativeIntSchema = z.coerce.number().int().nonnegative();

export const TRON_ADDRESS_PATTERN = /^T[A-Za-z0-9]{33}$/;
export const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export const TronAddressSchema = z
  .string()
  .trim()
  .regex(TRON_ADDRESS_PATTERN, "Invalid TRON address");

export const EvmAddressSchema = z
  .string()
  .trim()
  .regex(EVM_ADDRESS_PATTERN, "Invalid EVM address")
  .transform((value, ctx) => {
    // isAddress validates the EIP-55 checksum for mixed-case input, which
    // getAddress alone would silently "fix".
    if (!isAddress(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid EVM address checksum",
      });
      return z.NEVER;
    }

    return getAddress(value);
  });

export const AnyAddressSchema = z.union([
  TronAddressSchema,
  z.string().trim().regex(EVM_ADDRESS_PATTERN, "Invalid EVM address"),
]);

export const DecimalAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal string")
  .refine((value) => Number(value) > 0, "Amount must be greater than 0");

export const WalletDerivationFieldsSchema = z.object({
  appId: NonNegativeIntSchema,
  purpose: NonNegativeIntSchema,
  asset: NonNegativeIntSchema,
  stage: NonNegativeIntSchema,
  index: NonNegativeIntSchema,
});

export const WalletDerivationQuerySchema = WalletDerivationFieldsSchema;

function optionalContractAddress<Schema extends z.ZodTypeAny>(schema: Schema) {
  return z
    .union([schema, z.literal(""), z.literal("undefined"), z.null()])
    .optional()
    .transform((value) =>
      value && value !== "undefined" ? (value as z.output<Schema>) : undefined
    );
}

export const OptionalTronContractAddressSchema =
  optionalContractAddress(TronAddressSchema);

export const OptionalEvmContractAddressSchema =
  optionalContractAddress(EvmAddressSchema);

export const OptionalAnyContractAddressSchema =
  optionalContractAddress(AnyAddressSchema);

export const TronWalletBalanceQuerySchema = WalletDerivationFieldsSchema.extend({
  contractAddress: OptionalTronContractAddressSchema,
});

export const EvmWalletBalanceQuerySchema = WalletDerivationFieldsSchema.extend({
  contractAddress: OptionalEvmContractAddressSchema,
});

export type WalletDerivationParams = z.infer<typeof WalletDerivationFieldsSchema>;
export type TronWalletBalanceQuery = z.infer<typeof TronWalletBalanceQuerySchema>;
export type EvmWalletBalanceQuery = z.infer<typeof EvmWalletBalanceQuerySchema>;

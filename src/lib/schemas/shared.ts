import { TronWeb } from "tronweb";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

export const NonNegativeIntSchema = z.coerce.number().int().nonnegative();

export const TRON_ADDRESS_PATTERN = /^T[A-Za-z0-9]{33}$/;
export const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

export const TronAddressSchema = z
  .string()
  .trim()
  .regex(TRON_ADDRESS_PATTERN, "Invalid TRON address")
  .refine((value) => TronWeb.isAddress(value), "Invalid TRON address checksum");

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

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7E]+$/, "Idempotency key must be printable ASCII without spaces");

export const DecimalAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal string")
  .refine((value) => Number(value) > 0, "Amount must be greater than 0");

// Canonical derivation path for the DO contracts. Two producers feed it:
// buildDerivationPath (legacy field scheme, hardened prefix "m/44'/195'/0'/..."
// whose unhardened levels may use full uint32 indexes, as the legacy API
// always allowed) and parseRawDerivationSegments (raw URL paths, always
// non-hardened, capped at 2^31). Apostrophes are the only hardening notation;
// depth is capped at 10 levels.
export const DerivationPathSchema = z
  .string()
  .regex(/^m(\/\d+'?){1,10}$/, "Invalid derivation path")
  .refine(
    (value) =>
      value
        .split("/")
        .slice(1)
        .every((segment) => Number.parseInt(segment, 10) < 0x100000000),
    "Derivation path index out of range"
  );

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


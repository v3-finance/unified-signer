import { z } from "zod";
import { DecimalAmountSchema, EvmAddressSchema } from "./shared";

export const WeiAmountSchema = z
  .string()
  .regex(/^\d+$/, "Must be a non-negative integer string");

export const HexDataSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, "Must be a 0x-prefixed hex string");

export const RawTransactionSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "Must be a 0x-prefixed hex string");

const evmCalculateFields = {
  from: EvmAddressSchema,
  to: EvmAddressSchema,
  amount: DecimalAmountSchema,
  contract: EvmAddressSchema.optional(),
};

function withCalculateRefinements<
  Schema extends z.ZodType<{ from: string; to: string; contract?: string }>,
>(schema: Schema) {
  return schema
    .refine((data) => data.from !== data.to, {
      message: "Sender and recipient addresses must be different",
      path: ["to"],
    })
    .refine(
      (data) =>
        !data.contract ||
        (data.contract !== data.from && data.contract !== data.to),
      {
        message:
          "Contract address must not match the sender or recipient address",
        path: ["contract"],
      }
    );
}

export const evmCalculateSchema = withCalculateRefinements(
  z.object(evmCalculateFields)
);

export const EvmCalculateDoRequestSchema = withCalculateRefinements(
  z.object({
    network: z.string().min(1),
    ...evmCalculateFields,
  })
);

export const evmCalculateResponseSchema = z.object({
  totalFeeNative: z.string(),
  totalFeeWei: WeiAmountSchema,
  gasLimit: WeiAmountSchema,
  feeType: z.enum(["eip1559", "legacy"]),
  baseFeePerGas: WeiAmountSchema.optional(),
  maxFeePerGas: WeiAmountSchema.optional(),
  maxPriorityFeePerGas: WeiAmountSchema.optional(),
  gasPrice: WeiAmountSchema.optional(),
  transactionType: z.enum(["NATIVE_TRANSFER", "ERC20_TRANSFER"]),
  timestamp: z.number(),
});

const evmUnsignedTxBase = {
  chainId: z.number().int().positive(),
  nonce: z.number().int().nonnegative(),
  to: EvmAddressSchema,
  value: WeiAmountSchema,
  data: HexDataSchema.optional(),
  gas: WeiAmountSchema,
};

export const EvmUnsignedTxSchema = z.discriminatedUnion("feeType", [
  z.object({
    feeType: z.literal("eip1559"),
    ...evmUnsignedTxBase,
    maxFeePerGas: WeiAmountSchema,
    maxPriorityFeePerGas: WeiAmountSchema,
  }),
  z.object({
    feeType: z.literal("legacy"),
    ...evmUnsignedTxBase,
    gasPrice: WeiAmountSchema,
  }),
]);

export type EvmCalculateRequest = z.infer<typeof evmCalculateSchema>;
export type EvmCalculateDoRequest = z.infer<typeof EvmCalculateDoRequestSchema>;
export type EvmCalculateResponse = z.infer<typeof evmCalculateResponseSchema>;
export type EvmUnsignedTx = z.infer<typeof EvmUnsignedTxSchema>;

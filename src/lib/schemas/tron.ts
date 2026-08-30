import { z } from "zod";
import { DecimalAmountSchema, TronAddressSchema } from "./shared";

export const calculateSchema = z
  .object({
    from: TronAddressSchema,
    to: TronAddressSchema,
    amount: DecimalAmountSchema,
    contract: TronAddressSchema.optional(),
  })
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

export const calculateSchemaResponse = z.object({
  totalFeeTRX: z.number(),
  bandwidth: z.object({
    required: z.number(),
    available: z.object({
      fromStaking: z.number(),
      fromFree: z.number(),
      total: z.number(),
    }),
    coverage: z.object({
      fromStaking: z.number(),
      fromFree: z.number(),
      needsToBurn: z.number(),
      total: z.number(),
    }),
    costTRX: z.number(),
  }),
  energy: z.object({
    required: z.number(),
    available: z.number(),
    coverage: z.object({
      fromStaking: z.number(),
      needsToBurn: z.number(),
    }),
    costTRX: z.number(),
    baseEnergy: z.number(),
    energyFactor: z.number(),
    recipientHasTransactions: z.boolean(),
  }),
  transactionType: z.string(),
  timestamp: z.number(),
});

export type CalculateGasRequest = z.infer<typeof calculateSchema>;
export type CalculateGasResponse = z.infer<typeof calculateSchemaResponse>;

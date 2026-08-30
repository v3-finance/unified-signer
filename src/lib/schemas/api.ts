import { z } from "zod";
import {
  DecimalAmountSchema,
  EvmAddressSchema,
  OptionalEvmContractAddressSchema,
  OptionalTronContractAddressSchema,
  TronAddressSchema,
} from "./shared";

export const CreateTronTransactionBodySchema = z.object({
  to: TronAddressSchema,
  amount: DecimalAmountSchema,
  contractAddress: OptionalTronContractAddressSchema,
  gasFree: z.boolean().default(false),
});

export const CreateEvmTransactionBodySchema = z.object({
  to: EvmAddressSchema,
  amount: DecimalAmountSchema,
  contractAddress: OptionalEvmContractAddressSchema,
  gasFree: z.boolean().default(false),
});

export type CreateTronTransactionBody = z.infer<
  typeof CreateTronTransactionBodySchema
>;
export type CreateEvmTransactionBody = z.infer<
  typeof CreateEvmTransactionBodySchema
>;

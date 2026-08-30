import { describe, expect, test } from "bun:test";
import {
  EvmCalculateDoRequestSchema,
  EvmUnsignedTxSchema,
  evmCalculateResponseSchema,
} from "./evm";

const addressA = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const addressB = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

describe("evm fee calculation schemas", () => {
  test("rejects the same sender and recipient", () => {
    expect(() =>
      EvmCalculateDoRequestSchema.parse({
        network: "ethereum",
        from: addressA,
        to: addressA,
        amount: "1",
      })
    ).toThrow();
  });

  test("rejects contract collisions with sender or recipient", () => {
    expect(() =>
      EvmCalculateDoRequestSchema.parse({
        network: "ethereum",
        from: addressA,
        to: addressB,
        amount: "1",
        contract: addressA,
      })
    ).toThrow();
  });

  test("compares addresses after checksum normalization", () => {
    expect(() =>
      EvmCalculateDoRequestSchema.parse({
        network: "ethereum",
        from: addressA.toLowerCase(),
        to: addressA,
        amount: "1",
      })
    ).toThrow();
  });

  test("accepts a valid calculation response shape", () => {
    const parsed = evmCalculateResponseSchema.parse({
      totalFeeNative: "0.000315",
      totalFeeWei: "315000000000000",
      gasLimit: "25200",
      feeType: "eip1559",
      baseFeePerGas: "5500000000",
      maxPriorityFeePerGas: "1500000000",
      maxFeePerGas: "12500000000",
      transactionType: "NATIVE_TRANSFER",
      timestamp: 1729872000000,
    });

    expect(parsed.feeType).toBe("eip1559");
  });
});

describe("evm unsigned transaction schema", () => {
  test("accepts an eip1559 transaction", () => {
    const parsed = EvmUnsignedTxSchema.parse({
      feeType: "eip1559",
      chainId: 1,
      nonce: 0,
      to: addressB,
      value: "1000000000000000000",
      gas: "21000",
      maxFeePerGas: "12500000000",
      maxPriorityFeePerGas: "1500000000",
    });

    expect(parsed.feeType).toBe("eip1559");
  });

  test("accepts a legacy transaction with call data", () => {
    const parsed = EvmUnsignedTxSchema.parse({
      feeType: "legacy",
      chainId: 56,
      nonce: 12,
      to: addressA,
      value: "0",
      data: "0xa9059cbb",
      gas: "65000",
      gasPrice: "5000000000",
    });

    expect(parsed.feeType).toBe("legacy");
  });

  test("rejects non-integer wei values", () => {
    expect(() =>
      EvmUnsignedTxSchema.parse({
        feeType: "legacy",
        chainId: 56,
        nonce: 12,
        to: addressA,
        value: "1.5",
        gas: "65000",
        gasPrice: "5000000000",
      })
    ).toThrow();
  });
});

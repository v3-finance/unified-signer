import { describe, expect, test } from "bun:test";
import {
  EvmTxBuildRequestSchema,
  EvmTxSignRequestSchema,
  RegistryBalanceQuerySchema,
  TronTxBuildRequestSchema,
  TronTxSignRequestSchema,
} from "./do";

const tronAddressA = "TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9";
const tronAddressB = "TUdbkixK7zU4ua7YC2oNz6ujsfZxb98GFb";
const evmAddressA = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const evmAddressB = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

describe("durable object schemas", () => {
  test("requires contractAddress for TRC20 transaction builds", () => {
    expect(() =>
      TronTxBuildRequestSchema.parse({
        type: "TRC20",
        from: tronAddressA,
        to: tronAddressB,
        amount: "1",
      })
    ).toThrow();
  });

  test("accepts valid tron signer payloads with purpose", () => {
    const parsed = TronTxSignRequestSchema.parse({
      appId: "1",
      purpose: "2",
      asset: "3",
      stage: "4",
      index: "5",
      transaction: { raw_data: {} },
    });

    expect(parsed).toEqual({
      appId: 1,
      purpose: 2,
      asset: 3,
      stage: 4,
      index: 5,
      transaction: { raw_data: {} },
    });
  });

  test("requires contractAddress for ERC20 transaction builds", () => {
    expect(() =>
      EvmTxBuildRequestSchema.parse({
        type: "ERC20",
        network: "ethereum",
        from: evmAddressA,
        to: evmAddressB,
        amount: "1",
      })
    ).toThrow();
  });

  test("accepts native evm build requests", () => {
    const parsed = EvmTxBuildRequestSchema.parse({
      type: "NATIVE",
      network: "ethereum",
      from: evmAddressA.toLowerCase(),
      to: evmAddressB,
      amount: "0.5",
    });

    expect(parsed.from).toBe(evmAddressA);
  });

  test("accepts a full evm sign payload", () => {
    const parsed = EvmTxSignRequestSchema.parse({
      appId: 0,
      purpose: 0,
      asset: 0,
      stage: 0,
      index: 0,
      transaction: {
        feeType: "eip1559",
        chainId: 1,
        nonce: 7,
        to: evmAddressB,
        value: "500000000000000000",
        gas: "21000",
        maxFeePerGas: "12500000000",
        maxPriorityFeePerGas: "1500000000",
      },
    });

    expect(parsed.transaction.feeType).toBe("eip1559");
  });

  test("rejects a sign payload mixing fee modes", () => {
    expect(() =>
      EvmTxSignRequestSchema.parse({
        appId: 0,
        purpose: 0,
        asset: 0,
        stage: 0,
        index: 0,
        transaction: {
          feeType: "legacy",
          chainId: 1,
          nonce: 7,
          to: evmAddressB,
          value: "0",
          gas: "21000",
          maxFeePerGas: "12500000000",
        },
      })
    ).toThrow();
  });

  test("accepts registry balance queries for both families", () => {
    const tron = RegistryBalanceQuerySchema.parse({
      network: "tron",
      appId: "0",
      purpose: "0",
      asset: "0",
      stage: "0",
      index: "0",
      contractAddress: tronAddressA,
    });
    const evm = RegistryBalanceQuerySchema.parse({
      network: "ethereum",
      appId: "0",
      purpose: "0",
      asset: "0",
      stage: "0",
      index: "0",
      contractAddress: evmAddressA,
    });

    expect(tron.contractAddress).toBe(tronAddressA);
    expect(evm.contractAddress).toBe(evmAddressA);
  });
});

import { describe, expect, test } from "bun:test";
import {
  EvmAddressSchema,
  EvmWalletBalanceQuerySchema,
  TronWalletBalanceQuerySchema,
  WalletDerivationQuerySchema,
} from "./shared";

describe("wallet query schemas", () => {
  test("accepts canonical purpose field", () => {
    const parsed = WalletDerivationQuerySchema.parse({
      appId: "1",
      purpose: "2",
      asset: "3",
      stage: "4",
      index: "5",
    });

    expect(parsed).toEqual({
      appId: 1,
      purpose: 2,
      asset: 3,
      stage: 4,
      index: 5,
    });
  });

  test("normalizes optional contractAddress values", () => {
    const parsed = TronWalletBalanceQuerySchema.parse({
      appId: "1",
      purpose: "2",
      asset: "3",
      stage: "4",
      index: "5",
      contractAddress: "undefined",
    });

    expect(parsed).toEqual({
      appId: 1,
      purpose: 2,
      asset: 3,
      stage: 4,
      index: 5,
      contractAddress: undefined,
    });
  });

  test("rejects legacy purpuse alias", () => {
    expect(() =>
      WalletDerivationQuerySchema.parse({
        appId: "1",
        purpuse: "2",
        asset: "3",
        stage: "4",
        index: "5",
      })
    ).toThrow();
  });
});

describe("evm address schema", () => {
  test("checksums lowercase addresses", () => {
    expect(
      EvmAddressSchema.parse("0xdac17f958d2ee523a2206206994597c13d831ec7")
    ).toBe("0xdAC17F958D2ee523a2206206994597C13D831ec7");
  });

  test("accepts valid checksummed addresses", () => {
    expect(
      EvmAddressSchema.parse("0xdAC17F958D2ee523a2206206994597C13D831ec7")
    ).toBe("0xdAC17F958D2ee523a2206206994597C13D831ec7");
  });

  test("rejects an invalid checksum", () => {
    expect(() =>
      EvmAddressSchema.parse("0xDAC17f958d2ee523a2206206994597c13d831ec7")
    ).toThrow();
  });

  test("rejects malformed addresses", () => {
    expect(() => EvmAddressSchema.parse("0x1234")).toThrow();
    expect(() =>
      EvmAddressSchema.parse("TJRkbhnep1CqUSSKamhDWLpfTGLU2s7se9")
    ).toThrow();
  });

  test("normalizes optional evm contract addresses in queries", () => {
    const parsed = EvmWalletBalanceQuerySchema.parse({
      appId: "0",
      purpose: "0",
      asset: "0",
      stage: "0",
      index: "0",
      contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    });

    expect(parsed.contractAddress).toBe(
      "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    );
  });
});

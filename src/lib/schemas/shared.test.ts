import { describe, expect, test } from "bun:test";
import {
  DerivationPathSchema,
  EvmAddressSchema,
  OptionalEvmContractAddressSchema,
  OptionalTronContractAddressSchema,
} from "./shared";

describe("optional contract address schemas", () => {
  test("normalizes empty and placeholder values to undefined", () => {
    expect(OptionalTronContractAddressSchema.parse("undefined")).toBeUndefined();
    expect(OptionalTronContractAddressSchema.parse("")).toBeUndefined();
    expect(OptionalTronContractAddressSchema.parse(null)).toBeUndefined();
    expect(OptionalTronContractAddressSchema.parse(undefined)).toBeUndefined();
  });

  test("passes valid contract addresses through", () => {
    expect(
      OptionalTronContractAddressSchema.parse(
        "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
      )
    ).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(
      OptionalEvmContractAddressSchema.parse(
        "0xdac17f958d2ee523a2206206994597c13d831ec7"
      )
    ).toBe("0xdAC17F958D2ee523a2206206994597C13D831ec7");
  });
});

describe("derivation path schema", () => {
  test("accepts canonical hardened and non-hardened paths", () => {
    expect(DerivationPathSchema.parse("m/44/60/0")).toBe("m/44/60/0");
    expect(DerivationPathSchema.parse("m/44'/195'/0'/0/0")).toBe(
      "m/44'/195'/0'/0/0"
    );
  });

  test("rejects malformed and out-of-range paths", () => {
    expect(() => DerivationPathSchema.parse("44/60/0")).toThrow();
    expect(() => DerivationPathSchema.parse("m/44h/60h")).toThrow();
    expect(() => DerivationPathSchema.parse("m/2147483648")).toThrow();
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
});

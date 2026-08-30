import { describe, expect, test } from "bun:test";
import {
  listEvmChainIds,
  listNetworkKeys,
  parseEvmNetworks,
  resolveEvmNetworkByChainId,
  resolveNetwork,
} from "./networks";

const validNetworks = [
  {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1,
    rpcUrl: "https://cloudflare-eth.com",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    feeType: "eip1559",
  },
  {
    key: "bsc",
    name: "BNB Smart Chain",
    chainId: 56,
    rpcUrl: "https://bsc-dataseed.bnbchain.org",
    nativeSymbol: "BNB",
    feeType: "legacy",
  },
];

describe("network configuration", () => {
  test("parses a JSON string of networks", () => {
    const parsed = parseEvmNetworks(JSON.stringify(validNetworks));

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.key).toBe("ethereum");
    expect(parsed[1]?.nativeDecimals).toBe(18);
    expect(parsed[1]?.feeType).toBe("legacy");
  });

  test("parses an already-decoded array", () => {
    expect(parseEvmNetworks(validNetworks)).toHaveLength(2);
  });

  test("returns an empty list for missing configuration", () => {
    expect(parseEvmNetworks(undefined)).toEqual([]);
    expect(parseEvmNetworks("")).toEqual([]);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseEvmNetworks("not json")).toThrow(
      "EVM_NETWORKS is not valid JSON"
    );
  });

  test("rejects the reserved tron key", () => {
    expect(() =>
      parseEvmNetworks([{ ...validNetworks[0], key: "tron" }])
    ).toThrow('reserved');
  });

  test("rejects duplicate keys and chain ids", () => {
    expect(() =>
      parseEvmNetworks([validNetworks[0], { ...validNetworks[1], key: "ethereum" }])
    ).toThrow("Duplicate network key");
    expect(() =>
      parseEvmNetworks([validNetworks[0], { ...validNetworks[1], chainId: 1 }])
    ).toThrow("Duplicate chainId");
  });

  test("lists tron plus configured evm networks", () => {
    expect(listNetworkKeys(JSON.stringify(validNetworks))).toEqual([
      "tron",
      "ethereum",
      "bsc",
    ]);
  });

  test("resolves evm networks by chainId", () => {
    const input = JSON.stringify(validNetworks);

    expect(resolveEvmNetworkByChainId(56, input)?.key).toBe("bsc");
    expect(resolveEvmNetworkByChainId(999, input)).toBeUndefined();
    expect(listEvmChainIds(input)).toEqual([1, 56]);
  });

  test("resolves tron and evm networks", () => {
    const tron = resolveNetwork("tron", JSON.stringify(validNetworks));
    const ethereum = resolveNetwork("ethereum", JSON.stringify(validNetworks));

    expect(tron?.family).toBe("tron");
    expect(ethereum?.family).toBe("evm");

    if (ethereum?.family === "evm") {
      expect(ethereum.config.chainId).toBe(1);
    }

    expect(resolveNetwork("goerli", JSON.stringify(validNetworks))).toBeUndefined();
  });
});

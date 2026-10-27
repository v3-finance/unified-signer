import { describe, expect, test } from "bun:test";
import { createOpenApiDocument } from "./openapi";

const evmNetworks = [
  {
    key: "ethereum",
    name: "Ethereum",
    chainId: 1,
    rpcUrl: "https://cloudflare-eth.com",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    feeType: "eip1559" as const,
  },
  {
    key: "bsc",
    name: "BNB Smart Chain",
    chainId: 56,
    rpcUrl: "https://bsc-dataseed.bnbchain.org",
    nativeSymbol: "BNB",
    nativeDecimals: 18,
    feeType: "legacy" as const,
  },
];

describe("openapi document", () => {
  test("documents exactly the global endpoint surface", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);

    expect(Object.keys(document.paths).sort()).toEqual(
      [
        "/",
        "/doc",
        "/llms.txt",
        "/wallet/address/{path}",
        "/wallet/balance/{path}",
        "/transaction/{path}",
        "/calculate/fees/{path}",
        // Legacy cloud-tron-wallet compatibility surface.
        "/wallet/address",
        "/wallet/balance",
        "/wallet/history",
        "/transaction",
        "/calculate/fees",
      ].sort()
    );
  });

  test("does not document removed network-prefixed or monitoring routes", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);
    const paths = Object.keys(document.paths);

    expect(paths.some((path) => path.includes("{network}"))).toBe(false);
    expect(paths.some((path) => path.startsWith("/tron/"))).toBe(false);
    expect(document.paths["/transaction"].post.tags).toEqual(["Legacy"]);
    expect(paths.some((path) => path.includes("monitor"))).toBe(false);
    expect(paths.some((path) => path.includes("webhook"))).toBe(false);
  });

  test("exposes configured chain ids in the transaction body schema", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);
    const byChainRequest =
      document.components.schemas.CreateEvmTransactionByChainRequest;

    expect(byChainRequest.properties.chainId.enum).toEqual([1, 56]);
    expect(
      document.components.schemas.CalculateFeesByChainRequest.properties
        .chainId.enum
    ).toEqual([1, 56]);
  });

  test("describes non-hardened paths and both coin types", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);

    expect(document.info.description).toContain("non-hardened");
    expect(document.info.description).toContain("44/60");
    expect(document.info.description).toContain("44/195");
    expect(document.info.description).toContain("chainId");
    expect(document.info.description).toContain("`tron`, `ethereum`, `bsc`");
  });

  test("keeps fee response schemas for both families", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);

    expect(document.components.schemas.TronCalculateFeesResponse).toBeDefined();
    expect(document.components.schemas.EvmCalculateFeesResponse).toBeDefined();
    expect(
      document.paths["/transaction/{path}"].post.summary.length
    ).toBeGreaterThan(0);
  });
});

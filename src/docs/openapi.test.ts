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
  test("documents purpose without the legacy alias", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);
    const parameters = document.paths["/tron/wallet/address"].get.parameters;
    const purposeParameter = parameters.find(
      (parameter) => parameter.name === "purpose"
    );

    expect(purposeParameter?.description).toContain("purpose");
    expect(JSON.stringify(document)).not.toContain("purpuse");
  });

  test("includes transaction endpoints for both families", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);

    expect(document.paths["/tron/transaction"].post.summary).toBe(
      "Build, sign and broadcast a TRON transaction"
    );
    expect(document.paths["/{network}/transaction"].post.summary).toBe(
      "Build, sign and broadcast an EVM transaction"
    );
  });

  test("exposes configured evm networks in the path parameter", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);
    const networkParameter = document.paths[
      "/{network}/wallet/address"
    ].get.parameters.find((parameter) => parameter.name === "network");

    expect(networkParameter?.schema).toMatchObject({
      enum: ["ethereum", "bsc"],
    });
  });

  test("documents both derivation trees", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);

    expect(document.info.description).toContain("m/44'/195'");
    expect(document.info.description).toContain("m/44'/60'");
    expect(document.info.description).toContain("`tron`, `ethereum`, `bsc`");
  });

  test("does not document monitoring or webhook routes", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);
    const paths = Object.keys(document.paths);

    expect(paths.some((path) => path.includes("monitor"))).toBe(false);
    expect(paths.some((path) => path.includes("webhook"))).toBe(false);
  });

  test("includes evm fee calculation schemas", () => {
    const document = createOpenApiDocument("https://signer.example", evmNetworks);

    expect(document.components.schemas.EvmCalculateFeesResponse).toBeDefined();
    expect(document.components.schemas.TronCalculateFeesResponse).toBeDefined();
  });
});

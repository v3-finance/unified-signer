import { describe, expect, test } from "bun:test";
import {
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createDerivationRoot } from "../derivation";
import { deriveEvmAddressFromRoot, deriveEvmPrivateKeyFromRoot } from "./derivation";
import { signEvmTransaction } from "./sign";

const mnemonic =
  "test test test test test test test test test test test ball";

const baseParams = {
  appId: 0,
  purpose: 0,
  asset: 0,
  stage: 0,
  index: 0,
};

const recipient = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e" as const;

describe("evm signing", () => {
  test("signs an eip1559 transaction that parses back to the same fields", async () => {
    const root = createDerivationRoot(mnemonic);
    const privateKey = deriveEvmPrivateKeyFromRoot(root, baseParams);

    const raw = await signEvmTransaction(privateKey, {
      feeType: "eip1559",
      chainId: 1,
      nonce: 7,
      to: recipient,
      value: "50000000000000000",
      gas: "21000",
      maxFeePerGas: "86658071",
      maxPriorityFeePerGas: "70215",
    });

    const parsed = parseTransaction(raw);

    expect(parsed.type).toBe("eip1559");
    expect(parsed.chainId).toBe(1);
    expect(parsed.nonce).toBe(7);
    expect(parsed.to?.toLowerCase()).toBe(recipient.toLowerCase());
    expect(parsed.value).toBe(50000000000000000n);
    expect(parsed.gas).toBe(21000n);
    expect(parsed.maxFeePerGas).toBe(86658071n);
    expect(parsed.maxPriorityFeePerGas).toBe(70215n);

    const sender = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerialized,
    });
    expect(sender).toBe(deriveEvmAddressFromRoot(root, baseParams));
  });

  test("signs a legacy transaction with call data", async () => {
    const root = createDerivationRoot(mnemonic);
    const privateKey = deriveEvmPrivateKeyFromRoot(root, baseParams);
    const data =
      "0xa9059cbb000000000000000000000000742d35cc6634c0532925a3b844bc454e4438f44e0000000000000000000000000000000000000000000000000000000005f5e100";

    const raw = await signEvmTransaction(privateKey, {
      feeType: "legacy",
      chainId: 56,
      nonce: 0,
      to: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      value: "0",
      data,
      gas: "65000",
      gasPrice: "50000000",
    });

    const parsed = parseTransaction(raw);

    expect(parsed.type).toBe("legacy");
    expect(parsed.chainId).toBe(56);
    expect(parsed.gasPrice).toBe(50000000n);
    expect(parsed.data).toBe(data);

    const sender = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerialized,
    });
    expect(sender).toBe(deriveEvmAddressFromRoot(root, baseParams));
  });

  test("signature matches the account derived from the same private key", async () => {
    const root = createDerivationRoot(mnemonic);
    const privateKey = deriveEvmPrivateKeyFromRoot(root, baseParams);
    const account = privateKeyToAccount(privateKey);

    expect(account.address).toBe(deriveEvmAddressFromRoot(root, baseParams));
  });
});

import { describe, expect, test } from "bun:test";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  buildDerivationPath,
  createDerivationRoot,
  derivePrivateKeyFromMnemonic,
  derivePrivateKeyFromRoot,
} from "./derivation";
import { deriveEvmAddressFromRoot } from "./evm/derivation";

const mnemonic =
  "test test test test test test test test test test test ball";

const baseParams = {
  appId: 0,
  purpose: 0,
  asset: 1,
  stage: 2,
  index: 3,
};

describe("derivation helpers", () => {
  test("builds the expected tron derivation path", () => {
    expect(buildDerivationPath("tron", baseParams)).toBe(
      "m/44'/195'/0'/0/1/2/3"
    );
  });

  test("builds the expected evm derivation path", () => {
    expect(buildDerivationPath("evm", baseParams)).toBe("m/44'/60'/0'/0/1/2/3");
  });

  test("derives the same private key from mnemonic and root", () => {
    const root = createDerivationRoot(mnemonic);
    const fromMnemonic = derivePrivateKeyFromMnemonic(
      mnemonic,
      "tron",
      baseParams
    );
    const fromRoot = derivePrivateKeyFromRoot(root, "tron", baseParams);

    expect(fromMnemonic).toBe(fromRoot);
    expect(fromMnemonic).toHaveLength(64);
  });

  test("derives different keys per chain family", () => {
    const tronKey = derivePrivateKeyFromMnemonic(mnemonic, "tron", baseParams);
    const evmKey = derivePrivateKeyFromMnemonic(mnemonic, "evm", baseParams);

    expect(tronKey).not.toBe(evmKey);
  });

  test("changes derived keys when derivation params change", () => {
    const firstKey = derivePrivateKeyFromMnemonic(mnemonic, "tron", baseParams);
    const secondKey = derivePrivateKeyFromMnemonic(mnemonic, "tron", {
      ...baseParams,
      index: 4,
    });

    expect(firstKey).not.toBe(secondKey);
  });

  test("evm derivation matches viem's independent implementation", () => {
    const root = createDerivationRoot(mnemonic);
    const address = deriveEvmAddressFromRoot(root, baseParams);

    const viemAccount = mnemonicToAccount(mnemonic, {
      path: buildDerivationPath("evm", baseParams) as `m/44'/60'/${string}`,
    });

    expect(address).toBe(viemAccount.address);
  });

  test("evm private key produces the derived evm address", () => {
    const root = createDerivationRoot(mnemonic);
    const privateKey = derivePrivateKeyFromRoot(root, "evm", baseParams);
    const account = privateKeyToAccount(`0x${privateKey}`);

    expect(deriveEvmAddressFromRoot(root, baseParams)).toBe(account.address);
  });
});

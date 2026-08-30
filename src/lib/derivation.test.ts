import { describe, expect, test } from "bun:test";
import * as bip39 from "bip39";
import { HDKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  buildDerivationPath,
  createDerivationRoot,
  derivePrivateKeyFromMnemonic,
  derivePrivateKeyFromPath,
  derivePrivateKeyFromRoot,
  inferFamilyFromPath,
  parseRawDerivationSegments,
  pathFamilyConflict,
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

describe("raw derivation paths", () => {
  test("canonicalizes h and apostrophe hardening markers", () => {
    expect(parseRawDerivationSegments(["44h", "60H", "0'", "0", "5"])).toEqual({
      ok: true,
      path: "m/44'/60'/0'/0/5",
    });
  });

  test("treats unmarked segments as non-hardened (literal semantics)", () => {
    expect(parseRawDerivationSegments(["44", "60", "0"])).toEqual({
      ok: true,
      path: "m/44/60/0",
    });
  });

  test("accepts an optional leading m segment", () => {
    expect(parseRawDerivationSegments(["m", "44h", "60h", "0h"])).toEqual({
      ok: true,
      path: "m/44'/60'/0'",
    });
  });

  test("re-splits percent-encoded separators from a single segment", () => {
    expect(parseRawDerivationSegments(["44h%2F60h%2F0h"])).toEqual({
      ok: true,
      path: "m/44'/60'/0'",
    });
    expect(parseRawDerivationSegments(["m%2F44h%2F60h", "0"])).toEqual({
      ok: true,
      path: "m/44'/60'/0",
    });
  });

  test("rejects empty, malformed, too-deep and out-of-range paths", () => {
    expect(parseRawDerivationSegments([]).ok).toBe(false);
    expect(parseRawDerivationSegments(["abc"]).ok).toBe(false);
    expect(parseRawDerivationSegments(["44hh"]).ok).toBe(false);
    expect(parseRawDerivationSegments(["-1"]).ok).toBe(false);
    expect(parseRawDerivationSegments(["2147483648"]).ok).toBe(false);
    expect(
      parseRawDerivationSegments(Array.from({ length: 11 }, () => "0")).ok
    ).toBe(false);
  });

  test("field-based paths and raw paths derive identical keys", () => {
    const root = createDerivationRoot(mnemonic);
    const raw = parseRawDerivationSegments(["44h", "60h", "0h", "0", "1", "2", "3"]);

    if (!raw.ok) throw new Error(raw.error);

    expect(derivePrivateKeyFromPath(root, raw.path)).toBe(
      derivePrivateKeyFromRoot(root, "evm", baseParams)
    );
  });

  test("non-hardened raw path matches viem's independent HDKey implementation", () => {
    const root = createDerivationRoot(mnemonic);
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const scureKey = HDKey.fromMasterSeed(seed).derive("m/44/60/0");

    expect(derivePrivateKeyFromPath(root, "m/44/60/0")).toBe(
      Buffer.from(scureKey.privateKey ?? new Uint8Array()).toString("hex")
    );
  });

  test("infers chain family from BIP44-shaped paths only", () => {
    expect(inferFamilyFromPath("m/44'/60'/0'")).toBe("evm");
    expect(inferFamilyFromPath("m/44/60/0")).toBe("evm");
    expect(inferFamilyFromPath("m/44'/195'/0'/0/0")).toBe("tron");
    expect(inferFamilyFromPath("m/44'/0'/0'")).toBeUndefined();
    expect(inferFamilyFromPath("m/0/1")).toBeUndefined();
    expect(inferFamilyFromPath("m/60")).toBeUndefined();
  });

  test("flags any BIP44 coin type that differs from the network family", () => {
    expect(pathFamilyConflict("m/44'/195'/0'", "evm")).toBe(true);
    expect(pathFamilyConflict("m/44'/60'/0'", "tron")).toBe(true);
    expect(pathFamilyConflict("m/44'/0'/0'", "evm")).toBe(true);
    expect(pathFamilyConflict("m/44'/0'/0'", "tron")).toBe(true);
    expect(pathFamilyConflict("m/44'/60'/0'", "evm")).toBe(false);
    expect(pathFamilyConflict("m/44'/195'/0'", "tron")).toBe(false);
    expect(pathFamilyConflict("m/0/1/2", "evm")).toBe(false);
    expect(pathFamilyConflict("m/44", "evm")).toBe(false);
  });
});

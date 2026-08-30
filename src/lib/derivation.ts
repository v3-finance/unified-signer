import ecc from "@bitcoinerlab/secp256k1";
import BIP32Factory, { type BIP32Interface } from "bip32";
import * as bip39 from "bip39";

const bip32 = BIP32Factory(ecc);

export type ChainFamily = "tron" | "evm";

export const SLIP44_COIN_TYPES: Record<ChainFamily, number> = {
  tron: 195,
  evm: 60,
};

export const MAX_DERIVATION_DEPTH = 10;
const HARDENED_OFFSET = 0x80000000;

export type WalletDerivationParams = {
  appId: number;
  purpose: number;
  asset: number;
  stage: number;
  index: number;
};

export function buildDerivationPath(
  family: ChainFamily,
  params: WalletDerivationParams
): string {
  const coinType = SLIP44_COIN_TYPES[family];
  return `m/44'/${coinType}'/${params.appId}'/${params.purpose}/${params.asset}/${params.stage}/${params.index}`;
}

export type RawPathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

// Parses URL segments like ["44h", "60h", "0h", "0", "5"] into the canonical
// derivation path "m/44'/60'/0'/0/5". Hardening is strictly literal: a level
// is hardened only when marked with ' or h/H — "/44/60/0" derives the fully
// non-hardened key m/44/60/0. An optional leading "m" segment is accepted.
// Spec-conformant clients percent-encode the separators of a single path
// parameter (44h%2F60h%2F0h), so segments are re-split after decoding.
export function parseRawDerivationSegments(
  rawSegments: string[]
): RawPathResult {
  const decoded: string[] = [];

  for (const rawSegment of rawSegments) {
    let segment: string;

    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return { ok: false, error: `Invalid path segment "${rawSegment}"` };
    }

    for (const part of segment.split("/")) {
      if (part.length > 0) {
        decoded.push(part);
      }
    }
  }

  const segments =
    decoded[0]?.toLowerCase() === "m" ? decoded.slice(1) : decoded;

  if (segments.length === 0) {
    return { ok: false, error: "Derivation path is empty" };
  }

  if (segments.length > MAX_DERIVATION_DEPTH) {
    return {
      ok: false,
      error: `Derivation path is too deep (max ${MAX_DERIVATION_DEPTH} levels)`,
    };
  }

  const parts: string[] = [];

  for (const segment of segments) {
    const match = /^(\d+)(['hH])?$/.exec(segment);

    if (!match) {
      return {
        ok: false,
        error: `Invalid path segment "${segment}": expected an index with an optional ' or h hardening marker`,
      };
    }

    const index = Number(match[1]);

    if (!Number.isSafeInteger(index) || index >= HARDENED_OFFSET) {
      return {
        ok: false,
        error: `Path index ${match[1]} is out of range`,
      };
    }

    parts.push(`${index}${match[2] ? "'" : ""}`);
  }

  return { ok: true, path: `m/${parts.join("/")}` };
}

// Infers the chain family from a canonical path's BIP44 shape: the first
// level must be 44 and the second a known coin type. Hardening markers are
// ignored for inference.
export function inferFamilyFromPath(path: string): ChainFamily | undefined {
  const segments = path.split("/").slice(1);

  if (segments.length < 2) {
    return undefined;
  }

  if (Number.parseInt(segments[0] ?? "", 10) !== 44) {
    return undefined;
  }

  const coinType = Number.parseInt(segments[1] ?? "", 10);

  if (coinType === SLIP44_COIN_TYPES.evm) {
    return "evm";
  }

  if (coinType === SLIP44_COIN_TYPES.tron) {
    return "tron";
  }

  return undefined;
}

// true when a BIP44-shaped path (first level 44) carries a coin type other
// than the given family's — deriving a foreign-branch key against a network
// is almost certainly a client mistake. Non-BIP44 paths never conflict.
export function pathFamilyConflict(path: string, family: ChainFamily): boolean {
  const segments = path.split("/").slice(1);

  if (segments.length < 2) {
    return false;
  }

  if (Number.parseInt(segments[0] ?? "", 10) !== 44) {
    return false;
  }

  return (
    Number.parseInt(segments[1] ?? "", 10) !== SLIP44_COIN_TYPES[family]
  );
}

export function createDerivationRoot(mnemonic: string): BIP32Interface {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  return bip32.fromSeed(seed);
}

export function derivePrivateKeyFromPath(
  root: BIP32Interface,
  path: string
): string {
  const child = root.derivePath(path);

  if (!child.privateKey) {
    throw new Error("Unable to derive a private key for the provided path");
  }

  return Buffer.from(child.privateKey).toString("hex");
}

export function derivePrivateKeyFromRoot(
  root: BIP32Interface,
  family: ChainFamily,
  params: WalletDerivationParams
): string {
  return derivePrivateKeyFromPath(root, buildDerivationPath(family, params));
}

export function derivePrivateKeyFromMnemonic(
  mnemonic: string,
  family: ChainFamily,
  params: WalletDerivationParams
): string {
  return derivePrivateKeyFromRoot(createDerivationRoot(mnemonic), family, params);
}

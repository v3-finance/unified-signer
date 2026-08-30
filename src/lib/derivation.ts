import ecc from "@bitcoinerlab/secp256k1";
import BIP32Factory, { type BIP32Interface } from "bip32";
import * as bip39 from "bip39";

const bip32 = BIP32Factory(ecc);

export type ChainFamily = "tron" | "evm";

export const SLIP44_COIN_TYPES: Record<ChainFamily, number> = {
  tron: 195,
  evm: 60,
};

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

export function createDerivationRoot(mnemonic: string): BIP32Interface {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  return bip32.fromSeed(seed);
}

export function derivePrivateKeyFromRoot(
  root: BIP32Interface,
  family: ChainFamily,
  params: WalletDerivationParams
): string {
  const child = root.derivePath(buildDerivationPath(family, params));

  if (!child.privateKey) {
    throw new Error("Unable to derive a private key for the provided path");
  }

  return Buffer.from(child.privateKey).toString("hex");
}

export function derivePrivateKeyFromMnemonic(
  mnemonic: string,
  family: ChainFamily,
  params: WalletDerivationParams
): string {
  return derivePrivateKeyFromRoot(createDerivationRoot(mnemonic), family, params);
}

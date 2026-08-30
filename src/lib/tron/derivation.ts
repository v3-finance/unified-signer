import type { BIP32Interface } from "bip32";
import type { TronWeb } from "tronweb";
import {
  buildDerivationPath,
  derivePrivateKeyFromPath,
  type WalletDerivationParams,
} from "../derivation";

export function deriveTronPrivateKeyFromPath(
  root: BIP32Interface,
  path: string
): string {
  return derivePrivateKeyFromPath(root, path);
}

export function deriveTronAddressFromPath(
  root: BIP32Interface,
  tronWeb: TronWeb,
  path: string
): string {
  return tronWeb.address.fromPrivateKey(
    deriveTronPrivateKeyFromPath(root, path)
  ) as string;
}

export function deriveTronAddressFromRoot(
  root: BIP32Interface,
  tronWeb: TronWeb,
  params: WalletDerivationParams
): string {
  return deriveTronAddressFromPath(
    root,
    tronWeb,
    buildDerivationPath("tron", params)
  );
}

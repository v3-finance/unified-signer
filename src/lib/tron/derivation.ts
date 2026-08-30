import type { BIP32Interface } from "bip32";
import type { TronWeb } from "tronweb";
import { derivePrivateKeyFromPath } from "../derivation";

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

import type { BIP32Interface } from "bip32";
import type { TronWeb } from "tronweb";
import {
  derivePrivateKeyFromRoot,
  type WalletDerivationParams,
} from "../derivation";

export function deriveTronPrivateKeyFromRoot(
  root: BIP32Interface,
  params: WalletDerivationParams
): string {
  return derivePrivateKeyFromRoot(root, "tron", params);
}

export function deriveTronAddressFromRoot(
  root: BIP32Interface,
  tronWeb: TronWeb,
  params: WalletDerivationParams
): string {
  return tronWeb.address.fromPrivateKey(
    deriveTronPrivateKeyFromRoot(root, params)
  ) as string;
}

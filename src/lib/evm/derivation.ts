import type { BIP32Interface } from "bip32";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildDerivationPath,
  derivePrivateKeyFromPath,
  derivePrivateKeyFromRoot,
  type WalletDerivationParams,
} from "../derivation";

export function deriveEvmPrivateKeyFromPath(
  root: BIP32Interface,
  path: string
): `0x${string}` {
  return `0x${derivePrivateKeyFromPath(root, path)}`;
}

export function deriveEvmAddressFromPath(
  root: BIP32Interface,
  path: string
): `0x${string}` {
  return privateKeyToAccount(deriveEvmPrivateKeyFromPath(root, path)).address;
}

export function deriveEvmPrivateKeyFromRoot(
  root: BIP32Interface,
  params: WalletDerivationParams
): `0x${string}` {
  return `0x${derivePrivateKeyFromRoot(root, "evm", params)}`;
}

export function deriveEvmAddressFromRoot(
  root: BIP32Interface,
  params: WalletDerivationParams
): `0x${string}` {
  return deriveEvmAddressFromPath(root, buildDerivationPath("evm", params));
}

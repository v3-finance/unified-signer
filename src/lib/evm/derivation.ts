import type { BIP32Interface } from "bip32";
import { privateKeyToAccount } from "viem/accounts";
import {
  derivePrivateKeyFromRoot,
  type WalletDerivationParams,
} from "../derivation";

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
  return privateKeyToAccount(deriveEvmPrivateKeyFromRoot(root, params)).address;
}

import type { GasCalculator } from "./services/GasCalculator";
import type { Registry } from "./services/Registry";
import type { Signer } from "./services/Signer";
import type { TxBuilder } from "./services/TxBuilder";

export type Env = {
  Bindings: {
    baseUrl: string;
    mnemonic: string;
    TRONGRID_BASE_URL: string;
    EVM_NETWORKS: string;
    TX_BUILDER: DurableObjectNamespace<TxBuilder>;
    SIGNER: DurableObjectNamespace<Signer>;
    REGISTRY: DurableObjectNamespace<Registry>;
    GAS_CALCULATOR: DurableObjectNamespace<GasCalculator>;
  };
};

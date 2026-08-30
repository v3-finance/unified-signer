export interface TronAccountResource {
  freeNetLimit?: number;
  freeNetUsed?: number;
  NetLimit?: number;
  NetUsed?: number;
  EnergyLimit?: number;
  EnergyUsed?: number;
  TotalNetLimit?: number;
  TotalEnergyLimit?: number;
}

export interface TronBandwidthAvailable {
  fromStaking: number;
  fromFree: number;
  total: number;
}

export interface BandwidthCoverage {
  fromStaking: number;
  fromFree: number;
  needsToBurn: number;
  total: number;
}

export interface EnergyCoverage {
  fromStaking: number;
  needsToBurn: number;
}

export interface TronBandwidth {
  required: number;
  available: TronBandwidthAvailable;
  coverage: BandwidthCoverage;
  costTRX: number;
}

export interface TronEnergy {
  required: number;
  available: number;
  coverage: EnergyCoverage;
  costTRX: number;
  baseEnergy: number;
  energyFactor: number;
  recipientHasTransactions: boolean;
}

export interface CalculateTronFeeResult {
  totalFeeTRX: number;
  bandwidth: TronBandwidth;
  energy: TronEnergy;
  transactionType: TransactionType;
  timestamp: number;
}

export const TransactionType = {
  TRX_TRANSFER: "TRX_TRANSFER",
  TRC20_TRANSFER: "TRC20_TRANSFER",
} as const;

export type TransactionType =
  (typeof TransactionType)[keyof typeof TransactionType];

export const TRON_CONSTANTS = {
  BANDWIDTH: {
    FREE_DAILY_LIMIT: 600,
  },

  ENERGY: {
    TRC20: {
      DEFAULT: 64285,
      WITHOUT_CONTRACT_TRANSACTIONS: 130285,
    },
    A7A5: {
      DEFAULT: 15732,
      WITHOUT_CONTRACT_TRANSACTIONS: 30732,
    },
  },

  PRICES: {
    BANDWIDTH_PER_UNIT: 0.001, // TRX
    ENERGY_IN_TRX: 0.0001, // TRX
    SUN_TO_TRX: 0.000001,
  },

  NETWORK: {
    TOTAL_BANDWIDTH_LIMIT: 43200000000,
    TOTAL_ENERGY_LIMIT: 180000000000,
  },

  CONTRACTS: {
    USDT_MAINNET: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    USDT_NILE: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
  },
};

export const EVM_CONSTANTS = {
  // Multiplier applied to the estimated gas limit so transactions survive
  // small state changes between estimation and execution.
  GAS_LIMIT_BUFFER_PERCENT: 20,

  // Fallback priority fee when the RPC does not expose
  // eth_maxPriorityFeePerGas (1.5 gwei).
  DEFAULT_PRIORITY_FEE_WEI: 1_500_000_000n,

  // maxFeePerGas = baseFee * multiplier + priority fee.
  BASE_FEE_MULTIPLIER: 2n,

  CONTRACTS: {
    USDT_ETHEREUM: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    USDC_ETHEREUM: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
};

export const factorSignalMap = {
  equities: {
    growth: 1,
    liquidity: 1,
    inflation: -0.5,
  },

  bonds: {
    inflation: -1,
    liquidity: 0.5,
    growth: -0.5,
  },

  commodities: {
    inflation: 1,
    growth: 0.5,
  },

  usd: {
    liquidity: -1,
    inflation: 0.5,
  },
} as const;

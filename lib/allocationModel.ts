export const allocationModel = {
  BUY: 0.3,
  SELL: -0.3,
  NEUTRAL: 0,
} as const;

export type AllocationSignal = keyof typeof allocationModel;

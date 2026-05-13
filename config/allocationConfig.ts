export const SIGNAL_ADJUSTMENT = 0.05;

export const DEFAULT_REGIME_ADJUSTMENT = 0.05;
export const MIN_REGIME_ADJUSTMENT = 0.02;
export const MAX_REGIME_ADJUSTMENT = 0.08;

export const MIN_REGIME_SCORE = 2;
export const MIN_REGIME_MARGIN = 1;
export const MAX_REGIME_SCORE = 4; // Maximum possible regime score; used for evidence-aware confidence

export const REGIME_HISTORY_SIZE = 5;

export const DEFAULT_FALLBACK_REGIME = "growth" as const;

// Fallback regime expiration: clear regime state if no detection within this window
export const REGIME_FALLBACK_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Confidence bands for mapping to the above strength bands
export const REGIME_CONFIDENCE_WEAK_MAX = 0.4;
export const REGIME_CONFIDENCE_STRONG_MIN = 0.7;

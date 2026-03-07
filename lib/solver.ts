import { futureValue } from "./finance";

/**
 * Ensures the provided value is a finite number.
 * @throws {TypeError} If the value is not a finite number.
 */
function assertFiniteNumber(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

/**
 * Solve for the number of years (n) required to reach a target future value.
 *
 * This uses binary search over a fixed range of years because, under typical
 * assumptions (non-negative PV/PMT and r >= 0), futureValue is monotonic
 * increasing with time.
 *
 * Search constraints:
 * - Range: 0..50 years
 * - Precision: 0.01 years
 * - Max iterations: 100
 *
 * Binary search logic (high level):
 * - Maintain an interval [lo, hi] that is guaranteed to contain the answer.
 * - Evaluate FV at mid.
 * - If FV(mid) is already >= target, the answer is at or before mid => move hi.
 * - Otherwise, the answer is after mid => move lo.
 * - Stop once the interval is narrower than the desired precision (or hit max iterations).
 *
 * @throws {TypeError} If any input is not a finite number.
 * @throws {RangeError} If the target cannot be reached within 0..50 years.
 */
export function solveForN(PV: number, PMT: number, r: number, target: number): number {
  assertFiniteNumber("PV", PV);
  assertFiniteNumber("PMT", PMT);
  assertFiniteNumber("r", r);
  assertFiniteNumber("target", target);

  if (r < 0) {
    throw new RangeError("r must be >= 0");
  }

  const minYears = 0;
  const maxYears = 50;
  const precision = 0.01;
  const maxIterations = 100;

  // Quick exits and feasibility checks within the allowed search range.
  const fvAtMin = futureValue(PV, PMT, r, minYears);
  if (target <= fvAtMin) {
    return 0;
  }

  const fvAtMax = futureValue(PV, PMT, r, maxYears);
  if (target > fvAtMax) {
    throw new RangeError("Target cannot be reached within 0..50 years");
  }

  let lo = minYears;
  let hi = maxYears;

  for (let i = 0; i < maxIterations && hi - lo > precision; i++) {
    const mid = (lo + hi) / 2;
    const fv = futureValue(PV, PMT, r, mid);

    if (fv >= target) {
      // We have reached (or exceeded) the target; try to find an earlier time.
      hi = mid;
    } else {
      // Still below target; need more time.
      lo = mid;
    }
  }

  // Return the smallest time within the precision that reaches the target.
  // Rounding to 2 decimals matches the 0.01-year precision requirement.
  return Number(hi.toFixed(2));
}

/**
 * Solve for the required monthly savings (PMT) to reach a target amount in n years.
 *
 * We start from the annual-compounding future value equation used by `futureValue`:
 *
 *   target = PV(1 + r)^n + PMT_annual * ((1 + r)^n - 1) / r
 *
 * Solve for PMT_annual:
 *
 *   PMT_annual = (target - PV(1 + r)^n) * r / ((1 + r)^n - 1)
 *
 * Then convert back to monthly savings:
 *
 *   PMT_monthly = PMT_annual / 12
 *
 * Edge cases:
 * - If r === 0: target = PV + PMT_annual * n  =>  PMT_monthly = (target - PV) / (12n)
 * - If n === 0: target must equal PV (no time for contributions/growth)
 *
 * @throws {TypeError} If any input is not a finite number.
 * @throws {RangeError} If inputs are outside the solvable domain (e.g. negative n).
 */
export function solveForPMT(PV: number, r: number, n: number, target: number): number {
  assertFiniteNumber("PV", PV);
  assertFiniteNumber("r", r);
  assertFiniteNumber("n", n);
  assertFiniteNumber("target", target);

  if (n < 0) {
    throw new RangeError("n must be >= 0");
  }
  if (r < 0) {
    throw new RangeError("r must be >= 0");
  }

  // With no time, the only way to hit the target is if it's already met by PV.
  if (n === 0) {
    if (target === PV) {
      return 0;
    }
    throw new RangeError("Target cannot be reached with n = 0 unless target === PV");
  }

  if (r === 0) {
    // target = PV + (PMT * 12) * n  =>  PMT = (target - PV) / (12n)
    return (target - PV) / (12 * n);
  }

  const growth = (1 + r) ** n;
  const numerator = (target - PV * growth) * r;
  const denominator = growth - 1;

  // If denominator is 0 here, n is effectively 0 (handled above), or r is tiny.
  if (denominator === 0) {
    throw new RangeError("Cannot solve for PMT with the provided r and n");
  }

  const annualPMT = numerator / denominator;
  return annualPMT / 12;
}

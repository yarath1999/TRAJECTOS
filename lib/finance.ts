/**
 * Trajectos — financial calculation helpers.
 *
 * All rates are expressed in decimal form (e.g. 0.10 for 10%).
 */

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
 * Computes the future value (FV) of an investment with annual compounding.
 *
 * Inputs:
 * - PV: current savings (present value)
 * - PMT: monthly savings (payment per month)
 * - r: expected annual return rate in decimal form (e.g. 0.10)
 * - n: time in years
 *
 * The classic future value formula (annual compounding) is:
 *
 *   FV = PV(1 + r)^n + PMT_annual * ((1 + r)^n - 1) / r
 *
 * Where:
 * - PMT_annual = PMT * 12 (monthly contribution converted to annual)
 *
 * Special case:
 * - If r === 0, the growth terms collapse and:
 *     FV = PV + PMT_annual * n
 *
 * @throws {TypeError} If any input is not a finite number.
 */
export function futureValue(PV: number, PMT: number, r: number, n: number): number {
  assertFiniteNumber("PV", PV);
  assertFiniteNumber("PMT", PMT);
  assertFiniteNumber("r", r);
  assertFiniteNumber("n", n);

  const annualContribution = PMT * 12;

  if (r === 0) {
    return PV + annualContribution * n;
  }

  const growth = (1 + r) ** n;

  // FV = PV(1+r)^n + PMT_annual * ((1+r)^n - 1)/r
  return PV * growth + annualContribution * ((growth - 1) / r);
}

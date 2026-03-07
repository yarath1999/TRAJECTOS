import { solveForN } from "@/lib/solver";

export type FinancialInputs = {
  currentSavings: number;
  monthlySavings: number;
  expectedReturn: number; // decimal (e.g. 0.10)
  targetAmount: number;
  timeHorizon: number;
};

export type Scenario = {
  label: string;
  modify: (inputs: FinancialInputs) => FinancialInputs;
};

export type ScenarioResult = {
  label: string;
  monthsImproved: number;
};

/**
 * Runs scenarios by applying small modifications to inputs and comparing
 * the time-to-target vs the baseline inputs.
 *
 * Note: This returns raw deltas (can be negative or zero). Filtering/sorting is
 * intentionally left to the caller, because some scenario UIs need to show
 * worse-case environments (e.g. conservative markets).
 */
export function runScenarios(
  inputs: FinancialInputs,
  scenarios: Scenario[],
): ScenarioResult[] {
  const baselineYears = solveForN(
    inputs.currentSavings,
    inputs.monthlySavings,
    inputs.expectedReturn,
    inputs.targetAmount,
  );

  return scenarios.map((scenario) => {
    const modified = scenario.modify(inputs);

    const newYears = solveForN(
      modified.currentSavings,
      modified.monthlySavings,
      modified.expectedReturn,
      modified.targetAmount,
    );

    const monthsImproved = Math.round((baselineYears - newYears) * 12);

    return { label: scenario.label, monthsImproved };
  });
}

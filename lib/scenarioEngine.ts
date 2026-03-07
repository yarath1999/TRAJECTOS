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

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    const modified = scenario.modify(inputs);

    const newYears = solveForN(
      modified.currentSavings,
      modified.monthlySavings,
      modified.expectedReturn,
      modified.targetAmount,
    );

    const monthsImproved = Math.round((baselineYears - newYears) * 12);

    if (monthsImproved > 0) {
      results.push({ label: scenario.label, monthsImproved });
    }
  }

  return results.sort((a, b) => b.monthsImproved - a.monthsImproved);
}

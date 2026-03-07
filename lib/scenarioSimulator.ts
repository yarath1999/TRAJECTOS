import { solveForN } from "@/lib/solver";

export type ScenarioInputs = {
  currentSavings: number;
  monthlySavings: number;
  expectedReturn: number; // decimal (e.g. 0.10)
  timeHorizon: number;
  targetAmount: number;
};

export type ContributionScenarioResult = {
  extraContribution: 500 | 1000 | 2000;
  monthsImproved: number;
};

export function simulateContributionScenarios(
  inputs: ScenarioInputs,
): ContributionScenarioResult[] {
  void inputs.timeHorizon;

  const baselineYears = solveForN(
    inputs.currentSavings,
    inputs.monthlySavings,
    inputs.expectedReturn,
    inputs.targetAmount,
  );

  const extras: Array<500 | 1000 | 2000> = [500, 1000, 2000];

  const results: ContributionScenarioResult[] = [];

  for (const extra of extras) {
    const newMonthlySavings = inputs.monthlySavings + extra;

    const yearsScenario = solveForN(
      inputs.currentSavings,
      newMonthlySavings,
      inputs.expectedReturn,
      inputs.targetAmount,
    );

    const monthsImproved = Math.round((baselineYears - yearsScenario) * 12);

    if (monthsImproved > 0) {
      results.push({ extraContribution: extra, monthsImproved });
    }
  }

  return results;
}

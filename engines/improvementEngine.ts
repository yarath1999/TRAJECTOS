import { futureValue } from "@/lib/finance";
import { solveForN } from "@/lib/solver";

export type ImprovementInputs = {
  currentSavings: number;
  monthlySavings: number;
  expectedReturn: number; // decimal (e.g. 0.10)
  timeHorizon: number; // years
  targetAmount: number;
};

export type ImprovementSuggestion = {
  type: "savings" | "return" | "timeline";
  label: string;
  monthsImproved: number;
};

const inrInteger = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

export function generateImprovements(
  inputs: ImprovementInputs,
  baselineYearsOverride?: number,
): ImprovementSuggestion[] {
  const baselineYears =
    typeof baselineYearsOverride === "number" &&
    Number.isFinite(baselineYearsOverride)
      ? baselineYearsOverride
      : solveForN(
          inputs.currentSavings,
          inputs.monthlySavings,
          inputs.expectedReturn,
          inputs.targetAmount,
        );

  // Step 2: Simulate improvements
  // A) Savings increase (10% bump)
  const simulateSavings = inputs.monthlySavings * 1.1;
  const yearsSavings = solveForN(
    inputs.currentSavings,
    simulateSavings,
    inputs.expectedReturn,
    inputs.targetAmount,
  );
  const monthsSavedSavings = Math.round((baselineYears - yearsSavings) * 12);
  const savingsDelta = Math.round(simulateSavings - inputs.monthlySavings);

  // B) Return increase (+0.5%)
  const simulateReturn = inputs.expectedReturn + 0.005;
  const yearsReturn = solveForN(
    inputs.currentSavings,
    inputs.monthlySavings,
    simulateReturn,
    inputs.targetAmount,
  );
  const monthsSavedReturn = Math.round((baselineYears - yearsReturn) * 12);

  // C) Timeline extension (+2 years)
  const simulateTimeline = inputs.timeHorizon + 2;
  const fvExtended = futureValue(
    inputs.currentSavings,
    inputs.monthlySavings,
    inputs.expectedReturn,
    simulateTimeline,
  );

  const monthsSavedTimeline =
    fvExtended >= inputs.targetAmount
      ? Math.round((baselineYears - inputs.timeHorizon) * 12)
      : 0;

  const suggestions: ImprovementSuggestion[] = [
    {
      type: "savings",
      label: `Increase monthly savings by ₹${inrInteger.format(savingsDelta)}`,
      monthsImproved: monthsSavedSavings,
    },
    {
      type: "return",
      label: "Increase expected return by 0.5%",
      monthsImproved: monthsSavedReturn,
    },
    {
      type: "timeline",
      label: "Extend timeline by 2 years",
      monthsImproved: monthsSavedTimeline,
    },
  ];

  return suggestions
    .filter((s) => s.monthsImproved > 0)
    .sort((a, b) => b.monthsImproved - a.monthsImproved);
}

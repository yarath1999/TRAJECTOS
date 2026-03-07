import { futureValue } from "@/lib/finance";
import { generateImprovements, type ImprovementSuggestion } from "@/lib/improvementEngine";
import {
  classifyTrajectory,
  detectTrajectoryCause,
  type TrajectoryCause,
  type TrajectoryInsight,
} from "@/lib/insights";
import { getReturnInsight, type ReturnInsight } from "@/lib/returnInsight";
import { marketScenarios } from "@/simulation/marketScenarios";
import {
  runScenarios,
  type FinancialInputs,
  type Scenario,
  type ScenarioResult,
} from "@/simulation/scenarioEngine";
import { solveForN, solveForPMT } from "@/lib/solver";

export type TrajectoryAnalysis = {
  projectedFutureValue: number;
  nActual: number;
  compression: number;
  accelerationScore: number;
  requiredMonthlySavings: number | null;
  increaseMonthlySavings: number | null;
  shock: {
    rNew: number;
    projectedFutureValue: number;
    nActual: number;
    monthsAdded: number;
  };
  returnInsight: ReturnInsight;
  insight: TrajectoryInsight;
  cause: TrajectoryCause;
  improvements: ImprovementSuggestion[];
  scenarios: ScenarioResult[];
  marketScenarios: ScenarioResult[];
};

const contributionScenarios: Scenario[] = [
  {
    label: "+₹500 per month",
    modify: (inputs: FinancialInputs) => ({
      ...inputs,
      monthlySavings: inputs.monthlySavings + 500,
    }),
  },
  {
    label: "+₹1000 per month",
    modify: (inputs: FinancialInputs) => ({
      ...inputs,
      monthlySavings: inputs.monthlySavings + 1000,
    }),
  },
  {
    label: "+₹2000 per month",
    modify: (inputs: FinancialInputs) => ({
      ...inputs,
      monthlySavings: inputs.monthlySavings + 2000,
    }),
  },
];

export function analyzeTrajectory(inputs: FinancialInputs): TrajectoryAnalysis {
  // 1) Projected future value at the user's time horizon.
  const projectedFutureValue = futureValue(
    inputs.currentSavings,
    inputs.monthlySavings,
    inputs.expectedReturn,
    inputs.timeHorizon,
  );

  // 2) Years to reach target.
  const nActual = solveForN(
    inputs.currentSavings,
    inputs.monthlySavings,
    inputs.expectedReturn,
    inputs.targetAmount,
  );

  const compression = inputs.timeHorizon - nActual;

  // Acceleration Score
  if (inputs.timeHorizon <= 0) {
    throw new RangeError("Time horizon must be > 0");
  }
  const requiredPace = inputs.targetAmount / inputs.timeHorizon;
  const actualPace = projectedFutureValue / inputs.timeHorizon;
  const accelerationScore =
    requiredPace === 0
      ? actualPace === 0
        ? 1
        : Number.POSITIVE_INFINITY
      : actualPace / requiredPace;

  // Inflation shock simulation: r_new = r_old - 0.01
  const rNew = inputs.expectedReturn - 0.01;
  if (rNew < 0) {
    throw new RangeError(
      "Inflation shock results in r < 0; unable to run simulation",
    );
  }

  const projectedFutureValueShock = futureValue(
    inputs.currentSavings,
    inputs.monthlySavings,
    rNew,
    inputs.timeHorizon,
  );

  const nActualShock = solveForN(
    inputs.currentSavings,
    inputs.monthlySavings,
    rNew,
    inputs.targetAmount,
  );

  const monthsAdded = Math.max(0, Math.round((nActualShock - nActual) * 12));

  // Savings lever (only when behind)
  const isBehind = compression < 0;
  const requiredMonthlySavings = isBehind
    ? solveForPMT(
        inputs.currentSavings,
        inputs.expectedReturn,
        inputs.timeHorizon,
        inputs.targetAmount,
      )
    : null;

  const increaseMonthlySavings =
    isBehind && requiredMonthlySavings !== null
      ? Math.max(0, requiredMonthlySavings - inputs.monthlySavings)
      : null;

  // Layer-2 insights
  const returnInsight = getReturnInsight(inputs.expectedReturn);
  const insight = classifyTrajectory(compression, accelerationScore);
  const cause = detectTrajectoryCause(
    compression,
    inputs.monthlySavings,
    inputs.expectedReturn,
    inputs.timeHorizon,
    requiredMonthlySavings ?? undefined,
  );

  // Improvement suggestions and scenarios
  const improvements = isBehind ? generateImprovements(inputs, nActual) : [];
  const scenarios = runScenarios(inputs, contributionScenarios)
    .filter((s) => s.monthsImproved > 0)
    .sort((a, b) => b.monthsImproved - a.monthsImproved);

  const marketScenarioResults = runScenarios(inputs, marketScenarios);

  return {
    projectedFutureValue,
    nActual,
    compression,
    accelerationScore,
    requiredMonthlySavings,
    increaseMonthlySavings,
    shock: {
      rNew,
      projectedFutureValue: projectedFutureValueShock,
      nActual: nActualShock,
      monthsAdded,
    },
    returnInsight,
    insight,
    cause,
    improvements,
    scenarios,
    marketScenarios: marketScenarioResults,
  };
}

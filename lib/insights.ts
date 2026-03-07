/**
 * Trajectos — Layer-2 Insight Logic
 *
 * This module contains pure classification logic that interprets
 * numerical outputs from the financial engine into human-readable insights.
 */

export type TrajectoryInsight = { title: string; message: string };

export type TrajectoryCause = { primary: string; secondary?: string };

export function classifyTrajectory(
  compression: number,
  accelerationScore: number,
): TrajectoryInsight {
  // `compression` is included in the signature to allow future rules that
  // incorporate timeline lead/lag directly. Current rules are score-based.
  void compression;

  if (!Number.isFinite(accelerationScore)) {
    return {
      title: "Trajectory",
      message: "Your trajectory insight is unavailable for the current inputs.",
    };
  }

  if (accelerationScore >= 1.2) {
    return {
      title: "Trajectory Strongly Ahead",
      message:
        "Your current savings rate and expected returns exceed the pace required to reach your financial target.",
    };
  }

  if (accelerationScore >= 1.0) {
    return {
      title: "Trajectory On Track",
      message: "Your current financial trajectory is aligned with your target timeline.",
    };
  }

  if (accelerationScore >= 0.9) {
    return {
      title: "Trajectory Slightly Behind",
      message:
        "You are slightly below the pace required to meet your financial goal within the selected timeline.",
    };
  }

  if (accelerationScore < 0.9) {
    return {
      title: "Trajectory Behind Target",
      message:
        "Your savings rate and expected returns are not sufficient to reach the target within the selected time horizon.",
    };
  }

  return {
    title: "Trajectory",
    message: "Your current trajectory is being evaluated.",
  };
}

export function detectTrajectoryCause(
  compression: number,
  monthlySavings: number,
  expectedReturn: number,
  timeHorizon: number,
  requiredMonthlySavings?: number,
): TrajectoryCause {
  void timeHorizon;

  if (compression >= 0) {
    return {
      primary: "Your financial trajectory is currently aligned with your target.",
    };
  }

  // User is behind target; detect causes prioritized by controllability.
  const savingsInsufficient =
    typeof requiredMonthlySavings === "number" &&
    Number.isFinite(requiredMonthlySavings) &&
    requiredMonthlySavings > monthlySavings;
  const expectedReturnTooLow = expectedReturn < 0.07;
  const timelineTooAggressive = compression < -0.5;

  if (savingsInsufficient) {
    return {
      primary: "Monthly savings are too low relative to the target.",
      secondary:
        "Increasing contributions would significantly improve the trajectory.",
    };
  }

  if (expectedReturnTooLow) {
    return {
      primary: "The expected return assumption may be too conservative.",
      secondary:
        "A higher-return investment strategy could accelerate the trajectory.",
    };
  }

  if (timelineTooAggressive) {
    return {
      primary: "The selected timeline may be too aggressive for the target.",
      secondary: "Extending the time horizon could make the goal achievable.",
    };
  }

  return {
    primary: "Multiple factors are contributing to the delay in reaching the target.",
  };
}

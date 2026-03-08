export type ReturnInsight = {
  label: string;
  message: string;
};

export function getReturnInsight(expectedReturn: number): ReturnInsight {
  const returnPercent = expectedReturn * 100;

  if (!Number.isFinite(returnPercent)) {
    return {
      label: "Unknown",
      message: "Unable to evaluate your expected return assumption.",
    };
  }

  if (returnPercent < 5) {
    return {
      label: "Very Conservative",
      message:
        "Your expected return is very conservative compared to typical market returns.",
    };
  }

  if (returnPercent >= 5 && returnPercent < 7) {
    return {
      label: "Conservative",
      message:
        "Your expected return is conservative relative to long-term equity averages.",
    };
  }

  if (returnPercent >= 7 && returnPercent <= 12) {
    return {
      label: "Realistic",
      message:
        "Your expected return falls within a realistic long-term equity range.",
    };
  }

  if (returnPercent > 12 && returnPercent <= 15) {
    return {
      label: "Optimistic",
      message: "Your expected return is optimistic compared to historical averages.",
    };
  }

  if (returnPercent > 15) {
    return {
      label: "Potentially Unrealistic",
      message:
        "Your expected return may be unrealistic compared to typical market performance.",
    };
  }

  return {
    label: "Neutral",
    message: "Your expected return assumption could not be classified.",
  };
}

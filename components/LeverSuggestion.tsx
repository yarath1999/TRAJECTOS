import React from "react";

export type LeverSuggestionProps = {
  /** Whether the user is behind schedule (needs adjustment). */
  isBehind: boolean;
  /** How much the user should increase their monthly savings by (monthly). */
  increaseMonthlySavings?: number;
};

function formatINR(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(safe);
}

/**
 * Simple suggestion card for actionable levers.
 */
export default function LeverSuggestion({
  isBehind,
  increaseMonthlySavings,
}: LeverSuggestionProps) {
  const increase = Math.max(0, increaseMonthlySavings ?? 0);

  return (
    <div className="rounded-lg border border-foreground/15 p-4">
      <p className="text-sm">
        {isBehind
          ? `To stay on track, increase monthly savings by ${formatINR(increase)}.`
          : "You are already on track. No savings adjustment required."}
      </p>
    </div>
  );
}

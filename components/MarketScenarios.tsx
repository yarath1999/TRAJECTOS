import type { ScenarioResult } from "@/simulation/scenarioEngine";

function formatYears(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export default function MarketScenarios({
  marketScenarios,
  timeHorizon,
}: {
  marketScenarios: ScenarioResult[];
  timeHorizon: number;
}) {
  if (marketScenarios.length === 0) return null;

  return (
    <div className="border border-foreground/15 rounded-lg p-4 mt-4">
      <div className="text-sm font-semibold">Market Scenarios</div>

      <div className="mt-3 space-y-3">
        {marketScenarios.map((s) => {
          const yearsToTarget = timeHorizon - s.monthsImproved / 12;

          return (
            <div key={s.label}>
              <div className="text-sm font-medium">{s.label}</div>
              <div className="mt-0.5 text-sm text-foreground/70">
                → Goal reached in {formatYears(yearsToTarget)} years
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

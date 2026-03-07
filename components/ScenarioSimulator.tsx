import type { ScenarioResult } from "@/simulation/scenarioEngine";

export default function ScenarioSimulator({
  scenarios,
}: {
  scenarios: ScenarioResult[];
}) {
  if (scenarios.length === 0) return null;

  return (
    <div className="border border-foreground/15 rounded-lg p-4 mt-4">
      <div className="text-sm font-semibold">Scenario Simulator</div>
      <div className="mt-1 text-sm text-foreground/70">
        If you invested more each month
      </div>

      <div className="mt-3 space-y-3">
        {scenarios.map((s) => (
          <div key={s.label}>
            <div className="text-sm font-medium">{s.label}</div>
            <div className="mt-0.5 text-sm text-foreground/70">
              → Reach goal {s.monthsImproved} months earlier
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

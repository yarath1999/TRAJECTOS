import type { ImprovementSuggestion } from "@/lib/improvementEngine";

export default function ImprovementSuggestions({
  suggestions,
}: {
  suggestions: ImprovementSuggestion[];
}) {
  if (suggestions.length === 0) return null;

  return (
    <div className="border border-foreground/15 rounded-lg p-4 mt-4">
      <div className="text-sm font-semibold">Suggested Improvements</div>

      <div className="mt-3 space-y-3">
        {suggestions.map((s, index) => {
          let rankLabel = "";

          if (index === 0) rankLabel = "Best Improvement";
          else if (index === 1) rankLabel = "Alternative";
          else rankLabel = "Minor Impact";

          return (
            <div
              key={s.type}
              className="rounded-md border border-foreground/15 p-3"
            >
              <div className="text-xs font-semibold text-foreground/70">
                {rankLabel}
              </div>
              <div className="mt-2 text-sm font-medium">{s.label}</div>
              <div className="mt-0.5 text-sm text-foreground/70">
                → Reach goal {s.monthsImproved} months earlier
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

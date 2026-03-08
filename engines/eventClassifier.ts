export type MacroEventType =
  | "inflation"
  | "interest_rate"
  | "market"
  | "tax"
  | "policy"
  | "unknown";

export function classifyEvent(eventText: string): MacroEventType {
  const text = eventText.toLowerCase();

  if (text.includes("inflation")) return "inflation";
  if (text.includes("interest") || text.includes("repo")) return "interest_rate";
  if (text.includes("stock") || text.includes("market")) return "market";
  if (text.includes("tax")) return "tax";
  if (text.includes("policy")) return "policy";

  return "unknown";
}

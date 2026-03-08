import { type MacroEventType } from "./eventClassifier";

export type ImpactResult = {
  returnAdjustment: number;
  timelineAdjustmentMonths: number;
};

export function computeEventImpact(eventType: MacroEventType): ImpactResult {
  switch (eventType) {
    case "inflation":
      return { returnAdjustment: -0.01, timelineAdjustmentMonths: 6 };

    case "interest_rate":
      return { returnAdjustment: -0.005, timelineAdjustmentMonths: 3 };

    case "market":
      return { returnAdjustment: 0, timelineAdjustmentMonths: 0 };

    case "tax":
    case "policy":
    case "unknown":
    default:
      return { returnAdjustment: 0, timelineAdjustmentMonths: 0 };
  }
}

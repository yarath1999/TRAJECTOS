import type { Scenario } from "@/simulation/scenarioEngine";

export const marketScenarios: Scenario[] = [
  {
    label: "Conservative Market (6%)",
    modify: (inputs) => ({
      ...inputs,
      expectedReturn: 0.06,
    }),
  },
  {
    label: "Expected Market",
    modify: (inputs) => ({
      ...inputs,
      expectedReturn: inputs.expectedReturn,
    }),
  },
  {
    label: "Optimistic Market (12%)",
    modify: (inputs) => ({
      ...inputs,
      expectedReturn: 0.12,
    }),
  },
];

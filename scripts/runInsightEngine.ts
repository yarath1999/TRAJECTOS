import { loadEnvConfig } from "@next/env";
import { runInsightEngine } from "../services/insightEngine";

loadEnvConfig(process.cwd());

runInsightEngine()
  .then(() => {
    console.log("Insight engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Insight engine failed:", message);
    process.exit(1);
  });

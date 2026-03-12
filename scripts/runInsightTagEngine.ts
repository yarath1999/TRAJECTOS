import { loadEnvConfig } from "@next/env";
import { runInsightTagEngine } from "../services/insightTagEngine";

loadEnvConfig(process.cwd());

runInsightTagEngine()
  .then(() => {
    console.log("Insight tag engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Insight tag engine failed:", message);
    process.exit(1);
  });

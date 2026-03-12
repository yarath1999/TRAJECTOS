import { loadEnvConfig } from "@next/env";
import { runRelevanceEngine } from "../services/relevanceEngine";

loadEnvConfig(process.cwd());

runRelevanceEngine()
  .then(() => {
    console.log("Relevance engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Relevance engine failed:", message);
    process.exit(1);
  });

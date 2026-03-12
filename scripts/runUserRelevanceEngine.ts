import { loadEnvConfig } from "@next/env";
import { runUserRelevanceEngine } from "../services/userRelevanceEngine";

loadEnvConfig(process.cwd());

runUserRelevanceEngine()
  .then(() => {
    console.log("User relevance engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("User relevance engine failed:", message);
    process.exit(1);
  });

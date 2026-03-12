import { loadEnvConfig } from "@next/env";
import { runUserFeedEngine } from "../services/userFeedEngine";

loadEnvConfig(process.cwd());

runUserFeedEngine()
  .then(() => {
    console.log("User feed engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("User feed engine failed:", message);
    process.exit(1);
  });

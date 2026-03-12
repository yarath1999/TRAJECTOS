import { loadEnvConfig } from "@next/env";
import { runFeedCacheEngine } from "../services/feedCacheEngine";

loadEnvConfig(process.cwd());

runFeedCacheEngine()
  .then(() => {
    console.log("Feed cache engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Feed cache engine failed:", message);
    process.exit(1);
  });

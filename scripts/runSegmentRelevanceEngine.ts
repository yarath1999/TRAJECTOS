import { loadEnvConfig } from "@next/env";
import { runSegmentRelevanceEngine } from "../services/segmentRelevanceEngine";

loadEnvConfig(process.cwd());

runSegmentRelevanceEngine()
  .then(() => {
    console.log("Segment relevance engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Segment relevance engine failed:", message);
    process.exit(1);
  });

import { loadEnvConfig } from "@next/env";
import { processEventQueue } from "@/services/eventProcessor";

loadEnvConfig(process.cwd());

processEventQueue()
  .then(() => {
    console.log("Queue processed");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Queue processing failed:", message);
    process.exit(1);
  });

import { loadEnvConfig } from "@next/env";
import { runEventClustering } from "@/services/eventClustering";

loadEnvConfig(process.cwd());

runEventClustering()
  .then(() => {
    console.log("Event clustering complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Event clustering failed:", message);
    process.exit(1);
  });

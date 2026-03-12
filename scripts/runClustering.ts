import { loadEnvConfig } from "@next/env";
import { runIncrementalClustering } from "@/services/clusterEngine";

loadEnvConfig(process.cwd());

runIncrementalClustering()
  .then(() => {
    console.log("Incremental clustering complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Incremental clustering failed:", message);
    process.exit(1);
  });

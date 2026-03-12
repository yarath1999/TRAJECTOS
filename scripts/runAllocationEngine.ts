import { loadEnvConfig } from "@next/env";
import { runAllocationEngine } from "../services/allocationEngine";

loadEnvConfig(process.cwd());

runAllocationEngine()
  .then(() => {
    console.log("Allocation engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Allocation engine failed:", message);
    process.exit(1);
  });

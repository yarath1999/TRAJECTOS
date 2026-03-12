import { loadEnvConfig } from "@next/env";
import { runFactorEngine } from "@/services/factorEngine";

loadEnvConfig(process.cwd());

runFactorEngine()
  .then(() => {
    console.log("Factor engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Factor engine failed:", message);
    process.exit(1);
  });

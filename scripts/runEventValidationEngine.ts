import { loadEnvConfig } from "@next/env";
import { runEventValidationEngine } from "../services/eventValidationEngine";

loadEnvConfig(process.cwd());

runEventValidationEngine()
  .then(() => {
    console.log("Event validation engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Event validation engine failed:", message);
    process.exit(1);
  });

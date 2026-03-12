import { loadEnvConfig } from "@next/env";
import { runImpactEngine } from "@/services/impactEngine";

loadEnvConfig(process.cwd());

runImpactEngine().then(() => {
  console.log("Impact engine complete");
});

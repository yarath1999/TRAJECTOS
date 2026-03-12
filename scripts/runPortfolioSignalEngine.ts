import { loadEnvConfig } from "@next/env";
import { runPortfolioSignalEngine } from "../services/portfolioSignalEngine";

loadEnvConfig(process.cwd());

runPortfolioSignalEngine()
  .then(() => {
    console.log("Portfolio signal engine complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Portfolio signal engine failed:", message);
    process.exit(1);
  });

import { loadEnvConfig } from "@next/env";
import { runCanonicalizer } from "../services/eventCanonicalizer";

loadEnvConfig(process.cwd());

runCanonicalizer()
  .then(() => {
    console.log("Canonicalizer complete");
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Canonicalizer failed:", message);
    process.exit(1);
  });

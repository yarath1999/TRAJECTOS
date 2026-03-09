import { loadEnvConfig } from "@next/env";
import { fetchAndStoreNews } from "@/services/newsFetcher";

async function main(): Promise<void> {
  // Load .env.local / .env (Next.js-style) for local scripts.
  loadEnvConfig(process.cwd());

  console.log("Starting RSS ingestion test...");

  const result = await fetchAndStoreNews();

  console.log("RSS ingestion completed");
  console.log(`Sources processed: ${result.sourcesProcessed}`);
  console.log(`Articles inserted: ${result.articlesInserted}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("RSS ingestion failed:", message);
  process.exit(1);
});

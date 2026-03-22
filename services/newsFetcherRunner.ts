import { fetchAndStoreNews } from "./newsFetcher";

async function main(): Promise<void> {
  const started = Date.now();
  const res = await fetchAndStoreNews();
  const elapsedMs = Math.max(0, Date.now() - started);
  console.log(
    `[newsFetcherRunner] sources=${res.sourcesProcessed} inserted=${res.articlesInserted} elapsed_ms=${elapsedMs}`,
  );
}

main().catch((err) => {
  console.error("[newsFetcherRunner] failed", err);
  process.exit(1);
});

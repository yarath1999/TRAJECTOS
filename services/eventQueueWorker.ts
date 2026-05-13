import "./loadEnv";

import { createSupabaseServerClient } from "./newsFetcher";
import { processEventQueue } from "./eventProcessor";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getUnprocessedQueueCount(): Promise<number> {
  const supabase = createSupabaseServerClient();

  const { count, error } = await supabase
    .from("event_queue")
    .select("id", { count: "exact", head: true })
    .eq("processed", false);

  if (error) {
    throw new Error(`Failed to count unprocessed event_queue rows: ${error.message}`);
  }

  return Number(count ?? 0);
}

(async () => {
  console.log("[eventQueueWorker] starting...");

  let loops = 0;
  let lastCount: number | null = null;

  while (true) {
    loops += 1;

    try {
      await processEventQueue();
    } catch (err) {
      console.error("[eventQueueWorker] processEventQueue failed", err);
      await sleep(5000);
      continue;
    }

    const count = await getUnprocessedQueueCount();
    if (lastCount === null || count !== lastCount || loops % 10 === 0) {
      console.log("[eventQueueWorker] remaining unprocessed", count);
      lastCount = count;
    }

    if (count === 0) {
      console.log("[eventQueueWorker] queue drained");
      process.exit(0);
    }

    // Small delay to avoid hammering PostgREST.
    await sleep(200);
  }
})().catch((err) => {
  console.error("[eventQueueWorker] fatal", err);
  process.exit(1);
});

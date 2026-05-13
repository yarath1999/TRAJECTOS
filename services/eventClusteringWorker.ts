import "./loadEnv";

import { createSupabaseServerClient } from "./newsFetcher";
import { runEventClustering } from "./eventClustering";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countUnclustered(): Promise<number> {
  const supabase = createSupabaseServerClient();

  const { count, error } = await supabase
    .from("macro_events_raw")
    .select("id", { count: "exact", head: true })
    .eq("clustered", false);

  if (error) {
    throw new Error(`Failed to count unclustered macro_events_raw rows: ${error.message}`);
  }

  return Number(count ?? 0);
}

async function getLatestClusterCreatedAt(): Promise<string | null> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("pipeline_events")
    .select("created_at")
    .eq("event_type", "CLUSTER_CREATED")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load latest CLUSTER_CREATED: ${error.message}`);
  }

  const createdAt = (data as { created_at?: unknown } | null)?.created_at;
  return typeof createdAt === "string" ? createdAt : null;
}

(async () => {
  console.log("[eventClusteringWorker] starting...");

  const baselineUnclustered = await countUnclustered();
  const baselineClusterCreatedAt = await getLatestClusterCreatedAt();

  const targetDrop = Math.max(50, Math.floor(baselineUnclustered * 0.2));

  console.log("[eventClusteringWorker] baseline unclustered", baselineUnclustered);
  console.log("[eventClusteringWorker] baseline latest CLUSTER_CREATED", baselineClusterCreatedAt);
  console.log("[eventClusteringWorker] will exit after unclustered drops by", targetDrop, "AND a new CLUSTER_CREATED appears");

  let loops = 0;
  let lastUnclustered: number | null = null;
  let sawNewClusterCreated = false;

  while (true) {
    loops += 1;

    try {
      await runEventClustering();
    } catch (err) {
      console.error("[eventClusteringWorker] runEventClustering failed", err);
      await sleep(5000);
      continue;
    }

    const [unclustered, latestClusterCreatedAt] = await Promise.all([
      countUnclustered(),
      getLatestClusterCreatedAt(),
    ]);

    if (
      !sawNewClusterCreated &&
      latestClusterCreatedAt &&
      latestClusterCreatedAt !== baselineClusterCreatedAt
    ) {
      sawNewClusterCreated = true;
      console.log(
        "[eventClusteringWorker] observed new CLUSTER_CREATED",
        latestClusterCreatedAt,
      );
    }

    const dropped = baselineUnclustered - unclustered;

    if (lastUnclustered === null || unclustered !== lastUnclustered || loops % 10 === 0) {
      console.log("[eventClusteringWorker] unclustered remaining", unclustered, "(dropped", dropped, ")");
      lastUnclustered = unclustered;
    }

    const dropSatisfied = dropped >= targetDrop;
    if (dropSatisfied && sawNewClusterCreated) {
      console.log("[eventClusteringWorker] done: unclustered dropped and CLUSTER_CREATED emitted");
      process.exit(0);
    }

    if (unclustered === 0) {
      console.log("[eventClusteringWorker] done: no unclustered rows remain");
      process.exit(0);
    }

    await sleep(250);
  }
})().catch((err) => {
  console.error("[eventClusteringWorker] fatal", err);
  process.exit(1);
});

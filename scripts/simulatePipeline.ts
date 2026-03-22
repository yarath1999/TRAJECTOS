import { loadEnvConfig } from "@next/env";

import { createSupabaseServerClient } from "@/services/newsFetcher";
import { processEventQueue } from "@/services/eventProcessor";
import { runEventClustering } from "@/services/eventClustering";
import { runIncrementalClustering } from "@/services/clusterEngine";
import { runCanonicalizer } from "@/services/eventCanonicalizer";
import { runPipelineOrchestrator } from "@/services/pipelineOrchestrator";
import { runInsightTagEngine } from "@/services/insightTagEngine";
import { runSegmentRelevanceEngine } from "@/services/segmentRelevanceEngine";
import { runUserRelevanceEngine } from "@/services/userRelevanceEngine";
import { runUserFeedEngine } from "@/services/userFeedEngine";
import { runFeedCacheEngine } from "@/services/feedCacheEngine";

loadEnvConfig(process.cwd());

function nowMs(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryExecSql(sql: string): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const rpcCandidates = ["exec_sql", "execute_sql", "run_sql"] as const;

  for (const fn of rpcCandidates) {
    const { error } = await supabase.rpc(fn, { sql });
    if (!error) return true;
  }

  return false;
}

async function ensureTable(params: { name: string; probeColumn?: string; ddlSql: string }): Promise<void> {
  const supabase = createSupabaseServerClient();
  const probeColumn = params.probeColumn ?? "id";

  const probe = await supabase.from(params.name).select(probeColumn).limit(1);
  if (!probe.error) return;

  const created = await tryExecSql(params.ddlSql);
  if (!created) {
    throw new Error(
      `Missing table ${params.name} and no SQL-exec RPC available to auto-create it. Apply migrations or add an RPC like exec_sql(sql text).`,
    );
  }

  const reprobe = await supabase.from(params.name).select(probeColumn).limit(1);
  if (reprobe.error) {
    throw new Error(`Failed to initialize missing table: ${params.name} (${reprobe.error.message})`);
  }
}

async function ensureColumn(params: { table: string; select: string; ddlSql: string }): Promise<void> {
  const supabase = createSupabaseServerClient();

  const probe = await supabase.from(params.table).select(params.select).limit(1);
  if (!probe.error) return;

  const altered = await tryExecSql(params.ddlSql);
  if (!altered) {
    throw new Error(
      `Missing column(s) for ${params.table} and no SQL-exec RPC available to auto-fix it. Apply migrations or add an RPC like exec_sql(sql text).`,
    );
  }

  const reprobe = await supabase.from(params.table).select(params.select).limit(1);
  if (reprobe.error) {
    throw new Error(`Failed to initialize missing column(s) on ${params.table}: ${reprobe.error.message}`);
  }
}

async function countRows(table: string, filters?: (q: any) => any): Promise<number> {
  const supabase = createSupabaseServerClient();

  const keyColumnByTable: Record<string, string> = {
    canonical_events: "cluster_id",
    user_feed_cache: "user_id",
    insight_user_edges: "user_id",
  };

  const keyColumn = keyColumnByTable[table] ?? "id";
  const pageSize = 1000;

  async function tableExists(tableName: string): Promise<boolean> {
    const { error } = await supabase.from(tableName).select(keyColumn).limit(1);
    return !error;
  }

  if (!(await tableExists(table))) {
    console.warn(`Skipping count, table missing: ${table}`);
    return 0;
  }

  let total = 0;
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(keyColumn).range(from, from + pageSize - 1);
    if (filters) query = filters(query);

    const { data, error } = await query;

    if (error) {
      console.error("Supabase count error:", { table, error });
      throw new Error(`Failed to count ${table}`);
    }

    const pageCount = (data as unknown[] | null)?.length ?? 0;
    total += pageCount;

    if (pageCount < pageSize) break;
  }

  return total;
}

async function ensureTableReadable(table: string, probeColumn = "id"): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from(table).select(probeColumn).limit(1);
  if (error) {
    throw new Error(`Missing required table or permissions: ${table} (${error.message})`);
  }
}

async function seedSimulationPrereqs(): Promise<void> {
  const supabase = createSupabaseServerClient();

  // Ensure key tables exist.
  await ensureTableReadable("event_queue");
  await ensureTableReadable("macro_events_raw");
  await ensureTableReadable("event_clusters");
  await ensureTableReadable("pipeline_events");
  await ensureTableReadable("event_factor_exposures");
  await ensureTableReadable("portfolio_signals");
  await ensureTableReadable("event_insights");
  await ensureTableReadable("user_feed");

  // ranking_score is optional: if the migration hasn't been applied yet,
  // the feed engines will fall back to relevance_score ordering.
  const { error: rankingProbeError } = await supabase
    .from("user_feed")
    .select("id,ranking_score")
    .limit(1);

  if (rankingProbeError) {
    console.warn(
      "[simulatePipeline] user_feed.ranking_score not available; feed will fall back to relevance_score ordering. Apply migration 0037_user_feed_ranking_score.sql to enable ranking persistence.",
    );
  }

  // Ensure prerequisite tables exist. If your DB doesn't expose an SQL-exec RPC,
  // apply migrations / DDL manually instead of relying on auto-create.
  try {
    await ensureTable({
      name: "asset_tags",
      ddlSql: `
        CREATE TABLE IF NOT EXISTS public.asset_tags (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          asset text,
          tag text,
          created_at timestamptz DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_asset_tags_asset
        ON public.asset_tags(asset);

        CREATE INDEX IF NOT EXISTS idx_asset_tags_tag
        ON public.asset_tags(tag);
      `,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Missing required table asset_tags. Apply supabase/migrations/0026_asset_tags.sql (or create public.asset_tags manually). Original error: ${message}`,
    );
  }

  try {
    await ensureTable({
      name: "user_portfolios",
      ddlSql: `
        CREATE TABLE IF NOT EXISTS public.user_portfolios (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id uuid,
          asset text,
          created_at timestamptz DEFAULT now(),
          UNIQUE(user_id, asset)
        );

        CREATE INDEX IF NOT EXISTS idx_user_portfolios_user
        ON public.user_portfolios(user_id);
      `,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Missing required table user_portfolios. Create public.user_portfolios (DDL embedded in scripts/simulatePipeline.ts) or add an SQL-exec RPC. Original error: ${message}`,
    );
  }

  // Seed test user portfolios so relevance/feed stages have data.
  const { error: seedPortfolioError } = await supabase.from("user_portfolios").upsert(
    [
      { user_id: "00000000-0000-0000-0000-000000000001", asset: "equities" },
      { user_id: "00000000-0000-0000-0000-000000000001", asset: "bonds" },
      { user_id: "00000000-0000-0000-0000-000000000002", asset: "commodities" },
    ],
    { onConflict: "user_id,asset" },
  );

  if (seedPortfolioError) {
    throw new Error(`Failed to seed user_portfolios: ${seedPortfolioError.message}`);
  }

  // Seed asset tags so user relevance can match insight tags.
  const { error: seedAssetTagsError } = await supabase.from("asset_tags").upsert(
    [
      { asset: "equities", tag: "equities" },
      { asset: "bonds", tag: "bonds" },
      { asset: "commodities", tag: "commodities" },
      { asset: "usd", tag: "currency" },
    ],
    { onConflict: "asset,tag" },
  );

  if (seedAssetTagsError) {
    throw new Error(`Failed to seed asset_tags: ${seedAssetTagsError.message}`);
  }

  // Optional: seed segments so segment engine can build indexes.
  // If segment tables are missing, skip silently (simulation can still validate user feed).
  const segProbe = await supabase.from("segment_tags").select("id").limit(1);
  if (!segProbe.error) {
    await supabase.from("segment_tags").upsert(
      [
        { segment: "tech_investors", tag: "equities" },
        { segment: "bond_investors", tag: "bonds" },
        { segment: "crypto_investors", tag: "commodities" },
      ],
      { onConflict: "segment,tag" },
    );
  }

  console.log("Seeded simulation prereqs (user_portfolios, asset_tags). ");
}

type SyntheticEvent = {
  title: string;
  description: string;
  source: string;
  url: string;
  category: string;
  geography: string;
  industries: string[];
  published_at: string;
  processed: boolean;
};

function pick<T>(items: readonly T[], index: number): T {
  return items[index % items.length] as T;
}

function buildSyntheticEvents(count: number): SyntheticEvent[] {
  const now = Date.now();
  const sources = ["pipeline_simulator"] as const;
  const categories = ["macro", "rates", "inflation", "growth", "risk"] as const;
  const geographies = ["US", "EU", "UK", "JP", "CN", "Global"] as const;
  const industries = ["technology", "energy", "financials", "industrials", "healthcare"] as const;

  const out: SyntheticEvent[] = [];

  for (let i = 0; i < count; i += 1) {
    const publishedMs = now - i * 60_000;
    const geography = pick(geographies, i);
    const category = pick(categories, i);
    const industryA = pick(industries, i);
    const industryB = pick(industries, i + 2);

    // Titles are written to intentionally trigger insightTagEngine tags.
    const title =
      i % 3 === 0
        ? `Inflation rises as bond yields move (${geography}) #${i}`
        : i % 3 === 1
          ? `Equities wobble amid tighter liquidity and risk sentiment (${geography}) #${i}`
          : `Oil and energy prices lift commodities; USD reacts (${geography}) #${i}`;

    const description =
      i % 3 === 0
        ? "Inflation data surprised to the upside; interest rates expectations shifted and bond pricing adjusted."
        : i % 3 === 1
          ? "Liquidity conditions tightened, weighing on equities as risk sentiment deteriorated."
          : "Energy markets tightened; oil prices moved higher, supporting commodities while the dollar responded to funding demand.";

    out.push({
      title,
      description,
      source: sources[0],
      url: `https://example.com/simulated/pipeline/${now}-${i}`,
      category,
      geography,
      industries: [industryA, industryB],
      published_at: new Date(publishedMs).toISOString(),
      processed: false,
    });
  }

  return out;
}

async function insertSyntheticQueueEvents(count: number): Promise<void> {
  const supabase = createSupabaseServerClient();

  const batch = buildSyntheticEvents(count);
  const { error } = await supabase.from("event_queue").upsert(batch, {
    onConflict: "url",
  });

  if (error) {
    throw new Error(`Failed to insert synthetic event_queue rows: ${error.message}`);
  }

  console.log(`Inserted ${count} synthetic events into event_queue.`);
}

async function emitClusterCreatedForSimulationClusters(params: {
  sinceIso: string;
}): Promise<number> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("macro_events_raw")
    .select("cluster_id")
    .eq("source", "pipeline_simulator")
    .gte("published_at", params.sinceIso)
    .not("cluster_id", "is", null)
    .limit(5000);

  if (error) {
    throw new Error(`Failed to load simulation macro events for cluster emission: ${error.message}`);
  }

  const clusterIds = Array.from(
    new Set(
      ((data as Array<{ cluster_id: string | null }> | null) ?? [])
        .map((r) => (r.cluster_id ?? "").toString().trim())
        .filter(Boolean),
    ),
  );

  if (clusterIds.length === 0) return 0;

  let emitted = 0;

  // Emit events only if no unprocessed CLUSTER_CREATED exists for that cluster.
  for (const clusterId of clusterIds) {
    const { data: existing, error: existingError } = await supabase
      .from("pipeline_events")
      .select("id")
      .eq("event_type", "CLUSTER_CREATED")
      .eq("processed", false)
      .eq("payload->>cluster_id", clusterId)
      .limit(1);

    if (existingError) {
      // If we can't check, skip emission (safe).
      continue;
    }

    if ((existing ?? []).length > 0) continue;

    const { error: insertError } = await supabase.from("pipeline_events").insert({
      event_type: "CLUSTER_CREATED",
      payload: { cluster_id: clusterId },
    });

    if (insertError) {
      throw new Error(`Failed to emit CLUSTER_CREATED for ${clusterId}: ${insertError.message}`);
    }

    emitted += 1;
  }

  return emitted;
}

async function runStage(name: string, fn: () => Promise<void>): Promise<void> {
  const started = nowMs();
  console.log(`Running stage: ${name}`);
  await fn();
  console.log(`Stage completed: ${name} (${nowMs() - started}ms)`);
}

async function drainStage(params: {
  name: string;
  runOnce: () => Promise<void>;
  pendingCount: () => Promise<number>;
  maxIterations?: number;
}): Promise<void> {
  const started = nowMs();
  const maxIterations = params.maxIterations ?? 25;
  const deadline = Date.now() + 90_000;

  console.log(`Running stage: ${params.name}`);

  let lastPending = await params.pendingCount();
  for (let i = 0; i < maxIterations; i += 1) {
    if (Date.now() > deadline) {
      throw new Error(`Drain timeout exceeded for ${params.name}`);
    }

    if (lastPending === 0) {
      console.log(`Stage completed: ${params.name} (drained in ${i} iterations, ${nowMs() - started}ms)`);
      return;
    }

    await params.runOnce();

    const nextPending = await params.pendingCount();
    if (nextPending === lastPending) {
      console.log(
        `Stage completed: ${params.name} (stopped: no progress; pending=${nextPending}, ${nowMs() - started}ms)`,
      );
      return;
    }

    lastPending = nextPending;
    await sleep(50);
  }

  const finalPending = await params.pendingCount();
  console.log(
    `Stage completed: ${params.name} (max iterations reached; pending=${finalPending}, ${nowMs() - started}ms)`,
  );
}

async function main(): Promise<void> {
  const simCount = Number(process.env.SIM_EVENT_COUNT ?? "100");
  const n = Number.isFinite(simCount) && simCount > 0 ? Math.floor(simCount) : 100;

  await seedSimulationPrereqs();

  const before = {
    event_clusters: await countRows("event_clusters"),
    factor_exposures: await countRows("event_factor_exposures"),
    portfolio_signals: await countRows("portfolio_signals"),
    event_insights: await countRows("event_insights"),
    user_feed: await countRows("user_feed"),
  };

  const sinceIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  await insertSyntheticQueueEvents(n);

  await drainStage({
    name: "Queue processing (processEventQueue)",
    runOnce: async () => {
      await processEventQueue();
    },
    pendingCount: async () => countRows("event_queue", (q) => q.eq("processed", false)),
    maxIterations: 20,
  });

  // Clustering: prefer vector-based clustering if available; fallback to incremental clustering + CLUSTER_CREATED emission.
  let clusteringUsed: "eventClustering" | "incrementalClustering" = "eventClustering";

  try {
    await runStage("Clustering (runEventClustering)", async () => {
      for (let i = 0; i < 6; i += 1) {
        await runEventClustering();
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("runEventClustering failed; falling back to runIncrementalClustering", { message });
    clusteringUsed = "incrementalClustering";

    await runStage("Clustering fallback (runIncrementalClustering)", async () => {
      for (let i = 0; i < 6; i += 1) {
        await runIncrementalClustering();
      }
    });

    const emitted = await emitClusterCreatedForSimulationClusters({ sinceIso });
    console.log(`Emitted ${emitted} CLUSTER_CREATED events for fallback clustering.`);
  }

  await runStage("Canonicalization (runCanonicalizer)", async () => {
    for (let i = 0; i < 6; i += 1) {
      await runCanonicalizer();
    }
  });

  await runStage("Pipeline DAG (runPipelineOrchestrator)", async () => {
    // Run multiple passes so downstream engines are kicked promptly.
    await runPipelineOrchestrator({ batchSize: 75, maxPasses: 40 });
  });

  // Post-DAG: tagging + relevance + feed + cache.
  await runStage("Insight tagging (runInsightTagEngine)", async () => {
    for (let i = 0; i < 10; i += 1) {
      await runInsightTagEngine();
    }
  });

  await runStage("Segment relevance (runSegmentRelevanceEngine)", async () => {
    await runSegmentRelevanceEngine();
  });

  await runStage("User relevance (runUserRelevanceEngine)", async () => {
    await runUserRelevanceEngine();
  });

  await drainStage({
    name: "Feed generation (runUserFeedEngine)",
    runOnce: async () => {
      await runUserFeedEngine();
    },
    pendingCount: async () =>
      countRows("pipeline_events", (q) => q.eq("event_type", "USER_RELEVANCE_UPDATED").eq("processed", false)),
    maxIterations: 25,
  });

  await drainStage({
    name: "Feed cache (runFeedCacheEngine)",
    runOnce: async () => {
      await runFeedCacheEngine();
    },
    pendingCount: async () =>
      countRows("pipeline_events", (q) => q.eq("event_type", "USER_FEED_DELTA").eq("processed", false)),
    maxIterations: 25,
  });

  const after = {
    event_clusters: await countRows("event_clusters"),
    factor_exposures: await countRows("event_factor_exposures"),
    portfolio_signals: await countRows("portfolio_signals"),
    event_insights: await countRows("event_insights"),
    user_feed: await countRows("user_feed"),
  };

  console.log("\n=== PIPELINE SIMULATION SUMMARY ===");
  console.log(`Clustering mode: ${clusteringUsed}`);

  console.log("\nRequested output (deltas):");
  console.log(`• clusters created: ${after.event_clusters - before.event_clusters}`);
  console.log(`• factor exposures generated: ${after.factor_exposures - before.factor_exposures}`);
  console.log(`• signals generated: ${after.portfolio_signals - before.portfolio_signals}`);
  console.log(`• insights created: ${after.event_insights - before.event_insights}`);
  console.log(`• feed entries generated: ${after.user_feed - before.user_feed}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Pipeline simulation failed:", message);
  process.exit(1);
});

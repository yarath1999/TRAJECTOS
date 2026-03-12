import { loadEnvConfig } from "@next/env";
import { createSupabaseServerClient, fetchAndStoreNews } from "@/services/newsFetcher";
import { processEventQueue } from "@/services/eventProcessor";
import { runEventClustering } from "@/services/eventClustering";
import { runCanonicalizer } from "@/services/eventCanonicalizer";
import { runEventValidationEngine } from "@/services/eventValidationEngine";
import { runFactorEngine } from "@/services/factorEngine";
import { runImpactEngine } from "@/services/impactEngine";
import { runPortfolioSignalEngine } from "@/services/portfolioSignalEngine";
import { runInsightEngine } from "@/services/insightEngine";
import { runAllocationEngine } from "@/services/allocationEngine";
import { runInsightTagEngine } from "@/services/insightTagEngine";
import { runSegmentRelevanceEngine } from "@/services/segmentRelevanceEngine";
import { runUserRelevanceEngine } from "@/services/userRelevanceEngine";
import { runUserFeedEngine } from "@/services/userFeedEngine";
import { runFeedCacheEngine } from "@/services/feedCacheEngine";

loadEnvConfig(process.cwd());

type StepResult = {
  step: string;
  ok: boolean;
  details: string;
  ms: number;
};

function nowMs(): number {
  return Date.now();
}

async function countRows(
  table: string,
  filters?: (q: any) => any,
): Promise<number> {
  const supabase = createSupabaseServerClient();

  // Avoid { count: 'exact', head: true } because it can fail intermittently on some setups.
  // Instead, fetch a minimal key column and count rows client-side (paginated).
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

    if (pageCount < pageSize) {
      break;
    }
  }

  return total;
}

async function tryStep(name: string, fn: () => Promise<void>): Promise<StepResult> {
  const started = nowMs();
  try {
    console.log(`Running stage: ${name}`);
    await fn();
    console.log(`Stage completed: ${name}`);
    return { step: name, ok: true, details: "ok", ms: nowMs() - started };
  } catch (err: unknown) {
    console.error(`Stage failed: ${name}`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { step: name, ok: false, details: message, ms: nowMs() - started };
  }
}

async function drain(
  name: string,
  runOnce: () => Promise<void>,
  pendingCount: () => Promise<number>,
  maxIterations = 15,
): Promise<StepResult> {
  const started = nowMs();
  const startTime = Date.now();

  console.log(`Running stage: ${name}`);

  const complete = (result: StepResult): StepResult => {
    if (result.ok) {
      console.log(`Stage completed: ${name}`);
    } else {
      console.error(`Stage failed: ${name}`, new Error(result.details));
    }
    return result;
  };

  try {
    let lastPending = await pendingCount();
    for (let i = 0; i < maxIterations; i += 1) {
      if (Date.now() - startTime > 60000) {
        throw new Error(`Drain timeout exceeded for ${name}`);
      }

      if (lastPending === 0) {
        return complete({
          step: name,
          ok: true,
          details: `drained (${i} iterations)`,
          ms: nowMs() - started,
        });
      }

      await runOnce();

      const nextPending = await pendingCount();

      // Prevent infinite loops for engines that intentionally leave events pending
      // (e.g. factor engine waiting for validation).
      if (nextPending === lastPending) {
        return complete({
          step: name,
          ok: true,
          details: `stopped (no pending progress; pending=${nextPending})`,
          ms: nowMs() - started,
        });
      }

      lastPending = nextPending;
    }

    const finalPending = await pendingCount();
    return complete({
      step: name,
      ok: finalPending === 0,
      details: `max iterations reached (pending=${finalPending})`,
      ms: nowMs() - started,
    });
  } catch (err: unknown) {
    console.error(`Stage failed: ${name}`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { step: name, ok: false, details: message, ms: nowMs() - started };
  }
}

async function checkPipelineHealth(): Promise<void> {
  const pending = await countRows("pipeline_events", (q) => q.eq("processed", false));

  if (pending > 200) {
    throw new Error(`Pipeline backlog detected: ${pending} unprocessed events`);
  }

  console.log("Pipeline health OK");
}

async function cleanupPipelineEvents(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from("pipeline_events")
    .delete()
    .lt("created_at", cutoffIso);

  if (error) {
    // Keep tests running even if cleanup fails (e.g. missing table).
    console.warn("Failed to cleanup old pipeline events", {
      error,
    });
    return;
  }

  console.log("Cleaned up old pipeline events");
}

async function main(): Promise<void> {
  const results: StepResult[] = [];

  await cleanupPipelineEvents();

  // Seed test user portfolios so relevance/feed/cache stages have data.
  const supabase = createSupabaseServerClient();
  const { error: seedError } = await supabase.from("user_portfolios").upsert(
    [
      { user_id: "00000000-0000-0000-0000-000000000001", asset: "equities" },
      { user_id: "00000000-0000-0000-0000-000000000001", asset: "bonds" },
      { user_id: "00000000-0000-0000-0000-000000000002", asset: "commodities" },
    ],
    { onConflict: "user_id,asset" },
  );

  if (seedError) {
    throw new Error(`Failed to seed user_portfolios: ${seedError.message}`);
  }

  console.log("Seeded test user portfolios");

  const before = {
    macro_events_raw: await countRows("macro_events_raw"),
    event_queue_total: await countRows("event_queue"),
    event_queue_unprocessed: await countRows("event_queue", (q) => q.eq("processed", false)),
    event_clusters: await countRows("event_clusters"),
    canonical_events: await countRows("canonical_events"),
    validated_clusters: await countRows("event_clusters", (q) => q.eq("validated", true)),
    factor_exposures: await countRows("event_factor_exposures"),
    impact_scores: await countRows("event_impact_scores"),
    portfolio_signals: await countRows("portfolio_signals"),
    event_insights: await countRows("event_insights"),
    portfolio_allocations: await countRows("portfolio_allocations"),
    insight_tags: await countRows("insight_tags"),
    segment_insight_index: await countRows("segment_insight_index"),
    user_relevance_index: await countRows("user_relevance_index"),
    user_feed: await countRows("user_feed"),
    user_feed_cache: await countRows("user_feed_cache"),
  };

  // STEP 1 — Ingestion test
  results.push(
    await tryStep("1) Ingestion (fetchAndStoreNews)", async () => {
      await fetchAndStoreNews();

      // In this codebase ingestion writes to event_queue (macro_events_raw increases during queue processing).
      const afterQueue = await countRows("event_queue");
      if (afterQueue <= before.event_queue_total) {
        throw new Error(
          `Expected event_queue count to increase after ingestion (before=${before.event_queue_total}, after=${afterQueue}).`,
        );
      }
    }),
  );

  // STEP 2 — Queue processing test
  results.push(
    await drain(
      "2) Queue processing (processEventQueue)",
      async () => {
        await processEventQueue();
      },
      async () => countRows("event_queue", (q) => q.eq("processed", false)),
      20,
    ),
  );

  results.push(
    await tryStep("2c) Pipeline health", async () => {
      await checkPipelineHealth();
    }),
  );

  // Verify macro_events_raw increased as items move from queue.
  results.push(
    await tryStep("2b) Verify macro_events_raw increase", async () => {
      const afterRaw = await countRows("macro_events_raw");
      if (afterRaw <= before.macro_events_raw) {
        throw new Error(
          `Expected macro_events_raw count to increase after queue processing (before=${before.macro_events_raw}, after=${afterRaw}).`,
        );
      }
    }),
  );

  // STEP 3 — Clustering test
  results.push(
    await tryStep("3) Clustering (runEventClustering)", async () => {
      // Loop a few times to cover the limit(50) behavior.
      for (let i = 0; i < 5; i += 1) {
        await runEventClustering();
      }

      const afterClusters = await countRows("event_clusters");
      if (afterClusters <= before.event_clusters) {
        throw new Error(
          `Expected event_clusters count to increase after clustering (before=${before.event_clusters}, after=${afterClusters}).`,
        );
      }
    }),
  );

  results.push(
    await tryStep("3c) Pipeline health", async () => {
      await checkPipelineHealth();
    }),
  );

  // STEP 3.5 — Canonicalization test
  results.push(
    await tryStep("3.5) Canonicalization (runCanonicalizer)", async () => {
      for (let i = 0; i < 5; i += 1) {
        await runCanonicalizer();
      }

      const canonicalCount = await countRows("canonical_events");
      if (canonicalCount === 0) {
        throw new Error("Canonical events not generated");
      }
    }),
  );

  // STEP 4 — Validation test
  results.push(
    await tryStep("4) Validation (runEventValidationEngine)", async () => {
      for (let i = 0; i < 5; i += 1) {
        await runEventValidationEngine();
      }

      const validated = await countRows("event_clusters", (q) => q.eq("validated", true));
      if (validated <= before.validated_clusters) {
        throw new Error(
          `Expected validated clusters to increase (before=${before.validated_clusters}, after=${validated}).`,
        );
      }
    }),
  );

  // STEP 5 — Factor engine test (event-driven)
  results.push(
    await drain(
      "5) Factor engine (runFactorEngine)",
      async () => {
        // Re-run validation as a nudge since factor engine gates on validated clusters.
        await runEventValidationEngine();
        await runFactorEngine();
      },
      async () =>
        countRows("pipeline_events", (q) =>
          q.eq("event_type", "CLUSTER_CREATED").eq("processed", false),
        ),
      25,
    ),
  );

  results.push(
    await tryStep("5c) Pipeline health", async () => {
      await checkPipelineHealth();
    }),
  );

  results.push(
    await tryStep("5b) Verify event_factor_exposures", async () => {
      const after = await countRows("event_factor_exposures");
      if (after <= before.factor_exposures) {
        throw new Error(
          `Expected event_factor_exposures to increase (before=${before.factor_exposures}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 6 — Impact engine test (event-driven)
  results.push(
    await drain(
      "6) Impact engine (runImpactEngine)",
      async () => {
        await runImpactEngine();
      },
      async () =>
        countRows("pipeline_events", (q) =>
          q.eq("event_type", "FACTOR_CREATED").eq("processed", false),
        ),
      25,
    ),
  );

  results.push(
    await tryStep("6c) Pipeline health", async () => {
      await checkPipelineHealth();
    }),
  );

  results.push(
    await tryStep("6b) Verify event_impact_scores", async () => {
      const after = await countRows("event_impact_scores");
      if (after <= before.impact_scores) {
        throw new Error(
          `Expected event_impact_scores to increase (before=${before.impact_scores}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 7 — Portfolio signal test (event-driven)
  results.push(
    await drain(
      "7) Portfolio signal engine (runPortfolioSignalEngine)",
      async () => {
        await runPortfolioSignalEngine();
      },
      async () =>
        countRows("pipeline_events", (q) =>
          q.eq("event_type", "SIGNAL_CREATED").eq("processed", false),
        ),
      25,
    ),
  );

  results.push(
    await tryStep("7c) Pipeline health", async () => {
      await checkPipelineHealth();
    }),
  );

  results.push(
    await tryStep("7b) Verify portfolio_signals", async () => {
      const after = await countRows("portfolio_signals");
      if (after <= before.portfolio_signals) {
        throw new Error(
          `Expected portfolio_signals to increase (before=${before.portfolio_signals}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 8 — Insight engine test (event-driven)
  results.push(
    await drain(
      "8) Insight engine (runInsightEngine)",
      async () => {
        await runInsightEngine();
      },
      async () =>
        countRows("pipeline_events", (q) =>
          q.eq("event_type", "INSIGHT_REQUIRED").eq("processed", false),
        ),
      25,
    ),
  );

  results.push(
    await tryStep("8c) Pipeline health", async () => {
      await checkPipelineHealth();
    }),
  );

  results.push(
    await tryStep("8b) Verify event_insights", async () => {
      const after = await countRows("event_insights");
      if (after <= before.event_insights) {
        throw new Error(
          `Expected event_insights to increase (before=${before.event_insights}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 9 — Allocation engine test (event-driven)
  results.push(
    await drain(
      "9) Allocation engine (runAllocationEngine)",
      async () => {
        await runAllocationEngine();
      },
      async () =>
        countRows("pipeline_events", (q) =>
          q.eq("event_type", "INSIGHT_CREATED").eq("processed", false),
        ),
      25,
    ),
  );

  results.push(
    await tryStep("9b) Verify portfolio_allocations", async () => {
      const after = await countRows("portfolio_allocations");
      if (after <= before.portfolio_allocations) {
        throw new Error(
          `Expected portfolio_allocations to increase (before=${before.portfolio_allocations}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 10 — Tag engine test
  results.push(
    await tryStep("10) Tag engine (runInsightTagEngine)", async () => {
      await runInsightTagEngine();

      const after = await countRows("insight_tags");
      if (after <= before.insight_tags) {
        throw new Error(
          `Expected insight_tags to increase (before=${before.insight_tags}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 11 — Segment engine test
  results.push(
    await tryStep("11) Segment engine (runSegmentRelevanceEngine)", async () => {
      await runSegmentRelevanceEngine();

      const after = await countRows("segment_insight_index");
      if (after <= before.segment_insight_index) {
        throw new Error(
          `Expected segment_insight_index to increase (before=${before.segment_insight_index}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 12 — User relevance test
  results.push(
    await tryStep("12) User relevance (runUserRelevanceEngine)", async () => {
      await runUserRelevanceEngine();

      const after = await countRows("user_relevance_index");
      if (after <= before.user_relevance_index) {
        throw new Error(
          `Expected user_relevance_index to increase (before=${before.user_relevance_index}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 13 — Feed generation test
  results.push(
    await drain(
      "13) Feed generation (runUserFeedEngine)",
      async () => {
        await runUserFeedEngine();
      },
      async () =>
        countRows("pipeline_events", (q) =>
          q.eq("event_type", "USER_RELEVANCE_UPDATED").eq("processed", false),
        ),
      25,
    ),
  );

  results.push(
    await tryStep("13b) Verify user_feed", async () => {
      const after = await countRows("user_feed");
      if (after <= before.user_feed) {
        throw new Error(
          `Expected user_feed to increase (before=${before.user_feed}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 14 — Feed cache test
  results.push(
    await drain(
      "14) Feed cache (runFeedCacheEngine)",
      async () => {
        await runFeedCacheEngine();
      },
      async () =>
        countRows("pipeline_events", (q) =>
          q.eq("event_type", "USER_FEED_DELTA").eq("processed", false),
        ),
      25,
    ),
  );

  results.push(
    await tryStep("14b) Verify user_feed_cache JSON", async () => {
      const after = await countRows("user_feed_cache", (q) => q.not("feed", "is", null));
      if (after <= before.user_feed_cache) {
        throw new Error(
          `Expected user_feed_cache to increase and contain feed JSON (before=${before.user_feed_cache}, after=${after}).`,
        );
      }
    }),
  );

  // STEP 15 — Print final summary
  const after = {
    macro_events_raw: await countRows("macro_events_raw"),
    event_queue_total: await countRows("event_queue"),
    event_queue_unprocessed: await countRows("event_queue", (q) => q.eq("processed", false)),
    event_clusters: await countRows("event_clusters"),
    canonical_events: await countRows("canonical_events"),
    validated_clusters: await countRows("event_clusters", (q) => q.eq("validated", true)),
    factor_exposures: await countRows("event_factor_exposures"),
    impact_scores: await countRows("event_impact_scores"),
    portfolio_signals: await countRows("portfolio_signals"),
    event_insights: await countRows("event_insights"),
    portfolio_allocations: await countRows("portfolio_allocations"),
    insight_tags: await countRows("insight_tags"),
    segment_insight_index: await countRows("segment_insight_index"),
    user_relevance_index: await countRows("user_relevance_index"),
    user_feed: await countRows("user_feed"),
    user_feed_cache: await countRows("user_feed_cache"),
  };

  console.log("\n=== SYSTEM TEST RESULTS ===");
  console.table(
    results.map((r) => ({
      step: r.step,
      ok: r.ok,
      ms: r.ms,
      details: r.details,
    })),
  );

  console.log("\n=== TABLE COUNTS (before -> after) ===");
  console.table(
    Object.keys(after).map((k) => ({
      table: k,
      before: (before as any)[k],
      after: (after as any)[k],
      delta: (after as any)[k] - (before as any)[k],
    })),
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("System test failed:", message);
  process.exit(1);
});

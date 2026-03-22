import { createSupabaseServerClient } from "./newsFetcher";
import { withStageSpan } from "./pipelineInstrumentation";
import { workerPoolForEach } from "./workerPool";
import { emitClusterEventOnce } from "./pipelineEventUtils";
import { recordPipelineDeadLetter } from "./pipelineDeadLetterService";

const BATCH_SIZE = 50;

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

function extractClusterIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const clusterId = (payload as { cluster_id?: unknown }).cluster_id;
  if (typeof clusterId !== "string" && typeof clusterId !== "number") return null;
  const trimmed = clusterId.toString().trim();
  return trimmed ? trimmed : null;
}

export async function runFactorEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "FACTOR_REQUIRED")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    throw new Error(`Failed to load pipeline events: ${error.message}`);
  }

  const pending = (events as PipelineEventRow[] | null) ?? [];
  if (pending.length === 0) return;

  // Avoid processing the same cluster multiple times in a single run.
  const seen = new Set<string>();
  const unique: PipelineEventRow[] = [];
  for (const evt of pending) {
    const clusterId = extractClusterIdFromPayload(evt.payload);
    if (!clusterId) {
      unique.push(evt);
      continue;
    }
    if (seen.has(clusterId)) continue;
    seen.add(clusterId);
    unique.push(evt);
  }

  console.log(`[factorEngine] processing ${unique.length} events`);

  await workerPoolForEach(
    unique,
    async (evt) => {
      const clusterId = extractClusterIdFromPayload(evt.payload);
      try {
        await withStageSpan({
          supabase,
          stageName: "factor",
          clusterId,
          eventId: evt.id,
          statusOnSuccess: clusterId ? "success" : "skipped",
          fn: async () => {
        if (!clusterId) {
          const { error: markError } = await supabase
            .from("pipeline_events")
            .update({ processed: true })
            .eq("id", evt.id);
          if (markError) {
            throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
          }
          return;
        }

        const { data: cluster, error: clusterError } = await supabase
          .from("event_clusters")
          .select("id,title,validated,processed")
          .eq("id", clusterId)
          .maybeSingle();

        if (clusterError) {
          throw new Error(`Failed to load cluster: ${clusterError.message}`);
        }

        if (!cluster) {
          const { error: markError } = await supabase
            .from("pipeline_events")
            .update({ processed: true })
            .eq("id", evt.id);
          if (markError) {
            throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
          }
          return;
        }

        // Preserve existing gating behavior: only process validated & unprocessed clusters.
        if (cluster.processed) {
          const { error: markError } = await supabase
            .from("pipeline_events")
            .update({ processed: true })
            .eq("id", evt.id);
          if (markError) {
            throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
          }

          await emitClusterEventOnce({
            supabase,
            eventType: "FACTOR_COMPLETED",
            clusterId,
          });

          return;
        }

        if (!cluster.validated) {
          // Leave the event unprocessed so it can be retried after validation.
          return;
        }

        // Idempotency: if factor exposures already exist, do not insert duplicates.
        const { data: existingExposure, error: existingExposureError } = await supabase
          .from("event_factor_exposures")
          .select("id")
          .eq("cluster_id", clusterId)
          .limit(1);

        if (existingExposureError) {
          throw new Error(
            `Failed to check existing factor exposures: ${existingExposureError.message}`,
          );
        }

        const title = (cluster.title ?? "").toString().toLowerCase();

        const exposures: Array<{ factor: string; exposure: number }> = [];

        if (title.includes("rate") || title.includes("interest")) {
          exposures.push(
            { factor: "liquidity", exposure: -0.8 },
            { factor: "growth", exposure: -0.3 },
            { factor: "inflation", exposure: -0.4 },
          );
        }

        if (title.includes("oil") || title.includes("energy")) {
          exposures.push(
            { factor: "inflation", exposure: 0.7 },
            { factor: "commodity_pressure", exposure: 0.6 },
          );
        }

        if (title.includes("war") || title.includes("conflict")) {
          exposures.push({ factor: "risk_sentiment", exposure: -0.7 });
        }

        if ((existingExposure ?? []).length === 0) {
          for (const exposure of exposures) {
            const { error: insertError } = await supabase
              .from("event_factor_exposures")
              .insert({
                cluster_id: clusterId,
                factor: exposure.factor,
                exposure: exposure.exposure,
              });

            if (insertError) {
              throw new Error(
                `Failed to insert factor exposure: ${insertError.message}`,
              );
            }
          }
        }

        const { error: markProcessedError } = await supabase
          .from("event_clusters")
          .update({ processed: true })
          .eq("id", clusterId);

        if (markProcessedError) {
          throw new Error(
            `Failed to mark cluster processed: ${markProcessedError.message}`,
          );
        }

        const { error: markEventError } = await supabase
          .from("pipeline_events")
          .update({ processed: true })
          .eq("id", evt.id);

        if (markEventError) {
          throw new Error(
            `Failed to mark pipeline event processed: ${markEventError.message}`,
          );
        }

        await emitClusterEventOnce({
          supabase,
          eventType: "FACTOR_COMPLETED",
          clusterId,
        });
          },
        });
      } catch (err) {
        await recordPipelineDeadLetter({
          supabase,
          id: evt.id,
          clusterId,
          stageName: "factor",
          err,
        });

        const { error: markError } = await supabase
          .from("pipeline_events")
          .update({ processed: true })
          .eq("id", evt.id);
        if (markError) {
          console.error("[factorEngine] failed to mark event processed after error", {
            eventId: evt.id,
            clusterId,
            error: markError.message,
          });
        }
      }
    },
    { concurrency: Number(process.env.PIPELINE_CONCURRENCY ?? 5) },
  );
}

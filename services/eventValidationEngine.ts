import { createSupabaseServerClient } from "./newsFetcher";
import { withStageSpan } from "./pipelineInstrumentation";
import { workerPoolForEach } from "./workerPool";
import { emitClusterEventOnce } from "./pipelineEventUtils";
import { recordPipelineDeadLetter } from "./pipelineDeadLetterService";

const BATCH_SIZE = 100;

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

type ClusterEventRow = {
  title: string | null;
  description: string | null;
  source: string | null;
  published_at: string | null;
  geography: string | null;
  industries: string[] | null;
  entities: string[] | null;
  embedding: number[] | null;
};

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value: unknown): string {
  return (typeof value === "string" ? value : "").toLowerCase().trim();
}

function tokenize(text: string): string[] {
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "for",
    "on",
    "at",
    "by",
    "with",
    "from",
    "as",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "it",
    "this",
    "that",
    "these",
    "those",
    "after",
    "before",
    "amid",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => !stop.has(t));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function sourceReliabilityScore(sources: string[]): number {
  if (sources.length === 0) return 0.5;

  function scoreForSource(source: string): number {
    const s = normalizeText(source);
    if (!s) return 0.5;

    if (s.includes("federal reserve") || s.includes("federalreserve.gov")) return 0.95;
    if (s.includes("international monetary fund") || s === "imf" || s.includes("imf")) return 0.95;
    if (s.includes("world bank")) return 0.95;
    if (s.includes("reuters")) return 0.9;
    if (s.includes("bloomberg")) return 0.9;
    if (s.includes("financial times") || s.includes("ft.com")) return 0.85;
    if (s.includes("bbc")) return 0.8;
    if (s.includes("cnbc")) return 0.7;

    return 0.6;
  }

  const values = sources.map(scoreForSource);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return clamp(0, avg, 1);
}

function timeProximityScore(publishedAtIso: Array<string | null>): number {
  const times = publishedAtIso
    .map((iso) => (iso ? Date.parse(iso) : NaN))
    .filter((ms) => Number.isFinite(ms));

  if (times.length <= 1) return 1;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const spread = Math.max(0, max - min);

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (spread <= 15 * minute) return 1.0;
  if (spread <= 1 * hour) return 0.9;
  if (spread <= 6 * hour) return 0.8;
  if (spread <= 1 * day) return 0.7;
  if (spread <= 3 * day) return 0.5;
  return 0.3;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function embeddingSimilarityScore(embeddings: Array<number[] | null>): number | null {
  const vectors = embeddings
    .filter((e): e is number[] => Array.isArray(e) && e.length > 0)
    .filter((e) => e.every((v) => typeof v === "number" && Number.isFinite(v)));

  if (vectors.length < 2) return null;

  const dim = vectors[0].length;
  if (!vectors.every((v) => v.length === dim)) return null;

  const centroid = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) {
      centroid[i] += v[i];
    }
  }
  for (let i = 0; i < dim; i += 1) {
    centroid[i] /= vectors.length;
  }

  const sims = vectors.map((v) => cosineSimilarity(v, centroid));
  const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;

  // Cosine similarity is [-1..1]; map to [0..1].
  return clamp(0, (avgSim + 1) / 2, 1);
}

function computeValidationScore(events: ClusterEventRow[]): number {
  if (events.length === 0) return 0;

  const sources = events
    .map((e) => (e.source ?? "").toString().trim())
    .filter(Boolean);
  const source_reliability = sourceReliabilityScore(sources);

  const titleTokens = events.map((e) => tokenize(normalizeText(e.title)));
  const baseTitle = titleTokens[0] ?? [];
  const title_similarity =
    titleTokens.length <= 1
      ? 1
      : clamp(
          0,
          titleTokens
            .slice(1)
            .map((t) => jaccardSimilarity(baseTitle, t))
            .reduce((a, b) => a + b, 0) /
            Math.max(1, titleTokens.length - 1),
          1,
        );

  const entityLists = events.map((e) =>
    Array.isArray(e.entities)
      ? e.entities
          .map((v) => (v ?? "").toString().trim().toLowerCase())
          .filter(Boolean)
      : [],
  );

  const hasStoredEntities = entityLists.some((l) => l.length > 0);

  const entity_overlap = (() => {
    if (!hasStoredEntities) {
      // Backward-compatible fallback for older rows.
      const tokenLists = events.map((e) => {
        const text = `${e.title ?? ""} ${e.description ?? ""}`;
        return tokenize(normalizeText(text));
      });

      const base = tokenLists[0] ?? [];
      return tokenLists.length <= 1
        ? 1
        : clamp(
            0,
            tokenLists
              .slice(1)
              .map((t) => jaccardSimilarity(base, t))
              .reduce((a, b) => a + b, 0) /
              Math.max(1, tokenLists.length - 1),
            1,
          );
    }

    const base = entityLists[0] ?? [];
    return entityLists.length <= 1
      ? 1
      : clamp(
          0,
          entityLists
            .slice(1)
            .map((t) => jaccardSimilarity(base, t))
            .reduce((a, b) => a + b, 0) /
            Math.max(1, entityLists.length - 1),
          1,
        );
  })();

  const time_proximity = timeProximityScore(events.map((e) => e.published_at));

  const embedding_similarity = embeddingSimilarityScore(events.map((e) => e.embedding));

  const components: number[] = [
    source_reliability,
    title_similarity,
    entity_overlap,
    time_proximity,
  ];
  if (embedding_similarity !== null) components.push(embedding_similarity);

  const avg = components.reduce((a, b) => a + b, 0) / components.length;
  return clamp(0, avg, 1);
}

function extractClusterIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const clusterId = (payload as { cluster_id?: unknown }).cluster_id;
  if (typeof clusterId !== "string" && typeof clusterId !== "number") return null;
  const trimmed = clusterId.toString().trim();
  return trimmed ? trimmed : null;
}

export async function runEventValidationEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  while (true) {
    const { data: events, error } = await supabase
      .from("pipeline_events")
      .select("id,payload")
      .eq("event_type", "VALIDATION_REQUIRED")
      .eq("processed", false)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      throw new Error(`Failed to load pipeline events: ${error.message}`);
    }

    const pending = (events as PipelineEventRow[] | null) ?? [];
    if (pending.length === 0) break;

    // Avoid processing the same cluster multiple times in a single batch.
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

    console.log(`[eventValidationEngine] processing ${unique.length} events`);

    await workerPoolForEach(
      unique,
      async (evt) => {
        const clusterId = extractClusterIdFromPayload(evt.payload);

        try {
          await withStageSpan({
            supabase,
            stageName: "event_validation",
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
                .select("id,validated")
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

              // If already validated, just mark the event processed and re-emit the transition.
              if (Boolean((cluster as { validated?: unknown }).validated)) {
                const { error: markError } = await supabase
                  .from("pipeline_events")
                  .update({ processed: true })
                  .eq("id", evt.id);
                if (markError) {
                  throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
                }

                await emitClusterEventOnce({
                  supabase,
                  eventType: "CLUSTER_VALIDATED",
                  clusterId,
                });

                return;
              }

              const { data: eventRows, error: eventRowsError } = await supabase
                .from("macro_events_raw")
                .select(
                  "title,description,source,published_at,geography,industries,entities,embedding",
                )
                .eq("cluster_id", clusterId)
                .limit(200);

              if (eventRowsError) {
                throw new Error(`Failed to load cluster events: ${eventRowsError.message}`);
              }

              const rows = (eventRows as ClusterEventRow[] | null) ?? [];
              const validationScore = computeValidationScore(rows);
              const validated = validationScore >= 0.6;

              const { error: updateError } = await supabase
                .from("event_clusters")
                .update({
                  validated,
                  validation_score: validationScore,
                })
                .eq("id", clusterId);

              if (updateError) {
                throw new Error(
                  `Failed to update validation status: ${updateError.message} (cluster_id=${clusterId})`,
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

              if (validated) {
                await emitClusterEventOnce({
                  supabase,
                  eventType: "CLUSTER_VALIDATED",
                  clusterId,
                });
              }
            },
          });
        } catch (err) {
          await recordPipelineDeadLetter({
            supabase,
            id: evt.id,
            clusterId,
            stageName: "event_validation",
            err,
          });

          const { error: markError } = await supabase
            .from("pipeline_events")
            .update({ processed: true })
            .eq("id", evt.id);
          if (markError) {
            console.error(
              "[eventValidationEngine] failed to mark event processed after error",
              {
                eventId: evt.id,
                clusterId,
                error: markError.message,
              },
            );
          }
        }
      },
      { concurrency: Number(process.env.PIPELINE_CONCURRENCY ?? 5) },
    );
  }

  console.log("[eventValidationEngine] queue drained");
}

import { createSupabaseServerClient } from "./newsFetcher";
import { findSimilarEvents } from "@/lib/vectorSearch";
import { emitClusterEventOnce } from "./pipelineEventUtils";
import { generateClusterKey } from "@/lib/clusterKey";

type MacroEventRow = {
  id: string;
  title: string;
  description: string;
  published_at: string | null;
  time_bucket: string | null;
  embedding: number[] | null;
  cluster_key?: string | null;
  cluster_id: string | null;
  clustered: boolean;
};

export async function runEventClustering(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const diagnostics = {
    rowsLoaded: 0,
    nullEmbedding: 0,
    clusterKeysGenerated: 0,
    clustersInserted: 0,
    assignedToExistingCluster: 0,
  };

  const { data: checkpoint, error: checkpointError } = await supabase
    .from("clustering_checkpoints")
    .select("id,last_processed_published_at")
    .maybeSingle();

  if (checkpointError) {
    throw new Error(`Failed to load clustering checkpoint: ${checkpointError.message}`);
  }

  const lastProcessed = (() => {
    const value = (
      checkpoint as { last_processed_published_at?: unknown } | null
    )?.last_processed_published_at;
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date(0);
  })();

  const lastProcessedIso = lastProcessed.toISOString();

  const { data: events, error } = await supabase
    .from("macro_events_raw")
    .select("*")
    .eq("clustered", false)
    .gte("published_at", lastProcessedIso)
    .order("published_at", { ascending: true })
    .limit(50);

  if (error) {
    throw new Error(`Failed to load events: ${error.message}`);
  }

  diagnostics.rowsLoaded = events?.length ?? 0;
  console.log(`[eventClustering] Loaded ${diagnostics.rowsLoaded} macro_events_raw rows`);

  if (!events?.length) return;

  let lastCheckpointMs: number | null = null;
  let lastCheckpointIso: string | null = null;

  for (const event of events as MacroEventRow[]) {
    const existingClusterKey = (event.cluster_key ?? "").toString().trim();
    if (!existingClusterKey) {
      const generated = generateClusterKey(event.title);
      if (generated) diagnostics.clusterKeysGenerated += 1;
    }

    const embedding = Array.isArray(event.embedding) ? event.embedding : null;
    if (!embedding) diagnostics.nullEmbedding += 1;
    const similar = embedding
      ? await findSimilarEvents(embedding, event.time_bucket)
      : [];

    let clusterId: string | null | undefined;

    if (similar.length > 0) {
      diagnostics.assignedToExistingCluster += 1;
      const { data: cluster, error: clusterError } = await supabase
        .from("macro_events_raw")
        .select("cluster_id")
        .eq("id", similar[0].id)
        .single();

      if (clusterError) {
        throw new Error(`Failed to load cluster_id: ${clusterError.message}`);
      }

      clusterId = (cluster as { cluster_id: string | null } | null)?.cluster_id;
    } else {
      const { data: newCluster, error: newClusterError } = await supabase
        .from("event_clusters")
        .insert({
          title: event.title,
          summary: event.title,
          article_count: 1,
        })
        .select("id")
        .single();

      if (newClusterError) {
        throw new Error(`Failed to create cluster: ${newClusterError.message}`);
      }

      clusterId = (newCluster as { id: string }).id;

      diagnostics.clustersInserted += 1;

      await emitClusterEventOnce({
        supabase,
        eventType: "CLUSTER_CREATED",
        clusterId,
      });
    }

    const { error: updateError } = await supabase
      .from("macro_events_raw")
      .update({
        cluster_id: clusterId,
        clustered: true,
      })
      .eq("id", event.id);

    if (updateError) {
      throw new Error(`Failed to update event: ${updateError.message}`);
    }

    // Advance checkpoint based on published_at only (never on cluster_id).
    if (event.published_at) {
      const publishedDate = new Date(event.published_at);
      const publishedMs = publishedDate.getTime();
      if (Number.isFinite(publishedMs)) {
        if (lastCheckpointMs === null || publishedMs > lastCheckpointMs) {
          lastCheckpointMs = publishedMs;
          lastCheckpointIso = publishedDate.toISOString();
        }
      }
    }

    if (!clusterId) {
      continue;
    }

    const titleProbe = event.title.slice(0, 40);
    const { data: existingStage, error: existingStageError } = await supabase
      .from("event_timelines")
      .select("id")
      .eq("cluster_id", clusterId)
      .ilike("title", `%${titleProbe}%`)
      .limit(1);

    if (existingStageError) {
      throw new Error(
        `Failed to check existing timeline stage: ${existingStageError.message}`,
      );
    }

    if (!existingStage?.length) {
      const { count, error: countError } = await supabase
        .from("event_timelines")
        .select("*", { count: "exact", head: true })
        .eq("cluster_id", clusterId);

      if (countError) {
        throw new Error(`Failed to count timeline stages: ${countError.message}`);
      }

      const stage = (count ?? 0) + 1;

      const { error: insertError } = await supabase
        .from("event_timelines")
        .insert({
          cluster_id: clusterId,
          stage,
          title: event.title,
          description: event.description,
          event_timestamp: event.published_at ?? new Date(),
        });

      if (insertError) {
        throw new Error(`Failed to insert timeline record: ${insertError.message}`);
      }
    }
  }

  console.log(
    `[eventClustering] Diagnostics: nullEmbedding=${diagnostics.nullEmbedding}, clusterKeysGenerated=${diagnostics.clusterKeysGenerated}, clustersInserted=${diagnostics.clustersInserted}`,
  );

  if (diagnostics.rowsLoaded > 0 && diagnostics.clustersInserted === 0) {
    const reason =
      diagnostics.assignedToExistingCluster === diagnostics.rowsLoaded
        ? "all loaded events matched existing clusters (vector similarity found matches)"
        : diagnostics.nullEmbedding === diagnostics.rowsLoaded
          ? "all loaded events had null embeddings (vector similarity skipped)"
          : "no new clusters were inserted for the loaded events";

    console.warn(
      `[eventClustering] WARNING: Loaded ${diagnostics.rowsLoaded} rows but created 0 clusters; ${reason}. assignedToExistingCluster=${diagnostics.assignedToExistingCluster}, nullEmbedding=${diagnostics.nullEmbedding}`,
    );
  }

  if (lastCheckpointIso) {
    const checkpointId = (checkpoint as { id?: string } | null)?.id;

    const checkpointUpdate = checkpointId
      ? await supabase
          .from("clustering_checkpoints")
          .update({ last_processed_published_at: lastCheckpointIso })
          .eq("id", checkpointId)
      : await supabase
          .from("clustering_checkpoints")
          .insert({ last_processed_published_at: lastCheckpointIso });

    if (checkpointUpdate.error) {
      throw new Error(
        `Failed to update clustering checkpoint: ${checkpointUpdate.error.message}`,
      );
    }
  }
}

import { createSupabaseServerClient } from "./newsFetcher";
import { findSimilarEvents } from "@/lib/vectorSearch";

type MacroEventRow = {
  id: string;
  title: string;
  description: string;
  published_at: string | null;
  time_bucket: string | null;
  embedding: number[] | null;
  cluster_id: string | null;
  clustered: boolean;
};

export async function runEventClustering(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: checkpoint, error: checkpointError } = await supabase
    .from("clustering_checkpoints")
    .select("last_processed_at")
    .single();

  if (checkpointError) {
    throw new Error(`Failed to load clustering checkpoint: ${checkpointError.message}`);
  }

  const lastProcessed = checkpoint?.last_processed_at ?? new Date(0);

  const { data: events, error } = await supabase
    .from("macro_events_raw")
    .select("*")
    .eq("clustered", false)
    .gte("published_at", lastProcessed)
    .order("published_at", { ascending: true })
    .limit(50);

  if (error) {
    throw new Error(`Failed to load events: ${error.message}`);
  }

  if (!events?.length) return;

  for (const event of events as MacroEventRow[]) {
    const embedding = Array.isArray(event.embedding) ? event.embedding : null;
    const similar = embedding
      ? await findSimilarEvents(embedding, event.time_bucket)
      : [];

    let clusterId: string | null | undefined;

    if (similar.length > 0) {
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

      const { error: emitError } = await supabase.from("pipeline_events").insert({
        event_type: "CLUSTER_CREATED",
        payload: { cluster_id: clusterId },
      });

      if (emitError) {
        throw new Error(`Failed to emit CLUSTER_CREATED event: ${emitError.message}`);
      }
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

  const { error: checkpointUpdateError } = await supabase
    .from("clustering_checkpoints")
    .update({ last_processed_at: new Date() })
    .neq("id", null);

  if (checkpointUpdateError) {
    throw new Error(
      `Failed to update clustering checkpoint: ${checkpointUpdateError.message}`,
    );
  }
}

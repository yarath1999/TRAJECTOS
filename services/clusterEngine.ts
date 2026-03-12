import { createSupabaseServerClient } from "./newsFetcher";
import { generateClusterKey } from "@/lib/clusterKey";

type MacroEvent = {
  id: string;
  title: string;
  cluster_key: string | null;
};

type EventCluster = {
  id: string;
};

export async function runIncrementalClustering(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: newEvents, error: newEventsError } = await supabase
    .from("macro_events_raw")
    .select("id,title,cluster_key")
    .eq("clustered", false)
    .limit(100);

  if (newEventsError) {
    throw new Error(`Failed to load unclustered events: ${newEventsError.message}`);
  }

  if (!newEvents?.length) return;

  for (const event of newEvents as MacroEvent[]) {
    const clusterKey = event.cluster_key ?? generateClusterKey(event.title);

    if (!clusterKey) {
      await supabase
        .from("macro_events_raw")
        .update({ clustered: true })
        .eq("id", event.id);
      continue;
    }

    const { data: existingCluster, error: existingClusterError } = await supabase
      .from("event_clusters")
      .select("id")
      .eq("title", clusterKey)
      .limit(1)
      .maybeSingle();

    if (existingClusterError) {
      throw new Error(
        `Failed to load existing cluster: ${existingClusterError.message}`,
      );
    }

    let clusterId: string;

    if (existingCluster) {
      clusterId = (existingCluster as EventCluster).id;
    } else {
      const { data: newCluster, error: newClusterError } = await supabase
        .from("event_clusters")
        .insert({
          title: clusterKey,
          summary: event.title,
          article_count: 1,
        })
        .select("id")
        .single();

      if (newClusterError) {
        throw new Error(`Failed to create cluster: ${newClusterError.message}`);
      }

      clusterId = (newCluster as EventCluster).id;
    }

    const { error: updateError } = await supabase
      .from("macro_events_raw")
      .update({
        cluster_id: clusterId,
        clustered: true,
      })
      .eq("id", event.id);

    if (updateError) {
      throw new Error(`Failed to mark event clustered: ${updateError.message}`);
    }
  }
}

-- Emits a real-time notification whenever a pipeline event is created.
-- Channel: pipeline_event_created
-- Payload: { event_id, event_type, cluster_id }

create or replace function public.notify_pipeline_event_created()
returns trigger
language plpgsql
as $$
declare
  v_cluster_id text;
  v_payload text;
begin
  -- cluster_id is carried in the JSON payload for most pipeline events.
  v_cluster_id := nullif(trim(coalesce((new.payload ->> 'cluster_id')::text, '')), '');

  v_payload := json_build_object(
    'event_id', new.id,
    'event_type', new.event_type,
    'cluster_id', v_cluster_id
  )::text;

  perform pg_notify('pipeline_event_created', v_payload);
  return new;
end;
$$;

-- Drop + recreate to be idempotent.
drop trigger if exists trg_pipeline_event_created_notify on public.pipeline_events;

create trigger trg_pipeline_event_created_notify
after insert on public.pipeline_events
for each row
execute function public.notify_pipeline_event_created();

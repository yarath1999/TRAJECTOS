-- Notify the Node worker when new pipeline_events are inserted.
-- Channel: pipeline_events_channel
-- Payload: NEW.id as text

create or replace function public.notify_pipeline_event()
returns trigger
language plpgsql
as $$
begin
  perform pg_notify(
    'pipeline_events_channel',
    new.id::text
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_pipeline_event on public.pipeline_events;

create trigger trg_notify_pipeline_event
after insert on public.pipeline_events
for each row
execute function public.notify_pipeline_event();

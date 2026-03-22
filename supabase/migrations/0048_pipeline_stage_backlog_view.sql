-- Pipeline health view: backlog counts by event_type.

CREATE OR REPLACE VIEW public.pipeline_stage_backlog AS
SELECT
  event_type,
  count(*) FILTER (WHERE processed = false) AS pending,
  count(*) FILTER (WHERE processed = true) AS completed
FROM public.pipeline_events
GROUP BY event_type;

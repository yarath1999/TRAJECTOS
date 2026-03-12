-- Emits a pipeline event whenever an insight row is created.
-- This enables downstream streaming stages (e.g. allocation engine) without
-- modifying the existing insight engine code.

CREATE OR REPLACE FUNCTION emit_insight_created_pipeline_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO pipeline_events (event_type, payload, processed)
  VALUES (
    'INSIGHT_CREATED',
    jsonb_build_object('cluster_id', NEW.cluster_id),
    false
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_event_insights_emit_pipeline_event ON event_insights;

CREATE TRIGGER trg_event_insights_emit_pipeline_event
AFTER INSERT ON event_insights
FOR EACH ROW
EXECUTE FUNCTION emit_insight_created_pipeline_event();

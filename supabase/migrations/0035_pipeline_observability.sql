-- Pipeline observability tables (additive)

create table if not exists public.pipeline_stage_runtime (
  id uuid primary key default gen_random_uuid(),
  stage_name text not null,
  event_id uuid null,
  cluster_id text null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  duration_ms integer not null,
  status text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_pipeline_stage_runtime_stage_time
  on public.pipeline_stage_runtime(stage_name, end_time desc);

create index if not exists idx_pipeline_stage_runtime_cluster
  on public.pipeline_stage_runtime(cluster_id);

create table if not exists public.pipeline_failures (
  id uuid primary key default gen_random_uuid(),
  stage_name text not null,
  event_id uuid null,
  cluster_id text null,
  error_message text not null,
  error_stack text null,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_pipeline_failures_stage_time
  on public.pipeline_failures(stage_name, occurred_at desc);

create index if not exists idx_pipeline_failures_cluster
  on public.pipeline_failures(cluster_id);

-- Aggregated per-minute metrics snapshots (written by pipelineMonitor)
create table if not exists public.pipeline_metrics (
  window_start timestamptz not null,
  stage_name text not null,
  processed_count integer not null default 0,
  avg_duration_ms numeric null,
  failure_count integer not null default 0,
  backlog_size integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (window_start, stage_name)
);

create index if not exists idx_pipeline_metrics_window
  on public.pipeline_metrics(window_start desc);

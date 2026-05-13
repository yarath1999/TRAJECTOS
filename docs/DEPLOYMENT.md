# Trajectos V1 Deployment

Concise production runbook for Trajectos V1.

## Environment Setup
1. Copy [.env.example](../.env.example) to `.env.local`.
2. Fill in the required values from your Supabase project and Postgres connection string.
3. Keep secrets out of git; use the deployment platform's secret store in production.

Required variables:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY`
- `DATABASE_URL`

Optional tuning / debug variables:
- `PGSSLMODE`
- `PIPELINE_CONCURRENCY`
- `PIPELINE_EVENT_COOLDOWN_MINUTES`
- `PIPELINE_EVENT_RECENT_PROCESSED_MINUTES`
- `DEAD_LETTER_FALLBACK_REPLAY_BATCH_SIZE`
- `PIPELINE_SIGNAL_STRENGTH_BACKFILL_CLUSTER_LIMIT`
- `PIPELINE_DEBUG_SIGNIFICANCE`
- `PIPELINE_DEBUG_INSIGHT_REASONING`
- `CLUSTERING_RECOVERY_MODE`
- `CLUSTERING_BACKLOG_LIMIT`
- `SIM_EVENT_COUNT`

## Supabase Setup
1. Create or verify the Supabase project.
2. Apply the migrations in `supabase/migrations/`.
3. Confirm these tables exist and are queryable:
- `pipeline_events`
- `event_clusters`
- `event_insights`
- `event_allocations`
- `portfolio_signals`
- `pipeline_stage_runtime`
- `pipeline_failures`
- `pipeline_metrics`
4. Make sure the service-role key has write access for worker scripts.

Useful validation:
```bash
npx tsc --noEmit
npx tsx scripts/checkSystemHealth.ts
```

## Worker Startup
Start workers in this order:
1. Queue / ingestion worker
2. Validation / factor / impact / signal / insight stages
3. Allocation worker
4. Pipeline monitor
5. Pipeline watchdog

Exact commands:
```bash
npm run allocation-worker
npm run pipeline-monitor
npm run pipeline-watchdog
```

If you are running the full pipeline worker loop, use:
```bash
npx tsx services/pipelineWorker.ts
```

## Monitoring Startup
Run the monitor alongside the workers:
```bash
npm run pipeline-monitor
```

For health checks:
```bash
npm run healthcheck
```

The monitor writes metrics into `pipeline_metrics` and prints stage summaries to stdout.

## Health Checks
Run health checks before and after deployment:
```bash
npm run healthcheck
```

Expected success output:
```bash
SYSTEM_HEALTH_OK
```

If it fails, inspect the printed per-check diagnostics first.

## Smoke Tests
Run the deterministic production smoke checks:
```bash
npm run snapshots
npm run simulate
```

Broad validation before release:
```bash
npm run typecheck
```

## Deployment Order
1. Deploy code.
2. Apply Supabase migrations.
3. Publish or sync `.env.local` / secret values.
4. Run typecheck.
5. Run health checks.
6. Start workers in the production order above.
7. Confirm monitor output and backlog reduction.
8. Run snapshots and simulation before the first traffic cutover.

## Restart Procedure
Use a clean restart after a deploy or config change:
1. Stop worker processes.
2. Wait for the current in-flight cycle to finish.
3. Restart workers in the same order listed above.
4. Re-run health checks.
5. Verify the monitor reports fresh runtime rows and backlog movement.

Commands:
```bash
npm run healthcheck
npm run allocation-worker
npm run pipeline-monitor
npm run pipeline-watchdog
```

## Recovery Procedure
Use this when backlog grows, a worker stalls, or a deployment partially fails:
1. Run `npm run healthcheck`.
2. Check `pipeline-monitor` output for backlog and failure spikes.
3. Check `pipeline-watchdog` output for stuck clusters or missing downstream outputs.
4. If needed, restart the affected worker first, then the remaining workers.
5. Re-run `npm run simulate` if allocation behavior needs a quick offline verification.

If the worker loop is stuck but the database is healthy:
```bash
npm run pipeline-watchdog
```

If allocations look wrong after recovery:
```bash
npm run snapshots
npm run simulate
```

## Troubleshooting
- Missing Supabase env vars usually mean `.env.local` was not created from [.env.example](../.env.example).
- `SYSTEM_HEALTH_FAIL` usually points to a database connectivity issue, missing tables, or a stale worker runtime.
- If `pipeline-watchdog` reports repeated recovery events, check whether `pipeline_events` is backing up.
- If `pipeline-monitor` cannot write metrics, verify Supabase permissions and table migrations.
- If a worker never exits, send `SIGINT` or `SIGTERM`; workers are wired to stop polling cleanly and finish the current cycle.
- If `npm run simulate` or `npm run snapshots` fails, treat it as an allocation/regime regression before promoting the deploy.

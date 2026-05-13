# Trajectos V1 Performance

This guide covers the V1 performance stabilization pass for Trajectos. The goal is to improve visibility and reduce avoidable overhead without changing allocation decisions, regime scoring, or the overall worker architecture.

## What Is Profiled

- allocation engine
- regime engine
- dashboard queries
- health checks

## Optimizations Applied

- cached Supabase clients where the process lifetime makes that safe
- reduced duplicate DB reads in dashboard and health paths
- cached regime parsing for repeated payloads
- shared query timing helpers for fast instrumentation
- minimized repeated JSON parsing on identical reasoning payloads

## Query Timing Logs

The system now emits lightweight timing logs for dashboard, health, and worker queries.

Use these logs to spot slow reads and unexpected fan-out.

Slow query threshold:

- anything above 500ms emits a warning

## In-Memory Caching

Caching is intentionally small and local to the running process.

Safe caches include:

- Supabase client singletons for server and admin read paths
- regime reasoning parse cache

The caches are best-effort only and never replace source-of-truth database behavior.

## Allocation Engine Profiling

Watch for these events in logs:

- `ALLOCATION_QUERY_TIMING`
- `ALLOCATION_SLOW_QUERY`
- `ALLOCATION_EXECUTION_DURATION`
- `ALLOCATION_CLUSTER_DURATION`

## Regime Engine Profiling

Watch for these events in logs:

- `REGIME_CONFIDENCE_BREAKDOWN`
- `REGIME_FALLBACK_USED`
- `REGIME_FALLBACK_REPEATED`
- `REGIME_FINAL_USED`

## Dashboard Query Profiling

Watch for these events in logs:

- `DASHBOARD_QUERY_TIMING`
- `DASHBOARD_SLOW_QUERY`

## Health Check Profiling

Watch for these events in logs:

- `HEALTHCHECK_QUERY_TIMING`
- `HEALTHCHECK_SLOW_QUERY`

## Validation Commands

```bash
npm run typecheck
npm run snapshots
npm run healthcheck
```

## Practical Review Flow

1. Run the dashboard and collect a few minutes of timing logs.
2. Confirm any slow query warnings are tied to an actual table scan or backlog spike.
3. Compare allocation duration logs before and after a deployment.
4. Inspect regime confidence logs to ensure the cache does not alter scoring results.
5. Keep the caches small and local; do not add external infrastructure.
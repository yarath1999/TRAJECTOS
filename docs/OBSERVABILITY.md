# Trajectos V1 Observability

This guide covers the production observability surface for Trajectos V1. It is intentionally focused on runtime visibility only and does not change allocation, regime, or schema behavior.

## Structured Logs

Trajectos emits JSON logs for machine parsing plus a human-readable summary for local inspection.

Common log fields:

- `event`
- `level`
- `timestamp`
- `cluster_id`
- `regime`
- `confidence`
- `correlation_id`
- `run_id`

Key log families:

- request lifecycle logs for API routes
- worker lifecycle logs for batch and background services
- regime analysis logs from the regime engine
- allocation timing and outcome logs
- watchdog recovery and stale-event warnings

## Health Checks

Use the healthcheck flow before and after deployments.

- `npm run healthcheck`
- `curl http://localhost:3000/api/health`
- `curl http://localhost:3001/api/health/system`
- `curl http://localhost:3001/api/health/database`
- `curl http://localhost:3001/api/health/regime-engine`

Health checks validate:

- database connectivity
- worker freshness
- allocation engine readiness
- regime engine readiness

## Worker Lifecycle

Worker runs emit run-scoped IDs so a single batch can be traced end to end.

- allocation worker run start and completion
- event queue worker run start and completion
- cluster processing duration logs
- allocation execution duration logs
- duplicate-skip tracking and warnings

## Snapshot Testing

Snapshot coverage protects the allocation output shape and keeps regime refinements from introducing regressions.

- `npm run snapshots`
- deterministic scenario coverage for strong, weak, conflicting, and fallback cases

## Simulation Suite

The simulation script exercises regime scoring and allocation outputs across representative macro conditions.

- `npm run simulate`
- confirm confidence bands, fallback behavior, and allocation stability

## Regime Diagnostics

Regime logs should be used to understand the control path before any allocation or deployment change.

- `REGIME_RAW_DETECTED`
- `REGIME_REJECT_REASON`
- `REGIME_FALLBACK_USED`
- `REGIME_FALLBACK_REPEATED`
- `REGIME_HISTORY_CONFIRMED_ONLY`
- `REGIME_CONFIDENCE_BREAKDOWN`
- `REGIME_FINAL_USED`

## Deployment Monitoring Flow

1. Start the monitor service first.
2. Start the worker services.
3. Run `npm run healthcheck`.
4. Inspect `pm2 status` or `docker compose ps`.
5. Watch for:
   - stale pipeline event warnings
   - repeated fallback regime warnings
   - high allocation latency warnings
   - repeated duplicate-skip warnings
6. Confirm the metrics snapshot shows:
   - clusters processed per minute
   - allocation failures per minute
   - average regime confidence
   - average allocation execution time

## Useful Commands

```bash
npm run typecheck
npm run snapshots
npm run simulate
npm run healthcheck
pm2 monit
pm2 logs worker --lines 100
pm2 logs monitor --lines 100
pm2 logs watchdog --lines 100
```
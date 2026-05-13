# Trajectos V1 Architecture

## 1. System Overview
Trajectos V1 is an event-driven pipeline that turns ingestible news and market events into insights, regime classification, allocations, and operational telemetry. The system is intentionally stage-based so each worker owns one responsibility, emits explicit pipeline events, and writes its own runtime records.

High-level flow:

news/events -> insights -> regime engine -> allocation engine -> allocations -> analytics

The production flow is:

1. `newsFetcher` ingests external source data into pipeline-facing tables.
2. `eventProcessor` consumes queue items and keeps source liveness metadata current.
3. `insightEngine` builds structured insight reasoning from factor and signal data.
4. `regimeEngine` scores the reasoning and resolves the active macro regime.
5. `allocationEngine` converts signals plus regime context into normalized portfolio allocations.
6. `pipelineWorker`, `pipelineMonitor`, and `pipelineWatchdog` provide orchestration, observability, and recovery.

The architecture is designed around additive writes, idempotent event emission, and read-only health/monitoring checks so production behavior stays stable under retries and partial failures.

## 2. Pipeline Flow

### newsFetcher
Purpose: ingest source data from feeds and external inputs into the application data model.

Inputs:
- RSS/feed content and article metadata
- environment configuration for Supabase access
- normalized article and entity extraction helpers

Outputs:
- inserted or upserted queue/event rows in pipeline-facing tables
- deduplicated source records ready for downstream processing

Side effects:
- writes to Supabase/Postgres
- uses database upserts to suppress duplicate source rows
- establishes the shared server-side Supabase client used by worker scripts

Important logs:
- client bootstrap and key-type diagnostics
- batch insert or upsert failures
- duplicate suppression errors when a feed item cannot be safely written

### eventProcessor
Purpose: process queued ingestion items and maintain source activity metadata.

Inputs:
- queue records from ingestion tables
- pipeline event payloads

Outputs:
- processed queue rows
- updated source heartbeat data via `last_seen_at`

Side effects:
- updates `event_fingerprints.last_seen_at` as the best available liveness proxy for source processing
- advances queue-processing state in the database

Important logs:
- queue processing progress
- fingerprint updates
- recovery or retry failures

### insightEngine
Purpose: generate structured insight reasoning from factor exposure and signal data.

Inputs:
- validated clusters
- factor exposures
- legacy signal rows when reasoning is not available
- cluster summaries when present

Outputs:
- `event_insights` rows containing insight text, confidence, and structured reasoning
- `INSIGHT_COMPLETED` pipeline events

Side effects:
- writes structured insight reasoning to the database
- can backfill or update an existing insight row for a cluster
- emits downstream events only when the insight is ready or materially changed

Important logs:
- `REGIME_SCORES`
- `REGIME_DETECTED`
- `INSIGHT_REASONING`
- insert/update failures for `event_insights`
- `INSIGHT_COMPLETED` emission issues

### regimeEngine
Purpose: resolve the active macro regime from structured insight reasoning.

Inputs:
- `event_insights.reasoning`
- signal rows embedded in reasoning

Outputs:
- detected regime
- confidence score
- dynamic adjustment strength
- smoothing state derived from recent detections

Side effects:
- keeps regime state in memory for smoothing and fallback behavior
- emits structured regime logs for downstream analysis

Important logs:
- `REGIME_RAW_DETECTED`
- `REGIME_TOP_SCORE`
- `REGIME_SECOND_SCORE`
- `REGIME_REJECT_REASON`
- `REGIME_FALLBACK_USED`
- `REGIME_HISTORY`
- `REGIME_SMOOTHED`
- `REGIME_FINAL_USED`
- `REGIME_CONFIDENCE`
- `REGIME_ADJUSTMENT_STRENGTH`

### allocationEngine
Purpose: convert insight reasoning and regime context into final normalized allocations.

Inputs:
- `event_insights.reasoning`
- `portfolio_signals` as a backward-compatible fallback
- prior `event_allocations` for significance comparison
- regime output from `regimeEngine`

Outputs:
- `event_allocations` rows with asset, action, weight, and confidence
- `ALLOCATION_COMPLETED` events with significance metadata

Side effects:
- deletes and replaces old allocation rows for a cluster before inserting the fresh set
- marks the processed pipeline event as complete
- suppresses duplicate processing within the same worker run

Important logs:
- `ALLOCATION_SKIPPED_DUPLICATE`
- `ALLOCATION_DECISION`
- `ALLOCATION_INSERT_ERROR`
- `PIPELINE_EVENT_MARK_ERROR`
- `REGIME_CONFIDENCE`
- `REGIME_ADJUSTMENT_STRENGTH`

### pipelineWorker
Purpose: orchestrate the end-to-end worker loop.

Inputs:
- pending `pipeline_events`
- worker-specific environment settings
- database connectivity

Outputs:
- sequential execution of orchestrator and stage workers
- periodic operational summaries
- dead-letter retry processing and fallback replay

Side effects:
- coordinates worker execution order
- emits worker telemetry and regime analytics
- starts fallback dead-letter replay on boot

Important logs:
- `PIPELINE_WORKER_START`
- `PIPELINE_PENDING_COUNT`
- `PIPELINE_STAGE_PROCESSED`
- `REGIME_ANALYTICS`
- `REGIME_ANALYTICS_FAILED`

### pipelineMonitor
Purpose: summarize pipeline runtime and failure health.

Inputs:
- `pipeline_stage_runtime`
- `pipeline_failures`
- backlog counts from `pipeline_events`

Outputs:
- periodic snapshots written to `pipeline_metrics`
- console summaries for operators

Side effects:
- upserts aggregate metrics for the latest time window
- keeps a low-overhead operational history in the database

Important logs:
- backlog summary lines
- per-stage throughput and failure summaries
- snapshot write failures are best-effort and do not stop monitoring

### pipelineWatchdog
Purpose: detect and recover from stalled pipeline activity.

Inputs:
- backlog counts from `pipeline_events`
- stale unvalidated clusters
- validated clusters missing factor exposures or impact scores

Outputs:
- re-emitted recovery events such as `CLUSTER_CREATED` and `CLUSTER_VALIDATED`

Side effects:
- emits recovery events only
- never mutates the business tables directly

Important logs:
- backlog warnings
- stuck-cluster warnings
- recovery event emission failures

## 3. Regime Engine
The regime engine supports four regimes:
- inflationary
- risk_off
- growth
- deflationary

### Scoring system
The regime scorer reads structured insight signals and maps them into a simple deterministic score set:
- inflationary: `bonds = SELL` and/or `commodities = BUY`
- risk_off: `equities = SELL` and/or `usd = BUY`
- growth: `equities = BUY` and/or `commodities = BUY`
- deflationary: `bonds = BUY` and/or `equities = SELL`

Each matching signal contributes one point to the relevant regime score. The scores are then compared to choose the active regime.

### Thresholds
A regime is only accepted when:
- the top score is at least `MIN_REGIME_SCORE`
- the top score exceeds the second score by at least `MIN_REGIME_MARGIN`

If the score is too weak or too close to a runner-up, the regime is rejected and fallback logic is used.

### Tie-breaking rules
When two or more regimes have the same score, the engine uses a fixed priority order:
1. inflationary
2. risk_off
3. growth
4. deflationary

This keeps regime selection deterministic across identical inputs.

### Fallback logic
If the scorer cannot resolve a regime:
- the last detected regime is reused when available
- otherwise the default fallback regime is `growth`

This makes the engine resilient to sparse or ambiguous reasoning without stopping downstream processing.

### Persistence
Regime state is not persisted in a dedicated table. The current implementation keeps:
- recent regime history in memory for smoothing
- the last detected regime in memory for fallback behavior

That means regime smoothing is process-local and resets on worker restart.

### Smoothing
The engine keeps a bounded recent history of detections and derives a smoothed regime from that history.
- history size is controlled by `REGIME_HISTORY_SIZE`
- the most frequent regime in the recent window wins
- if there is a tie, the most recent tied regime wins

This suppresses one-off flips without hiding sustained regime change.

### Confidence calculation
Confidence is calculated from the relative strength of the winning regime:
- `confidence = topScore / totalScore`
- if the total score is zero, confidence is zero

This makes confidence easy to interpret and stable across runs.

### Dynamic adjustment strength
The engine maps confidence to a bounded adjustment strength:
- weak confidence maps near `MIN_REGIME_ADJUSTMENT`
- mid confidence stays near `DEFAULT_REGIME_ADJUSTMENT`
- strong confidence approaches `MAX_REGIME_ADJUSTMENT`

The mapping is centralized in `config/allocationConfig.ts` and keeps regime influence secondary to signal direction.

### Score examples
Examples of deterministic outcomes:
- `bonds = SELL`, `commodities = BUY` -> inflationary
- `equities = SELL`, `usd = BUY` -> risk_off
- `equities = BUY`, `commodities = BUY` -> growth
- `bonds = BUY`, `equities = SELL` -> deflationary

Examples of ties:
- `growth = 2` and `inflationary = 2` resolves to inflationary because of the priority order
- `risk_off = 1` and `growth = 1` with a weak score is rejected if the threshold is not met

### Smoothing behavior
Smoothing only changes the chosen regime when the recent history supports a different dominant regime. It does not rewrite the raw scoring result; it only affects the final regime used downstream.

## 4. Allocation Engine
The allocation engine takes structured insight signals plus the resolved regime and produces final weights.

### Base asset weights
The current base weights are:
- equities: `0.4`
- bonds: `0.3`
- commodities: `0.2`
- usd: `0.1`
- cash: `0`

These base weights are the starting point before signal and regime adjustments are applied.

### Signal-driven adjustments
Signals are primary. Each asset signal maps through `allocationModel`:
- BUY -> `+0.3`
- SELL -> `-0.3`
- NEUTRAL -> `0`

This means the asset-level signal has the first and largest effect on the final allocation.

### Secondary regime adjustments
Regime adjustments are intentionally smaller and are applied after the signal-based adjustments:
- inflationary: commodities up, bonds down
- risk_off: bonds up, equities down
- growth: equities up, commodities up
- deflationary: bonds up, equities down

This keeps macro context secondary to the direct signals inside the reasoning payload.

### Why signals are primary
Signals encode the direct interpretation of the current event cluster. Regime context is a macro overlay and should not override the per-asset signal structure unless the regime is strong enough to justify a smaller bias.

### Why regime is secondary
The regime engine is a stabilizer, not the main allocator. It nudges the portfolio toward the dominant macro state, but the direct asset signals remain the main source of allocation direction.

### Normalization
After all adjustments:
- weights are clamped into a valid range
- allocations are normalized so the final set sums to 1.0

If normalization cannot produce a positive total, the system falls back to cash.

### Duplicate prevention
The engine prevents duplicate work in two ways:
- it skips clusters already processed during the same worker run
- it avoids duplicate per-asset logging using a cluster-local asset set

The database-side pipeline event guards also help keep event emission idempotent.

### Insertion flow
The allocation flow is:
1. load pending `ALLOCATION_REQUIRED` events
2. resolve cluster ID
3. load the latest `event_insights.reasoning`
4. fall back to legacy `portfolio_signals` if needed
5. read prior `event_allocations` for significance comparison
6. apply signal adjustments
7. apply regime adjustments
8. normalize final weights
9. delete old allocations for the cluster
10. insert the new `event_allocations` rows
11. mark the pipeline event processed
12. emit `ALLOCATION_COMPLETED`

### Example: risk_off allocation
For a risk_off regime, the engine biases toward bonds and away from equities.
A typical outcome is:
- higher bond weight than the base profile
- lower equity weight than the base profile
- commodities and usd remain comparatively stable unless signal inputs change them

### Example: inflationary allocation
For an inflationary regime, the engine biases toward commodities and away from bonds.
A typical outcome is:
- commodities rise above baseline
- bonds are reduced
- equity direction still depends on the signal payload

## 5. Configuration System
`config/allocationConfig.ts` centralizes the regime and allocation tuning constants.

It contains:
- `MIN_REGIME_SCORE`
- `MIN_REGIME_MARGIN`
- `DEFAULT_REGIME_ADJUSTMENT`
- `MIN_REGIME_ADJUSTMENT`
- `MAX_REGIME_ADJUSTMENT`
- `REGIME_HISTORY_SIZE`
- `DEFAULT_FALLBACK_REGIME`
- confidence bands used for strength mapping

Why it is centralized:
- keeps regime tuning consistent across the engine and tests
- reduces drift between allocation logic and documentation
- makes production changes easier to audit
- avoids scattering magic numbers across services

## 6. Logging + Observability
`utils/logger.ts` provides structured JSON logs plus a human-readable summary line for each event.

Logging behavior:
- `logEvent` emits machine-readable JSON first
- `logDebug` is for detailed diagnostics
- `logWarn` is for non-fatal issues and degraded paths
- `logError` is for failures that should be visible immediately

The system uses logs to support:
- stage-level debugging
- regime tracing
- allocation traceability
- health checks
- pipeline analytics

Major logs:
- `REGIME_FINAL_USED`
- `REGIME_CONFIDENCE`
- `ALLOCATION_DECISION`
- `ALLOCATION_SKIPPED_DUPLICATE`
- `REGIME_ANALYTICS`
- `SYSTEM_HEALTH_OK`

Observability surfaces:
- `pipeline_stage_runtime`
- `pipeline_failures`
- `pipeline_metrics`
- health checks based on read-only database queries

## 7. Testing Strategy
V1 uses a small but practical validation stack.

### Snapshot tests
Snapshot tests verify the allocation output shape and guard against unintentional drift in regime selection or normalization.

Command:
```bash
npx tsx --test tests/allocationSnapshots.test.ts
```

### Simulator
The deterministic simulator exercises regime and allocation scenarios offline without database writes.

Command:
```bash
npx tsx scripts/simulateAllocationScenarios.ts
```

### Health checks
The health script performs read-only production checks for connectivity, worker freshness, allocation readiness, and regime readiness.

Command:
```bash
npx tsx scripts/checkSystemHealth.ts
```

### Typecheck
TypeScript compilation remains the fastest broad validation for the refactor surface.

Command:
```bash
npx tsc --noEmit
```

## 8. Current Technical Debt
The V1 architecture is stable, but a few limitations remain:
- some console logs still exist outside the allocation and regime path
- regime analytics are still in-memory and reset on worker restart
- there is no distributed worker coordination yet
- there is no persisted regime analytics table yet

These are acceptable for V1, but they constrain long-running visibility and horizontal scaling.

## 9. V1 Freeze Rules
This is a V1 freeze point.

Do not introduce:
- new AI agents
- recursive orchestration
- autonomous planning systems
- architecture rewrites

Only work in these areas:
- stability
- monitoring
- bug fixes
- deployment
- data quality

The goal is to keep the current pipeline reliable and observable, not to redesign it.

## 10. Deployment Checklist
Before shipping or promoting a build, verify:

- required env vars are set:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY` as fallback when service role is unavailable
- `npx tsc --noEmit` passes
- `npx tsx --test tests/allocationSnapshots.test.ts` passes
- `npx tsx scripts/simulateAllocationScenarios.ts` passes when used as a smoke check
- `npx tsx scripts/checkSystemHealth.ts` reports `SYSTEM_HEALTH_OK`
- worker startup order is sane:
  - ingestion and queue processing first
  - then validation/factor/impact/signal/insight
  - then allocation
  - then monitoring and watchdog loops
- monitoring verification confirms runtime, backlog, and failure metrics are updating

The deployment target should only be considered healthy when the pipeline can ingest, score, allocate, and observe itself without manual intervention.

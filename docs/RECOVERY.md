# Trajectos V1 Recovery

This runbook covers the built-in recovery path for Trajectos V1. It stays within the existing worker architecture and uses the current database tables only.

## Failure Classification

Pipeline failures are classified into three buckets:

- `transient_failure` for network issues, timeouts, and upstream 5xx responses
- `permanent_failure` for non-retryable processing errors
- `malformed_payload_failure` for invalid or incomplete payloads

Classification is applied before retry scheduling so malformed or permanent failures do not loop forever.

## Retry Backoff

Dead-letter retries use a fixed backoff ladder:

1. 1 second
2. 5 seconds
3. 15 seconds
4. 30 seconds max

The same schedule is reused for repeated dead-letter retry attempts.

## Dead-Letter Diagnostics

Each dead-letter record and fallback record carries recovery metadata when available:

- `failure_reason`
- `retry_count`
- `failed_stage`
- `last_attempt_at`

Existing schema fields are reused; no new infrastructure or database tables are introduced.

## Recovery Flow

1. Workers record the failure with stage and retry metadata.
2. Transient failures enter the retry queue with backoff.
3. Permanent and malformed failures are marked non-retryable.
4. The watchdog observes backlog, worker freshness, and repeated allocation failures.
5. The monitor surfaces recovery and latency trends.

## Watchdog Alerts

Watchdog alerts are emitted for:

- worker inactivity
- queue backlog spikes
- repeated allocation failures

## Operational Commands

```bash
npm run healthcheck
npm run typecheck
npm run snapshots
pm2 monit
pm2 logs worker --lines 100
pm2 logs watchdog --lines 100
```

## Recovery Checklist

1. Confirm the worker is running and healthy.
2. Check whether backlog is spiking.
3. Review allocation failure warnings.
4. Inspect dead-letter records for `failure_reason` and `failed_stage`.
5. Let transient failures age through the backoff schedule.
6. Escalate only if permanent or malformed failures keep appearing after input fixes.
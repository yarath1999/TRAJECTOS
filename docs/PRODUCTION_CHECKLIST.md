# Trajectos V1 Production Deployment Checklist

## Pre-Deployment Environment Setup

### 1. Environment Configuration

```bash
# Copy and configure .env.production
cp .env.example .env.production

# Required variables:
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
DATABASE_URL=<your-postgres-connection-string>
LOG_LEVEL=INFO
REGIME_ENGINE_DEBUG=false
NODE_ENV=production
```

### 2. Verify Node.js Version

```bash
# Required: Node.js 20.x LTS
node --version  # v20.x.x
npm --version   # v10.x.x or higher
```

### 3. Install Dependencies

```bash
npm ci  # Use ci for production (cleaner than npm install)
```

## Database Migration Order

Execute migrations in this sequence to ensure regime engine state tables exist before pipeline operations begin:

### 1. Core Pipeline Infrastructure

```sql
-- Runs via: npm run db:migrate
-- Creates: pipeline_events, pipeline_stage_runtime
-- Purpose: Event log and runtime tracking
```

### 2. Regime Engine State Tables

```sql
-- Creates: regime_history, regime_transitions
-- Purpose: Smoothing history and transition tracking for macro regimes
-- Dependencies: None (independent of pipeline)
```

### 3. Observability Tables

```sql
-- Creates: event_insights, event_allocations, pipeline_failures, event_clusters
-- Purpose: Analytics, allocation tracking, failure diagnostics
-- Dependencies: pipeline_events (foreign keys)
```

### 4. Indexing Strategy

```sql
-- Create indexes after tables populated
-- Priority indexes:
--   - pipeline_events(event_type, created_at DESC)
--   - event_insights(regime, created_at DESC)
--   - event_allocations(allocation_state, created_at DESC)
--   - pipeline_failures(stage, created_at DESC)
```

**Migration Execution:**

```bash
# Run migrations (must complete before any worker starts)
npm run db:migrate

# Verify all tables created
npm run db:verify-schema
```

## Worker Startup Order

Start processes in this sequence to prevent race conditions:

### 1. Start Monitor Service (First)

```bash
# Starts observability, healthcheck endpoints, metrics collection
npm run start:monitor &

# Wait for port 3001 to be healthy
sleep 2
curl http://localhost:3001/health
```

### 2. Start Main Worker (Second)

```bash
# Starts core allocation pipeline
npm run start:worker &

# Wait for worker initialization
sleep 3
curl http://localhost:3000/api/health
```

### 3. Start Watchdog (Third)

```bash
# Starts background processes: TTL expiration, cleanup, state validation
npm run start:watchdog &

# Verify all services running
npm run healthcheck
```

**Full Sequential Start:**

```bash
# Using docker-compose (recommended for production)
docker-compose -f docker-compose.yml up -d monitor
docker-compose -f docker-compose.yml up -d worker
docker-compose -f docker-compose.yml up -d watchdog

# Or using PM2
pm2 start ecosystem.config.js
```

## Healthcheck Steps

Run these before considering deployment complete:

```bash
# 1. System Health (all services running)
curl http://localhost:3001/api/health/system
# Expected: 200 OK, all services "healthy"

# 2. Database Connection
curl http://localhost:3001/api/health/database
# Expected: 200 OK, connection pool healthy

# 3. Regime Engine Ready
curl http://localhost:3001/api/health/regime-engine
# Expected: 200 OK, state initialized

# 4. Full Health Report
npm run healthcheck
# Expected: All checks pass, no warnings
```

## Monitoring Commands

Monitor production in real-time:

```bash
# 1. PM2 Monitoring
pm2 monit

# 2. View application logs
pm2 logs worker --lines 100
pm2 logs monitor --lines 100
pm2 logs watchdog --lines 100

# 3. Check process memory/CPU
pm2 status

# 4. Inspect errors
pm2 logs worker --err --lines 50

# 5. Real-time metrics endpoint
curl http://localhost:3001/api/metrics

# 6. Regime engine state
curl http://localhost:3001/api/admin/regime-state

# 7. Pipeline backlog check
curl http://localhost:3001/api/admin/pipeline-stats
```

## Rollback Procedure

If deployment fails or critical issues detected:

### 1. Immediate Rollback (within 5 minutes)

```bash
# Stop all services
pm2 stop all
docker-compose down

# Roll back to previous container image
docker pull trajectos-worker:v0.9.0
docker-compose up -d

# Verify services recovering
npm run healthcheck
```

### 2. Data Rollback (if corrupted)

```bash
# DO NOT delete regime_history table
# Rollback is automatic via REGIME_FALLBACK_TTL_MS (30 minutes)
# Manual state reset:

# If regime state is corrupt:
DELETE FROM regime_history WHERE created_at > NOW() - INTERVAL '1 hour';
DELETE FROM regime_transitions WHERE created_at > NOW() - INTERVAL '1 hour';

# Restart worker (state reinitializes)
pm2 restart worker
```

### 3. Database Rollback

```bash
# Use Supabase backups if available
# Point DATABASE_URL to previous backup
export DATABASE_URL=<backup-connection-string>

# Restart worker
pm2 restart worker

# Verify data integrity
npm run db:verify-schema
```

## Restart Procedure

Restart services gracefully:

### 1. Single Service Restart

```bash
# Restart only worker (cleanest, keeps monitor/watchdog running)
pm2 restart worker

# Wait for worker to reinitialize regime state
sleep 5

# Verify healthy
curl http://localhost:3000/api/health
```

### 2. Full Service Restart

```bash
# Stop in reverse order: watchdog → worker → monitor
pm2 stop watchdog
pm2 stop worker
pm2 stop monitor

# Wait for graceful shutdown
sleep 3

# Start in correct order: monitor → worker → watchdog
pm2 start ecosystem.config.js

# Verify all healthy
npm run healthcheck
```

### 3. Emergency Restart (with cleanup)

```bash
# Hard stop all processes
pm2 kill

# Clear stale connections
redis-cli FLUSHDB  # If using Redis for queues

# Restart with fresh state
pm2 start ecosystem.config.js

# Monitor startup logs
npm run healthcheck
```

## Smoke Test Checklist

Run after deployment to validate core functionality:

- [ ] **System Health**: `npm run healthcheck` passes all checks
- [ ] **Database**: Can read/write to all tables
- [ ] **Regime Detection**: Post test signal data, verify regime detection works
- [ ] **Allocation**: Verify allocation calculations applied correctly
- [ ] **Smoothing**: Check regime smoothing history building over time
- [ ] **Fallback**: Disable signal input, verify fallback regime engages after 5 minutes
- [ ] **TTL Expiration**: Wait 30+ minutes, verify regime state expires and resets
- [ ] **Monitoring**: Verify dashboard shows events, metrics, allocations
- [ ] **Logs**: Check logs for any WARN or ERROR events (excluding expected ones)
- [ ] **Performance**: Response time < 200ms for allocation endpoints
- [ ] **Concurrency**: Send 10 parallel requests, verify all succeed

### Automated Smoke Test

```bash
npm run test:smoke

# Expected output:
# ✓ System health check
# ✓ Database connectivity
# ✓ Regime scoring
# ✓ Allocation calculation
# ✓ Smoothing history
# ✓ Fallback activation
# ✓ TTL expiration
# All smoke tests passed
```

## First Deployment Summary

**Minimum Time to Production:**

1. Environment setup: 5 min
2. Database migration: 2 min
3. Start services: 3 min
4. Healthchecks: 2 min
5. Smoke tests: 5 min

**Total: ~17 minutes**

**Success Criteria:**

- All healthchecks pass
- No WARN or ERROR in logs (except expected)
- Dashboard loads with real data
- Allocation calculations working
- No database connection errors
- All 3 services (monitor, worker, watchdog) running

**Post-Deployment Monitoring:**

- First 1 hour: Monitor logs for any startup issues
- First 24 hours: Watch for memory leaks, connection pool issues
- After 24 hours: Verify regime fallback TTL working correctly (30 min)
- Weekly: Check database table growth and index performance

---

**Created**: May 11, 2026  
**Version**: V1.0  
**Last Updated**: V1.0 Pre-Deployment

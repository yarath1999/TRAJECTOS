import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type PerformanceContext = {
  correlation_id?: string;
  run_id?: string;
};

type MetricPoint = {
  at: number;
  value?: number;
};

const CONTEXT_WINDOW_MS = 60_000;
const MAX_SAMPLES = 2_000;

const performanceContext = new AsyncLocalStorage<PerformanceContext>();

const clusterProcessedPoints: MetricPoint[] = [];
const allocationFailurePoints: MetricPoint[] = [];
const regimeConfidenceSamples: MetricPoint[] = [];
const allocationExecutionSamples: MetricPoint[] = [];
const duplicateSkipPoints: MetricPoint[] = [];

function now(): number {
  return Date.now();
}

function compactMetricPoints(points: MetricPoint[], cutoffMs: number): void {
  while (points.length > 0 && points[0].at < cutoffMs) {
    points.shift();
  }
}

function compactAndBound(points: MetricPoint[], cutoffMs: number): void {
  compactMetricPoints(points, cutoffMs);
  while (points.length > MAX_SAMPLES) {
    points.shift();
  }
}

function average(points: MetricPoint[]): number {
  if (points.length === 0) return 0;
  const sum = points.reduce((acc, point) => acc + (Number.isFinite(point.value ?? NaN) ? (point.value ?? 0) : 0), 0);
  return sum / points.length;
}

export function createCorrelationId(prefix = "req"): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function createWorkerRunId(prefix = "worker"): string {
  return `${prefix}_${now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function withPerformanceContext<T>(context: PerformanceContext, fn: () => T): T {
  const current = performanceContext.getStore() ?? {};
  return performanceContext.run({ ...current, ...context }, fn);
}

export function getPerformanceContext(): PerformanceContext {
  return performanceContext.getStore() ?? {};
}

export async function measureAsyncOperation<T>(fn: () => T | PromiseLike<T>): Promise<{ value: Awaited<T>; durationMs: number }> {
  const startedAt = now();
  const value = await fn();
  return { value, durationMs: now() - startedAt };
}

export function createMemoryCache<K, V>(maxEntries = 100): {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  clear(): void;
} {
  const cache = new Map<K, V>();

  return {
    get(key: K): V | undefined {
      return cache.get(key);
    },
    set(key: K, value: V): void {
      if (cache.has(key)) {
        cache.delete(key);
      }
      cache.set(key, value);
      if (cache.size > maxEntries) {
        const firstKey = cache.keys().next().value as K | undefined;
        if (firstKey !== undefined) {
          cache.delete(firstKey);
        }
      }
    },
    has(key: K): boolean {
      return cache.has(key);
    },
    clear(): void {
      cache.clear();
    },
  };
}

export function recordClusterProcessed(at = now()): void {
  clusterProcessedPoints.push({ at });
  compactAndBound(clusterProcessedPoints, at - CONTEXT_WINDOW_MS);
}

export function recordAllocationFailure(at = now()): void {
  allocationFailurePoints.push({ at });
  compactAndBound(allocationFailurePoints, at - CONTEXT_WINDOW_MS);
}

export function recordRegimeConfidence(confidence: number, at = now()): void {
  if (!Number.isFinite(confidence)) return;
  regimeConfidenceSamples.push({ at, value: confidence });
  compactAndBound(regimeConfidenceSamples, at - CONTEXT_WINDOW_MS);
}

export function recordAllocationExecutionMs(durationMs: number, at = now()): void {
  if (!Number.isFinite(durationMs)) return;
  allocationExecutionSamples.push({ at, value: durationMs });
  compactAndBound(allocationExecutionSamples, at - CONTEXT_WINDOW_MS);
}

export function recordDuplicateSkip(at = now()): void {
  duplicateSkipPoints.push({ at });
  compactAndBound(duplicateSkipPoints, at - CONTEXT_WINDOW_MS);
}

export function getPerformanceSnapshot(at = now()): {
  clustersProcessedPerMinute: number;
  allocationFailuresPerMinute: number;
  averageRegimeConfidence: number;
  averageAllocationExecutionTimeMs: number;
  duplicateSkipsPerMinute: number;
} {
  const cutoffMs = at - CONTEXT_WINDOW_MS;
  compactMetricPoints(clusterProcessedPoints, cutoffMs);
  compactMetricPoints(allocationFailurePoints, cutoffMs);
  compactMetricPoints(regimeConfidenceSamples, cutoffMs);
  compactMetricPoints(allocationExecutionSamples, cutoffMs);
  compactMetricPoints(duplicateSkipPoints, cutoffMs);

  return {
    clustersProcessedPerMinute: clusterProcessedPoints.length,
    allocationFailuresPerMinute: allocationFailurePoints.length,
    averageRegimeConfidence: average(regimeConfidenceSamples),
    averageAllocationExecutionTimeMs: average(allocationExecutionSamples),
    duplicateSkipsPerMinute: duplicateSkipPoints.length,
  };
}
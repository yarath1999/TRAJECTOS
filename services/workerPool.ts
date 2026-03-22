export type WorkerPoolOptions = {
  concurrency?: number;
};

/**
 * Runs async work with a fixed maximum concurrency.
 *
 * - Preserves input order for the returned results.
 * - Rejects immediately on the first worker error.
 */
export async function workerPoolMap<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  options?: WorkerPoolOptions,
): Promise<R[]> {
  const requested = options?.concurrency;
  const normalized = Number.isFinite(requested) ? Math.floor(Number(requested)) : 5;
  const concurrency = Math.max(1, normalized);
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runners = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

export async function workerPoolForEach<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  options?: WorkerPoolOptions,
): Promise<void> {
  await workerPoolMap(items, worker, options);
}

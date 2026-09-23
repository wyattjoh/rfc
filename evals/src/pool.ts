/**
 * Runs `work` over `items` with at most `limit` in flight, preserving result order.
 */
export const pool = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<Array<R>> => {
  const results: Array<R> = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
};

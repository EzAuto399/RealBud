/** One piece of work per key at a time, within this process. Re-exported by
 * provisioning.ts for its existing importers; connectors.ts imports it from
 * here so the two modules do not import each other. */
const queues = new Map<string, Promise<unknown>>();
export function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

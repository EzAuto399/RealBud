/** Preserve website provenance through queued callbacks and awaited source checks. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WebsiteRequestExecution } from './website-requests.ts';

export function createWebsiteExecutionContext(options: {
  binding(requestId: string): WebsiteRequestExecution | null;
  check(execution: WebsiteRequestExecution): Promise<void>;
}) {
  const context = new AsyncLocalStorage<{ requestId: string; required: boolean }>();
  const missing = (): never => { throw Object.assign(new Error('Website execution permission changed. Review the request again.'), { status: 409 }); };
  function run<T>(requestId: string, work: () => T): T {
    return context.run({ requestId, required: true }, work);
  }
  function runLoop<T>(requestId: string | undefined, work: () => T): T {
    const inherited = context.getStore();
    return context.run({ requestId: requestId ?? '', required: inherited?.requestId === requestId && inherited?.required === true }, work);
  }
  async function check() {
    const current = context.getStore();
    if (!current?.requestId) return;
    const execution = options.binding(current.requestId);
    if (!execution) { if (current.required) missing(); return; }
    await options.check(execution);
    // A disable/revoke during an awaited adapter probe must stop provider entry.
    if (!options.binding(current.requestId)) missing();
  }
  return { run, runLoop, check };
}

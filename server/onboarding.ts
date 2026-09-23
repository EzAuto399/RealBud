import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { onboardingStage, parseOnboardingState, type OnboardingState } from '../shared/onboarding.ts';
import { DiskFullError, privateDirectory, readPrivateJson, writePrivateJson } from './private-json.ts';

const queues = new Map<string, Promise<unknown>>();
class OnboardingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string) => new OnboardingError(status, code, message);

/** Setup is a preference of this private workspace/seat, not a browser origin
 * or a company-wide fact. No name, existing book or unscoped browser flag proves
 * the person finished reviewing the welcome screens. */
export function createOnboardingHandler(options: { directory: string; workspaceId: string; memberKey: () => string }) {
  const directory = resolve(options.directory, 'onboarding');
  const scope = () => createHash('sha256').update(JSON.stringify([options.workspaceId, options.memberKey()])).digest('hex');
  return {
    async handle(path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
      if (path !== '/api/onboarding') return null;
      if (!['GET', 'PUT'].includes(method)) return { status: 405, body: { error: 'This setup action is unavailable.' } };
      const expectedScope = scope();
      const file = join(directory, `${expectedScope}.json`);
      const stillCurrent = () => { if (scope() !== expectedScope) throw fail(409, 'onboarding_scope_changed', 'Your workspace changed. Reopen setup before continuing.'); };
      const previous = queues.get(file) ?? Promise.resolve();
      const work = previous.catch(() => {}).then(async () => {
        stillCurrent();
        await privateDirectory(directory);
        stillCurrent();
        const saved = await readPrivateJson(file, 2048);
        stillCurrent();
        const current: OnboardingState = saved === undefined
          ? { version: 1, scope: expectedScope, revision: 0, stage: 'profile' }
          : parseOnboardingState(saved);
        if (current.scope !== expectedScope) throw fail(503, 'onboarding_recovery_required', 'Saved setup belongs to another workspace. Open recovery; existing records are preserved.');
        if (method === 'GET') return current;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'invalid_onboarding', 'Refresh setup before continuing.');
        const input = body as Record<string, unknown>;
        if (Object.keys(input).sort().join(',') !== 'expectedRevision,expectedScope,stage' || !onboardingStage(input.stage) ||
            !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw fail(400, 'invalid_onboarding', 'Refresh setup before continuing.');
        if (input.expectedScope !== expectedScope) throw fail(409, 'onboarding_scope_changed', 'Your workspace changed. Reopen setup before continuing.');
        // A lost successful response can be retried without incrementing or
        // regressing the saved state. Future revisions are never accepted.
        if (input.stage === current.stage && Number(input.expectedRevision) <= current.revision) return current;
        if (input.expectedRevision !== current.revision || current.stage === 'complete') throw fail(409, 'onboarding_changed', 'Setup changed in another window. Reopen it before continuing.');
        if (input.stage === 'complete' && current.stage !== 'office-rules') throw fail(409, 'onboarding_rules_required', 'Review the welcome rules before finishing setup.');
        if (current.revision === Number.MAX_SAFE_INTEGER) throw fail(409, 'onboarding_recovery_required', 'Saved setup needs recovery before further changes.');
        const next: OnboardingState = { ...current, revision: current.revision + 1, stage: input.stage };
        stillCurrent();
        await writePrivateJson(file, next);
        stillCurrent();
        return next;
      });
      queues.set(file, work);
      try { return { status: 200, body: await work }; }
      catch (cause) {
        const known = cause instanceof OnboardingError || cause instanceof DiskFullError ? cause : null;
        return { status: known?.status ?? 503, body: { error: known?.message ?? 'Saved setup could not be checked or saved. Open recovery or retry; existing records are preserved.', code: known?.code ?? 'onboarding_recovery_required' } };
      } finally { if (queues.get(file) === work) queues.delete(file); }
    },
  };
}

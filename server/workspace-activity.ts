/** A temporary snapshot pause. Admitted work drains; new background work waits
 * without clearing its channel queues. Pressure cancels the snapshot, not work.
 * This does not replace authorization or durable request identities. */
import { AsyncLocalStorage } from 'node:async_hooks';

export type WorkspaceActivity = <T>(work: () => T | Promise<T>) => Promise<T>;
export interface WorkspaceSnapshotLease { assertCurrent(): void; release(): void }
type Owner = {
  released: boolean; failure?: Error; resume: () => void; wait: Promise<void>;
  drained: () => void; drain: Promise<void>; dispose: () => void;
};
const interrupted = () => Object.assign(new Error('The backup pause ended before capture completed. Current work was preserved; retry when the workspace is quiet.'), { status: 409, code: 'private_snapshot_interrupted' });

export class WorkspaceActivityGate {
  private owner?: Owner;
  private running = 0;
  private waiting = 0;
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private readonly maxWaiting: number;
  private readonly assertAdmission: () => void;
  constructor(options: { maxWaiting?: number; assertAdmission?: () => void } = {}) {
    const maxWaiting = options.maxWaiting ?? 256;
    if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1 || maxWaiting > 1024) throw new Error('Invalid workspace pause queue limit.');
    this.maxWaiting = maxWaiting;
    this.assertAdmission = options.assertAdmission ?? (() => {});
  }
  get paused() { return !!this.owner; }
  get active() { return this.running; }
  get queued() { return this.waiting; }
  /** Service shutdown invalidates only the current snapshot lease. */
  cancelPause(): void { if (this.owner) this.end(this.owner, interrupted()); }

  readonly run: WorkspaceActivity = async work => {
    // Nested work belonging to an admitted task must be allowed to drain. A
    // detached callback after its parent finishes is a new admission instead.
    while (this.owner && !this.context.getStore()?.active) {
      const owner = this.owner;
      if (this.waiting >= this.maxWaiting) { this.end(owner, interrupted()); break; }
      this.waiting++;
      try { await owner.wait; } finally { this.waiting--; }
    }
    // A pause release is not permission to cross a newer restore/shutdown hold.
    // Check at execution time, including for callers that waited above.
    this.assertAdmission();
    const token = { active: true }; this.running++;
    try { return await this.context.run(token, work); }
    finally {
      token.active = false; this.running--;
      if (this.running === 0) this.owner?.drained();
    }
  };
  private end(owner: Owner, error?: Error) {
    if (owner.released) return;
    owner.released = true; owner.failure = error;
    if (this.owner === owner) this.owner = undefined;
    owner.resume(); owner.drained(); owner.dispose();
  }
  /** Installs its admission barrier synchronously, before the first await.
   * The timeout bounds the entire pause, including capture after drain. */
  async pause(options: { signal?: AbortSignal; timeoutMs?: number; onReleased?: () => void } = {}): Promise<WorkspaceSnapshotLease> {
    if (this.owner || this.context.getStore()?.active) throw Object.assign(new Error('Another workspace operation is active. Retry the backup after it finishes.'), { status: 409 });
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error('Invalid snapshot pause deadline.');
    options.signal?.throwIfAborted();
    let resume!: () => void, drained!: () => void;
    const wait = new Promise<void>(resolve => { resume = resolve; }), drain = new Promise<void>(resolve => { drained = resolve; });
    const owner: Owner = { released: false, resume, wait, drained, drain, dispose: () => {} };
    const cancel = () => this.end(owner, interrupted());
    const timer = setTimeout(cancel, timeout); timer.unref?.();
    owner.dispose = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); options.onReleased?.(); };
    this.owner = owner; options.signal?.addEventListener('abort', cancel, { once: true });
    if (this.running === 0) owner.drained();
    const assertCurrent = () => { if (owner.failure) throw owner.failure; if (this.owner !== owner || owner.released) throw interrupted(); };
    await owner.drain; assertCurrent();
    return { assertCurrent, release: () => this.end(owner) };
  }
}

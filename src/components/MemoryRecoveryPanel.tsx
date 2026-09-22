import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from '@/state/store';
import { MEMORY_REVIEW_ERRORS } from '@shared/hermes-memory-review';
import {
  MEMORY_RECOVERY_API, parseMemoryRecoveryPage, parseMemoryRecoveryClosure,
  type MemoryRecoveryItem, type MemoryRecoveryPage,
} from '@shared/hermes-memory-recovery';

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
const requestApi: Request = (path, init) => api(path, init, { timeoutMs: 35_000 });

/** Both memory panels use this queue because their HTTP handlers share a profile lock. */
export class MemoryReviewRequestCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private listeners = new Set<() => void>();
  constructor(private transport: Request = requestApi) {}
  getSnapshot = () => this.pending > 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { this.listeners.forEach(listener => listener()); }
  request: Request = (path, init) => {
    this.pending++; this.changed();
    const result = this.tail.then(() => this.transport(path, init));
    const settled = result.finally(() => { this.pending--; this.changed(); });
    this.tail = settled.then(() => undefined, () => undefined);
    return settled;
  };
}

type RecoveryState = {
  items: MemoryRecoveryItem[]; cursor: string | null; loaded: boolean;
  selected: MemoryRecoveryItem | null; confirmed: boolean; needsCheck: boolean; missing: boolean;
  unconfirmedKeys: string[]; busy: 'list' | 'close' | null; error: string; notice: string;
};
const unknownResult = 'The closure result could not be confirmed. Check its saved state before continuing.';
const missingResult = 'This interrupted proposal is no longer listed. Its closure cannot be confirmed here.';
const confirmedResult = 'The saved record confirms this interrupted proposal is closed. Closing it stops retries and does not change saved preferences.';
const labels: Record<MemoryRecoveryItem['state'], string> = {
  interrupted: 'Missing draft', closed: 'Closed', 'recovery-required': 'Needs service review',
};
const button = 'min-h-11 rounded border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';

function safeError(cause: unknown) {
  if (cause instanceof Error) {
    const known = Object.values(MEMORY_REVIEW_ERRORS).find(message => message === cause.message);
    if (known) return known;
  }
  return MEMORY_REVIEW_ERRORS.unavailable;
}
function pageResponse(raw: unknown, cursor: string | null): MemoryRecoveryPage {
  const page = parseMemoryRecoveryPage(raw);
  if (!page || page.items.some(item => item.key <= (cursor ?? ''))) throw new Error(MEMORY_REVIEW_ERRORS.unavailable);
  return page;
}
function matches(row: MemoryRecoveryItem, expected: MemoryRecoveryItem) {
  return row.key === expected.key && row.recoveryDigest === expected.recoveryDigest && row.state !== 'recovery-required';
}

/** No browser state is a closure receipt. Only exact, validated saved records confirm it. */
export class MemoryRecoverySession {
  private state: RecoveryState = { items: [], cursor: null, loaded: false, selected: null, confirmed: false, needsCheck: false, missing: false, unconfirmedKeys: [], busy: null, error: '', notice: '' };
  private listeners = new Set<() => void>();
  private active = true;
  private revision = 0;
  private task: Promise<void> | null = null;
  private restartPending = false;
  private activeIntent: MemoryRecoveryItem | null = null;
  private uncertain = new Map<string, MemoryRecoveryItem>();
  constructor(private request: Request = requestApi) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<RecoveryState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...change, unconfirmedKeys: [...this.uncertain.keys()] };
    this.listeners.forEach(listener => listener());
  }
  private current(version: number) { return this.active && this.revision === version; }
  private own(work: () => Promise<void>) {
    const task = work().finally(() => {
      if (this.task === task) this.task = null;
      if (this.active && this.restartPending) {
        this.restartPending = false;
        this.update({ busy: null, confirmed: false });
        void this.refresh();
      }
    });
    this.task = task;
    return task;
  }
  start() {
    const restarted = !this.active; this.active = true;
    if (restarted) this.update({ confirmed: false, needsCheck: !!this.state.selected && this.uncertain.has(this.state.selected.key) });
    if (this.task) { if (restarted) this.restartPending = true; return; }
    this.update({ busy: null }); void this.refresh();
  }
  stop() {
    if (this.activeIntent) this.uncertain.set(this.activeIntent.key, this.activeIntent);
    this.active = false; this.restartPending = false; this.revision++;
  }
  confirm(value: boolean) {
    const { selected, busy, needsCheck, missing } = this.state;
    this.update({ confirmed: value && selected?.state === 'interrupted' && !!selected.recoveryDigest && !busy && !needsCheck && !missing });
  }
  async refresh(more = false) {
    if (!this.active || this.task || this.state.busy || more && !this.state.cursor) return;
    await this.own(() => this.readPage(more));
  }
  private async readPage(more: boolean, afterFailure = '') {
    const version = ++this.revision, cursor = more ? this.state.cursor : null;
    const selectedKey = this.state.selected?.key;
    const expected = selectedKey ? this.uncertain.get(selectedKey) : undefined;
    this.update({ busy: 'list', confirmed: false, error: '', notice: afterFailure });
    try {
      const page = pageResponse(await this.request(`${MEMORY_RECOVERY_API}${cursor ? `?cursor=${cursor}` : ''}`), cursor);
      if (!this.current(version)) return;
      let saved = selectedKey ? page.items.find(item => item.key === selectedKey) : undefined;
      if (selectedKey && !saved) {
        // Full 256-bit identifiers cannot safely round-trip through Number.
        const prior = BigInt(`0x${selectedKey}`) - 1n;
        const anchor = prior < 0n ? null : prior.toString(16).padStart(64, '0');
        const focused = pageResponse(await this.request(`${MEMORY_RECOVERY_API}${anchor ? `?cursor=${anchor}` : ''}`), anchor);
        if (!this.current(version)) return;
        saved = focused.items.find(item => item.key === selectedKey);
      }
      const conflict = !!saved && !!expected && !matches(saved, expected);
      for (const item of [...page.items, ...(saved ? [saved] : [])]) {
        const intent = this.uncertain.get(item.key);
        if (intent && matches(item, intent)) this.uncertain.delete(item.key);
      }
      if (selectedKey && !saved && this.state.selected) this.uncertain.set(selectedKey, expected ?? this.state.selected);
      const selected = conflict ? expected! : saved ?? this.state.selected;
      const rows = more ? [...this.state.items.filter(item => !page.items.some(row => row.key === item.key)), ...page.items] : page.items;
      this.update({
        items: rows.map(item => this.uncertain.get(item.key) ?? item), cursor: page.nextCursor, loaded: true,
        selected, busy: null, confirmed: false, missing: !!selectedKey && !saved, needsCheck: conflict || !!selectedKey && !saved,
        error: conflict ? MEMORY_REVIEW_ERRORS.conflict : selectedKey && !saved ? missingResult : '',
        notice: conflict ? 'The saved record does not match the version you tried to close. Check its saved state before continuing.'
          : selectedKey && !saved ? '' : saved?.state === 'closed' ? confirmedResult
          : expected && saved?.state === 'interrupted' ? 'The saved record is still interrupted. Review it and confirm again if you still want to close it.'
          : afterFailure ? 'Saved state checked. Review the current record before continuing.' : 'Interrupted proposals checked.',
      });
    } catch (cause) {
      if (this.current(version)) this.update({ busy: null, confirmed: false, error: afterFailure || safeError(cause), notice: '' });
    }
  }
  async select(key: string) {
    if (!this.active || this.task || this.state.busy) return;
    const item = this.uncertain.get(key) ?? this.state.items.find(row => row.key === key);
    if (!item) return;
    await this.own(async () => {
      this.update({ selected: item, confirmed: false, needsCheck: this.uncertain.has(key), missing: false, error: '', notice: '' });
      if (this.uncertain.has(key)) await this.readPage(false);
    });
  }
  async close() {
    const { selected, confirmed, busy, needsCheck, missing } = this.state;
    if (!this.active || this.task || busy || needsCheck || missing || !confirmed || selected?.state !== 'interrupted' || !selected.recoveryDigest || this.uncertain.has(selected.key)) return;
    await this.own(() => this.closeSelected(selected));
  }
  private async closeSelected(item: MemoryRecoveryItem) {
    const version = ++this.revision;
    this.activeIntent = item;
    this.update({ busy: 'close', confirmed: false, error: '', notice: 'Closing the interrupted proposal and checking its result…' });
    try {
      const result = parseMemoryRecoveryClosure(await this.request(`${MEMORY_RECOVERY_API}/${item.key}/close`, {
        method: 'POST', body: JSON.stringify({ expectedDigest: item.recoveryDigest }),
      }));
      if (!this.current(version)) return;
      if (!result || result.key !== item.key || result.recoveryDigest !== item.recoveryDigest) throw new Error(unknownResult);
      const saved: MemoryRecoveryItem = { ...item, state: 'closed', closedAt: result.closedAt };
      this.uncertain.delete(item.key);
      this.update({ selected: saved, items: this.state.items.map(row => row.key === item.key ? saved : row), busy: null, confirmed: false, needsCheck: false, missing: false, notice: confirmedResult });
    } catch (cause) {
      if (this.current(version)) {
        this.uncertain.set(item.key, item);
        this.update({ needsCheck: true, confirmed: false });
        const message = safeError(cause);
        await this.readPage(false, message === MEMORY_REVIEW_ERRORS.unavailable ? unknownResult : message);
      }
    } finally { this.activeIntent = null; }
  }
}

export function MemoryRecoveryPanel({ coordinator, session: suppliedSession }: { coordinator: MemoryReviewRequestCoordinator; session?: MemoryRecoverySession }) {
  const [session] = useState(() => suppliedSession ?? new MemoryRecoverySession(coordinator.request));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const requestBusy = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  useEffect(() => { session.start(); return () => session.stop(); }, [session]);
  const blocked = !!state.busy || requestBusy, selected = state.selected;
  return <section aria-label="Interrupted memory proposals" aria-busy={blocked} className="min-w-0 space-y-3 border-t border-line pt-5">
    <div><h4 className="font-medium">Interrupted proposals</h4><p className="mt-1 text-ink-secondary">A proposal may have been interrupted and no longer have a recoverable draft. Closing its record stops retries. Closing does not change saved preferences or undo an earlier memory decision.</p></div>
    <button type="button" className={button} disabled={blocked} onClick={() => void session.refresh()}>Refresh interrupted proposals</button>
    {!state.loaded && !state.error && <p role="status">Checking interrupted proposals…</p>}
    {state.loaded && state.items.length === 0 && <p>No interrupted proposal records to review.</p>}
    {!!state.items.length && <div aria-label="Saved interrupted proposals" className="divide-y divide-line border-y border-line">{state.items.map(item => <button type="button" key={item.key} className={`flex min-h-14 w-full flex-wrap items-start justify-between gap-2 px-2 py-3 text-left focus-visible:outline-2 focus-visible:outline-agency disabled:opacity-50 ${selected?.key === item.key ? 'bg-selected' : ''}`} disabled={blocked} aria-pressed={selected?.key === item.key} onClick={() => void session.select(item.key)}><span><span className="block font-medium">Interrupted proposal · {item.key.slice(0, 8)}</span>{item.createdAt !== null && <span className="block text-xs text-ink-muted">Recorded {new Date(item.createdAt).toLocaleString()}</span>}</span><span className="text-xs">{state.unconfirmedKeys.includes(item.key) ? 'Closure needs confirmation' : labels[item.state]}</span></button>)}</div>}
    {state.cursor && <button type="button" className={button} disabled={blocked} onClick={() => void session.refresh(true)}>Show more interrupted proposals</button>}
    {selected && <section aria-label="Selected interrupted proposal" className="min-w-0 space-y-3 border-t border-line pt-3">
      <h5 className="font-medium">{state.needsCheck ? 'Closure needs confirmation' : labels[selected.state]}</h5>
      {state.needsCheck ? <><p>{state.missing ? missingResult : 'The closure is not yet confirmed. Check the saved record before continuing.'}</p><button type="button" className={button} disabled={blocked} onClick={() => void session.refresh()}>Check saved closure</button></>
        : selected.state === 'closed' ? <p>This record was closed{selected.closedAt !== null ? ` on ${new Date(selected.closedAt).toLocaleString()}` : ''}. Ask Bud to prepare a new proposal if a change is still needed.</p>
        : selected.state === 'recovery-required' ? <p>This record needs service review. Contact your RealBud administrator. Existing memory and recovery records are preserved.</p>
        : <><p>The recoverable draft is missing. You can close this interrupted record to stop its retries, then ask Bud to prepare a new proposal if needed.</p>
          <label className="flex min-h-11 items-start gap-2"><input type="checkbox" className="mt-1 size-4 shrink-0" disabled={blocked} checked={state.confirmed} onChange={event => session.confirm(event.target.checked)} /><span>I understand that closing this interrupted proposal stops its retries and does not change saved preferences.</span></label>
          <button type="button" className={button} disabled={blocked || !state.confirmed} onClick={() => void session.close()}>Close interrupted proposal</button>
        </>}
    </section>}
    {state.error && <p role="alert" className="text-danger">{state.error}</p>}
    <p role="status" aria-live="polite" className="text-ink-secondary">{state.busy === 'list' ? 'Checking interrupted proposals…' : state.busy === 'close' ? 'Closing the interrupted proposal and checking its result…' : state.notice}</p>
  </section>;
}

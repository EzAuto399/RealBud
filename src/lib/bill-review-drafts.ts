import type { BillReviewDraft, BillReviewDraftValue } from '@shared/bill-review-drafts';

type Transport = (path: string, init?: RequestInit) => Promise<any>;
export interface BillDraftEntry {
  id: string; workspaceId: string; value: BillReviewDraftValue; revision: number | null;
  dirty: boolean; saving: boolean; error: string; conflict: boolean;
  remote: BillReviewDraft | null;
}
const copy = <T,>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const draftValue = (draft: BillReviewDraft): BillReviewDraftValue => ({
  workspaceId: draft.workspaceId, state: draft.state, billId: draft.billId, billRevision: draft.billRevision,
  itemId: draft.itemId, messageId: draft.messageId, sourceDigest: draft.sourceDigest, fields: { ...draft.fields },
  billState: draft.billState, reason: draft.reason, seriesId: draft.seriesId, arrivalDate: draft.arrivalDate,
  proposalRequest: draft.proposalRequest ? { ...draft.proposalRequest } : null,
});

/** Memory holds unacknowledged edits across view changes. Durable copies go only
 * through the host's encrypted, workspace-scoped CAS store, never web storage. */
export class BillReviewDraftCoordinator {
  private entries = new Map<string, BillDraftEntry>();
  private writes = new Map<string, Promise<BillDraftEntry>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private active = new Map<string, string>();
  constructor(privateTransport?: Transport) { this.transport = privateTransport; }
  private transport?: Transport;
  configure(transport: Transport) { this.transport = transport; }
  private key(workspaceId: string, id: string) { return `${workspaceId}/${id}`; }
  private emit() { this.listeners.forEach(listener => listener()); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get(workspaceId: string, id: string) { return this.entries.get(this.key(workspaceId, id)); }
  list(workspaceId: string) { return [...this.entries.values()].filter(entry => entry.workspaceId === workspaceId); }
  activeId(workspaceId: string) { return this.active.get(workspaceId); }
  setActive(workspaceId: string, id: string | null) { if (id) this.active.set(workspaceId, id); else this.active.delete(workspaceId); }
  releaseLocal(workspaceId: string, id: string) {
    const key = this.key(workspaceId, id), entry = this.entries.get(key);
    const timer = this.timers.get(key); if (timer) clearTimeout(timer); this.timers.delete(key);
    if (entry?.saving) throw new Error('Wait for this draft save before leaving its local copy.');
    this.entries.delete(key); if (entry?.remote) this.adopt(entry.remote); this.emit();
  }
  hasUnpersisted() { return [...this.entries.values()].some(entry => entry.dirty || entry.saving); }
  adopt(draft: BillReviewDraft) {
    const key = this.key(draft.workspaceId, draft.id), previous = this.entries.get(key);
    // A read or a second mounted panel cannot replace newer local typing.
    if (previous?.dirty || previous?.saving) return previous;
    if (previous?.revision !== null && previous?.revision !== undefined) {
      if (previous.revision > draft.revision) return previous;
      if (previous.revision === draft.revision) {
        if (!equal(previous.value, draftValue(draft))) throw new Error('This draft returned different entries for the same saved revision. Your current entries are kept; refresh its history before continuing.');
        return previous;
      }
    }
    const entry: BillDraftEntry = { id: draft.id, workspaceId: draft.workspaceId, value: draftValue(draft), revision: draft.revision, dirty: false, saving: false, error: '', conflict: false, remote: null };
    this.entries.set(key, entry); this.emit(); return entry;
  }
  edit(id: string, value: BillReviewDraftValue, autosave = true) {
    const key = this.key(value.workspaceId, id), previous = this.entries.get(key);
    if (previous && equal(previous.value, value)) return previous;
    const entry: BillDraftEntry = { id, workspaceId: value.workspaceId, value: copy(value), revision: previous?.revision ?? null,
      dirty: true, saving: previous?.saving ?? false, error: previous?.error ?? '', conflict: previous?.conflict ?? false, remote: previous?.remote ?? null };
    this.entries.set(key, entry); this.emit();
    const timer = this.timers.get(key); if (timer) clearTimeout(timer);
    if (autosave && !entry.conflict) this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.flush(value.workspaceId, id).catch(() => {}); }, 500));
    return entry;
  }
  async flush(workspaceId: string, id: string): Promise<BillDraftEntry> {
    const key = this.key(workspaceId, id), timer = this.timers.get(key);
    if (timer) { clearTimeout(timer); this.timers.delete(key); }
    const running = this.writes.get(key); if (running) { await running; return this.flush(workspaceId, id); }
    const current = this.entries.get(key);
    if (!current) throw new Error('This review is unavailable in this workspace. Your other drafts are kept.');
    if (!current.dirty) return current;
    if (current.conflict) throw new Error(current.error);
    if (!this.transport) throw new Error('Draft storage is unavailable. Keep this window open.');
    const sent = copy(current.value), expectedRevision = current.revision;
    current.saving = true; current.error = ''; this.emit();
    const request = this.transport;
    const acknowledge = (saved: BillReviewDraft) => {
      if (!saved || saved.id !== id || saved.workspaceId !== workspaceId || !Number.isSafeInteger(saved.revision) || !equal(draftValue(saved), sent)) throw new Error('The draft save receipt does not match this review. Your entries are kept.');
      const latest = this.entries.get(key)!;
      latest.revision = saved.revision; latest.dirty = !equal(latest.value, sent); latest.error = ''; latest.conflict = false; latest.remote = null;
      return latest;
    };
    const work = (async () => {
      try {
        const response = await request(expectedRevision === null ? '/api/bill-review-drafts' : `/api/bill-review-drafts/${id}`, {
          method: expectedRevision === null ? 'POST' : 'PUT', body: JSON.stringify({ ...(expectedRevision === null ? { id } : {}), expectedRevision, value: sent }),
        });
        return acknowledge(response.draft);
      } catch (cause) {
        // A lost response may follow a durable save. Only exact direct readback
        // acknowledges it; no guessed success and no blind CAS overwrite.
        let remote: BillReviewDraft | null = null;
        try { remote = (await request(`/api/bill-review-drafts/${id}`)).draft; } catch { /* Retain unacknowledged data. */ }
        if (remote?.workspaceId === workspaceId && remote.id === id && equal(draftValue(remote), sent)) return acknowledge(remote);
        const latest = this.entries.get(key)!;
        latest.remote = remote?.workspaceId === workspaceId && remote.id === id ? remote : null;
        latest.conflict = !!latest.remote && latest.remote.revision !== expectedRevision;
        latest.error = latest.conflict ? 'This review changed in another window. Your entries are kept here. Save a separate copy to preserve both versions.' : `Draft not saved. Your entries are kept in this window. ${cause instanceof Error ? cause.message : 'Check the connection and retry.'}`;
        throw new Error(latest.error);
      } finally { const latest = this.entries.get(key)!; latest.saving = false; this.emit(); }
    })();
    this.writes.set(key, work);
    try { await work; } finally { this.writes.delete(key); }
    return this.entries.get(key)!.dirty ? this.flush(workspaceId, id) : this.entries.get(key)!;
  }
}

export const billReviewDrafts = new BillReviewDraftCoordinator();
export const hasUnpersistedBillDrafts = () => billReviewDrafts.hasUnpersisted();

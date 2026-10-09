import type { MailWorkItem } from '@shared/mail-ingestion';

export interface MailReviewContext { workspaceId: string; setupRevision: number; accountId: string | null }
export interface MailReviewEdit {
  item: MailWorkItem; priority: MailWorkItem['priority']; owner: string; note: string;
  disposition: MailWorkItem['disposition']; nextAction: string; status: MailWorkItem['status']; snoozedUntil: string;
}
export interface MailReviewDraft { context: MailReviewContext; edit: MailReviewEdit; sequence: number; dirty: boolean }
const copy = <T,>(value: T): T => structuredClone(value);
const localDateTime = (at: number | null) => at === null ? '' : new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
export const mailReviewEditor = (item: MailWorkItem): MailReviewEdit => ({ item: copy(item), priority: item.priority, owner: item.owner, note: item.note, disposition: item.disposition, nextAction: item.nextAction, status: item.status, snoozedUntil: localDateTime(item.snoozedUntil) });
export const mailReviewDirty = (edit: MailReviewEdit) => JSON.stringify(mailReviewEditor(edit.item)) !== JSON.stringify(edit);
export function readMailReviewContext(value: unknown): MailReviewContext {
  const state = (value as { state?: Record<string, any> } | null)?.state;
  if (!state || typeof state.workspaceId !== 'string' || !state.workspaceId || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !state.settings || (state.settings.gmailAccountId !== null && typeof state.settings.gmailAccountId !== 'string')) throw new Error('The private workspace and selected Gmail account could not be checked. Refresh before editing.');
  return { workspaceId: state.workspaceId, setupRevision: state.revision, accountId: state.settings.gmailAccountId };
}
export const sameMailReviewScope = (a: MailReviewContext, b: MailReviewContext) => a.workspaceId === b.workspaceId && a.accountId === b.accountId;
export function mailReviewStale(draft: Pick<MailReviewDraft, 'context' | 'edit'>, context: MailReviewContext | null, item: MailWorkItem | null): boolean {
  return !context || !sameMailReviewScope(draft.context, context) || draft.context.setupRevision !== context.setupRevision ||
    !item || item.id !== draft.edit.item.id || item.accountId !== draft.context.accountId || item.revision !== draft.edit.item.revision || item.sourceDigest !== draft.edit.item.sourceDigest;
}

/** Private notes stay in this renderer's memory, never browser storage. A route
 * or saved-view remount cannot overwrite typing. Closing/reloading is guarded;
 * this is not a durable draft or a saved staff review. */
export class MailReviewDraftJournal {
  private entries = new Map<string, MailReviewDraft>();
  private active = new Map<string, string>();
  private sequence = 0;
  constructor(private limit = 20) {}
  private scope(context: MailReviewContext) { return JSON.stringify([context.workspaceId, context.accountId]); }
  private key(context: MailReviewContext, id: string) { return JSON.stringify([context.workspaceId, context.accountId, id]); }
  list(context: MailReviewContext) { return [...this.entries.values()].filter(entry => sameMailReviewScope(entry.context, context)).map(copy); }
  current(context: MailReviewContext) { const id = this.active.get(this.scope(context)); return id ? this.get(context, id) : null; }
  get(context: MailReviewContext, id: string) { const entry = this.entries.get(this.key(context, id)); return entry ? copy(entry) : null; }
  open(context: MailReviewContext, item: MailWorkItem) {
    if (!context.accountId || context.accountId !== item.accountId) throw new Error('This item belongs to a different Gmail account. Review the selected agency source before editing.');
    const key = this.key(context, item.id), existing = this.entries.get(key);
    if (!existing) {
      // Clean inactive editors can be reread. Never silently evict private typing.
      for (const [oldKey, entry] of this.entries) if (!entry.dirty && this.active.get(this.scope(entry.context)) !== entry.edit.item.id) this.entries.delete(oldKey);
      if (this.entries.size >= this.limit) throw new Error('Twenty mail reviews are held in this session. Save or explicitly discard one before opening another.');
      this.entries.set(key, { context: copy(context), edit: mailReviewEditor(item), sequence: ++this.sequence, dirty: false });
    }
    this.active.set(this.scope(context), item.id);
    return this.get(context, item.id)!;
  }
  write(context: MailReviewContext, edit: MailReviewEdit, expectedSequence?: number) {
    const key = this.key(context, edit.item.id), existing = this.entries.get(key);
    if (!existing) throw new Error('Reopen this item in the current private workspace before editing.');
    if (expectedSequence !== undefined && existing.sequence !== expectedSequence) throw new Error('This retained review changed in another view. Reopen its held draft; newer typing was preserved.');
    // Preserve the reviewed baseline even when setup or source reads arrive later.
    if (JSON.stringify(edit.item) !== JSON.stringify(existing.edit.item)) throw new Error('The saved source baseline changed. Your retained draft must be explicitly discarded before reloading.');
    const next = { ...existing, edit: copy(edit), sequence: ++this.sequence, dirty: mailReviewDirty(edit) };
    this.entries.set(key, next); this.active.set(this.scope(context), edit.item.id); return copy(next);
  }
  remove(context: MailReviewContext, id: string, expectedSequence?: number) {
    const key = this.key(context, id), existing = this.entries.get(key);
    if (!existing || (expectedSequence !== undefined && existing.sequence !== expectedSequence)) return false;
    this.entries.delete(key); if (this.active.get(this.scope(context)) === id) this.active.delete(this.scope(context)); return true;
  }
  hasUnsaved() { return [...this.entries.values()].some(entry => entry.dirty); }
}
export const mailReviewDrafts = new MailReviewDraftJournal();
export const hasUnsavedMailReviews = () => mailReviewDrafts.hasUnsaved();

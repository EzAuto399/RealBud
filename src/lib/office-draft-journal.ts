import type { OfficeInput } from '../../shared/office';
import type { CompanyStatus } from '../../shared/company-api';

export interface OfficeDraftContext { workspaceId: string; companyId: string | null; memberId: string | null; sessionVersion: number }
export interface OfficeChanges { name?: string; jurisdictions?: string[]; office?: OfficeInput; expectedRevision?: number }
export interface OfficeDraft { context: OfficeDraftContext; startingRevision: number; changes: OfficeChanges; sequence: number; saving: boolean; needsReconciliation: boolean }
export interface EndedOfficeDraftReview { epoch: number; journalVersion: number; endedCount: number; discardableCount: number; savingCount: number }
const copy = <T,>(value: T): T => structuredClone(value);
export const officeDraftScope = (context: OfficeDraftContext) => JSON.stringify([context.workspaceId, context.companyId, context.memberId, context.sessionVersion]);
export const sameOfficeDraftScope = (a: OfficeDraftContext, b: OfficeDraftContext) => officeDraftScope(a) === officeDraftScope(b);
export function readOfficeDraftContext(value: unknown, status: CompanyStatus, sessionVersion: number): OfficeDraftContext {
  const workspaceId = (value as { state?: { workspaceId?: unknown } } | null)?.state?.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 128 || !Number.isSafeInteger(sessionVersion) || sessionVersion < 0 ||
    Boolean(status.company) !== Boolean(status.member)) throw new Error('The private workspace and office session could not be checked. Refresh before editing.');
  return { workspaceId, companyId: status.company?.id ?? null, memberId: status.member?.id ?? null, sessionVersion };
}

/** Office wording stays in this renderer's memory. Closing setup retains it;
 * a different workspace or member session cannot read it. This is not a saved
 * book, a credential cache, or a source of authority. Never evict dirty typing. */
export class OfficeDraftJournal {
  private entries = new Map<string, OfficeDraft>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  private version = 0;
  constructor(private limit = 20) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  read(context: OfficeDraftContext) { const entry = this.entries.get(officeDraftScope(context)); return entry ? copy(entry) : null; }
  write(context: OfficeDraftContext, revision: number, patch: OfficeChanges, expectedSequence?: number | null) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('The saved book revision could not be checked. Refresh before editing.');
    const key = officeDraftScope(context), previous = this.entries.get(key);
    if (previous?.saving) throw new Error('Office changes are being saved. Wait for their result before editing.');
    if (expectedSequence !== undefined && (previous?.sequence ?? null) !== expectedSequence) throw new Error('Your office draft changed in another view. The newer typing is kept; review it before editing again.');
    if (!previous && this.entries.size >= this.limit) throw new Error('Twenty office drafts are retained in this window. Save or explicitly discard one before starting another.');
    const { name, jurisdictions, office } = copy(patch);
    const changes = { ...previous?.changes, ...(name !== undefined ? { name } : {}), ...(jurisdictions !== undefined ? { jurisdictions } : {}), ...(office ? { office: { ...previous?.changes.office, ...office } } : {}) };
    const next: OfficeDraft = { context: copy(context), startingRevision: previous?.startingRevision ?? revision, changes, sequence: ++this.sequence, saving: false, needsReconciliation: previous?.needsReconciliation ?? false };
    this.entries.set(key, next); this.changed(); return copy(next);
  }
  beginSave(context: OfficeDraftContext, revision: number, expectedSequence: number) {
    const entry = this.entries.get(officeDraftScope(context));
    if (!entry || entry.sequence !== expectedSequence) throw new Error('The office draft changed. Review its retained typing before saving.');
    if (entry.saving) throw new Error('Office changes are already being saved. Wait for their result.');
    if (entry.needsReconciliation) throw new Error('The previous save reply could not be admitted. Check saved settings before any further save; your original typing is kept.');
    if (entry.startingRevision !== revision) throw new Error('The saved book changed. Your typing is kept. Discard edits and reload saved settings before saving.');
    entry.saving = true; this.changed(); return copy(entry);
  }
  finishSave(context: OfficeDraftContext, expectedSequence: number, saved: boolean, needsReconciliation = false) {
    const key = officeDraftScope(context), entry = this.entries.get(key);
    if (!entry || entry.sequence !== expectedSequence || !entry.saving) return false;
    if (saved) this.entries.delete(key); else { entry.saving = false; entry.needsReconciliation ||= needsReconciliation; }
    this.changed(); return true;
  }
  discard(context: OfficeDraftContext, expectedSequence: number) {
    const key = officeDraftScope(context), entry = this.entries.get(key);
    if (!entry || entry.saving || entry.sequence !== expectedSequence) return false;
    this.entries.delete(key); this.changed(); return true;
  }
  hasUnsaved() { return this.entries.size > 0; }
  reviewEnded(epoch: number): EndedOfficeDraftReview {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('The current office session could not be checked.');
    const ended = [...this.entries.values()].filter(entry => entry.context.sessionVersion < epoch);
    const savingCount = ended.filter(entry => entry.saving).length;
    return { epoch, journalVersion: this.version, endedCount: ended.length, discardableCount: ended.length - savingCount, savingCount };
  }
  discardEnded(review: EndedOfficeDraftReview, epoch: number | (() => number)) {
    const currentEpoch = typeof epoch === 'function' ? epoch() : epoch;
    const current = this.reviewEnded(currentEpoch);
    if (review.epoch !== currentEpoch || review.journalVersion !== current.journalVersion || review.endedCount !== current.endedCount ||
      review.discardableCount !== current.discardableCount || review.savingCount !== current.savingCount) throw new Error('The office drafts or session changed. Review clearing ended-session drafts again; no typing was removed.');
    if (!current.discardableCount) return 0;
    for (const [key, entry] of this.entries) if (entry.context.sessionVersion < currentEpoch && !entry.saving) this.entries.delete(key);
    this.changed(); return current.discardableCount;
  }
}
export const officeDrafts = new OfficeDraftJournal();
export const hasUnsavedOfficeDrafts = () => officeDrafts.hasUnsaved();

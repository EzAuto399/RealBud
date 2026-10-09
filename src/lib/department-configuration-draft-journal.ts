import type { CompanyStatus } from '../../shared/company-api';
import { DEPARTMENT_CONFIGURATION_MAX_BYTES, normalizeDepartmentConfiguration, normalizeSaveDepartmentConfiguration, type DepartmentConfiguration, type SaveDepartmentConfigurationInput } from '../../shared/department-configuration';
import { canonicalWebsiteCommand } from '../../shared/website-commands';

export interface DepartmentDraftActor { workspaceId: string; companyId: string; memberId: string; role: 'owner' | 'member'; sessionVersion: number }
export interface DepartmentDraftContext extends DepartmentDraftActor { departmentId: string }
export interface DepartmentDraftWording { configuration: DepartmentConfiguration; note: string; sourceReceiptId: string | null }
export interface DepartmentConfigurationDraft extends DepartmentDraftWording { context: DepartmentDraftContext; startingRevision: string; sequence: number; phase: 'idle' | 'saving' | 'unknown'; attempt: 'first' | 'replay' | null; operation: SaveDepartmentConfigurationInput | null }
export interface EndedDepartmentDraftReview { epoch: number; journalVersion: number; endedCount: number; discardableCount: number; heldCount: number }
export interface EarlierDepartmentSaveReview { actorScope: string; journalVersion: number; count: number }
const copy = <T,>(value: T): T => structuredClone(value);
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const validActor = (value: DepartmentDraftActor) => bounded(value.workspaceId) && bounded(value.companyId) && bounded(value.memberId) && ['owner', 'member'].includes(value.role) && Number.isSafeInteger(value.sessionVersion) && value.sessionVersion >= 0;
export const departmentDraftActorScope = (context: DepartmentDraftActor) => JSON.stringify([context.workspaceId, context.companyId, context.memberId, context.role, context.sessionVersion]);
export const departmentDraftScope = (context: DepartmentDraftContext) => JSON.stringify([departmentDraftActorScope(context), context.departmentId]);
export const sameDepartmentDraftActor = (a: DepartmentDraftActor, b: DepartmentDraftActor) => departmentDraftActorScope(a) === departmentDraftActorScope(b);
export const sameDepartmentDraftIdentity = (a: DepartmentDraftActor, b: DepartmentDraftActor) => a.workspaceId === b.workspaceId && a.companyId === b.companyId && a.memberId === b.memberId && a.role === 'owner' && b.role === 'owner';
export function readDepartmentDraftActor(localState: unknown, status: CompanyStatus, sessionVersion: number): DepartmentDraftActor {
  const workspaceId = (localState as { workspaceId?: unknown } | null)?.workspaceId;
  const actor = { workspaceId, companyId: status.company?.id, memberId: status.member?.id, role: status.member?.role, sessionVersion } as DepartmentDraftActor;
  if (!validActor(actor)) throw new Error('The private workspace and company identity could not be checked. Check company status before reopening department edits.');
  return actor;
}
export async function verifyDepartmentDraftActor(expected: DepartmentDraftActor, source: { status: () => Promise<CompanyStatus>; localState: () => Promise<unknown>; sessionVersion: () => number }) {
  if (source.sessionVersion() !== expected.sessionVersion) throw new Error('The company session changed. The original department draft is kept in its private scope.');
  const [status, localState] = await Promise.all([source.status(), source.localState()]);
  if (source.sessionVersion() !== expected.sessionVersion || !sameDepartmentDraftActor(expected, readDepartmentDraftActor(localState, status, source.sessionVersion()))) throw new Error('The company, role or private workspace changed. The original department draft is kept; no reply or new save was admitted.');
}

/** Private wording survives component unmounts in this window only. Neither
 * this journal nor a retained review checkbox grants company authority. */
export class DepartmentConfigurationDraftJournal {
  private entries = new Map<string, DepartmentConfigurationDraft>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  private version = 0;
  constructor(private limit = 20) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  read(context: DepartmentDraftContext) { const value = this.entries.get(departmentDraftScope(context)); return value ? copy(value) : null; }
  lastDepartment(actor: DepartmentDraftActor) {
    return [...this.entries.values()].filter(value => sameDepartmentDraftActor(value.context, actor)).sort((a,b) => b.sequence - a.sequence)[0]?.context.departmentId ?? '';
  }
  write(context: DepartmentDraftContext, revision: string, wording: DepartmentDraftWording, expectedSequence: number | null) {
    if (!validActor(context) || !bounded(context.departmentId) || !/^(0|[1-9][0-9]*)$/.test(revision) || BigInt(revision) > 9223372036854775807n) throw new Error('The department identity and saved revision could not be checked. Refresh before editing.');
    const key = departmentDraftScope(context), previous = this.entries.get(key);
    if ((previous?.sequence ?? null) !== expectedSequence) throw new Error('The department draft changed in another view. Its newer typing is kept. Reopen this department before editing.');
    if (previous && previous.phase !== 'idle') throw new Error('The original department save needs confirmation. Retry its exact saved request before making another change.');
    if (!previous && this.entries.size >= this.limit) throw new Error('Twenty department drafts are retained in this window. Save or explicitly discard a draft, or review clearing ended-session typing before starting another.');
    if (typeof wording.note !== 'string' || wording.note.length > 2048 || wording.configuration.version !== 1 || wording.configuration.plans.length > 8 || wording.configuration.workflowDefaults.length > 8 || new TextEncoder().encode(JSON.stringify(wording.configuration)).byteLength > DEPARTMENT_CONFIGURATION_MAX_BYTES) throw new Error('This department draft exceeds the settings limit. Shorten the wording or select fewer plans; the previous typing is kept.');
    const next: DepartmentConfigurationDraft = { ...copy(wording), context: copy(context), startingRevision: previous?.startingRevision ?? revision, sequence: ++this.sequence, phase: 'idle', attempt: null, operation: null };
    this.entries.set(key, next); this.changed(); return copy(next);
  }
  beginSave(context: DepartmentDraftContext, revision: string, sequence: number, operation: SaveDepartmentConfigurationInput) {
    const entry = this.entries.get(departmentDraftScope(context));
    if (!entry || entry.sequence !== sequence || entry.phase !== 'idle') throw new Error('The department draft changed or its original save needs confirmation. No new request was sent.');
    if (entry.startingRevision !== revision) throw new Error('The department revision changed. Your typing is kept. Discard this draft and reload current settings before saving.');
    const exact = normalizeSaveDepartmentConfiguration(operation);
    if (exact.departmentId !== context.departmentId || exact.expectedRevision !== entry.startingRevision || exact.note !== entry.note.trim() || exact.sourceReceiptId !== entry.sourceReceiptId || canonicalWebsiteCommand(exact.configuration) !== canonicalWebsiteCommand(normalizeDepartmentConfiguration(entry.configuration))) throw new Error('The reviewed request does not match the retained department draft. No save was sent.');
    entry.phase = 'saving'; entry.attempt = 'first'; entry.operation = copy(exact); this.changed(); return copy(entry);
  }
  beginReplay(context: DepartmentDraftContext, sequence: number) {
    const entry = this.entries.get(departmentDraftScope(context));
    if (!entry || entry.sequence !== sequence || entry.phase !== 'unknown' || !entry.operation) throw new Error('The original department request is unavailable or changed. No new request was sent.');
    entry.phase = 'saving'; entry.attempt = 'replay'; this.changed(); return copy(entry);
  }
  rejectFirst(context: DepartmentDraftContext, sequence: number, requestId: string) {
    const entry = this.entries.get(departmentDraftScope(context));
    if (!entry || entry.sequence !== sequence || entry.operation?.requestId !== requestId || entry.phase !== 'saving' || entry.attempt !== 'first') return false;
    entry.phase = 'idle'; entry.attempt = null; entry.operation = null; this.changed(); return true;
  }
  finish(context: DepartmentDraftContext, sequence: number, requestId: string, admitted: boolean) {
    const key = departmentDraftScope(context), entry = this.entries.get(key);
    if (!entry || entry.sequence !== sequence || entry.operation?.requestId !== requestId || entry.phase !== 'saving') return false;
    if (admitted) this.entries.delete(key); else { entry.phase = 'unknown'; entry.attempt = null; }
    this.changed(); return true;
  }
  discard(context: DepartmentDraftContext, sequence: number) {
    const key = departmentDraftScope(context), entry = this.entries.get(key);
    if (!entry || entry.sequence !== sequence || entry.phase !== 'idle') return false;
    this.entries.delete(key); this.changed(); return true;
  }
  hasUnsaved() { return this.entries.size > 0; }
  reviewEarlierSaves(actor: DepartmentDraftActor): EarlierDepartmentSaveReview {
    const count = [...this.entries.values()].filter(entry => entry.phase === 'unknown' && entry.context.sessionVersion < actor.sessionVersion && sameDepartmentDraftIdentity(entry.context, actor)).length;
    return { actorScope: departmentDraftActorScope(actor), journalVersion: this.version, count };
  }
  readEarlierSaves(review: EarlierDepartmentSaveReview, actor: DepartmentDraftActor) {
    if (canonicalWebsiteCommand(review) !== canonicalWebsiteCommand(this.reviewEarlierSaves(actor))) throw new Error('The original saves or company session changed. Review earlier saves again; no request was sent.');
    return [...this.entries.values()].filter(entry => entry.phase === 'unknown' && entry.context.sessionVersion < actor.sessionVersion && sameDepartmentDraftIdentity(entry.context, actor)).map(copy);
  }
  reviewEnded(epoch: number): EndedDepartmentDraftReview {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('The current company session could not be checked.');
    const ended = [...this.entries.values()].filter(entry => entry.context.sessionVersion < epoch);
    const heldCount = ended.filter(entry => entry.phase !== 'idle').length;
    return { epoch, journalVersion: this.version, endedCount: ended.length, discardableCount: ended.length - heldCount, heldCount };
  }
  discardEnded(review: EndedDepartmentDraftReview, currentEpoch: () => number) {
    const current = this.reviewEnded(currentEpoch());
    if (canonicalWebsiteCommand(review) !== canonicalWebsiteCommand(current)) throw new Error('The company session or retained drafts changed. Review clearing ended-session typing again; nothing was removed.');
    for (const [key, entry] of this.entries) if (entry.context.sessionVersion < current.epoch && entry.phase === 'idle') this.entries.delete(key);
    if (current.discardableCount) this.changed(); return current.discardableCount;
  }
}
export const departmentConfigurationDrafts = new DepartmentConfigurationDraftJournal();
export const hasUnsavedDepartmentConfigurationDrafts = () => departmentConfigurationDrafts.hasUnsaved();

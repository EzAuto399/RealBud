import { describe, expect, it, vi } from 'vitest';
import type { CompanyStatus } from '@shared/company-api';
import type { SaveDepartmentConfigurationInput } from '@shared/department-configuration';
import { DepartmentConfigurationDraftJournal, readDepartmentDraftActor, verifyDepartmentDraftActor, type DepartmentDraftContext, type DepartmentDraftWording } from './department-configuration-draft-journal';
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context: DepartmentDraftContext = { workspaceId: 'fictional-private-workspace', companyId: id(1), memberId: id(2), role: 'owner', sessionVersion: 0, departmentId: id(3) };
const wording: DepartmentDraftWording = { configuration: { version: 1, template: 'custom', plans: [], workflowDefaults: [{ id: 'work-review', label: 'Typed work type', defaultRecipeId: null }] }, note: '  Typed reason  ', sourceReceiptId: null };
const operation = (requestId = id(4)): SaveDepartmentConfigurationInput => ({ requestId, departmentId: context.departmentId, expectedRevision: '7', configuration: structuredClone(wording.configuration), note: wording.note.trim(), sourceReceiptId: null, reviewDigest: 'a'.repeat(64) });
const status: CompanyStatus = { storageAvailable: true, configured: true, setupAllowed: false, transport: 'local-only', limitations: [], company: { id: context.companyId, name: 'Fictional company' }, member: { id: context.memberId, displayName: 'Fictional owner', role: 'owner' } };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('private department draft identity and typing', () => {
  it('retains original wording and editor selection across view unmounts with defensive copies', () => {
    const journal = new DepartmentConfigurationDraftJournal(); journal.write(context, '7', wording, null);
    const remounted = journal.read(context)!; remounted.note = 'Changed copy'; remounted.configuration.workflowDefaults[0].label = 'Changed copy';
    expect(journal.read(context)?.note).toBe('  Typed reason  '); expect(journal.lastDepartment(context)).toBe(context.departmentId); expect(journal.hasUnsaved()).toBe(true);
  });
  it.each(['workspaceId', 'companyId', 'memberId', 'role', 'sessionVersion', 'departmentId'] as const)('does not expose typing to a different %s', field => {
    const journal = new DepartmentConfigurationDraftJournal(); journal.write(context, '7', wording, null);
    const foreign = { ...context, [field]: field === 'sessionVersion' ? 1 : field === 'role' ? 'member' : 'other' } as DepartmentDraftContext;
    expect(journal.read(foreign)).toBeNull(); if (field !== 'departmentId') expect(journal.lastDepartment(foreign)).toBe('');
  });
  it('keeps original base revision and temporarily blank labels rather than silently rebasing typing', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context, '7', wording, null);
    const next = journal.write(context, '8', { ...wording, configuration: { ...wording.configuration, workflowDefaults: [{ id: 'work-review', label: '', defaultRecipeId: null }] } }, first.sequence);
    expect(next.startingRevision).toBe('7'); expect(next.configuration.workflowDefaults[0].label).toBe('');
    expect(() => journal.beginSave(context, '8', next.sequence, operation())).toThrow('revision changed');
  });
  it('retains note-only changes for the app unload warning', () => {
    const journal = new DepartmentConfigurationDraftJournal(); journal.write(context, '7', { ...wording, configuration: { version: 1, template: 'custom', plans: [], workflowDefaults: [] } }, null);
    expect(journal.hasUnsaved()).toBe(true);
  });
  it('refuses stale-view edits and stale discards without clearing newer typing', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context, '7', wording, null);
    const newer = journal.write(context, '7', { ...wording, note: 'Newer typing' }, first.sequence);
    expect(() => journal.write(context, '7', wording, first.sequence)).toThrow('another view'); expect(journal.discard(context, first.sequence)).toBe(false); expect(journal.read(context)?.sequence).toBe(newer.sequence);
  });
  it('retains prior bounded typing when a later draft exceeds the limit', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context, '7', wording, null);
    expect(() => journal.write(context, '7', { ...wording, note: 'x'.repeat(2049) }, first.sequence)).toThrow('limit'); expect(journal.read(context)?.note).toBe(wording.note);
  });
  it.each([null, {}, { workspaceId: '' }, { workspaceId: ' padded ' }, { workspaceId: 'x\n' }])('refuses unavailable or malformed private identity %j', local => { expect(() => readDepartmentDraftActor(local, status, 0)).toThrow('could not be checked'); });
  it('never turns missing company membership into a local-only draft context', () => { expect(() => readDepartmentDraftActor({ workspaceId: context.workspaceId }, { ...status, member: undefined }, 0)).toThrow(); });
});

describe('immutable reviewed request and uncertainty', () => {
  it('returns only a definitely rejected first save to idle with original wording and base revision intact', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context,'7',wording,null); journal.beginSave(context,'7',first.sequence,operation());
    expect(journal.rejectFirst(context,first.sequence,id(4))).toBe(true); expect(journal.read(context)).toMatchObject({ phase:'idle',startingRevision:'7',note:wording.note,operation:null });
    expect(() => journal.beginSave(context,'8',first.sequence,operation())).toThrow('revision changed'); expect(journal.discard(context,first.sequence)).toBe(true);
  });
  it('cannot use first-refusal recovery after any prior unknown replay', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context,'7',wording,null); journal.beginSave(context,'7',first.sequence,operation()); journal.finish(context,first.sequence,id(4),false); journal.beginReplay(context,first.sequence);
    expect(journal.rejectFirst(context,first.sequence,id(4))).toBe(false); journal.finish(context,first.sequence,id(4),false); expect(journal.read(context)?.phase).toBe('unknown');
  });
  it('retains the exact request before dispatch and blocks editing or discard while saving', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context, '7', wording, null); const pending = journal.beginSave(context, '7', first.sequence, operation());
    expect(pending.operation).toEqual(operation()); expect(pending.phase).toBe('saving'); expect(() => journal.write(context, '7', wording, first.sequence)).toThrow('confirmation'); expect(journal.discard(context, first.sequence)).toBe(false);
  });
  it('holds an unknown effect through remount and empty outbox, and replays only its original request', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context, '7', wording, null); journal.beginSave(context, '7', first.sequence, operation()); journal.finish(context, first.sequence, id(4), false);
    // An empty host outbox after a lost acknowledgement is not proof of no effect.
    expect(journal.read(context)?.phase).toBe('unknown'); expect(() => journal.beginSave(context, '7', first.sequence, operation(id(5)))).toThrow('confirmation'); expect(journal.discard(context, first.sequence)).toBe(false);
    expect(journal.beginReplay(context, first.sequence).operation).toEqual(operation()); expect(journal.finish(context, first.sequence, id(4), true)).toBe(true); expect(journal.read(context)).toBeNull();
  });
  it.each(['note','configuration','departmentId','expectedRevision','sourceReceiptId'] as const)('refuses dispatch when reviewed %s differs from the retained original', field => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context, '7', wording, null);
    const other = { ...operation(), [field]: field === 'configuration' ? { ...wording.configuration, template: 'accounts-admin' } : field === 'expectedRevision' ? '8' : id(8) };
    expect(() => journal.beginSave(context, '7', first.sequence, other as SaveDepartmentConfigurationInput)).toThrow(); expect(journal.read(context)?.phase).toBe('idle');
  });
  it('cannot clear a request with an older sequence or different request ID', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context, '7', wording, null); journal.beginSave(context, '7', first.sequence, operation());
    expect(journal.finish(context, first.sequence - 1, id(4), true)).toBe(false); expect(journal.finish(context, first.sequence, id(5), true)).toBe(false); expect(journal.read(context)?.phase).toBe('saving');
  });
});

describe('bounded ended-session recovery', () => {
  it('does not evict existing dirty or unknown drafts at capacity', () => {
    const journal = new DepartmentConfigurationDraftJournal(2); const first = journal.write(context, '7', wording, null); journal.beginSave(context, '7', first.sequence, operation()); journal.finish(context, first.sequence, id(4), false);
    journal.write({ ...context, departmentId: id(9) }, '7', wording, null); expect(() => journal.write({ ...context, departmentId: id(10) }, '7', wording, null)).toThrow('retained'); expect(journal.read(context)?.phase).toBe('unknown');
  });
  it('reviews counts only and clears idle ended typing while keeping current/future/saving/unknown entries', () => {
    const journal = new DepartmentConfigurationDraftJournal(); journal.write(context, '7', wording, null);
    const held = { ...context, departmentId: id(9) }; const first = journal.write(held, '7', wording, null); journal.beginSave(held, '7', first.sequence, { ...operation(), departmentId: id(9) }); journal.finish(held, first.sequence, id(4), false);
    journal.write({ ...context, sessionVersion: 1 }, '7', wording, null); journal.write({ ...context, sessionVersion: 2 }, '7', wording, null);
    const review = journal.reviewEnded(1); expect(JSON.stringify(review)).not.toContain('Typed'); expect(review).toMatchObject({ endedCount: 2, discardableCount: 1, heldCount: 1 });
    expect(journal.discardEnded(review, () => 1)).toBe(1); expect(journal.read(held)?.phase).toBe('unknown'); expect(journal.read({ ...context, sessionVersion: 1 })).not.toBeNull(); expect(journal.read({ ...context, sessionVersion: 2 })).not.toBeNull();
  });
  it('refuses an old confirmation after epoch advances without a renderer rerender', () => {
    const journal = new DepartmentConfigurationDraftJournal(); journal.write(context, '7', wording, null); const review = journal.reviewEnded(1); let epoch = 1; epoch = 2;
    expect(() => journal.discardEnded(review, () => epoch)).toThrow('changed'); expect(journal.read(context)).not.toBeNull();
  });
  it('refuses an old confirmation after concurrent journal changes rather than doing partial cleanup', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const first = journal.write(context, '7', wording, null); const review = journal.reviewEnded(1); journal.write(context, '7', { ...wording, note: 'New typing' }, first.sequence);
    expect(() => journal.discardEnded(review, () => 1)).toThrow('changed'); expect(journal.read(context)?.note).toBe('New typing');
  });
});

describe('explicit earlier-session original recovery', () => {
  const unknown = (journal: DepartmentConfigurationDraftJournal) => { const entry = journal.write(context, '7', wording, null); journal.beginSave(context, '7', entry.sequence, operation()); journal.finish(context, entry.sequence, id(4), false); return entry; };
  it('reveals exact original bytes only by same owner metadata review, preserving a current draft', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const old = unknown(journal), actor = { ...context, sessionVersion: 1 };
    const current = journal.write(actor, '9', { ...wording, note: 'Current newer typing' }, null);
    const review = journal.reviewEarlierSaves(actor); expect(review.count).toBe(1); expect(JSON.stringify(review)).not.toContain('Typed');
    const originals = journal.readEarlierSaves(review, actor); expect(originals[0].operation).toEqual(operation());
    journal.beginReplay(originals[0].context, old.sequence); expect(journal.finish(context, old.sequence, id(4), true)).toBe(true);
    expect(journal.read(actor)?.sequence).toBe(current.sequence); expect(journal.read(actor)?.note).toBe('Current newer typing');
  });
  it.each(['workspaceId','companyId','memberId','role'] as const)('never discovers earlier private operations for a foreign %s', field => {
    const journal = new DepartmentConfigurationDraftJournal(); unknown(journal); const actor = { ...context, sessionVersion: 1, [field]: field === 'role' ? 'member' : 'other' } as DepartmentDraftContext;
    expect(journal.reviewEarlierSaves(actor).count).toBe(0); expect(journal.readEarlierSaves(journal.reviewEarlierSaves(actor), actor)).toEqual([]);
  });
  it('refuses stale numeric review after a concurrent unknown request changes phase', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const old = unknown(journal), actor = { ...context, sessionVersion: 1 }; const review = journal.reviewEarlierSaves(actor);
    journal.beginReplay(context, old.sequence); expect(() => journal.readEarlierSaves(review, actor)).toThrow('changed');
  });
  it('keeps original uncertainty sticky after an unsuccessful replay', () => {
    const journal = new DepartmentConfigurationDraftJournal(); const old = unknown(journal); journal.beginReplay(context, old.sequence); journal.finish(context, old.sequence, id(4), false);
    expect(journal.read(context)?.phase).toBe('unknown'); expect(journal.read(context)?.operation?.requestId).toBe(id(4));
  });
});

describe('actual after-await authority boundary', () => {
  it('adopts only a positive current actor and host-authored workspace', async () => {
    await expect(verifyDepartmentDraftActor(context, { status: async () => status, localState: async () => ({ workspaceId: context.workspaceId }), sessionVersion: () => 0 })).resolves.toBeUndefined();
  });
  it.each(['workspace','company','member','role'] as const)('refuses deferred %s change under the same tab session', async field => {
    const delayed = deferred<unknown>(); const readStatus = vi.fn(async () => field === 'workspace' ? status : { ...status, ...(field === 'company' ? { company: { ...status.company!, id: id(20) } } : { member: { ...status.member!, ...(field === 'member' ? { id: id(20) } : { role: 'member' as const }) } }) });
    const result = verifyDepartmentDraftActor(context, { status: readStatus, localState: () => delayed.promise, sessionVersion: () => 0 });
    delayed.resolve({ workspaceId: field === 'workspace' ? 'other' : context.workspaceId }); await expect(result).rejects.toThrow('changed');
  });
  it('refuses delayed identity after the tab session changes', async () => {
    const delayed = deferred<unknown>(); let epoch = 0; const result = verifyDepartmentDraftActor(context, { status: async () => status, localState: () => delayed.promise, sessionVersion: () => epoch }); epoch = 1; delayed.resolve({ workspaceId: context.workspaceId }); await expect(result).rejects.toThrow('changed');
  });
});

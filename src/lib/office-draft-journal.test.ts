import { describe, expect, it } from 'vitest';
import { OfficeDraftJournal, readOfficeDraftContext, type OfficeDraftContext } from './office-draft-journal';

const context: OfficeDraftContext = { workspaceId: 'fictional-workspace', companyId: 'fictional-office', memberId: 'fictional-member', sessionVersion: 2 };
describe('memory-only office typing', () => {
  it('retains exactly the edited fields and original revision across a settings remount or snapshot', () => {
    const journal = new OfficeDraftJournal();
    journal.write(context, 4, { name: 'Typed office', office: { pmUser: 'Fictional contact' } });
    journal.write(context, 9, { office: { namedExporter: 'Accounts team' } });
    expect(journal.read({ ...context })).toMatchObject({ startingRevision: 4, changes: { name: 'Typed office', office: { pmUser: 'Fictional contact', namedExporter: 'Accounts team' } } });
    expect(journal.hasUnsaved()).toBe(true);
    expect(journal.read(context)?.changes).not.toHaveProperty('jurisdictions');
  });
  it.each([{ workspaceId: 'other' }, { companyId: 'other' }, { memberId: 'other' }, { sessionVersion: 3 }])('never exposes predecessor typing to changed identity %j', change => {
    const journal = new OfficeDraftJournal(); journal.write(context, 4, { name: 'Private typing' });
    expect(journal.read({ ...context, ...change })).toBeNull();
    expect(journal.read(context)?.changes.name).toBe('Private typing');
  });
  it('holds a changed book revision without rebasing or clearing the retained edits', () => {
    const journal = new OfficeDraftJournal(), entry = journal.write(context, 4, { name: 'Private typing' });
    expect(() => journal.beginSave(context, 5, entry.sequence)).toThrow('saved book changed');
    expect(journal.read(context)).toEqual(entry);
    expect(journal.discard(context, entry.sequence)).toBe(true);
    expect(journal.write(context, 5, { name: 'Reviewed new typing' }).startingRevision).toBe(5);
  });
  it('allows one submission at a time and retains uncertain or rejected typing', () => {
    const journal = new OfficeDraftJournal(), entry = journal.write(context, 4, { name: 'Private typing' });
    journal.beginSave(context, 4, entry.sequence);
    expect(() => journal.beginSave(context, 4, entry.sequence)).toThrow('already being saved');
    expect(() => journal.write(context, 4, { name: 'Replacement' })).toThrow('being saved');
    expect(journal.discard(context, entry.sequence)).toBe(false);
    expect(journal.finishSave(context, entry.sequence, false)).toBe(true);
    expect(journal.read(context)).toMatchObject({ changes: { name: 'Private typing' }, startingRevision: 4, saving: false });
    journal.beginSave(context, 4, entry.sequence); journal.finishSave(context, entry.sequence, true);
    expect(journal.hasUnsaved()).toBe(false);
  });
  it('prevents stale view edits and late completion from erasing newer typing', () => {
    const journal = new OfficeDraftJournal(), old = journal.write(context, 4, { name: 'First' });
    const current = journal.write(context, 4, { name: 'Newer' }, old.sequence);
    expect(() => journal.write(context, 4, { name: 'Stale' }, old.sequence)).toThrow('another view');
    expect(journal.discard(context, old.sequence)).toBe(false);
    expect(journal.finishSave(context, old.sequence, true)).toBe(false);
    expect(journal.read(context)).toEqual(current);
  });
  it('refuses a second stale empty view instead of replacing first-entry typing', () => {
    const journal = new OfficeDraftJournal();
    const first = journal.write(context, 4, { office: { pmUser: 'First typing' } }, null);
    expect(() => journal.write(context, 4, { office: { pmUser: 'Stale replacement' } }, null)).toThrow('another view');
    expect(journal.read(context)).toEqual(first);
  });
  it('bounds memory without silently evicting unsaved typing or sharing mutable objects', () => {
    const journal = new OfficeDraftJournal(1); const patch = { office: { pmUser: 'Original' } };
    journal.write(context, 4, patch); patch.office.pmUser = 'Mutated input';
    const read = journal.read(context)!; read.changes.office!.pmUser = 'Mutated output';
    expect(journal.read(context)?.changes.office?.pmUser).toBe('Original');
    expect(() => journal.write({ ...context, workspaceId: 'other' }, 4, { name: 'Other' })).toThrow('retained');
    expect(journal.read(context)?.changes.office?.pmUser).toBe('Original');
  });
  it('captures positively checked local-only identity and refuses missing or inconsistent identity', () => {
    const local = { storageAvailable: false, configured: false, setupAllowed: false, transport: 'local-only' as const, limitations: [] };
    expect(readOfficeDraftContext({ state: { workspaceId: context.workspaceId } }, local, 2)).toEqual({ ...context, companyId: null, memberId: null });
    expect(() => readOfficeDraftContext({}, local, 2)).toThrow('could not be checked');
    expect(() => readOfficeDraftContext({ state: { workspaceId: context.workspaceId } }, { ...local, company: { id: 'office', name: 'Fictional' } }, 2)).toThrow('could not be checked');
  });
  it('holds an unadmitted save reply across remount without allowing an equivalent retry', () => {
    const journal = new OfficeDraftJournal(), entry = journal.write(context, 4, { name: 'Original private typing' });
    journal.beginSave(context, 4, entry.sequence); journal.finishSave(context, entry.sequence, false, true);
    expect(journal.read(context)).toMatchObject({ saving: false, needsReconciliation: true, changes: { name: 'Original private typing' } });
    expect(() => journal.beginSave(context, 4, entry.sequence)).toThrow('previous save reply');
    const edited = journal.write(context, 4, { office: { pmUser: 'Kept additional wording' } }, entry.sequence);
    expect(() => journal.beginSave(context, 4, edited.sequence)).toThrow('previous save reply');
    expect(journal.discard(context, edited.sequence)).toBe(true);
  });
  it('offers only numeric ended-session metadata, and explicit reviewed clearing releases capacity', () => {
    const journal = new OfficeDraftJournal(20);
    for (let n = 0; n < 20; n++) journal.write({ ...context, workspaceId: `private-${n}`, sessionVersion: 1 }, 4, { name: `Private text ${n}` });
    expect(() => journal.write(context, 4, { name: 'Current' })).toThrow('retained');
    const review = journal.reviewEnded(2);
    expect(review).toEqual({ epoch: 2, journalVersion: 20, endedCount: 20, discardableCount: 20, savingCount: 0 });
    expect(JSON.stringify(review)).not.toContain('Private text'); expect(JSON.stringify(review)).not.toContain('private-');
    expect(journal.discardEnded(review, 2)).toBe(20);
    expect(journal.write(context, 4, { name: 'Current' }).changes.name).toBe('Current');
  });
  it('retains current, future and in-flight drafts when explicitly clearing ended sessions', () => {
    const journal = new OfficeDraftJournal(), old = { ...context, sessionVersion: 1 }, future = { ...context, sessionVersion: 3 };
    journal.write(old, 4, { name: 'Ended' }); journal.write(context, 4, { name: 'Current' }); journal.write(future, 4, { name: 'Future' });
    const pending = journal.write({ ...old, workspaceId: 'saving' }, 4, { name: 'In flight' }); journal.beginSave(pending.context, 4, pending.sequence);
    const review = journal.reviewEnded(2);
    expect(review).toMatchObject({ endedCount: 2, discardableCount: 1, savingCount: 1 });
    expect(journal.discardEnded(review, 2)).toBe(1);
    expect(journal.read(old)).toBeNull(); expect(journal.read(context)?.changes.name).toBe('Current');
    expect(journal.read(future)?.changes.name).toBe('Future'); expect(journal.read(pending.context)?.saving).toBe(true);
    journal.finishSave(pending.context, pending.sequence, false, true);
    expect(journal.read(pending.context)?.needsReconciliation).toBe(true);
  });
  it.each(['edit', 'epoch', 'save-completion'] as const)('rejects stale ended-draft confirmation after %s without partial deletion', change => {
    const journal = new OfficeDraftJournal(), old = { ...context, sessionVersion: 1 }, entry = journal.write(old, 4, { name: 'Private old typing' });
    if (change === 'save-completion') journal.beginSave(old, 4, entry.sequence);
    const review = journal.reviewEnded(2);
    if (change === 'edit') journal.write(old, 4, { name: 'New private typing' }, entry.sequence);
    if (change === 'save-completion') journal.finishSave(old, entry.sequence, false);
    expect(() => journal.discardEnded(review, change === 'epoch' ? 3 : 2)).toThrow('no typing was removed');
    expect(journal.read(old)).not.toBeNull(); expect(journal.hasUnsaved()).toBe(true);
  });
  it('reads the live epoch at confirmation even when the originating render has not refreshed', () => {
    const journal = new OfficeDraftJournal(), old = { ...context, sessionVersion: 1 };
    journal.write(old, 4, { name: 'Ended private typing' }); let epoch = 2;
    const capturedReview = journal.reviewEnded(epoch), onConfirm = () => journal.discardEnded(capturedReview, () => epoch);
    epoch = 3;
    expect(() => onConfirm()).toThrow('no typing was removed'); expect(journal.read(old)?.changes.name).toBe('Ended private typing');
  });
});

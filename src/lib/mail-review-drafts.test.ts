import { describe, expect, it } from 'vitest';
import type { MailWorkItem } from '@shared/mail-ingestion';
import { MailReviewDraftJournal, mailReviewStale, readMailReviewContext } from './mail-review-drafts';
const context = { workspaceId: 'fictional-workspace-a', setupRevision: 4, accountId: 'fictional-gmail-a' };
const item = (id = 'fictional-item-a') => ({ id, accountId: context.accountId, revision: 3, sourceDigest: 'fictional-digest', priority: 'normal', owner: '', note: '', disposition: 'reply-review', nextAction: 'Review the original', status: 'open', snoozedUntil: null } as MailWorkItem);
describe('private mail review session journal', () => {
  it('retains typing across remount, saved views and item changes without a later read overwriting its baseline', () => {
    const journal = new MailReviewDraftJournal(), first = journal.open(context, item());
    journal.write(context, { ...first.edit, note: 'Fictional private note', owner: 'Fictional reviewer' });
    journal.open(context, item('fictional-item-b'));
    const restored = journal.open(context, { ...item(), note: 'A newer server note', revision: 4 });
    expect(restored.edit.note).toBe('Fictional private note'); expect(restored.edit.item.revision).toBe(3); expect(restored.dirty).toBe(true);
    expect(mailReviewStale(restored, context, { ...item(), revision: 4 })).toBe(true);
  });
  it('isolates private workspace and account identities, and holds setup/source changes for explicit review', () => {
    const journal = new MailReviewDraftJournal(), draft = journal.open(context, item());
    journal.write(context, { ...draft.edit, note: 'Fictional private note' });
    expect(journal.current({ ...context, workspaceId: 'fictional-workspace-b' })).toBeNull();
    expect(journal.list({ ...context, accountId: 'fictional-gmail-b' })).toEqual([]);
    expect(() => journal.open({ ...context, accountId: 'fictional-gmail-b' }, item())).toThrow('different Gmail account');
    expect(mailReviewStale(draft, context, item())).toBe(false);
    for (const next of [{ ...context, setupRevision: 5 }, { ...context, workspaceId: 'replaced' }, { ...context, accountId: 'other' }]) expect(mailReviewStale(draft, next, item())).toBe(true);
    expect(mailReviewStale(draft, context, { ...item(), sourceDigest: 'changed' })).toBe(true);
    expect(mailReviewStale(draft, context, null)).toBe(true);
  });
  it('does not let a late save clear newer typing or silently evict a dirty review at capacity', () => {
    const journal = new MailReviewDraftJournal(1), first = journal.open(context, item());
    const saving = journal.write(context, { ...first.edit, note: 'First draft' });
    const newer = journal.write(context, { ...first.edit, note: 'Newer draft' });
    expect(journal.remove(context, item().id, saving.sequence)).toBe(false);
    expect(() => journal.write(context, { ...saving.edit, note: 'Stale mounted view' }, saving.sequence)).toThrow('newer typing was preserved');
    expect(() => journal.open(context, item('another'))).toThrow('held in this session');
    expect(journal.current(context)?.edit.note).toBe('Newer draft'); expect(journal.hasUnsaved()).toBe(true);
    expect(journal.remove(context, item().id, newer.sequence)).toBe(true); expect(journal.hasUnsaved()).toBe(false);
  });
  it('refuses malformed authoritative context rather than guessing the current private scope', () => {
    expect(readMailReviewContext({ state: { workspaceId: context.workspaceId, revision: 4, settings: { gmailAccountId: context.accountId } } })).toEqual(context);
    expect(() => readMailReviewContext({ state: { revision: 4, settings: {} } })).toThrow('private workspace');
  });
});

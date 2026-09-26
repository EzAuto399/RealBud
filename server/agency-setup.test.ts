import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgencySetupObservations, AgencySetupView } from '../shared/agency-setup.ts';
import type { MailHistoryStatus } from '../shared/mail-ingestion.ts';
import { managedMailBindingRevision } from './managed-connectors.ts';
import { createAgencySetupService, defaultAgencySettings, validateAgencySettings } from './agency-setup.ts';
import { plantPrivateFile, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });
async function fixture() {
  const root = privateTempRoot(join(realpathSync(tmpdir()), 'rb-agency-setup-')); roots.push(root);
  let clock = 1_790_000_000_000;
  const observed: AgencySetupObservations = {
    gmail: { accounts: [{ id: 'mail-agency-a', label: 'Fictional accounts Gmail', status: 'active' }], accountId: 'mail-agency-a', state: 'verified', checkedAt: clock, bindingRevision: 'private-source-v1' },
    properties: { state: 'available', revision: 'property-book-v1', items: [{ id: 'property-a', label: 'Fictional Oak Street' }] },
    billRegister: { state: 'available', count: 0 },
    workflows: Object.fromEntries(['bank-references', 'bills-calendar', 'morning-priorities'].map(id => [id, { state: 'available', bindingRevision: `${id}-v1`, detail: 'Local adapter and plan admission checked.' }])),
  };
  const observe = vi.fn(async () => structuredClone(observed)), checkGmail = vi.fn(async () => {});
  const options = { directory: root, workspaceId: 'workspace-a', actorId: () => 'private-owner-a', observe, checkGmail, now: () => clock };
  const service = createAgencySetupService(options);
  const settings = { ...defaultAgencySettings(), agencyName: 'Fictional Acacia', workflowPackId: 'office-core' as const, timeZone: 'Australia/Brisbane', gmailAccountId: 'mail-agency-a', propertyReferences: [{ propertyId: 'property-a', reference: 'REF100', aliases: ['Practice payer'] }], selectedWorkflows: ['bank-references', 'bills-calendar', 'morning-priorities'] as const };
  return { root, service, options, observed, observe, checkGmail, settings: () => structuredClone({ ...settings, selectedWorkflows: [...settings.selectedWorkflows] }), advance: (ms: number) => { clock += ms; } };
}
async function reviewedFixture() {
  const f = await fixture(); let view = await f.service.save({ expectedRevision: 0, settings: f.settings() });
  const workflow = view.workflows.find(item => item.id === 'morning-priorities')!;
  view = await f.service.review(workflow.id, { expectedRevision: view.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });
  return { ...f, view };
}

describe('private reusable agency setup', () => {
  it('starts missing without writing files, choosing an agency timezone or claiming ready workflows', async () => {
    const f = await fixture(), view = await f.service.get();
    expect(view.state.revision).toBe(0); expect(view.state.settings.agencyName).toBe(''); expect(view.state.settings.timeZone).toBe('');
    expect(view.state.settings.mailScope).toEqual({ historyDays: 7, includeSent: true, maxMessages: 100, attachments: 'metadata-only' });
    expect(view.workflows.every(item => !item.canReview && !item.readyForRun && item.acceptance === 'not-verified')).toBe(true);
    await expect(readFile(join(f.root, 'agency-setup.json'))).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.checkGmail).not.toHaveBeenCalled();
  });
  it('saves per-workspace settings and a bound review, survives restart, and does not require customer acceptance before a reviewed read', async () => {
    const f = await reviewedFixture(), restarted = createAgencySetupService(f.options), state = await restarted.getConfiguration();
    expect(state.revision).toBe(1); expect(state.reviews['morning-priorities']?.actorId).toBe('private-owner-a');
    const ready = await restarted.assertWorkflowReady('morning-priorities'); expect(ready.settings.gmailAccountId).toBe('mail-agency-a');
    expect((await restarted.get()).workflows.find(item => item.id === 'morning-priorities')).toMatchObject({ readyForRun: true, acceptance: 'not-verified' });
    expect(f.checkGmail).not.toHaveBeenCalled();
  });
  it('retains idempotent saves/reviews but clears approval on source scope changes', async () => {
    const f = await reviewedFixture(), bytes = await readFile(join(f.root, 'agency-setup.json'), 'utf8');
    await f.service.save({ expectedRevision: 1, settings: f.settings() });
    await f.service.review('morning-priorities', { expectedRevision: 1, expectedEvidenceDigest: f.view.workflows.find(item => item.id === 'morning-priorities')!.evidenceDigest });
    expect(await readFile(join(f.root, 'agency-setup.json'), 'utf8')).toBe(bytes);
    const changed = f.settings(); changed.mailScope.historyDays = 30;
    const view = await f.service.save({ expectedRevision: 1, settings: changed }); expect(view.state.revision).toBe(2); expect(view.state.reviews).toEqual({});
    await expect(f.service.assertWorkflowReady('morning-priorities')).rejects.toMatchObject({ status: 409 });
  });
  it('requires explicit pack selection and reads legacy settings without assuming Austin or rewriting bytes', async () => {
    const f = await reviewedFixture(), file = join(f.root, 'agency-setup.json');
    const old = JSON.parse(await readFile(file, 'utf8')); delete old.settings.workflowPackId;
    const bytes = JSON.stringify(old); await writeFile(file, bytes);
    const view = await f.service.get(); expect(view.state.settings.workflowPackId).toBeNull();
    expect(view.workflows.every(workflow => !workflow.readyForRun)).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(bytes);
    await expect(f.service.assertWorkflowReady('morning-priorities')).rejects.toMatchObject({ status: 409 });
    expect(() => validateAgencySettings({ ...f.settings(), workflowPackId: 'Imported pack title' })).toThrow(/supported workflow pack/);
    const changed = { ...f.settings(), workflowPackId: 'austin-office' as const };
    const saved = await f.service.save({ expectedRevision: 1, settings: changed }); expect(saved.state.revision).toBe(2); expect(saved.state.reviews).toEqual({});
  });
  it('preserves valid saved bytes when revision growth would become unreadable', async () => {
    const f = await fixture(); await f.service.save({ expectedRevision: 0, settings: f.settings() });
    const file = join(f.root, 'agency-setup.json'), state = JSON.parse(await readFile(file, 'utf8'));
    state.revision = Number.MAX_SAFE_INTEGER; const bytes = JSON.stringify(state); await writeFile(file, bytes);
    const settings = f.settings(); settings.agencyName = 'Changed fictional name';
    await expect(f.service.save({ expectedRevision: Number.MAX_SAFE_INTEGER, settings })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });
  it('refuses forged checks, credentials, expanded attachment access and invalid source scope', () => {
    for (const extra of [{ verified: true }, { ready: true }, { apiKey: 'fake-key' }, { reviews: {} }]) expect(() => validateAgencySettings({ ...defaultAgencySettings(), ...extra })).toThrow();
    for (const field of [{ historyDays: 0 }, { historyDays: 91 }, { maxMessages: 501 }, { includeSent: 'true' }, { attachments: 'download-all' }]) expect(() => validateAgencySettings({ ...defaultAgencySettings(), mailScope: { ...defaultAgencySettings().mailScope, ...field } })).toThrow();
    expect(() => validateAgencySettings({ ...defaultAgencySettings(), agencyName: `rbc_${'a'.repeat(64)}` })).toThrow(/credentials/);
    expect(() => validateAgencySettings({ ...defaultAgencySettings(), timeZone: 'Australia/Invented' })).toThrow(/timezone/);
  });
  it('rejects unknown accounts and properties, duplicate normalized references and spreadsheet formulas', async () => {
    const f = await fixture(), settings = f.settings(); settings.gmailAccountId = 'another-agency-mail';
    await expect(f.service.save({ expectedRevision: 0, settings })).rejects.toThrow(/Gmail account/);
    settings.gmailAccountId = 'mail-agency-a'; settings.propertyReferences[0].propertyId = 'another-agency-property';
    await expect(f.service.save({ expectedRevision: 0, settings })).rejects.toThrow(/property is unavailable/);
    expect(() => validateAgencySettings({ ...f.settings(), propertyReferences: [{ propertyId: 'a', reference: 'Ref1', aliases: [] }, { propertyId: 'b', reference: 'ref1', aliases: [] }] })).toThrow(/unique/);
    expect(() => validateAgencySettings({ ...f.settings(), propertyReferences: [{ propertyId: 'a', reference: '=EXTERNAL()', aliases: [] }] })).toThrow(/formulas/);
  });
  it('rejects stale settings and evidence without losing a newer edit', async () => {
    const f = await fixture(); const initial = await f.service.save({ expectedRevision: 0, settings: f.settings() });
    const before = await readFile(join(f.root, 'agency-setup.json'), 'utf8');
    await expect(f.service.save({ expectedRevision: 0, settings: f.settings() })).rejects.toMatchObject({ status: 409 });
    f.observed.gmail!.bindingRevision = 'private-source-v2';
    await expect(f.service.review('morning-priorities', { expectedRevision: 1, expectedEvidenceDigest: initial.workflows.find(item => item.id === 'morning-priorities')!.evidenceDigest })).rejects.toThrow(/source, mapping or plan changed/);
    expect(await readFile(join(f.root, 'agency-setup.json'), 'utf8')).toBe(before);
  });
  it('holds reviewed workflows after revocation, expiry, a different account, a plan change or removed property', async () => {
    const f = await reviewedFixture(); f.observed.gmail!.state = 'revoked';
    await expect(f.service.assertWorkflowReady('morning-priorities')).rejects.toThrow(/needs current source/);
    f.observed.gmail!.state = 'verified'; f.advance(300_001);
    await expect(f.service.assertWorkflowReady('morning-priorities')).rejects.toThrow(/needs current source/);
    f.advance(-300_001); f.observed.gmail!.accountId = 'other-account';
    await expect(f.service.assertWorkflowReady('morning-priorities')).rejects.toThrow();
    f.observed.gmail!.accountId = 'mail-agency-a'; f.observed.workflows!['morning-priorities']!.bindingRevision = 'changed-plan';
    expect((await f.service.get()).workflows.find(item => item.id === 'morning-priorities')?.reviewed).toBe(false);
    f.observed.properties!.items = [];
    expect((await f.service.get()).workflows.find(item => item.id === 'bank-references')?.canReview).toBe(false);
  });
  it('requires actual observation and distinguishes stale/partial/wrong-account source receipts from acceptance', async () => {
    const f = await reviewedFixture(); f.observed.workflows!['morning-priorities']!.sourceReceipt = { id: 'source-a', capturedAt: 1_790_000_000_000, state: 'partial', accountId: 'mail-agency-a' };
    let view = await f.service.get(); expect(view.workflows.find(item => item.id === 'morning-priorities')!.checks.find(check => check.id === 'source')?.state).toBe('needed');
    f.observed.workflows!['morning-priorities']!.sourceReceipt!.state = 'complete'; f.observed.workflows!['morning-priorities']!.sourceReceipt!.accountId = 'other-account';
    view = await f.service.get(); expect(view.workflows.find(item => item.id === 'morning-priorities')!.checks.find(check => check.id === 'source')?.state).toBe('needed');
    f.observed.workflows!['morning-priorities']!.acceptanceReceipt = { id: 'accepted-a', acceptedAt: 1_790_000_000_000, settingsRevision: 0, evidenceDigest: f.view.workflows.find(item => item.id === 'morning-priorities')!.evidenceDigest };
    expect((await f.service.get()).workflows.find(item => item.id === 'morning-priorities')?.acceptance).toBe('not-verified');
    f.observe.mockRejectedValueOnce(new Error('Provider cache unavailable'));
    expect((await f.service.get()).workflows.every(item => !item.readyForRun)).toBe(true);
  });
  it('binds business acceptance to the reviewed source and plan, not just the settings revision', async () => {
    const f = await reviewedFixture(), workflow = f.view.workflows.find(item => item.id === 'morning-priorities')!;
    f.observed.workflows!['morning-priorities']!.acceptanceReceipt = { id: 'accepted-a', acceptedAt: 1_790_000_000_000, settingsRevision: 1, evidenceDigest: workflow.evidenceDigest };
    expect((await f.service.get()).workflows.find(item => item.id === 'morning-priorities')?.acceptance).toBe('accepted');
    f.observed.gmail!.bindingRevision = 'new-source-authority';
    expect((await f.service.get()).workflows.find(item => item.id === 'morning-priorities')).toMatchObject({ acceptance: 'not-verified', reviewed: false });
    f.observed.gmail!.bindingRevision = 'private-source-v1';
    f.observed.workflows!['morning-priorities']!.bindingRevision = 'new-plan';
    expect((await f.service.get()).workflows.find(item => item.id === 'morning-priorities')?.acceptance).toBe('not-verified');
  });
  it('preserves malformed, cross-workspace and linked state and blocks mutation', async () => {
    const f = await fixture(), path = join(f.root, 'agency-setup.json'); plantPrivateFile(path, '{ damaged bytes');
    await expect(f.service.save({ expectedRevision: 0, settings: f.settings() })).rejects.toMatchObject({ status: 503, code: 'agency_setup_recovery_required' });
    expect(await readFile(path, 'utf8')).toBe('{ damaged bytes'); await rm(path);
    await f.service.save({ expectedRevision: 0, settings: f.settings() });
    await expect(createAgencySetupService({ ...f.options, workspaceId: 'another-workspace' }).get()).rejects.toMatchObject({ status: 503 });
    const outside = join(f.root, 'outside'); await mkdir(outside); const linked = join(outside, 'agency-setup.json'); await symlink(path, linked);
    await expect(createAgencySetupService({ ...f.options, directory: outside }).get()).rejects.toMatchObject({ status: 503 });
  });
  it('serializes competing saves so exactly one expected revision wins', async () => {
    const f = await fixture(); const results = await Promise.allSettled([f.service.save({ expectedRevision: 0, settings: f.settings() }), f.service.save({ expectedRevision: 0, settings: { ...f.settings(), agencyName: 'Second window' } })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect((await f.service.getConfiguration()).settings.agencyName).toBe('Fictional Acacia');
  });
  it('binds an explicit Gmail check to the saved account and rejects stale scope while checking', async () => {
    const f = await reviewedFixture(); let release!: () => void;
    f.checkGmail.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const checking = f.service.handle('/api/agency-setup/check-gmail', 'POST', { expectedRevision: 1 });
    await vi.waitFor(() => expect(f.checkGmail).toHaveBeenCalledWith('mail-agency-a', 1));
    await f.service.save({ expectedRevision: 1, settings: { ...f.settings(), mailScope: { ...f.settings().mailScope, historyDays: 8 } } }); release();
    await expect(checking).rejects.toMatchObject({ status: 409 });
    await expect(f.service.handle('/api/agency-setup/check-gmail', 'POST', { expectedRevision: 2, accountId: 'other-account' })).rejects.toThrow(/supported agency settings/);
  });
  it('distinguishes an expired Gmail verification from one that was never checked', async () => {
    const f = await reviewedFixture();
    const never = await fixture();
    never.observed.gmail!.checkedAt = null;
    const gmailCheck = async (service: typeof f.service) => (await service.get()).workflows.find(item => item.id === 'morning-priorities')!.checks.find(check => check.id === 'gmail')!;
    expect(await gmailCheck(f.service)).toMatchObject({ state: 'passed' });
    // Just past the window and at five and a half minutes the count rounds up:
    // "5 minutes ago" beside "expires after five minutes" would contradict itself.
    const detailFor = (minutes: number) => `This account was verified ${minutes} minutes ago; verification expires after five minutes. Check the selected account again before approving.`;
    f.advance(300_001);
    expect(await gmailCheck(f.service)).toMatchObject({ state: 'needed', detail: detailFor(6) });
    f.advance(29_999);
    expect(await gmailCheck(f.service)).toMatchObject({ state: 'needed', detail: detailFor(6) });
    f.advance(30_000);
    const expired = await gmailCheck(f.service);
    expect(expired.state).toBe('needed');
    expect(expired.detail).toBe(detailFor(6));
    expect(expired.detail).not.toContain('5 minutes ago');
    expect(expired.nextAction).toBe('Check selected Gmail access again.');
    f.advance(60_000);
    expect((await gmailCheck(f.service)).detail).toBe(detailFor(7));
    f.advance(-60_000);
    await never.service.save({ expectedRevision: 0, settings: never.settings() });
    const unchecked = await gmailCheck(never.service);
    expect(unchecked.state).toBe('needed');
    expect(unchecked.detail).toContain('Choose an account and verify its current read access.');
    expect(unchecked.detail).not.toBe(expired.detail);
    expect(unchecked.nextAction).not.toBe(expired.nextAction);
  });
  it('starts history collection when the checked account projects as verified, without letting it change the check', async () => {
    const f = await reviewedFixture();
    const history = (state: MailHistoryStatus['state'], windowsChecked: number, heldReason: string | null = null) => ({ version: 1 as const, state,
      accountId: 'mail-agency-a', settingsRevision: 1, historyDays: 7, windowsChecked, windowCount: 3, heldReason, startedAt: 1, updatedAt: 1,
      detail: 'History detail', coverage: null });
    const onGmailVerified = vi.fn(async (event: { accountId: string; settingsRevision: number; historyDays: number }) => {
      f.observed.mailHistory = history('checking', 0);
      void event;
    });
    const service = createAgencySetupService({ ...f.options, onGmailVerified });
    const gmailCheck = (body: unknown) => (body as AgencySetupView).workflows.find(item => item.id === 'morning-priorities')!.checks.find(check => check.id === 'gmail')!;
    const first = await service.handle('/api/agency-setup/check-gmail', 'POST', { expectedRevision: 1 });
    expect(onGmailVerified.mock.calls).toEqual([[{ accountId: 'mail-agency-a', settingsRevision: 1, historyDays: 7 }]]);
    expect(first!.status).toBe(200);
    // The same response already says collection started and how far it got.
    expect(gmailCheck(first!.body)).toMatchObject({ state: 'passed' });
    expect(gmailCheck(first!.body).detail).toContain('History collection has started: 0 of 3 approved windows checked so far. This is progress, not complete coverage.');
    // Held acquisition is reported, but it never withdraws a current verification.
    f.observed.mailHistory = history('held', 1, 'the connection was withdrawn');
    const held = gmailCheck((await service.handle('/api/agency-setup', 'GET'))!.body);
    expect(held.state).toBe('passed');
    expect(held.detail).toContain('History collection is held (the connection was withdrawn); 1 of 3 approved windows were checked. The checkpoint was kept.');
    // A collector that cannot start is not a failed source check.
    onGmailVerified.mockRejectedValueOnce(Object.assign(new Error('The collector is unavailable.'), { status: 503 }));
    const second = await service.handle('/api/agency-setup/check-gmail', 'POST', { expectedRevision: 1 });
    expect(second!.status).toBe(200);
    expect(gmailCheck(second!.body).state).toBe('passed');
    expect(onGmailVerified).toHaveBeenCalledTimes(2);
    // An expired projection is not a verification, so nothing is collected.
    f.advance(300_001);
    const expired = await service.handle('/api/agency-setup/check-gmail', 'POST', { expectedRevision: 1 });
    expect(gmailCheck(expired!.body).state).toBe('needed');
    expect(f.checkGmail).toHaveBeenCalledTimes(3);
    expect(onGmailVerified).toHaveBeenCalledTimes(2);
  });
  it('offers the same start when the review completes a verified but unreviewed setup', async () => {
    const f = await fixture(), onGmailVerified = vi.fn();
    const service = createAgencySetupService({ ...f.options, onGmailVerified });
    const saved = await service.save({ expectedRevision: 0, settings: f.settings() });
    // Saving settings is not a verified source, so nothing is collected yet.
    expect(onGmailVerified).not.toHaveBeenCalled();
    const workflow = saved.workflows.find(item => item.id === 'morning-priorities')!;
    const request = { expectedRevision: 1, expectedEvidenceDigest: workflow.evidenceDigest };
    await service.review('morning-priorities', request);
    expect(onGmailVerified.mock.calls).toEqual([[{ accountId: 'mail-agency-a', settingsRevision: 1, historyDays: 7 }]]);
    // A repeated review records nothing new, so it offers no second start.
    await service.review('morning-priorities', request);
    expect(onGmailVerified).toHaveBeenCalledTimes(1);
  });
  it('names the ANZ-only limit of the installed bank preparation adapter', async () => {
    const f = await reviewedFixture();
    const limit = 'The installed preparation plan accepts ANZ exports only; it blocks other bank brands until a host adapter and source contract exist.';
    const mapped = (await f.service.get()).workflows.find(item => item.id === 'bank-references')!.checks.find(check => check.id === 'mapping')!;
    expect(mapped.state).toBe('passed'); expect(mapped.detail).toContain(limit);
    f.observed.properties!.items = [];
    const unmapped = (await f.service.get()).workflows.find(item => item.id === 'bank-references')!.checks.find(check => check.id === 'mapping')!;
    expect(unmapped.state).toBe('needed'); expect(unmapped.detail).toContain(limit);
  });
  it('refuses a review before any agency settings revision has been saved', async () => {
    const f = await fixture(), file = join(f.root, 'agency-setup.json');
    const view = await f.service.get(); expect(view.state.revision).toBe(0); expect(view.state.updatedAt).toBeNull();
    const workflow = view.workflows.find(item => item.id === 'morning-priorities')!;
    const request = { expectedRevision: 0, expectedEvidenceDigest: workflow.evidenceDigest };
    await expect(f.service.review('morning-priorities', request)).rejects.toMatchObject({ status: 409 });
    await expect(f.service.review('morning-priorities', request)).rejects.toThrow(/Save agency details before approving a workflow/);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await f.service.getConfiguration()).revision).toBe(0);
    const saved = await f.service.save({ expectedRevision: 0, settings: f.settings() });
    expect(saved.state.revision).toBe(1);
    const after = saved.workflows.find(item => item.id === 'morning-priorities')!;
    expect(await f.service.review('morning-priorities', { expectedRevision: 1, expectedEvidenceDigest: after.evidenceDigest })).toMatchObject({ state: { revision: 1 } });
    expect((await f.service.getConfiguration()).reviews['morning-priorities']?.settingsRevision).toBe(1);
  });
  it('rechecks the saved revision after awaiting observations before execution admission', async () => {
    const f = await reviewedFixture(); let release!: () => void;
    f.observe.mockImplementationOnce(() => new Promise<AgencySetupObservations>(resolve => { release = () => resolve(structuredClone(f.observed)); }));
    const admission = f.service.assertWorkflowReady('morning-priorities'); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await f.service.save({ expectedRevision: 1, settings: { ...f.settings(), agencyName: 'Changed office details' } }); release();
    await expect(admission).rejects.toMatchObject({ status: 409, code: 'agency_setup_stale' });
  });
});


it('requires a new workflow review when the same shared mailbox policy is revoked and regranted', async () => {
  const f = await fixture();
  const binding = (revision: number) => managedMailBindingRevision('workspace-a', 'property', undefined, { sourceKind: 'office_shared', policyRevision: revision, services: { gmail: { connected: true, status: 'ACTIVE', accountSelectionRequired: false, accounts: [{ id: 'mail-agency-a', status: 'ACTIVE' }] } } });
  f.observed.gmail!.sourceKind = 'office_shared'; f.observed.gmail!.bindingRevision = binding(1);
  let view = await f.service.save({ expectedRevision: 0, settings: f.settings() });
  const row = view.workflows.find(item => item.id === 'morning-priorities')!;
  view = await f.service.review(row.id, { expectedRevision: view.state.revision, expectedEvidenceDigest: row.evidenceDigest });
  expect(view.gmailSourceKind).toBe('office_shared');
  expect(view.workflows.find(item => item.id === row.id)!.readyForRun).toBe(true);
  f.observed.gmail!.bindingRevision = binding(3);
  const changed = await f.service.get();
  expect(changed.workflows.find(item => item.id === row.id)!.reviewed).toBe(false);
  await expect(f.service.assertWorkflowReady(row.id)).rejects.toThrow();
});

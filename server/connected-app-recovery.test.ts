import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT, MANUAL_MAIL_ACKNOWLEDGEMENT, connectedAppCanonical, type ConnectedMailBinding, type ConnectedMailReview } from '../shared/connected-app-binding.ts';
import { ConnectedAppOperationStore } from './connected-app-operations.ts';
import { ConnectedAppRecovery, createConnectedMailReviewArtifacts } from './connected-app-recovery.ts';
import { createPrivateVault } from './private-vault.ts';
import { loadWorkspaceIdentity } from './workspace-identity.ts';
import { needsSession } from './session-auth.ts';

const directories: string[] = [];
const digest = (value: unknown) => createHash('sha256').update(connectedAppCanonical(value)).digest('hex');
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'realbud-mail-recovery-')); directories.push(directory);
  await loadWorkspaceIdentity(join(directory, 'company-installation'));
  const store = new ConnectedAppOperationStore({ file: join(directory, 'connected-app-operations.json') });
  const vault = createPrivateVault(directory, Buffer.alloc(32, 7)), reviews = createConnectedMailReviewArtifacts(vault);
  let binding: ConnectedMailBinding = { provider: 'gmail', accountId: 'account-a', companyId: 'company-a', label: 'office@example.test', emailAddress: 'office@example.test', generation: 'a'.repeat(64) };
  let gatewayOrigin = 'https://gateway.example.test';
  const card = 'To: tenant@example.test\nSubject: Original inspection\nMessage: private original mail marker';
  const exact = '{"name":"GMAIL_SEND_EMAIL","arguments":{"body":"private original mail marker"}}';
  const review: ConnectedMailReview = { version: 1, gatewayOrigin, workspaceDigest: store.workspaceDigest, accountDigest: digest({ provider: binding.provider, accountId: binding.accountId, companyId: binding.companyId, gatewayOrigin }),
    bindingDigest: binding.generation, binding: { ...binding }, card, exact, reviewDigest: digest({ summary: card, detail: exact, approvalId: "f".repeat(32) }), approvedAt: 10, approvalId: "f".repeat(32) };
  await reviews.write(review);
  const row = store.start({ threadId: 'mail-thread', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [], accountDigest: review.accountDigest, realmDigest: digest({ companyId: binding.companyId, gatewayOrigin }), bindingDigest: review.bindingDigest,
    reviewDigest: review.reviewDigest, effectDigest: 'e'.repeat(64), workspaceDigest: store.workspaceDigest });
  store.finish(row.id, 'unknown');
  let authority = 'workspace-profile-connection-v1';
  const assertAuthority = vi.fn(), verifyAuthority = vi.fn(async () => {}), bindings = vi.fn(async () => [{ ...binding }]);
  const recovery = new ConnectedAppRecovery({ store, reviews, gatewayOrigin: () => gatewayOrigin, authority: () => authority, assertAuthority, verifyAuthority, bindings });
  const body = (prepared: Awaited<ReturnType<ConnectedAppRecovery['prepare']>>, outcome: 'sent' | 'not-sent' = 'not-sent') => ({ expectedRevision: prepared.expectedRevision,
    reviewDigest: prepared.reviewDigest, recoveryBindingDigest: prepared.recoveryBindingDigest, outcome, acknowledgement: prepared.acknowledgement });
  return { directory, store, vault, reviews, review, row, recovery, body, assertAuthority, verifyAuthority, bindings,
    changeOrigin: (value: string) => { gatewayOrigin = value; }, changeBinding: (next: Partial<ConnectedMailBinding>) => { binding = { ...binding, ...next }; }, changeAuthority: () => { authority += '-changed'; } };
}
const signal = () => new AbortController().signal;
describe('owner-only original mail review and manual outcome recovery', () => {
  it('saves the immutable original in the encrypted host vault, with no body/account data in receipts', async () => {
    const f = await setup();
    const encrypted = readFileSync(join(f.directory, 'company-installation/private', `mail-review-${f.review.reviewDigest}.json`), 'utf8');
    expect(encrypted).not.toContain('private original mail marker'); expect(encrypted).not.toContain('office@example.test');
    const receipt = readFileSync(join(f.directory, 'connected-app-operations.json'), 'utf8');
    expect(receipt).not.toContain('private original mail marker'); expect(receipt).not.toContain('account-a');
    const prepared = await f.recovery.prepare(f.row.id, signal());
    expect(prepared.originalReview.card).toBe(f.review.card); expect(prepared.originalReview.exact).toBe(f.review.exact);
    expect(prepared.acknowledgement).toBe(MANUAL_MAIL_ACKNOWLEDGEMENT);
    expect(prepared.account).toMatchObject({ accountId: 'account-a', companyId: 'company-a', gatewayOrigin: 'https://gateway.example.test', label: 'office@example.test' });
    const result = await f.recovery.reconcile(f.row.id, f.body(prepared), signal());
    expect(result.status).toBe('unknown'); expect(result.reconciliation).toMatchObject({ outcome: 'not-sent', source: 'manual-app-inspection' });
    expect(await f.recovery.reconcile(f.row.id, f.body(prepared), signal())).toEqual(result);
    await expect(f.recovery.reconcile(f.row.id, f.body(prepared, 'sent'), signal())).rejects.toThrow(/changed/);
  });
  it.each(['prepare', 'reconcile'] as const)('rechecks gateway generation after the awaited owner grant during %s', async method => {
    const f = await setup(); const prepared = await f.recovery.prepare(f.row.id, signal());
    f.verifyAuthority.mockImplementationOnce(async () => { f.changeBinding({ generation: 'd'.repeat(64) }); });
    await expect(method === 'prepare' ? f.recovery.prepare(f.row.id, signal()) : f.recovery.reconcile(f.row.id, f.body(prepared), signal())).rejects.toThrow(/connection changed while/);
    expect(f.store.list()[0].reconciliation).toBeUndefined();
  });
  it('gives concurrent independently approved identical cards distinct immutable artifacts and a single durable effect', async () => {
    const f = await setup();
    const first = { ...f.review, approvalId: '1'.repeat(32), approvedAt: 20 }, second = { ...f.review, approvalId: '2'.repeat(32), approvedAt: 30 };
    first.reviewDigest = digest({ summary: first.card, detail: first.exact, approvalId: first.approvalId });
    second.reviewDigest = digest({ summary: second.card, detail: second.exact, approvalId: second.approvalId });
    await Promise.all([f.reviews.write(first), f.reviews.write(second)]);
    expect((await f.reviews.read(first.reviewDigest))?.approvedAt).toBe(20);
    expect((await f.reviews.read(second.reviewDigest))?.approvedAt).toBe(30);
    const input = { threadId: 'concurrent', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [], accountDigest: first.accountDigest, realmDigest: digest({ companyId: first.binding.companyId, gatewayOrigin: first.gatewayOrigin }), bindingDigest: first.bindingDigest, effectDigest: 'c'.repeat(64), workspaceDigest: first.workspaceDigest };
    const row = f.store.start({ ...input, reviewDigest: first.reviewDigest });
    expect(() => f.store.start({ ...input, reviewDigest: second.reviewDigest })).toThrow(/unresolved/);
    expect((await f.reviews.read(f.store.list().find(r => r.id === row.id)!.reviewDigest!))?.approvedAt).toBe(20);
  });
  it.each(['company', 'issuer', 'missing-company'] as const)('holds %s changes even when account ID/address match the original', async change => {
    const f = await setup(), prepared = await f.recovery.prepare(f.row.id, signal());
    if (change === 'issuer') f.changeOrigin('https://another-gateway.example.test');
    else f.changeBinding({ companyId: change === 'company' ? 'company-b' : undefined });
    await expect(f.recovery.prepare(f.row.id, signal())).rejects.toThrow(/original|Original|company|gateway/);
    await expect(f.recovery.reconcile(f.row.id, f.body(prepared), signal())).rejects.toThrow(/original|Original|company|gateway/);
    expect(f.store.list()[0].reconciliation).toBeUndefined();
  });
  it('permits changed-generation recovery only for the same exact account, original review and explicit acknowledgement', async () => {
    const f = await setup(); f.changeBinding({ generation: 'b'.repeat(64) });
    const prepared = await f.recovery.prepare(f.row.id, signal());
    expect(prepared.connectionChanged).toBe(true); expect(prepared.acknowledgement).toBe(CHANGED_CONNECTION_MAIL_ACKNOWLEDGEMENT);
    await expect(f.recovery.reconcile(f.row.id, { ...f.body(prepared), acknowledgement: MANUAL_MAIL_ACKNOWLEDGEMENT }, signal())).rejects.toThrow(/connection changed/);
    const result = await f.recovery.reconcile(f.row.id, f.body(prepared, 'sent'), signal());
    expect(result.bindingDigest).toBe('a'.repeat(64)); expect(result.reconciliation?.recoveryBindingDigest).toBe('b'.repeat(64));
    expect(result.status).toBe('unknown');
  });
  it.each(['account', 'generation', 'workspace', 'role', 'revision', 'review'] as const)('holds when %s changes after preparation', async mutation => {
    const f = await setup(), prepared = await f.recovery.prepare(f.row.id, signal());
    if (mutation === 'account') f.changeBinding({ accountId: 'account-b' });
    if (mutation === 'generation') f.changeBinding({ generation: 'c'.repeat(64) });
    if (mutation === 'workspace') f.bindings.mockImplementation(async () => { f.changeAuthority(); return [f.review.binding]; });
    if (mutation === 'role') f.verifyAuthority.mockImplementation(async () => { throw new Error('Owner permission changed.'); });
    const request = { ...f.body(prepared), ...(mutation === 'revision' ? { expectedRevision: prepared.expectedRevision + 1 } : {}), ...(mutation === 'review' ? { reviewDigest: 'f'.repeat(64) } : {}) };
    await expect(f.recovery.reconcile(f.row.id, request, signal())).rejects.toThrow();
    expect(f.store.list()[0].reconciliation).toBeUndefined();
  });
  it.each(['missing', 'tampered', 'foreign'] as const)('holds a %s original encrypted review', async mutation => {
    const f = await setup();
    if (mutation === 'missing') await f.vault.remove(`mail-review-${f.review.reviewDigest}`);
    else await f.vault.write(`mail-review-${f.review.reviewDigest}`, { ...f.review, ...(mutation === 'tampered' ? { card: 'A replacement message' } : { workspaceDigest: 'f'.repeat(64) }) });
    await expect(f.recovery.prepare(f.row.id, signal())).rejects.toThrow(/original approval review/);
    expect(f.store.list()[0].reconciliation).toBeUndefined();
  });
  it('refuses model-style shortcuts, extra fields and any closure without the original review identity', async () => {
    const f = await setup(), prepared = await f.recovery.prepare(f.row.id, signal());
    for (const body of [{ outcome: 'not-sent', approved: true }, { ...f.body(prepared), intentionalResend: true }, { ...f.body(prepared), acknowledgement: true }])
      await expect(f.recovery.reconcile(f.row.id, body, signal())).rejects.toThrow(/explicit recovery controls/);
    expect(needsSession(`/api/connected-apps/operations/${f.row.id}/recovery`, 'GET')).toBe(true);
    expect(needsSession(`/api/connected-apps/operations/${f.row.id}/reconcile`, 'POST')).toBe(true);
    expect(f.store.list()[0].reconciliation).toBeUndefined();
  });
  it('does not replace a missing private workspace identity when history exists', async () => {
    const f = await setup(); rmSync(join(f.directory, 'company-installation/workspace.json'));
    await expect(f.recovery.prepare(f.row.id, signal())).rejects.toThrow(/history needs recovery/);
    expect(readFileSync(join(f.directory, 'connected-app-operations.json'), 'utf8')).toContain(f.row.id);
  });
});

import { createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from './config.ts';
import { createSupplierDirectory } from './supplier-directory.ts';
import { createMaintenanceReviewApi, createMaintenanceReviewStore, maintenanceCoverage, maintenanceInvoices, readMaintenanceReview, runMaintenanceReview, senderAddress } from './maintenance-review.ts';
import { computeMaintenanceFindings } from './maintenance-findings.ts';
import { billSenderEnvelopeDigest } from './source-bill-rules.ts';
import { previewBillSource } from './source-bills.ts';
import type { SourceBillOccurrence } from '../shared/source-bills.ts';
import type { RoutineResult } from '../shared/routine-result.ts';
import type { LoopRun } from '../shared/contracts.ts';

let n = 0;
const NOW = Date.parse('2026-10-05T00:00:00Z');
const CSV = 'Reference,Description,Email\nFIC-PLUMB,Fictional Plumbing,accounts@fictional-plumbing.example\nFIC-ELEC,Fictional Electrical,office@fictional-electrical.example';

// Gmail's own stamp confirming the From domain (fictional). `auth: null` leaves it off, as on older saved bills.
const pass = (domain: string) => `mx.google.com; dkim=pass header.i=@${domain} header.s=fictional header.b=FICTIONAL; spf=pass (google.com: fictional) smtp.mailfrom=bounce@${domain}; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${domain}`;
interface BillInput { id: string; property?: string; from?: string; replyTo?: string; auth?: string | null; number?: string | null; date?: string; amount?: number; kind?: string; work?: string; ref?: string | null; state?: SourceBillOccurrence['state']; classification?: SourceBillOccurrence['facts']['maintenanceClassification'] }
const bill = (b: BillInput): SourceBillOccurrence => {
  const from = b.from ?? 'Fictional Plumbing <accounts@fictional-plumbing.example>', auth = b.auth === undefined ? pass(from.replace(/^.*@|>.*$/g, '')) : b.auth;
  return {
  id: `source-bill:${b.id.padEnd(64, '0')}`, state: b.state ?? 'received',
  facts: { propertyId: b.property ?? 'fictional-property-a', kind: b.kind ?? 'Maintenance', vendor: 'Fictional label', amountCents: b.amount ?? 12000, currency: 'AUD',
    invoiceDate: b.date ?? '2026-09-10', dueDate: null, note: '', invoiceNumber: b.number === undefined ? `INV-${b.id}` : b.number, workDescription: b.work ?? 'Fictional tap repair', supplierReference: b.ref ?? null, ...(b.classification ? { maintenanceClassification: b.classification } : {}) },
  source: { accountId: 'fictional', receiptId: 'r', threadId: 't', digest: 'd', identity: 'i',
    message: { id: 'm', at: Date.parse(`${b.date ?? '2026-09-10'}T01:00:00Z`), from, subject: `Fictional invoice ${b.id}`, body: '', attachments: [],
      ...(b.replyTo === undefined ? {} : { replyTo: b.replyTo }), ...(auth === null ? {} : { authResults: auth }) } },
  } as unknown as SourceBillOccurrence;
};
const run = (id: string) => ({ id, loopId: 'maintenance-review' } as LoopRun);

async function rig(options: { csv?: boolean; weekly?: RoutineResult | null } = {}) {
  const i = ++n;
  const directory = createSupplierDirectory({ file: join(DATA_DIR, `mr-suppliers-${i}.json`), now: () => NOW });
  if (options.csv !== false) await directory.importCsv({ csv: CSV, expectedRevision: 0 });
  const store = createMaintenanceReviewStore({ file: join(DATA_DIR, `mr-findings-${i}.json`), now: () => NOW });
  let bills: SourceBillOccurrence[] = [];
  const deps = { store, directory, bills: () => bills, weekly: () => options.weekly ?? null, timeZone: async () => 'Australia/Brisbane', now: () => NOW };
  return { store, directory, deps, set: (next: SourceBillOccurrence[]) => { bills = next; } };
}

describe('maintenance review inputs', () => {
  it('keeps ambiguous no-supplier bills visible for staff classification instead of assuming they are unrelated', async () => {
    const f = await rig(), directory = await f.directory.read(), ambiguous = bill({ id: 'ambiguous', from: 'unlisted@fictional-unlisted.example', kind: 'Other', work: 'FYI' });
    const rows = maintenanceInvoices([ambiguous], directory, 'Australia/Brisbane');
    expect(rows).toHaveLength(1); expect(rows[0].classificationNeeded).toBe(true);
    const findings = computeMaintenanceFindings({ invoices: rows, coverage: { from: '2026-09-01', to: '2026-09-30', complete: true } });
    expect(findings[0]).toMatchObject({ kind: 'sender-verification', reasons: ['classification-needed', 'supplier-unresolved', 'unlisted-sender'] });
    expect(findings[0].notes.join(' ')).toContain('separate staff decision');
    expect(maintenanceInvoices([{ ...ambiguous, facts: { ...ambiguous.facts, maintenanceClassification: 'not-maintenance' } }], directory, 'Australia/Brisbane')).toEqual([]);
    const confirmed = maintenanceInvoices([{ ...ambiguous, facts: { ...ambiguous.facts, maintenanceClassification: 'maintenance' } }], directory, 'Australia/Brisbane');
    expect(confirmed).toHaveLength(1); expect(confirmed[0].classificationNeeded).toBeUndefined(); expect(confirmed[0].senderMatch).toBe('unlisted');
  });
  it('uses only a reviewed actual original envelope and keeps quoted or unauthenticated original senders qualified', async () => {
    const f = await rig(), directory = await f.directory.read();
    const forwarded = bill({ id: 'forwarded', from: 'office@fictional-agency.example', kind: 'Maintenance' });
    forwarded.source = previewBillSource({ ...forwarded.source, message: { ...forwarded.source.message, id: 'ab', subject: 'Fwd: Fictional repair invoice', body: '---------- Forwarded message ---------\nFrom: accounts@fictional-plumbing.example\nQuoted bill text' } });
    const withoutOriginal = maintenanceInvoices([forwarded], directory, 'Australia/Brisbane')[0];
    expect(withoutOriginal.senderMatch).toBe('unverified'); expect(withoutOriginal.supplierRef).toBeNull(); expect(withoutOriginal.senderNote).toContain('Quoted sender lines are unverified');
    const original = previewBillSource({ ...forwarded.source, threadId: 'actual-original-thread', message: { ...forwarded.source.message, id: 'cd', at: forwarded.source.message.at - 1000, subject: 'Fictional repair invoice', from: 'accounts@fictional-plumbing.example', body: 'Actual saved original bill', authResults: pass('fictional-plumbing.example') } });
    forwarded.reviewedAt = NOW;
    forwarded.forwardedSenderReview = { version: 1, forwardedSourceDigest: forwarded.source.digest, originalItemId: 'a'.repeat(64), originalSource: original, originalEnvelopeDigest: billSenderEnvelopeDigest(original), reviewedAt: NOW, reviewedBy: 'fictional-staff-reviewer', reviewReason: 'Checked the actual original and the same forwarded bill' };
    const verified = maintenanceInvoices([forwarded], directory, 'Australia/Brisbane')[0];
    expect(verified).toMatchObject({ supplierRef: 'FIC-PLUMB', senderMatch: 'listed', senderEmail: 'accounts@fictional-plumbing.example' }); expect(verified.senderNote).toContain('actual saved original message cd');
    delete forwarded.forwardedSenderReview.originalSource.message.authResults;
    const changed = maintenanceInvoices([forwarded], directory, 'Australia/Brisbane')[0]; expect(changed.senderMatch).toBe('unverified'); expect(changed.senderNote).toContain('could not be checked');
    forwarded.forwardedSenderReview.originalEnvelopeDigest = billSenderEnvelopeDigest(forwarded.forwardedSenderReview.originalSource);
    const qualified = maintenanceInvoices([forwarded], directory, 'Australia/Brisbane')[0]; expect(qualified.senderMatch).toBe('unverified'); expect(qualified.senderNote).toContain('authentication not available');
  });
  it('reads the address from a From header', () => {
    expect(senderAddress('Fictional Plumbing <Accounts@Fictional-Plumbing.example>')).toBe('accounts@fictional-plumbing.example');
    expect(senderAddress('office@fictional-electrical.example')).toBe('office@fictional-electrical.example');
    // Spoofs: a listed address in the display name or a second angle address never counts as that supplier.
    expect(senderAddress('"Fictional Plumbing <accounts@fictional-plumbing.example>" <scam@fictional-evil.example>')).toBe('');
    expect(senderAddress('accounts@fictional-plumbing.example <scam@fictional-evil.example>')).toBe('');
    expect(senderAddress('<accounts@fictional-plumbing.example> <scam@fictional-evil.example>')).toBe('');
    expect(senderAddress('<accounts@fictional-plumbing.example>, scam@fictional-evil.example')).toBe('');
    expect(senderAddress('accounts@fictional-plumbing.example, scam@fictional-evil.example')).toBe('');
    expect(senderAddress('not an address')).toBe('');
  });

  it('checks a Xero-relayed invoice by its Reply-To address, never by the relay, display name or domain', async () => {
    const { directory } = await rig();
    await directory.importCsv({ csv: `${CSV}\nFIC-HANDY,Fictional Handyman,fictional.handyman@hotmail.example`, expectedRevision: 1 });
    const d = await directory.read();
    const xero = 'Fictional Plumbing via Xero <messaging-service@post.xero.com>';
    const rows = maintenanceInvoices([
      bill({ id: 'x1', from: xero, replyTo: 'Ben <Accounts@Fictional-Plumbing.example>' }),
      bill({ id: 'x2', from: xero, replyTo: 'ben@fictional-plumbing-billing.example' }),
      bill({ id: 'x3', from: xero }),
      bill({ id: 'x4', from: xero, replyTo: 'accounts@fictional-plumbing.example, scam@fictional-evil.example' }),
      bill({ id: 'x5', from: 'Fictional Handyman <fictional.handyman@hotmail.example>' }),
      bill({ id: 'x6', from: 'Fictional Plumbing <accounts@fictional-plumbing.example>', replyTo: 'scam@fictional-evil.example' }),
      bill({ id: 'x7', from: 'accounts@post.xero.com.fictional-evil.example', replyTo: 'accounts@fictional-plumbing.example' }),
    ], d, 'Australia/Brisbane');
    expect(rows.map(r => [r.sourceId.slice(12, 14), r.supplierRef, r.senderMatch, r.senderEmail, r.senderNote])).toEqual([
      ['x1', 'FIC-PLUMB', 'listed', 'accounts@fictional-plumbing.example', 'Sent via Xero for accounts@fictional-plumbing.example.'],
      ['x2', null, 'unlisted', 'ben@fictional-plumbing-billing.example', 'Sent via Xero for ben@fictional-plumbing-billing.example.'],
      ['x3', null, 'unlisted', `unclear sender: ${xero}`, 'Sent via Xero with no single Reply-To address, so the supplier could not be checked.'],
      ['x4', null, 'unlisted', `unclear sender: ${xero}`, 'Sent via Xero with no single Reply-To address, so the supplier could not be checked.'],
      ['x5', 'FIC-HANDY', 'listed', 'fictional.handyman@hotmail.example', undefined],
      // Not a relay: From decides, Reply-To is ignored.
      ['x6', 'FIC-PLUMB', 'listed', 'accounts@fictional-plumbing.example', undefined],
      // A look-alike domain is not the relay.
      ['x7', null, 'unlisted', 'accounts@post.xero.com.fictional-evil.example', undefined],
    ]);
    const findings = computeMaintenanceFindings({ invoices: rows, coverage: { from: '2026-09-01', to: '2026-10-05', complete: true } });
    const flagged = findings.filter(f => f.kind === 'sender-verification');
    expect(flagged.map(f => f.invoices[0]!.sourceIds[0]!.slice(12, 14)).sort()).toEqual(['x2', 'x3', 'x4', 'x7']);
    expect(flagged.find(f => f.invoices[0]!.sourceIds[0]!.includes('x2'))!.notes).toContain('Sent via Xero for ben@fictional-plumbing-billing.example.');
  });

  it('trusts a listed sender only when Gmail confirmed the From domain', async () => {
    const { directory } = await rig();
    const d = await directory.read();
    const plumb = 'Fictional Plumbing <accounts@fictional-plumbing.example>', xero = 'Fictional Plumbing via Xero <messaging-service@post.xero.com>';
    const forged = 'mx.google.com; dkim=none; spf=softfail (google.com: fictional) smtp.mailfrom=scam@fictional-evil.example; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=fictional-plumbing.example';
    const rows = maintenanceInvoices([
      bill({ id: 'v1', from: plumb, auth: forged }),
      bill({ id: 'v2', from: plumb }),
      bill({ id: 'v3', from: xero, replyTo: 'accounts@fictional-plumbing.example', auth: 'mx.google.com; dkim=pass header.i=@post.xero.com header.s=fictional; spf=pass smtp.mailfrom=bounce@post.xero.com' }),
      bill({ id: 'v4', from: xero, replyTo: 'accounts@fictional-plumbing.example', auth: 'mx.google.com; dkim=pass header.i=@fictional-evil.example; spf=pass smtp.mailfrom=a@post.xero.com; dmarc=fail header.from=post.xero.com' }),
      // An Authentication-Results header written by someone other than Gmail is ignored.
      bill({ id: 'v5', from: plumb, auth: 'mail.fictional-evil.example; dkim=pass header.d=fictional-plumbing.example; dmarc=pass header.from=fictional-plumbing.example' }),
      bill({ id: 'v6', from: plumb, auth: null }),
    ], d, 'Australia/Brisbane');
    expect(rows.map(r => [r.sourceId.slice(12, 14), r.supplierRef, r.senderMatch, r.senderNote])).toEqual([
      ['v1', 'FIC-PLUMB', 'unverified', 'Mail server did not confirm this sender, so it could be forged (DMARC fail, DKIM none).'],
      ['v2', 'FIC-PLUMB', 'listed', undefined],
      ['v3', 'FIC-PLUMB', 'listed', 'Sent via Xero for accounts@fictional-plumbing.example.'],
      ['v4', 'FIC-PLUMB', 'unverified', "Sent via Xero for accounts@fictional-plumbing.example. Claims to be sent via Xero but Xero's signature was not confirmed (DMARC fail, DKIM pass)."],
      ['v5', 'FIC-PLUMB', 'unverified', 'Mail server did not confirm this sender, so it could be forged (no Gmail authentication result).'],
      ['v6', 'FIC-PLUMB', 'unverified', 'Sender not verified (mail authentication not available for this message).'],
    ]);
    const findings = computeMaintenanceFindings({ invoices: rows, coverage: { from: '2026-09-01', to: '2026-10-05', complete: true } });
    const flagged = findings.filter(f => f.kind === 'sender-verification');
    const of = (id: string) => flagged.find(f => f.invoices[0]!.sourceIds.some(s => s.includes(id)));
    expect(of('v1')).toMatchObject({ reasons: ['unverified-sender'], supplierRef: 'FIC-PLUMB', senderEmail: 'accounts@fictional-plumbing.example' });
    expect(of('v1')!.notes).toContain('Mail server did not confirm this sender, so it could be forged (DMARC fail, DKIM none).');
    expect(of('v2')).toBeUndefined();
    expect(of('v3')).toBeUndefined();
    expect(of('v4')!.reasons).toEqual(['unverified-sender']);
    expect(of('v6')!.notes).toContain('Sender not verified (mail authentication not available for this message).');
    // The sender finding is independent: FIC-PLUMB's several invoices are still compared.
    expect(findings.some(f => f.kind === 'multiple-invoices' && f.supplierRef === 'FIC-PLUMB')).toBe(true);
  });

  it('never lets a reviewed supplier reference stand in for sender verification', async () => {
    const { directory } = await rig();
    const forged = 'mx.google.com; dkim=none; dmarc=fail header.from=fictional-plumbing.example';
    const rows = maintenanceInvoices([
      bill({ id: 'r1', from: 'Fictional Plumbing <accounts@fictional-plumbing.example>', auth: forged, ref: 'FIC-PLUMB' }),
      bill({ id: 'r2', from: 'scam@fictional-evil.example', ref: 'FIC-PLUMB' }),
    ], await directory.read(), 'Australia/Brisbane');
    expect(rows.map(r => [r.sourceId.slice(12, 14), r.supplierRef, r.senderMatch])).toEqual([['r1', 'FIC-PLUMB', 'unverified'], ['r2', 'FIC-PLUMB', 'unlisted']]);
    const reasons = computeMaintenanceFindings({ invoices: rows, coverage: { from: '2026-09-01', to: '2026-10-05', complete: true } })
      .filter(f => f.kind === 'sender-verification').map(f => (f as { reasons: string[] }).reasons);
    expect(reasons).toEqual(expect.arrayContaining([['unverified-sender'], ['unlisted-sender']]));
  });

  it('carries Reply-To and Authentication-Results on bill evidence without changing any source digest', () => {
    const message = { id: 'fictional-m1', at: NOW, from: 'Fictional Plumbing <accounts@fictional-plumbing.example>', subject: 'Fictional invoice', body: 'Fictional', bodyTruncated: false, attachments: [] };
    const source = { accountId: 'fictional', receiptId: 'r', threadId: 't', message };
    const plain = previewBillSource(source), relayed = previewBillSource({ ...source, message: { ...message, replyTo: 'ben@fictional-plumbing.example' } });
    // The digest formula is unchanged: sha256 of the canonical source without receipt or Reply-To.
    expect(plain.digest).toBe(createHash('sha256').update(JSON.stringify({ accountId: 'fictional', threadId: 't', message })).digest('hex'));
    expect(plain.message).not.toHaveProperty('replyTo');
    expect(relayed.digest).toBe(plain.digest);
    expect(relayed.message.replyTo).toBe('ben@fictional-plumbing.example');
    expect(() => previewBillSource({ ...source, message: { ...message, replyTo: 'x'.repeat(2049) } })).toThrow();
    const stamped = previewBillSource({ ...source, message: { ...message, replyTo: 'ben@fictional-plumbing.example', authResults: 'mx.google.com; dmarc=pass header.from=fictional-plumbing.example' } });
    expect(stamped.digest).toBe(plain.digest);
    expect(stamped.message.authResults).toBe('mx.google.com; dmarc=pass header.from=fictional-plumbing.example');
    expect(() => previewBillSource({ ...source, message: { ...message, authResults: 'x'.repeat(4097) } })).toThrow();
  });

  it('flags an invoice from an email shared by two supplier records and reports the conflict', async () => {
    const { directory, store, deps, set } = await rig();
    await directory.importCsv({ csv: `${CSV}\nFIC-DUPE,Fictional Duplicate,accounts@fictional-plumbing.example`, expectedRevision: 1 });
    set([bill({ id: 'd1' })]);
    await runMaintenanceReview(run('dupe-1'), deps);
    const state = await store.read();
    expect(state.findings.map(f => [f.finding.kind, (f.finding as { reasons?: string[] }).reasons, f.finding.supplierRef])).toEqual([['sender-verification', ['conflicting-sender', 'supplier-unresolved'], null]]);
    expect(state.lastRun!.gaps).toContain('Same email on two suppliers: FIC-DUPE, FIC-PLUMB. Correct the supplier list.');
    const api = createMaintenanceReviewApi({ store, directory, recovery: () => false, propertyLabel: () => undefined, bill: () => undefined, loop: () => undefined });
    expect((await api(new URL('https://127.0.0.1/api/maintenance-review'), 'GET'))!.body).toMatchObject({
      directory: { suppliers: 3, withoutEmail: 0, conflicts: [{ email: 'accounts@fictional-plumbing.example', supplierRefs: ['FIC-DUPE', 'FIC-PLUMB'] }] } });
  });

  it('matches by exact email or reviewed reference and skips cancelled and non-maintenance bills', async () => {
    const { directory } = await rig();
    const d = await directory.read();
    const rows = maintenanceInvoices([
      bill({ id: 'a1' }),
      bill({ id: 'a2', from: 'billing@fictional-plumbing.example' }),
      bill({ id: 'a3', from: 'rates@fictional-council.example', kind: 'Council rates', work: '', classification: 'not-maintenance' }),
      bill({ id: 'a4', state: 'cancelled' }),
      bill({ id: 'a5', ref: 'FIC-ELEC' }),
    ], d, 'Australia/Brisbane');
    expect(rows.map(r => [r.sourceId.slice(12, 14), r.supplierRef, r.senderMatch])).toEqual([
      ['a1', 'FIC-PLUMB', 'listed'], ['a2', null, 'unlisted'], ['a5', 'FIC-ELEC', 'conflict'],
    ]);
  });

  it('marks coverage partial without a weekly review and when last month is not covered', () => {
    expect(maintenanceCoverage(null, [], 'UTC', '2026-10-05').coverage.complete).toBe(false);
    const weekly = { status: 'completed', gaps: [], coverage: { startAt: Date.parse('2026-08-01T00:00:00Z'), endAt: NOW, uncovered: [] } } as unknown as RoutineResult;
    expect(maintenanceCoverage(weekly, [], 'UTC', '2026-10-05')).toEqual({ coverage: { from: '2026-08-01', to: '2026-10-05', complete: true }, gaps: [] });
    const late = { ...weekly, coverage: { ...weekly.coverage!, startAt: Date.parse('2026-09-20T00:00:00Z') } };
    expect(maintenanceCoverage(late, [], 'UTC', '2026-10-05').coverage.complete).toBe(false);
  });
});

describe('maintenance review run', () => {
  it('alerts once, ignores forwarded copies, keeps properties apart and updates the same finding for a third invoice', async () => {
    const { store, deps, set } = await rig();
    set([
      bill({ id: 'b1', date: '2026-09-03', amount: 18000, work: 'Fictional blocked drain' }),
      bill({ id: 'b2', date: '2026-09-17', amount: 22000, work: 'Fictional hot water valve' }),
      bill({ id: 'b3', date: '2026-09-17', amount: 22000, number: 'INV-b2', from: 'office@fictional-agency.example', ref: 'FIC-PLUMB' }), // forwarded copy, reviewed supplier
      bill({ id: 'b4', date: '2026-09-20', property: 'fictional-property-b' }),
      bill({ id: 'b5', date: '2026-09-22', from: 'new@fictional-unknown.example', ref: null, property: 'fictional-property-c' }),
    ]);
    const first = await runMaintenanceReview(run('r1'), deps);
    let state = await store.read();
    const multiple = state.findings.filter(f => f.finding.kind === 'multiple-invoices');
    const sender = state.findings.filter(f => f.finding.kind === 'sender-verification');
    expect(multiple).toHaveLength(1);
    expect(multiple[0].finding.propertyId).toBe('fictional-property-a');
    expect(multiple[0].finding.invoices).toHaveLength(2);
    expect(multiple[0].finding.invoices.find(i => i.invoiceNumber === 'INV-b2')!.sourceIds).toHaveLength(2);
    expect(sender.map(f => (f.finding as { senderEmail: string }).senderEmail).sort()).toEqual(['new@fictional-unknown.example', 'office@fictional-agency.example']);
    expect(state.lastRun!.alerts).toBe(3);
    expect(first).toMatchObject({ ok: true, status: 'partial', quiet: false });
    expect(first.detail).toContain('3 findings to review');
    expect(first.detail).toContain('Check is partial');

    const again = await runMaintenanceReview(run('r2'), deps);
    expect(again.quiet).toBe(true);
    expect((await store.read()).lastRun!.alerts).toBe(0);

    state = await store.read();
    await store.decide({ id: multiple[0].finding.id, action: 'dismissed', expectedRevision: state.revision });
    set([...deps.bills(), bill({ id: 'b6', date: '2026-09-28', amount: 9000, work: 'Fictional tap washer' })]);
    const third = await runMaintenanceReview(run('r3'), deps);
    state = await store.read();
    const updated = state.findings.find(f => f.finding.id === multiple[0].finding.id)!;
    expect(updated.finding.invoices).toHaveLength(3);
    expect(updated.state).toBe('new');
    expect(state.lastRun!.alerts).toBe(1);
    expect(third.quiet).toBe(false);
    expect(state.findings.filter(f => f.finding.kind === 'multiple-invoices')).toHaveLength(1);
  });

  it('does not invent sender findings before the supplier list is imported', async () => {
    const { store, deps, set } = await rig({ csv: false });
    set([bill({ id: 'c1', ref: 'FIC-PLUMB', date: '2026-09-02' }), bill({ id: 'c2', ref: 'FIC-PLUMB', date: '2026-09-09' })]);
    const result = await runMaintenanceReview(run('r1'), deps);
    const state = await store.read();
    expect(state.findings.map(f => f.finding.kind)).toEqual(['multiple-invoices']);
    expect(state.lastRun!.gaps[0]).toContain('Import the supplier list');
    expect(result.status).toBe('partial');
  });

  it('says partial, never plain "No findings", when coverage is incomplete', async () => {
    const { deps } = await rig();
    expect((await runMaintenanceReview(run('r1'), deps)).detail).toContain('No findings in the bills checked so far');
  });
});

describe('maintenance review store and routes', () => {
  it('rejects stale revisions and a damaged file without replacing it', async () => {
    const { store, deps, set } = await rig();
    set([bill({ id: 'd1', from: 'x@fictional-unknown.example' })]);
    await runMaintenanceReview(run('r1'), deps);
    const state = await store.read();
    await expect(store.decide({ id: state.findings[0].finding.id, action: 'seen', expectedRevision: state.revision - 1 })).rejects.toMatchObject({ status: 409 });
    expect((await store.decide({ id: state.findings[0].finding.id, action: 'seen', expectedRevision: state.revision })).findings[0].state).toBe('seen');
    expect(() => readMaintenanceReview({ ...state, extra: 1 })).toThrow(/recovery/);
    const file = join(DATA_DIR, 'mr-damaged.json');
    await writeFile(file, '{"version":1}', { mode: 0o600 });
    await expect(createMaintenanceReviewStore({ file }).read()).rejects.toMatchObject({ status: 503 });
  });

  it('restores the last good copy when the saved file is damaged, keeping the damaged file', async () => {
    const { store, deps, set } = await rig();
    set([bill({ id: 'd1', from: 'x@fictional-unknown.example' })]);
    await runMaintenanceReview(run('r1'), deps);
    const state = await store.read();
    await store.decide({ id: state.findings[0].finding.id, action: 'seen', expectedRevision: state.revision });
    const file = join(DATA_DIR, `mr-findings-${n}.json`);
    await writeFile(file, '{"version":1', { mode: 0o600 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect(await store.read()).toMatchObject({ revision: state.revision }); } finally { warn.mockRestore(); }
    expect((await readdir(DATA_DIR)).some(name => name.startsWith(`mr-findings-${n}.json.damaged-`))).toBe(true);
  });

  it('keeps the month rule revision apart from loop runs, so only a real rule change conflicts', async () => {
    const { store, deps, set } = await rig();
    const opened = (await store.read()).ruleRevision ?? 0;
    set([bill({ id: 'd1', from: 'x@fictional-unknown.example' })]);
    await runMaintenanceReview(run('r1'), deps);
    const saved = await store.setRule({ rule: { basis: 'receivedDate', span: 'calendarMonth' }, expectedRevision: opened });
    expect(saved).toMatchObject({ ruleRevision: opened + 1, rule: { basis: 'receivedDate' } });
    await expect(store.setRule({ rule: { basis: 'invoiceDate', span: 'rolling30' }, expectedRevision: opened })).rejects.toMatchObject({ status: 409 });
    expect((await store.read()).rule).toEqual({ basis: 'receivedDate', span: 'calendarMonth' });
    const { ruleRevision: _dropped, ...older } = saved;
    expect(readMaintenanceReview(older).ruleRevision).toBeUndefined();
    expect(() => readMaintenanceReview({ ...saved, ruleRevision: -1 })).toThrow(/recovery/);
  });

  it('holds changes during recovery and imports the directory through the route', async () => {
    const { store, directory } = await rig({ csv: false });
    let recovery = true;
    const api = createMaintenanceReviewApi({ store, directory, recovery: () => recovery, propertyLabel: () => 'Fictional Oak Street', bill: () => undefined, loop: () => undefined });
    const url = (p: string) => new URL(`https://127.0.0.1${p}`);
    await expect(api(url('/api/supplier-directory/import'), 'POST', { csv: CSV, expectedRevision: 0 })).rejects.toMatchObject({ status: 503 });
    recovery = false;
    const imported = await api(url('/api/supplier-directory/import'), 'POST', { csv: CSV, expectedRevision: 0 });
    expect((imported!.body as { directory: { suppliers: unknown[] } }).directory.suppliers).toHaveLength(2);
    const alias = await api(url('/api/supplier-directory/aliases'), 'POST', { reference: 'FIC-PLUMB', email: 'jobs@fictional-plumbing.example', expectedRevision: 1 });
    expect((alias!.body as { directory: { aliases: unknown[] } }).directory.aliases).toHaveLength(1);
    expect((await api(url('/api/maintenance-review'), 'GET'))!.body).toMatchObject({ findings: [], rule: { basis: 'invoiceDate', span: 'calendarMonth' } });
    await expect(api(url('/api/maintenance-review/rule'), 'PUT', { rule: { basis: 'bogus', span: 'calendarMonth' }, expectedRevision: 0 })).rejects.toMatchObject({ status: 400 });
    expect(await api(url('/api/bill-register'), 'GET')).toBeNull();
  });
});

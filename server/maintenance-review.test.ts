import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DATA_DIR } from './config.ts';
import { createSupplierDirectory } from './supplier-directory.ts';
import { createMaintenanceReviewApi, createMaintenanceReviewStore, maintenanceCoverage, maintenanceInvoices, readMaintenanceReview, runMaintenanceReview, senderAddress } from './maintenance-review.ts';
import type { SourceBillOccurrence } from '../shared/source-bills.ts';
import type { RoutineResult } from '../shared/routine-result.ts';
import type { LoopRun } from '../shared/contracts.ts';

let n = 0;
const NOW = Date.parse('2026-10-05T00:00:00Z');
const CSV = 'Reference,Description,Email\nFIC-PLUMB,Fictional Plumbing,accounts@fictional-plumbing.example\nFIC-ELEC,Fictional Electrical,office@fictional-electrical.example';

interface BillInput { id: string; property?: string; from?: string; number?: string | null; date?: string; amount?: number; kind?: string; work?: string; ref?: string | null; state?: SourceBillOccurrence['state'] }
const bill = (b: BillInput): SourceBillOccurrence => ({
  id: `source-bill:${b.id.padEnd(64, '0')}`, state: b.state ?? 'received',
  facts: { propertyId: b.property ?? 'fictional-property-a', kind: b.kind ?? 'Maintenance', vendor: 'Fictional label', amountCents: b.amount ?? 12000, currency: 'AUD',
    invoiceDate: b.date ?? '2026-09-10', dueDate: null, note: '', invoiceNumber: b.number === undefined ? `INV-${b.id}` : b.number, workDescription: b.work ?? 'Fictional tap repair', supplierReference: b.ref ?? null },
  source: { accountId: 'fictional', receiptId: 'r', threadId: 't', digest: 'd', identity: 'i',
    message: { id: 'm', at: Date.parse(`${b.date ?? '2026-09-10'}T01:00:00Z`), from: b.from ?? 'Fictional Plumbing <accounts@fictional-plumbing.example>', subject: `Fictional invoice ${b.id}`, body: '', attachments: [] } },
} as unknown as SourceBillOccurrence);
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
  it('reads the address from a From header', () => {
    expect(senderAddress('Fictional Plumbing <Accounts@Fictional-Plumbing.example>')).toBe('accounts@fictional-plumbing.example');
    expect(senderAddress('office@fictional-electrical.example')).toBe('office@fictional-electrical.example');
  });

  it('matches by exact email or reviewed reference and skips cancelled and non-maintenance bills', async () => {
    const { directory } = await rig();
    const d = await directory.read();
    const rows = maintenanceInvoices([
      bill({ id: 'a1' }),
      bill({ id: 'a2', from: 'billing@fictional-plumbing.example' }),
      bill({ id: 'a3', from: 'rates@fictional-council.example', kind: 'Council rates', work: '' }),
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

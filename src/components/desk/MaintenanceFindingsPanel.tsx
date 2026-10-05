import { useCallback, useEffect, useState } from 'react';
import { api, useStore } from '@/state/store';
import { ReiDirectoryRefresh } from '../ReiDirectoryRefresh';

// W4 maintenance checks. Server shape: server/maintenance-review.ts (GET /api/maintenance-review).
interface FindingInvoice { invoiceNumber: string | null; invoiceDate: string | null; receivedDate: string; amountsCents: number[]; description: string; sourceIds: string[]; unresolvedRevision: boolean }
interface Finding {
  id: string; kind: 'sender-verification' | 'multiple-invoices'; propertyId: string; supplierRef: string | null;
  senderEmail?: string; reasons?: string[]; windowKey?: string; windowStart?: string; windowEnd?: string; invoices: FindingInvoice[]; notes: string[];
}
interface Saved { finding: Finding; state: 'new' | 'seen' | 'dismissed' }
interface Review {
  revision: number; findings: Saved[];
  lastRun: { finishedAt: number; checkedBills: number; coverage: { from: string; to: string; complete: boolean }; gaps: string[] } | null;
  properties: Record<string, string>; suppliers: Record<string, string>;
  sources: Record<string, { subject: string; from: string; receivedAt: number }>;
  directory: { revision: number; suppliers: number; withoutEmail?: number; conflicts?: { email: string; supplierRefs: string[] }[] };
}
interface Imported { directory: { suppliers: { emails: string[] }[] }; rejected: unknown[]; conflicts: unknown[] }

const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

function readReview(v: unknown): Review {
  const r = v as Review;
  if (!r || typeof r.revision !== 'number' || !Array.isArray(r.findings) || !r.properties || !r.suppliers || !r.sources || !r.directory ||
      !r.findings.every(f => f && f.finding && typeof f.finding.id === 'string' && Array.isArray(f.finding.invoices) && Array.isArray(f.finding.notes))) {
    throw new Error('Maintenance checks returned an unexpected answer.');
  }
  return r;
}

// A listed sender Gmail did not confirm (possible forgery) reads differently from an unknown one.
const reason = (f: Finding) => f.kind === 'sender-verification' ? (f.reasons?.length && f.reasons.every(r => r === 'unverified-sender') ? 'Sender not verified' : 'Sender needs checking')
  : f.windowKey?.includes('rolling30') ? 'Several invoices within 30 days' : 'Several invoices this month';

function FindingCard({ saved, review, busy, onDecide }: { saved: Saved; review: Review; busy: boolean; onDecide: (action: 'seen' | 'dismissed' | 'new') => void }) {
  const f = saved.finding, property = review.properties[f.propertyId] ?? f.propertyId;
  const supplier = f.supplierRef ? `${f.supplierRef}${review.suppliers[f.supplierRef] ? ` · ${review.suppliers[f.supplierRef]}` : ''}` : 'Supplier not matched yet';
  const name = `${reason(f)} · ${property}`;
  return <li data-finding-id={f.id} aria-label={name} className="space-y-2 py-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">{reason(f)}{saved.state === 'new' ? <span className="ml-2 rounded bg-hold/10 px-1.5 py-0.5 text-[11px] text-hold">New</span> : null}</p>
        <p className="text-ink-secondary break-words">{property} · {supplier}{f.senderEmail ? ` · Sent from ${f.senderEmail}` : ''}{f.windowStart ? ` · ${f.windowStart} to ${f.windowEnd}` : ''}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {saved.state === 'new' && <button type="button" className={button} disabled={busy} aria-label={`Mark seen: ${name}`} onClick={() => onDecide('seen')}>Mark seen</button>}
        {saved.state === 'dismissed'
          ? <button type="button" className={button} disabled={busy} aria-label={`Restore: ${name}`} onClick={() => onDecide('new')}>Restore</button>
          : <button type="button" className={button} disabled={busy} aria-label={`Dismiss: ${name}`} onClick={() => onDecide('dismissed')}>Dismiss</button>}
      </div>
    </div>
    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{f.invoices.map((inv, i) => <li key={i} className="rounded-lg border border-line bg-paper p-2 text-[13px]">
      <p className="font-medium break-words">{inv.invoiceNumber ? `Invoice ${inv.invoiceNumber}` : 'No invoice number'}</p>
      <p className="text-ink-secondary">{inv.invoiceDate ? `Invoice date ${inv.invoiceDate}` : `Received ${inv.receivedDate}`} · {inv.amountsCents.length ? inv.amountsCents.map(a => money.format(a / 100)).join(' or ') : 'Amount unknown'}</p>
      <p className="break-words">{inv.description || 'No description'}</p>
      <p className="mt-1 text-[12px] text-ink-muted">Sources{inv.sourceIds.length > 1 ? ` · ${inv.sourceIds.length} copies counted once` : ''}</p>
      <ul className="text-[12px] text-ink-muted">{inv.sourceIds.map(id => { const s = review.sources[id]; return <li key={id} className="break-words">{s ? `${s.subject} · ${s.from} · ${new Date(s.receivedAt).toLocaleDateString()}` : 'Saved bill no longer available'}</li>; })}</ul>
    </li>)}</ul>
    {f.notes.length > 0 && <ul className="list-disc pl-5 text-[13px] text-ink-secondary">{f.notes.map((note, i) => <li key={i} className="break-words">{note}</li>)}</ul>}
  </li>;
}

export function MaintenanceFindingsPanel() {
  const { state } = useStore();
  const latest = state.loopRuns?.find(run => run.loopId === 'maintenance-review');
  const [review, setReview] = useState<Review | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const load = useCallback(async () => setReview(readReview(await api('/api/maintenance-review'))), []);
  useEffect(() => {
    let alive = true;
    void api('/api/maintenance-review').then(v => { if (alive) { setReview(readReview(v)); setMessage(''); } })
      .catch(() => { if (alive) setMessage('Maintenance checks could not be loaded. Saved findings are unchanged.'); });
    return () => { alive = false; };
  }, [latest?.id, latest?.status]);
  const decide = async (id: string, action: 'seen' | 'dismissed' | 'new') => {
    if (!review) return;
    setBusy(true); setMessage('');
    try {
      await api('/api/maintenance-review/findings', { method: 'PATCH', body: JSON.stringify({ id, action, expectedRevision: review.revision }) });
      await load();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) { setMessage('These findings changed. The list has been refreshed.'); await load().catch(() => {}); }
      else setMessage(status ? (error as Error).message : 'We could not confirm that change. Refresh to check before trying again.');
    } finally { setBusy(false); }
  };
  // REI Cloud Suppliers export → the supplier directory. The server checks the revision; a stale one is a 409.
  const importSuppliers = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    if (!review || !file) return;
    setBusy(true); setMessage('');
    try {
      const result = await api('/api/supplier-directory/import', { method: 'POST', body: JSON.stringify({ csv: await file.text(), expectedRevision: review.directory.revision }) }) as Imported;
      const suppliers = result.directory.suppliers, withoutEmail = suppliers.filter(s => !s.emails.length).length;
      setMessage(`Imported ${suppliers.length} suppliers · ${withoutEmail} without email · ${result.conflicts.length} ${result.conflicts.length === 1 ? 'conflict' : 'conflicts'}${result.rejected.length ? ` · ${result.rejected.length} rows or emails skipped` : ''}.`);
      await load().catch(() => {});
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) { setMessage('The supplier list changed. It has been refreshed; import the file again.'); await load().catch(() => {}); }
      else setMessage(status ? (error as Error).message : 'We could not confirm the import. Refresh to check before trying again.');
    } finally { setBusy(false); input.value = ''; }
  };
  if (!review) return message ? <p role="alert" className="text-sm text-hold">{message}</p> : null;
  const conflicts = review.directory.conflicts ?? [];
  const open = review.findings.filter(f => f.state !== 'dismissed'), dismissed = review.findings.filter(f => f.state === 'dismissed');
  const run = review.lastRun;
  return <section aria-label="Maintenance checks" className="space-y-2 text-sm">
    <h4 className="font-medium">Maintenance checks{run ? ` · ${open.length} to review` : ''}</h4>
    {message && <p role="status">{message}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <label className={`${button} inline-flex cursor-pointer items-center focus-within:outline-2 focus-within:outline-agency${busy ? ' pointer-events-none opacity-50' : ''}`}>
        Import REI suppliers (CSV)
        <input type="file" accept=".csv,text/csv" className="sr-only" disabled={busy} onChange={event => void importSuppliers(event.currentTarget)} />
      </label>
      {review.directory.suppliers > 0 && <span className="text-[13px] text-ink-secondary">{review.directory.suppliers} suppliers{review.directory.withoutEmail ? ` · ${review.directory.withoutEmail} without email` : ''}</span>}
    </div>
    <ReiDirectoryRefresh kind="suppliers" onSaved={() => void load().catch(() => {})} />
    {conflicts.length > 0 && <ul aria-label="Supplier list conflicts" className="list-disc rounded-lg border border-hold/40 p-2 pl-6 text-hold">
      {conflicts.map(c => <li key={c.email} className="break-words">Same email on two suppliers: {c.supplierRefs.join(', ')} ({c.email})</li>)}
    </ul>}
    {!run ? <p className="text-ink-secondary">{review.directory.suppliers ? 'Maintenance checks have not run yet. Turn them on or run them from Schedule.' : 'Import the supplier list, then turn on Maintenance checks in Schedule.'}</p> : <>
      <p className="text-ink-secondary break-words">{run.checkedBills} reviewed maintenance bills checked · {new Date(run.finishedAt).toLocaleString()}</p>
      {!run.coverage.complete && <div role="status" className="rounded-lg border border-hold/40 p-2">
        <p className="font-medium text-hold">Partial check · bills from {run.coverage.from} to {run.coverage.to}</p>
        <ul className="list-disc pl-5">{run.gaps.map((gap, i) => <li key={i} className="break-words">{gap}</li>)}</ul>
      </div>}
      {open.length === 0 ? <p className="text-ink-secondary">{run.coverage.complete ? 'No findings to review.' : 'No findings in the bills checked so far. Earlier invoices may be missing.'}</p>
        : <ul className="divide-y divide-line">{open.map(saved => <FindingCard key={saved.finding.id} saved={saved} review={review} busy={busy} onDecide={action => void decide(saved.finding.id, action)} />)}</ul>}
      {dismissed.length > 0 && <details><summary className="min-h-11 cursor-pointer">Dismissed · {dismissed.length}</summary>
        <ul className="divide-y divide-line">{dismissed.map(saved => <FindingCard key={saved.finding.id} saved={saved} review={review} busy={busy} onDecide={action => void decide(saved.finding.id, action)} />)}</ul>
      </details>}
      <p className="text-[12px] text-ink-muted">A listed sender means the address is in your supplier list, not that the charge is correct. Similar or unrelated work is for you to judge.</p>
    </>}
  </section>;
}

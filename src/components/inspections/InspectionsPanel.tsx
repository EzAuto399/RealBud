import { useCallback, useEffect, useState } from 'react';
import { api, useStore } from '@/state/store';

// W5 inspection planning. Server: server/inspection-bookings.ts (/api/inspections*).
// A draft plan only: nothing here books, sends or calls Property Inspect.
interface Appointment { id: string; propertyId: string; address: string; area: string; date: string; time: string; inspector: string; dueDate: string | null; status: 'accepted' | 'manual' | 'draft'; reason: string }
interface Hold { propertyId: string; kind: 'overdue' | 'no-history' | 'unschedulable' | 'manual-hold' | 'unreadable'; dueDate: string | null; reason: string }
interface Rules { horizonMonths: number; cycleMonths: number; cycleBasis: 'completed' | 'planned'; workingDays: number[]; closedDates: string[]; inspectors: string[]; dayStart: string; appointmentMinutes: number; travelMinutes: number; dailyCapacity: number }
interface Unmatched { row: number; property: string; reason: string }
export interface InspectionsView {
  rules: { revision: number; rules: Rules };
  history: { revision: number; records: Record<string, unknown>; unmatched: Unmatched[]; lastImport: { at: number; matched: number; unmatched: number } | null };
  plan: { revision: number; draft: { planStart: string; createdAt: number; plan: { appointments: Appointment[]; holds: Hold[]; notDue: unknown[] } } | null };
  properties: Record<string, string>;
}

const button = 'pm-control min-h-11 rounded-lg border border-line bg-sheet px-3 text-sm text-ink hover:bg-selected disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const primary = 'pm-control min-h-11 rounded-lg border border-agency bg-agency px-3 text-sm text-sheet hover:bg-agency-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency';
const input = 'min-h-11 rounded-lg border border-line bg-sheet px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-agency';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOLD_LABEL: Record<Hold['kind'], string> = { overdue: 'Overdue', 'no-history': 'No history', unschedulable: 'No free slot', 'manual-hold': 'Held by hand', unreadable: 'Date unreadable' };
const STATUS_LABEL: Record<Appointment['status'], string> = { draft: 'Draft', accepted: 'Accepted', manual: 'Moved' };
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const localToday = () => new Date().toLocaleDateString('en-CA');

/** A malformed 200 is an error, never a partial view. */
export function readInspectionsView(v: unknown): InspectionsView {
  const r = v as InspectionsView;
  if (!r || !r.rules?.rules || !Array.isArray(r.rules.rules.inspectors) || !r.history || !Array.isArray(r.history.unmatched) || typeof r.history.revision !== 'number' ||
      !r.plan || typeof r.plan.revision !== 'number' || !(r.plan.draft === null || (Array.isArray(r.plan.draft?.plan?.appointments) && Array.isArray(r.plan.draft.plan.holds))) || !r.properties) {
    throw new Error('Inspections returned an unexpected answer.');
  }
  return r;
}

export function rulesSummary(rules: Rules): string {
  const people = rules.inspectors.length ? rules.inspectors.join(' and ') : 'No inspectors yet';
  return [`${people}`, `${rules.workingDays.map(d => DAYS[d]).join(', ')} from ${rules.dayStart}`, `${rules.appointmentMinutes} min + ${rules.travelMinutes} min travel`,
    `up to ${rules.dailyCapacity} a day each`, `every ${rules.cycleMonths} months from the ${rules.cycleBasis} date`,
    rules.closedDates.length ? `closed ${rules.closedDates.length} day${rules.closedDates.length === 1 ? '' : 's'} (${rules.closedDates[0]}${rules.closedDates.length > 1 ? ` … ${rules.closedDates[rules.closedDates.length - 1]}` : ''})` : 'no closed dates'].join(' · ');
}

/** Day → area → time. */
export function groupPlan(appointments: Appointment[]) {
  const days = new Map<string, Map<string, Appointment[]>>();
  for (const a of [...appointments].sort((x, y) => x.date.localeCompare(y.date) || x.area.localeCompare(y.area) || x.time.localeCompare(y.time) || x.inspector.localeCompare(y.inspector))) {
    const areas = days.get(a.date) ?? new Map<string, Appointment[]>();
    areas.set(a.area, [...(areas.get(a.area) ?? []), a]);
    days.set(a.date, areas);
  }
  return [...days].map(([date, areas]) => ({ date, areas: [...areas].map(([area, items]) => ({ area, items })) }));
}

function Row({ a, selected, busy, onSelect, onMove }: { a: Appointment; selected: boolean; busy: boolean; onSelect: (on: boolean) => void; onMove: (date: string, time: string) => void }) {
  const [moving, setMoving] = useState(false), [date, setDate] = useState(a.date), [time, setTime] = useState(a.time);
  const name = `${a.address || a.propertyId} at ${a.time} on ${dayLabel(a.date)}`;
  return <li data-appointment-id={a.id} aria-label={name} className="py-2">
    <div className="flex flex-wrap items-start gap-2">
      {a.status === 'draft'
        ? <label className="flex min-h-11 min-w-11 items-center justify-center"><input type="checkbox" className="size-5 accent-agency" checked={selected} disabled={busy} aria-label={`Select ${name}`} onChange={e => onSelect(e.target.checked)} /></label>
        : <span className="min-w-11" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className="break-words"><span className="font-medium tabular-nums">{a.time}</span> · {a.address || a.propertyId} · {a.inspector}
          <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] ${a.status === 'draft' ? 'bg-paper text-ink-muted' : 'bg-selected text-agency'}`}>{STATUS_LABEL[a.status]}</span></p>
        <p className="text-[13px] text-ink-secondary break-words">{a.reason}</p>
      </div>
      <button type="button" className={button} disabled={busy} aria-expanded={moving} aria-label={`Move ${name}`} onClick={() => setMoving(v => !v)}>Move</button>
    </div>
    {moving && <form className="mt-2 flex flex-wrap items-end gap-2 pl-13" onSubmit={e => { e.preventDefault(); onMove(date, time); setMoving(false); }}>
      <label className="flex flex-col text-[12px] text-ink-muted">New date<input type="date" required className={input} value={date} onChange={e => setDate(e.target.value)} /></label>
      <label className="flex flex-col text-[12px] text-ink-muted">New time<input type="time" required step={300} className={input} value={time} onChange={e => setTime(e.target.value)} /></label>
      <button type="submit" className={primary} disabled={busy}>Save move</button>
      <button type="button" className={button} onClick={() => setMoving(false)}>Cancel</button>
    </form>}
  </li>;
}

export function InspectionsPanel() {
  const { dispatch } = useStore();
  const [view, setView] = useState<InspectionsView | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set()), [planStart, setPlanStart] = useState(localToday);
  const load = useCallback(async () => { setView(readInspectionsView(await api('/api/inspections'))); }, []);
  useEffect(() => {
    let alive = true;
    void api('/api/inspections').then(v => { if (alive) setView(readInspectionsView(v)); })
      .catch(() => { if (alive) setMessage('Inspections could not be loaded. Saved plans are unchanged.'); });
    return () => { alive = false; };
  }, []);
  const change = async (path: string, body: unknown, done: string) => {
    setBusy(true); setMessage('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setSelected(new Set());
      await load();
      setMessage(done);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 409) { setMessage(`${(error as Error).message} The plan has been refreshed.`); await load().catch(() => {}); }
      else setMessage(status ? (error as Error).message : 'We could not confirm that change. Refresh to check before trying again.');
    } finally { setBusy(false); }
  };
  const importFile = async (file: File | undefined) => {
    if (!file || !view) return;
    await change('/api/inspections/history/import', { csv: await file.text(), expectedRevision: view.history.revision }, 'Inspection history imported.');
  };
  const askBud = () => view && dispatch({ type: 'stageAskContext', context: { id: crypto.randomUUID(), sourceKey: 'inspection-rules', title: 'Inspection rules',
    text: `Current inspection rules: ${rulesSummary(view.rules.rules)}.`, instruction: 'Help me change my inspection rules. Ask what should change, then propose the change for my approval.' } });

  if (!view) return message ? <p role="alert" className="text-sm text-hold">{message}</p> : <p role="status" className="text-sm text-ink-muted">Loading inspections…</p>;
  const draft = view.plan.draft, appointments = draft?.plan.appointments ?? [], holds = draft?.plan.holds ?? [];
  const pickable = appointments.filter(a => a.status === 'draft');
  const label = (id: string) => view.properties[id] ?? id;
  return <section aria-label="Inspections" className="space-y-3 text-sm">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="font-medium">Inspections</h4>
      <p className="rounded bg-hold/10 px-2 py-1 text-[12px] font-medium text-hold">Draft plan · not booked in Property Inspect</p>
    </div>
    {message && <p role="status" className="break-words">{message}</p>}

    <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line bg-paper p-2">
      <p className="min-w-0 flex-1 break-words text-ink-secondary"><span className="font-medium text-ink">Rules · </span>{rulesSummary(view.rules.rules)}</p>
      <button type="button" className={button} onClick={askBud}>Ask Bud to change</button>
    </div>

    <div className="flex flex-wrap items-end gap-2">
      <label className={`${button} inline-flex cursor-pointer items-center focus-within:outline-2 focus-within:outline-agency`}>
        Import history CSV
        <input type="file" accept=".csv,text/csv" className="sr-only" disabled={busy} onChange={e => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      <label className="flex flex-col text-[12px] text-ink-muted">Plan from<input type="date" className={input} value={planStart} onChange={e => setPlanStart(e.target.value)} /></label>
      <button type="button" className={primary} disabled={busy || !planStart} onClick={() => void change('/api/inspections/draft', { planStart }, 'Draft plan updated. Accepted and moved visits stayed where they were.')}>{draft ? 'Redraft plan' : 'Draft plan'}</button>
      {pickable.length > 0 && <button type="button" className={button} disabled={busy || !selected.size}
        onClick={() => void change('/api/inspections/accept', { ids: [...selected], expectedRevision: view.plan.revision }, `${selected.size} accepted into the plan.`)}>Accept selected ({selected.size})</button>}
    </div>
    <p className="text-[12px] text-ink-muted">CSV columns: property address or id, area, last completed date, last planned date, access notes.
      {view.history.lastImport ? ` Last import: ${view.history.lastImport.matched} matched, ${view.history.lastImport.unmatched} held.` : ` ${Object.keys(view.history.records).length} properties have history.`}</p>

    {view.history.unmatched.length > 0 && <div role="status" className="rounded-lg border border-hold/40 p-2">
      <p className="font-medium text-hold">Held from the last import · {view.history.unmatched.length}</p>
      <ul className="list-disc pl-5">{view.history.unmatched.map(u => <li key={u.row} className="break-words">Row {u.row} · {u.property || 'blank'} · {u.reason}</li>)}</ul>
      <p className="text-[12px] text-ink-muted">Fix these rows in the file and import again. RealBud never guesses which property a row means.</p>
    </div>}

    {!draft ? <p className="text-ink-secondary">{view.rules.rules.inspectors.length ? 'Import history, then draft a plan.' : 'Add inspectors to the rules (Ask Bud to change), then draft a plan.'}</p> : <>
      <p className="text-ink-secondary">Plan from {dayLabel(draft.planStart)} · {appointments.length} visits · {holds.length} held · {draft.plan.notDue.length} not due yet</p>
      {holds.length > 0 && <div aria-label="Held for you" role="group" className="rounded-lg border border-line p-2">
        <h5 className="font-medium">Held for you · {holds.length}</h5>
        <ul className="divide-y divide-line">{holds.map(h => <li key={h.propertyId} className="py-1.5 break-words"><span className="font-medium">{HOLD_LABEL[h.kind]}</span> · {label(h.propertyId)} · <span className="text-ink-secondary">{h.reason}</span></li>)}</ul>
      </div>}
      <ol aria-label="Draft plan by day" className="space-y-3">{groupPlan(appointments).map(day => <li key={day.date} className="rounded-lg border border-line bg-sheet p-2">
        <h5 className="font-medium">{dayLabel(day.date)}</h5>
        {day.areas.map(group => <div key={group.area} className="mt-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{group.area}</p>
          <ul className="divide-y divide-line">{group.items.map(a => <Row key={a.id} a={a} busy={busy} selected={selected.has(a.id)}
            onSelect={on => setSelected(s => { const next = new Set(s); if (on) next.add(a.id); else next.delete(a.id); return next; })}
            onMove={(date, time) => void change('/api/inspections/move', { id: a.id, date, time, expectedRevision: view.plan.revision }, 'Visit moved. It stays there when the plan is redrafted.')} />)}</ul>
        </div>)}
      </li>)}</ol>
    </>}
  </section>;
}

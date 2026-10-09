// W4 maintenance review (docs/SHERRY-WORKFLOWS-BUILD-PLAN-2026-10-02.md): saved
// reviewed bills + the supplier directory → computeMaintenanceFindings → a private
// findings store that notifies once per evidence version. "Alert Sherry" is the
// loop run itself: a run that records new or changed findings is left unseen, so
// Desk and Schedule show it for attention. Nothing is sent outside the app.
import { billSenderEnvelopeDigest, isForwardedBillSource, validateForwardedSenderReview } from './source-bill-rules.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { readPrivateJsonWithFallback, writePrivateJson } from './private-json.ts';
import { redactSecretsInText } from './redact.ts';
import { billDateInZone } from '../shared/bill-dates.ts';
import { mailAuthConfirms, mailAuthWords, parseMailAuth } from '../shared/mail-auth.ts';
import { matchSender, normalizeSupplierEmail, supplierEmailConflicts, type SupplierDirectory } from '../shared/supplier-directory.ts';
import type { SourceBillOccurrence } from '../shared/source-bills.ts';
import type { RoutineResult } from '../shared/routine-result.ts';
import type { Loop, LoopRun } from '../shared/contracts.ts';
import { computeMaintenanceFindings, newOrChanged, DEFAULT_WINDOW_RULE, type MaintenanceCoverage, type MaintenanceFinding,
  type MaintenanceInvoice, type MaintenanceWindowRule } from './maintenance-findings.ts';
import type { createSupplierDirectory } from './supplier-directory.ts';
import type { LoopExecuteResult } from './routines.ts';

export type FindingState = 'new' | 'seen' | 'dismissed';
export interface SavedFinding {
  finding: MaintenanceFinding;
  /** Evidence version Sherry was last alerted about. */
  notifiedVersion: string;
  state: FindingState;
  firstSeenAt: number; updatedAt: number;
  /** False once a later run no longer produces it (kept for history). */
  active: boolean;
}
export interface MaintenanceRunSummary {
  runId: string; finishedAt: number; checkedBills: number; alerts: number;
  coverage: MaintenanceCoverage; gaps: string[]; coverageKey: string;
}
export interface MaintenanceReviewState {
  version: 1; purpose: 'maintenance-review'; revision: number;
  rule: MaintenanceWindowRule; lastRun: MaintenanceRunSummary | null; findings: SavedFinding[];
  /** Replaced month rules, newest first, at most MAX_RULE_HISTORY. Absent in files saved before it existed. */
  ruleHistory?: Array<{ rule: MaintenanceWindowRule; replacedAt: number }>;
  /** Bumps only on a rule save, so a loop run or a finding decision never conflicts with a rule change. Absent (= 0) in older files. */
  ruleRevision?: number;
}

const MAX_BYTES = 8_000_000, MAX_FINDINGS = 5000, MAX_RULE_HISTORY = 10;
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function rule(v: unknown): v is MaintenanceWindowRule {
  return object(v) && exact(v, 'basis,span') && ['invoiceDate', 'receivedDate'].includes(String(v.basis)) && ['calendarMonth', 'rolling30'].includes(String(v.span));
}
export const isMaintenanceWindowRule = rule;
export const MAINTENANCE_RULE_MESSAGE = 'Choose invoice or received date, and calendar month or rolling 30 days.';

/** Throws on anything unexpected; a damaged file is kept and holds changes. */
export function readMaintenanceReview(v: unknown): MaintenanceReviewState {
  const bad = (): never => { throw new Error('Saved maintenance findings need recovery. Their file has been kept.'); };
  const keys = 'version,purpose,revision,rule,lastRun,findings';
  if (!object(v) || !exact(v, [keys, ...['ruleHistory', 'ruleRevision'].filter(k => k in v)].join(',')) || v.version !== 1 || v.purpose !== 'maintenance-review' ||
      !count(v.revision) || (v.ruleRevision !== undefined && !count(v.ruleRevision)) || !rule(v.rule) || !Array.isArray(v.findings) || v.findings.length > MAX_FINDINGS) return bad();
  if (v.ruleHistory !== undefined && (!Array.isArray(v.ruleHistory) || v.ruleHistory.length > MAX_RULE_HISTORY ||
      !v.ruleHistory.every(h => object(h) && exact(h, 'rule,replacedAt') && rule(h.rule) && count(h.replacedAt)))) return bad();
  const run = v.lastRun;
  if (run !== null && (!object(run) || !exact(run, 'runId,finishedAt,checkedBills,alerts,coverage,gaps,coverageKey') || typeof run.runId !== 'string' ||
      !count(run.finishedAt) || !count(run.checkedBills) || !count(run.alerts) || !hex(run.coverageKey) || !Array.isArray(run.gaps) ||
      !run.gaps.every(g => typeof g === 'string' && g.length <= 500) || !object(run.coverage) || !exact(run.coverage, 'from,to,complete') ||
      !day(run.coverage.from) || !day(run.coverage.to) || typeof run.coverage.complete !== 'boolean')) return bad();
  const ids = new Set<string>();
  // ponytail: the nested finding is only shape-checked at its identity fields; this
  // 0600 file is written by this module alone. Full validation if it is ever imported.
  for (const f of v.findings) {
    if (!object(f) || !exact(f, 'finding,notifiedVersion,state,firstSeenAt,updatedAt,active') || !object(f.finding) ||
        !hex(f.finding.id) || ids.has(String(f.finding.id)) || !hex(f.finding.evidenceVersion) || !hex(f.notifiedVersion) ||
        !['sender-verification', 'multiple-invoices'].includes(String(f.finding.kind)) || !Array.isArray(f.finding.invoices) ||
        !['new', 'seen', 'dismissed'].includes(String(f.state)) || !count(f.firstSeenAt) || !count(f.updatedAt) || typeof f.active !== 'boolean') return bad();
    ids.add(String(f.finding.id));
  }
  return structuredClone(v) as unknown as MaintenanceReviewState;
}

export function createMaintenanceReviewStore(options: { file?: string; now?: () => number } = {}) {
  const file = options.file ?? join(DATA_DIR, 'maintenance-review.json');
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const recovery = (): never => fail('Saved maintenance findings need recovery. Their file has been kept.', 503);
  const validate = (value: unknown) => { try { return readMaintenanceReview(value); } catch { return recovery(); } };
  const load = async (): Promise<MaintenanceReviewState> => {
    let raw: unknown;
    try { raw = await readPrivateJsonWithFallback(file, MAX_BYTES, validate); } catch { return recovery(); }
    return raw === undefined ? { version: 1, purpose: 'maintenance-review', revision: 0, ruleRevision: 0, rule: { ...DEFAULT_WINDOW_RULE }, lastRun: null, findings: [] } : validate(raw);
  };
  const save = async (state: MaintenanceReviewState) => {
    state.revision++;
    await writePrivateJson(file, state, { maxBytes: MAX_BYTES, validate, keepPrevious: true });
    return structuredClone(state);
  };
  const current = async (expectedRevision: unknown) => {
    if (!count(expectedRevision)) fail('Reload maintenance findings before changing them.', 400);
    const state = await load();
    if (state.revision !== expectedRevision) fail('Maintenance findings changed since you opened them. Reload and try again.', 409);
    return state;
  };
  return {
    read: () => serial(load),

    /** Saves one run's findings. Notify once: only a new finding or a changed
     * evidence version counts as an alert, and a changed one is shown again
     * even if it was seen or dismissed. */
    record: (input: { findings: MaintenanceFinding[]; run: Omit<MaintenanceRunSummary, 'alerts' | 'finishedAt'> }) => serial(async () => {
      const state = await load(), at = Math.max(0, now());
      const byId = new Map(state.findings.map(f => [f.finding.id, f]));
      const changed = new Set(newOrChanged(input.findings, new Map(state.findings.map(f => [f.finding.id, f.notifiedVersion]))).map(f => f.id));
      const live = new Set(input.findings.map(f => f.id));
      for (const saved of state.findings) if (!live.has(saved.finding.id)) saved.active = false;
      for (const finding of input.findings) {
        const saved = byId.get(finding.id);
        if (!saved) { state.findings.push({ finding, notifiedVersion: finding.evidenceVersion, state: 'new', firstSeenAt: at, updatedAt: at, active: true }); continue; }
        saved.active = true;
        if (changed.has(finding.id)) Object.assign(saved, { finding, notifiedVersion: finding.evidenceVersion, state: 'new', updatedAt: at });
        else saved.finding = finding; // same evidence; notes such as coverage may have changed
      }
      // ponytail: keeps the newest MAX_FINDINGS by dropping the oldest inactive first; archive if offices exceed it.
      if (state.findings.length > MAX_FINDINGS) {
        const drop = new Set(state.findings.filter(f => !f.active).sort((a, b) => a.updatedAt - b.updatedAt).slice(0, state.findings.length - MAX_FINDINGS).map(f => f.finding.id));
        state.findings = state.findings.filter(f => !drop.has(f.finding.id)).slice(-MAX_FINDINGS);
      }
      state.lastRun = { ...input.run, finishedAt: at, alerts: changed.size };
      return { state: await save(state), alerts: changed.size };
    }),

    decide: (input: { id: unknown; action: unknown; expectedRevision: unknown }) => serial(async () => {
      if (!hex(input.id) || !['seen', 'dismissed', 'new'].includes(String(input.action))) fail('Choose a finding and whether to mark it seen, dismiss it or restore it.', 400);
      const state = await current(input.expectedRevision);
      const saved = state.findings.find(f => f.finding.id === input.id);
      if (!saved) return fail('That finding is no longer saved. Reload and try again.', 404);
      saved.state = input.action as FindingState;
      saved.updatedAt = Math.max(0, now());
      return save(state);
    }),

    /** Sherry confirmed calendar month (5 Oct); invoice vs received date still open. Changing it starts new comparison windows on the next run. */
    setRule: (input: { rule: unknown; expectedRevision: unknown }) => serial(async () => {
      if (!rule(input.rule)) fail(MAINTENANCE_RULE_MESSAGE, 400);
      if (!count(input.expectedRevision)) fail('Reload the month rule before changing it.', 400);
      const state = await load();
      if ((state.ruleRevision ?? 0) !== input.expectedRevision) fail('The month rule changed since you opened it. Reload and try again.', 409);
      const next = { basis: (input.rule as MaintenanceWindowRule).basis, span: (input.rule as MaintenanceWindowRule).span };
      // The replaced rule is kept (newest first, bounded) so a change can be undone.
      if (next.basis !== state.rule.basis || next.span !== state.rule.span) state.ruleHistory = [{ rule: state.rule, replacedAt: Math.max(0, now()) }, ...(state.ruleHistory ?? [])].slice(0, MAX_RULE_HISTORY);
      state.rule = next;
      state.ruleRevision = (state.ruleRevision ?? 0) + 1;
      return save(state);
    }),
  };
}
export type MaintenanceReviewStore = ReturnType<typeof createMaintenanceReviewStore>;
type DirectoryStore = ReturnType<typeof createSupplierDirectory>;

const MAINTENANCE_KIND = /maint|repair|plumb|electric|trade|handyman|garden|pest|lock|roof|glaz|hot water|appliance/i;

/** Sender address from a From header ("Name <a@b>" or "a@b"). A header with
 * more than one angle address, or an address-looking display name, is
 * ambiguous: mail clients deliver from the last address while a naive parse
 * reads the first, so a spoofed display name could pass as a listed supplier.
 * Ambiguous headers return '' and stay unlisted (sender needs checking). */
export function senderAddress(from: string): string {
  const angles = from.match(/<[^<>]*>/g) ?? [];
  if (angles.length > 1) return '';
  if (angles.length === 1) {
    const display = from.slice(0, from.indexOf('<'));
    // A second address after the angle (e.g. "<a@b>, c@d") is ambiguous too.
    if (display.includes('@') || from.slice(from.indexOf('>') + 1).includes('@')) return '';
    return normalizeSupplierEmail(angles[0]!.slice(1, -1)) ?? '';
  }
  return normalizeSupplierEmail(from) ?? '';
}

/** Invoicing services that send on a supplier's behalf, by exact sender
 * domain → name shown. Their From address is the service, never the supplier,
 * so the supplier check uses the Reply-To address instead. */
export const INVOICE_RELAYS: ReadonlyMap<string, string> = new Map([['post.xero.com', 'Xero']]);

/** Reviewed, uncancelled bills that belong to maintenance, as findings input.
 * Supplier identity comes from the reviewed supplier reference or an exact
 * directory match, never from the vendor label or the email domain. A relayed
 * invoice is matched on its single Reply-To address (same parsing rules as
 * From); without one it stays unlisted. From and Reply-To can be forged, so a
 * directory match counts as listed only when Gmail's Authentication-Results
 * confirm the From domain (the relay's domain for a relayed invoice); otherwise
 * it is 'unverified' and still raises a sender finding. */
export function maintenanceInvoices(bills: SourceBillOccurrence[], directory: SupplierDirectory, timeZone: string): MaintenanceInvoice[] {
  const invoices: MaintenanceInvoice[] = [];
  for (const bill of bills) {
    if (bill.state === 'cancelled') continue;
    let message = bill.source.message, originalNote = '', originalVerified = false;
    if (bill.forwardedSenderReview) {
      try {
        validateForwardedSenderReview(bill.forwardedSenderReview, bill.source, bill.reviewedAt);
        if (billSenderEnvelopeDigest(bill.forwardedSenderReview.originalSource) !== bill.forwardedSenderReview.originalEnvelopeDigest) throw new Error('Changed original envelope');
        message = bill.forwardedSenderReview.originalSource.message; originalVerified = true;
        originalNote = `Staff linked the actual saved original message ${message.id} from the same Gmail account. Its saved envelope, not quoted body text, supplies this sender check.`;
      } catch { originalNote = 'Saved original sender evidence could not be checked. Keep the original sender qualified and review its source again.'; }
    }
    const unresolvedForward = isForwardedBillSource(bill.source) && !originalVerified;
    if (unresolvedForward && !originalNote) originalNote = 'Forwarded copy: no reviewed actual original saved-message envelope is attached. Quoted sender lines are unverified; check the actual original source.';
    const from = senderAddress(message.from), fromDomain = from.slice(from.lastIndexOf('@') + 1), relay = INVOICE_RELAYS.get(fromDomain);
    const email = relay ? senderAddress(message.replyTo ?? '') : from, match = matchSender(directory, email);
    const auth = parseMailAuth(message.authResults), confirmed = !!from && mailAuthConfirms(auth, fromDomain);
    const notes = [originalNote, !relay ? '' : email ? `Sent via ${relay} for ${email}.` : `Sent via ${relay} with no single Reply-To address, so the supplier could not be checked.`];
    // An unlisted sender is already a finding; the verification note matters when a match would be trusted.
    if (!confirmed && match.kind !== 'unlisted') notes.push(!message.authResults ? 'Sender not verified (mail authentication not available for this message).'
      : relay ? `Claims to be sent via ${relay} but ${relay}'s signature was not confirmed (${mailAuthWords(auth)}).`
      : `Mail server did not confirm this sender, so it could be forged (${mailAuthWords(auth)}).`);
    const senderNote = notes.filter(Boolean).join(' ') || undefined;
    const reviewed = bill.facts.supplierReference?.trim() || null;
    if (bill.facts.maintenanceClassification === 'not-maintenance') continue;
    const classificationNeeded = bill.facts.maintenanceClassification !== 'maintenance' && !reviewed && match.kind === 'unlisted' && !MAINTENANCE_KIND.test(`${bill.facts.kind} ${bill.facts.workDescription ?? ''}`);
    let supplierRef: string | null = reviewed, senderMatch: MaintenanceInvoice['senderMatch'] = 'unlisted';
    if (match.kind === 'listed') { supplierRef = reviewed ?? match.supplierRef; senderMatch = reviewed && reviewed !== match.supplierRef ? 'conflict' : confirmed ? 'listed' : 'unverified'; }
    if (match.kind === 'conflict') { supplierRef = reviewed && match.supplierRefs.includes(reviewed) ? reviewed : null; senderMatch = 'conflict'; }
    if (unresolvedForward) { supplierRef = reviewed; senderMatch = 'unverified'; }
    invoices.push({ senderEvidenceVersion: createHash('sha256').update(JSON.stringify([bill.source.digest, bill.forwardedSenderReview?.originalEnvelopeDigest ?? null, bill.facts.maintenanceClassification ?? 'unclassified'])).digest('hex'), ...(classificationNeeded ? { classificationNeeded: true } : {}), sourceId: bill.id, propertyId: bill.facts.propertyId, supplierRef, senderEmail: email || `unclear sender: ${redactSecretsInText(message.from).replace(/\s+/g, ' ').trim().slice(0, 200)}`, senderMatch, ...(senderNote ? { senderNote } : {}),
      invoiceNumber: bill.facts.invoiceNumber ?? null, invoiceVersion: bill.facts.invoiceVersion ?? null, invoiceDate: bill.facts.invoiceDate,
      receivedDate: billDateInZone(message.at, timeZone), amountCents: bill.facts.amountCents,
      description: (bill.facts.workDescription?.trim() || bill.facts.note.trim() || bill.facts.kind).slice(0, 500) });
  }
  return invoices;
}

const monthStart = (date: string, back: number) => { const [y, m] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10); };

/** Which mail the saved bills can speak for. Missing history is a limit, never "nothing found". */
export function maintenanceCoverage(weekly: RoutineResult | null, invoices: MaintenanceInvoice[], timeZone: string, today: string): { coverage: MaintenanceCoverage; gaps: string[] } {
  if (!weekly?.coverage) {
    const dates = invoices.map(i => i.receivedDate).sort();
    return { coverage: { from: dates[0] ?? today, to: dates.at(-1) ?? today, complete: false },
      gaps: ['No weekly bills review has checked the mailbox yet, so only bills already reviewed by hand were compared.'] };
  }
  const from = billDateInZone(weekly.coverage.startAt, timeZone), to = billDateInZone(weekly.coverage.endAt, timeZone);
  const gaps = [...weekly.gaps];
  if (weekly.coverage.uncovered.length) gaps.push('Some mail in the checked period has not been fully read yet.');
  if (weekly.status !== 'completed') gaps.push('Some bill candidates are still waiting for review, so they are not compared yet.');
  if (from > monthStart(today, 1)) gaps.push(`Mail before ${from} has not been checked, so last month may be incomplete.`);
  return { coverage: { from, to, complete: gaps.length === 0 }, gaps: gaps.map(g => redactSecretsInText(g).slice(0, 500)).slice(0, 50) };
}

export interface MaintenanceReviewDependencies {
  store: MaintenanceReviewStore; directory: DirectoryStore;
  bills: () => SourceBillOccurrence[]; weekly: () => RoutineResult | null;
  timeZone: () => Promise<string>; now?: () => number;
}

export async function runMaintenanceReview(run: LoopRun, deps: MaintenanceReviewDependencies): Promise<LoopExecuteResult> {
  const [state, directory, timeZone] = await Promise.all([deps.store.read(), deps.directory.read(), deps.timeZone()]);
  const today = billDateInZone((deps.now ?? Date.now)(), timeZone);
  const invoices = maintenanceInvoices(deps.bills(), directory, timeZone);
  const { coverage, gaps } = maintenanceCoverage(deps.weekly(), invoices, timeZone, today);
  const imported = directory.suppliers.length > 0;
  if (!imported) gaps.unshift('Import the supplier list to check senders. Sender checks were skipped.');
  const conflicts = supplierEmailConflicts(directory);
  for (const c of conflicts.slice(0, 10)) gaps.push(`Same email on two suppliers: ${c.supplierRefs.join(', ')}. Correct the supplier list.`);
  if (conflicts.length > 10) gaps.push(`${conflicts.length - 10} more email addresses belong to more than one supplier. Correct the supplier list.`);
  // An empty directory would make every sender "unlisted"; that is a missing input, not a finding.
  const findings = computeMaintenanceFindings({ invoices, coverage: { ...coverage, complete: coverage.complete && imported }, rule: state.rule })
    .filter(f => imported || f.kind !== 'sender-verification');
  const complete = coverage.complete && imported && !conflicts.length;
  const coverageKey = hash([coverage, gaps]);
  const quietBefore = state.lastRun?.coverageKey === coverageKey;
  const { state: saved, alerts } = await deps.store.record({ findings, run: { runId: run.id, checkedBills: invoices.length, coverage: { ...coverage, complete }, gaps, coverageKey } });
  const open = saved.findings.filter(f => f.active && f.state !== 'dismissed').length;
  const limit = complete ? '' : ` Check is partial: ${gaps[0] ?? `mail before ${coverage.from} was not checked.`}`;
  const detail = `${invoices.length} reviewed maintenance bills checked. ${open ? `${open} findings to review` : complete ? 'No findings' : 'No findings in the bills checked so far'}${alerts ? `, ${alerts} new or changed` : ''}. Open Bills to review.${limit}`.slice(0, 500);
  return { ok: true, status: !complete ? 'partial' : alerts ? 'awaiting-approval' : 'completed', detail, quiet: alerts === 0 && quietBefore };
}

export interface MaintenanceApiHost {
  store: MaintenanceReviewStore; directory: DirectoryStore;
  recovery: () => boolean;
  propertyLabel: (id: string) => string | undefined;
  bill: (id: string) => SourceBillOccurrence | undefined;
  loop: () => Loop | undefined;
}

/** Called only behind the desktop session check, like the bill routes. */
export function createMaintenanceReviewApi(host: MaintenanceApiHost) {
  return async (url: URL, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> => {
    const path = url.pathname;
    if (!/^\/api\/(?:supplier-directory|maintenance-review)(?:\/|$)/.test(path)) return null;
    if (method !== 'GET' && host.recovery()) fail('Recover the private book before changing maintenance checks.', 503);
    const input = object(body) ? body : {};
    if (path === '/api/supplier-directory' && method === 'GET') {
      const directory = await host.directory.read();
      return { status: 200, body: { directory, conflicts: supplierEmailConflicts(directory) } };
    }
    if (path === '/api/supplier-directory/import' && method === 'POST') {
      return { status: 200, body: await host.directory.importCsv({ csv: input.csv as string, expectedRevision: input.expectedRevision as number }) };
    }
    if (path === '/api/supplier-directory/aliases' && method === 'POST') {
      const directory = await host.directory.addAlias({ reference: String(input.reference ?? ''), email: input.email as string, expectedRevision: input.expectedRevision as number });
      return { status: 200, body: { directory, conflicts: supplierEmailConflicts(directory) } };
    }
    if (path === '/api/maintenance-review' && method === 'GET') {
      const [state, directory] = await Promise.all([host.store.read(), host.directory.read()]);
      const shown = state.findings.filter(f => f.active);
      const properties: Record<string, string> = {}, suppliers: Record<string, string> = {};
      const sources: Record<string, { subject: string; from: string; receivedAt: number }> = {};
      for (const { finding } of shown) {
        properties[finding.propertyId] ??= host.propertyLabel(finding.propertyId) ?? finding.propertyId;
        if (finding.supplierRef) suppliers[finding.supplierRef] ??= directory.suppliers.find(s => s.reference === finding.supplierRef)?.description ?? '';
        for (const id of finding.invoices.flatMap(i => i.sourceIds)) {
          const bill = sources[id] ? undefined : host.bill(id);
          if (bill) sources[id] = { subject: bill.source.message.subject.slice(0, 200), from: bill.source.message.from.slice(0, 200), receivedAt: bill.source.message.at };
        }
      }
      return { status: 200, body: { revision: state.revision, rule: state.rule, ruleRevision: state.ruleRevision ?? 0, ruleHistory: state.ruleHistory ?? [], lastRun: state.lastRun, findings: shown, properties, suppliers, sources,
        directory: { revision: directory.revision, suppliers: directory.suppliers.length, withoutEmail: directory.suppliers.filter(s => !s.emails.length).length,
          importedAt: directory.importedAt, conflicts: supplierEmailConflicts(directory) }, loop: host.loop() ?? null } };
    }
    if (path === '/api/maintenance-review/findings' && method === 'PATCH') {
      const state = await host.store.decide({ id: input.id, action: input.action, expectedRevision: input.expectedRevision });
      return { status: 200, body: { revision: state.revision } };
    }
    if (path === '/api/maintenance-review/rule' && method === 'PUT') {
      const state = await host.store.setRule({ rule: input.rule, expectedRevision: input.expectedRevision });
      return { status: 200, body: { revision: state.revision, rule: state.rule, ruleRevision: state.ruleRevision ?? 0 } };
    }
    return { status: 404, body: { error: 'Unknown maintenance check action.' } };
  };
}

import { createHash } from 'node:crypto';
import type { BillFacts, BillMailSource, BillSourceEvidence, BillOccurrenceVersion, SourceBillOccurrence, BillSeriesVersion, BillRecurrenceSeries, BillCalendarEntry, SourceBillState, BillDuplicateMatch, BillFinancialObservation, BillFinancialReview, BillPaymentTerms } from '../shared/source-bills.ts';
import { sameBillFacts } from '../shared/source-bills.ts';
import { validBillDate, addBillDays, anchoredBillMonth, billDateInZone } from '../shared/bill-dates.ts';

const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown, keys: string[]) => {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) return fail('Use the supported bill review fields.');
  return value;
};
const text = (value: unknown, max: number, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (!empty && !value.trim())) return fail('Use a valid plain-text bill label or review reason.');
  return value;
};
const date = (value: unknown): string => validBillDate(value) ? value : fail('Use a valid calendar date in YYYY-MM-DD format.');
const nullableDate = (value: unknown) => value === null ? null : date(value);
const positive = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : fail('Use the current saved revision.');
const at = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail('The source timestamp is invalid.');
const states: SourceBillState[] = ['received', 'in-process', 'hold', 'cancelled'];
const state = (value: unknown): SourceBillState => states.includes(value as SourceBillState) ? value as SourceBillState : fail('Choose received, in process, hold or cancelled. Payment confirmation is a separate workflow.');
const normalized = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase('en-AU');
const dateSpan = (from: unknown, to: unknown) => {
  const start = date(from), end = date(to);
  if (end < start || Date.parse(end) - Date.parse(start) > 550 * 86_400_000) return fail('Choose a calendar range of at most 550 days.');
  return { from: start, to: end };
};

/** The caller supplies this from its private, authenticated mail store. Never
 * pass source content from the HTTP body here. Receipt provenance is retained
 * separately from stable message identity/content, so rescans do not duplicate. */
export function previewBillSource(value: BillMailSource): BillSourceEvidence {
  if (!record(value) || !record(value.message)) return fail('Choose an available saved mail message.');
  const message = value.message;
  const accountId = text(value.accountId, 200), receiptId = text(value.receiptId, 200), threadId = text(value.threadId, 200);
  if (!Array.isArray(message.attachments) || message.attachments.length > 100) return fail('The attachment metadata is invalid.');
  const attachments = message.attachments.map(value => {
    const a = object(value, ['id', 'name', 'mimeType', 'size']);
    if (a.size !== null && (!Number.isSafeInteger(a.size) || Number(a.size) < 0)) return fail('The attachment metadata is invalid.');
    return { id: text(a.id, 512), name: text(a.name, 255, true), mimeType: text(a.mimeType, 120, true), size: a.size as number | null };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(attachments.map(a => a.id)).size !== attachments.length || (message.bodyTruncated !== undefined && typeof message.bodyTruncated !== 'boolean')) return fail('The saved message metadata needs review.');
  const canonical = { accountId, threadId, message: { id: text(message.id, 200), at: at(message.at),
    from: text(message.from, 2048, true), subject: text(message.subject, 2048, true), body: text(message.body, 12000, true),
    bodyTruncated: message.bodyTruncated ?? false, attachments } };
  // Reply-To and Authentication-Results are sender evidence for the maintenance supplier
  // check. They stay outside the digest so saved proposals replay and digests are unchanged.
  const replyTo = message.replyTo === undefined ? {} : { replyTo: text(message.replyTo, 2048) };
  const authResults = message.authResults === undefined ? {} : { authResults: text(message.authResults, 4096) };
  return { ...canonical, message: { ...canonical.message, ...replyTo, ...authResults }, receiptId, digest: hash(canonical), identity: hash([accountId, threadId, canonical.message.id]) };
}
function facts(value: unknown): BillFacts {
  const f = object(value, ['propertyId', 'kind', 'vendor', 'amountCents', 'currency', 'invoiceDate', 'dueDate', 'note', 'invoiceNumber', 'invoiceVersion', 'supplierReference', 'workDescription']);
  if (f.currency !== 'AUD') return fail('This bill workflow currently supports AUD. Confirm the source currency before accepting.');
  if (f.amountCents !== null && (!Number.isSafeInteger(f.amountCents) || Number(f.amountCents) < 0 || Number(f.amountCents) > 999_999_999_999)) return fail('Enter a non-negative bill amount in whole cents.');
  const result: BillFacts = { propertyId: text(f.propertyId, 200).trim(), kind: text(f.kind, 80).trim(), vendor: text(f.vendor, 160).trim(), amountCents: f.amountCents as number | null, currency: 'AUD',
    invoiceDate: nullableDate(f.invoiceDate), dueDate: nullableDate(f.dueDate), note: text(f.note, 1000, true).trim() };
  for (const [key, max] of [['invoiceNumber', 120], ['invoiceVersion', 80], ['supplierReference', 120], ['workDescription', 1000]] as const) {
    if (Object.hasOwn(f, key)) result[key] = f[key] === null ? null : text(f[key], max).trim();
  }
  if (result.invoiceVersion && !result.invoiceNumber) return fail('Confirm an invoice number before recording its version.');
  if (result.invoiceDate && result.dueDate && result.dueDate < result.invoiceDate) return fail('The due date precedes the invoice date. Resolve the source dates before accepting.');
  return result;
}
function reviewed(body: Record<string, unknown>, source: BillSourceEvidence) {
  if (body.expectedSourceDigest !== source.digest) return fail('This source changed. Reopen the saved message and review it again.', 409);
  if (body.sourceReviewed !== true) return fail('Confirm that you reviewed this message and the entered bill facts.');
  if ((source.message.bodyTruncated || source.message.attachments.length > 0) && body.limitedSourceAcknowledged !== true) return fail('Acknowledge that attachments and any truncated text need checking against the original.');
  return text(body.reviewReason, 1000).trim();
}
const versionOf = ({ id: _id, createdAt: _createdAt, history: _history, ...version }: SourceBillOccurrence): BillOccurrenceVersion => structuredClone(version);
const seriesVersion = ({ id: _id, occurrenceId: _occ, sourceOccurrenceRevision: _rev, sourceDigest: _digest, accountId: _account, propertyId: _property, kind: _kind, vendor: _vendor, createdAt: _at, history: _history, ...version }: BillRecurrenceSeries): BillSeriesVersion => structuredClone(version);
type Register = { version: 1; occurrences: SourceBillOccurrence[]; series: BillRecurrenceSeries[] };
const fresh = (): Register => ({ version: 1, occurrences: [], series: [] });
const recovery = (): never => fail('Saved source-linked bills need recovery. Changes are paused and existing records were preserved.', 503);
const sameBillKind = (a: Pick<BillFacts, 'propertyId' | 'kind' | 'vendor'>, b: Pick<BillRecurrenceSeries, 'propertyId' | 'kind' | 'vendor'>) => a.propertyId === b.propertyId && normalized(a.kind) === normalized(b.kind) && normalized(a.vendor) === normalized(b.vendor);
export const FINANCIAL_OBSERVATION_KEYS = ['provenance', 'sourceKind', 'sourceIds', 'locator', 'accountContext', 'observedAt', 'coverage', 'entry', 'payment', 'funding', 'advance', 'note'] as const;
export const FINANCIAL_STATUS_OPTIONS = {
  provenance: ['simulated', 'actual'], sourceKind: ['external-record', 'document', 'csv-status', 'unknown'], coverage: ['complete', 'partial', 'unknown'],
  entry: ['recorded', 'not-recorded', 'unknown'], payment: ['confirmed-paid', 'unpaid', 'arranged-unconfirmed', 'unknown'],
  funding: ['sufficient', 'insufficient', 'unknown'], advance: ['none', 'outstanding', 'recovered', 'unknown'],
} as const;
export function financialObservation(value: unknown): BillFinancialObservation {
  const v = object(value, [...FINANCIAL_OBSERVATION_KEYS]);
  if (Object.keys(v).length !== FINANCIAL_OBSERVATION_KEYS.length) return fail('Complete every financial observation field, using unknown when unsupported.');
  for (const [key, options] of Object.entries(FINANCIAL_STATUS_OPTIONS)) {
    if (!(options as readonly unknown[]).includes(v[key])) return fail('Choose a supported financial observation status.');
  }
  if (!Array.isArray(v.sourceIds) || v.sourceIds.length > 20) return fail('Use at most twenty supporting source identifiers.');
  const sourceIds = v.sourceIds.map(value => text(value, 200).trim());
  if (sourceIds.some(value => /[\r\n]/.test(value))) return fail('Use one supporting source identifier per entry.');
  if (new Set(sourceIds).size !== sourceIds.length) return fail('List each supporting source identifier once.');
  const result: BillFinancialObservation = {
    provenance: v.provenance as BillFinancialObservation['provenance'], sourceKind: v.sourceKind as BillFinancialObservation['sourceKind'],
    sourceIds, locator: text(v.locator, 1000, true).trim(), accountContext: text(v.accountContext, 200, true).trim(), observedAt: at(v.observedAt),
    coverage: v.coverage as BillFinancialObservation['coverage'], entry: v.entry as BillFinancialObservation['entry'], payment: v.payment as BillFinancialObservation['payment'],
    funding: v.funding as BillFinancialObservation['funding'], advance: v.advance as BillFinancialObservation['advance'], note: text(v.note, 1000, true).trim(),
  };
  if (!Number.isFinite(new Date(result.observedAt).getTime())) return fail('Use a valid financial observation date.');
  const claims = [result.entry, result.payment, result.funding, result.advance].some(value => value !== 'unknown');
  if (claims && (!sourceIds.length || !result.locator || !result.accountContext || result.coverage === 'unknown' || ['csv-status', 'unknown'].includes(result.sourceKind)))
    return fail('Keep financial statuses unknown without reviewed supporting sources, account context, location and known coverage. A CSV status is not financial confirmation.');
  if (result.entry !== 'unknown' && result.sourceKind !== 'external-record') return fail('An entry claim needs a reviewed external record; a document alone cannot confirm system entry.');
  if ((result.entry === 'not-recorded' || result.advance === 'none') && result.coverage !== 'complete')
    return fail('Absence of an entry or advance needs complete coverage of the reviewed scope; otherwise keep it unknown.');
  return result;
}
export function observationOf(review: BillFinancialReview): BillFinancialObservation {
  const { version: _version, basisBillRevision: _basis, sourceDigest: _source, reviewedAt: _at, reviewedBy: _by, reviewReason: _reason, ...observation } = review;
  return observation;
}
function validateFinancialReview(value: unknown, billRevision: number, reviewedAt: number) {
  const r = object(value, [...FINANCIAL_OBSERVATION_KEYS, 'version', 'basisBillRevision', 'sourceDigest', 'reviewedAt', 'reviewedBy', 'reviewReason']);
  if (Object.keys(r).length !== FINANCIAL_OBSERVATION_KEYS.length + 6 || r.version !== 1 || positive(r.basisBillRevision) >= billRevision ||
      typeof r.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(r.sourceDigest) || at(r.reviewedAt) > reviewedAt) return recovery();
  text(r.reviewedBy, 200); text(r.reviewReason, 1000);
  const observation = financialObservation(observationOf(r as unknown as BillFinancialReview));
  if (observation.observedAt > Number(r.reviewedAt)) recovery();
}
function pattern(value: Record<string, unknown>): Pick<BillSeriesVersion, 'intervalMonths' | 'anchorDate' | 'windowBeforeDays' | 'windowAfterDays' | 'timeZone'> {
  if (![1, 3, 12].includes(Number(value.intervalMonths)) || typeof value.intervalMonths !== 'number') return fail('Choose monthly, quarterly or yearly arrival.');
  for (const key of ['windowBeforeDays', 'windowAfterDays']) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 14) return fail('Use an arrival window of zero to fourteen days either side.');
  const timeZone = text(value.timeZone, 100);
  try { if (timeZone !== 'UTC' && !timeZone.includes('/')) throw new Error(); new Intl.DateTimeFormat('en', { timeZone }).format(0); } catch { return fail('Choose a valid office timezone.'); }
  return { intervalMonths: value.intervalMonths as 1 | 3 | 12, anchorDate: date(value.anchorDate), windowBeforeDays: Number(value.windowBeforeDays), windowAfterDays: Number(value.windowAfterDays), timeZone };
}
function validateVersion(value: unknown) {
  const v = object(value, ['revision', 'facts', 'state', 'source', 'seriesId', 'expectedArrivalDate', 'reviewedAt', 'reviewedBy', 'reviewReason', 'duplicateReview', 'financialReview']);
  positive(v.revision); facts(v.facts); state(v.state); at(v.reviewedAt); text(v.reviewedBy, 200); text(v.reviewReason, 1000);
  if (!record(v.source)) recovery();
  const storedSource = v.source as Record<string, unknown>;
  const source = previewBillSource(v.source as unknown as BillMailSource);
  if (source.digest !== storedSource.digest || source.identity !== storedSource.identity) recovery();
  if (v.seriesId !== null) text(v.seriesId, 100);
  nullableDate(v.expectedArrivalDate);
  if ((v.seriesId === null) !== (v.expectedArrivalDate === null)) recovery();
  if (Object.hasOwn(v, 'financialReview')) validateFinancialReview(v.financialReview, Number(v.revision), Number(v.reviewedAt));
  if (Object.hasOwn(v, 'duplicateReview')) {
    const review = object(v.duplicateReview, ['version', 'reviewDigest', 'candidates', 'reviewedAt', 'reviewedBy', 'reason']);
    if (Object.keys(review).length !== 6 || review.version !== 1 || typeof review.reviewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(review.reviewDigest) || !Array.isArray(review.candidates) || !review.candidates.length || review.candidates.length > 20) return recovery();
    if (at(review.reviewedAt) > Number(v.reviewedAt)) recovery();
    text(review.reviewedBy, 200); text(review.reason, 1000);
    const ids = new Set<string>();
    for (const candidate of review.candidates) {
      const c = object(candidate, ['billId', 'revision', 'matchedRevision', 'sourceDigest']);
      if (Object.keys(c).length !== 4 || typeof c.billId !== 'string' || !/^source-bill:[a-f0-9]{64}$/.test(c.billId) || ids.has(c.billId) || typeof c.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(c.sourceDigest)) return recovery();
      if (positive(c.matchedRevision) > positive(c.revision)) recovery();
      ids.add(c.billId);
    }
  }
}
/** Narrow candidate signal, never an instruction to merge or pay a bill. */
export function sameExactBillEvidence(a: Pick<BillOccurrenceVersion, 'source' | 'facts'>, b: Pick<BillOccurrenceVersion, 'source' | 'facts'>): boolean {
  if (a.source.accountId !== b.source.accountId || a.source.identity === b.source.identity || a.source.message.bodyTruncated || b.source.message.bodyTruncated || !a.source.message.body.trim() || a.source.message.body !== b.source.message.body) return false;
  if (a.facts.invoiceNumber && b.facts.invoiceNumber && a.facts.invoiceNumber !== b.facts.invoiceNumber) return false;
  const keys = ['propertyId', 'kind', 'vendor', 'amountCents', 'currency', 'invoiceDate', 'dueDate'] as const;
  return keys.every(key => a.facts[key] === b.facts[key]);
}
/** A reviewed number can surface a forward or PDF-only source. Vendor names
 * are only a candidate signal: never automatically merge either record. */
export function billEvidenceMatch(a: Pick<BillOccurrenceVersion, 'source' | 'facts'>, b: Pick<BillOccurrenceVersion, 'source' | 'facts'>): BillDuplicateMatch | null {
  if (a.source.accountId === b.source.accountId && a.source.identity !== b.source.identity &&
      a.facts.propertyId === b.facts.propertyId && normalized(a.facts.vendor) === normalized(b.facts.vendor) &&
      a.facts.invoiceNumber && a.facts.invoiceNumber === b.facts.invoiceNumber) {
    const keys = ['kind', 'amountCents', 'currency', 'invoiceDate', 'dueDate', 'invoiceVersion'] as const;
    return keys.some(key => (a.facts[key] ?? null) !== (b.facts[key] ?? null)) ? 'invoice-conflict' : 'invoice-identity';
  }
  return sameExactBillEvidence(a, b) ? 'exact-evidence' : null;
}
function validateSeriesVersion(value: unknown) {
  const v = object(value, ['revision', 'intervalMonths', 'anchorDate', 'windowBeforeDays', 'windowAfterDays', 'timeZone', 'active', 'reviewedAt', 'reviewedBy', 'reviewReason']);
  positive(v.revision); pattern(v); if (typeof v.active !== 'boolean') recovery();
  at(v.reviewedAt); text(v.reviewedBy, 200); text(v.reviewReason, 1000);
}
function validRegister(value: unknown): Register {
  try {
    const r = object(value, ['version', 'occurrences', 'series']);
    if (r.version !== 1 || !Array.isArray(r.occurrences) || r.occurrences.length > 500 || !Array.isArray(r.series) || r.series.length > 100) recovery();
    const rows = r.occurrences as SourceBillOccurrence[], series = r.series as BillRecurrenceSeries[];
    for (const row of rows) {
      object(row, ['id', 'createdAt', 'history', 'revision', 'facts', 'state', 'source', 'seriesId', 'expectedArrivalDate', 'reviewedAt', 'reviewedBy', 'reviewReason', 'duplicateReview', 'financialReview']);
      if (!/^source-bill:[a-f0-9]{64}$/.test(row.id)) recovery();
      at(row.createdAt); validateVersion(versionOf(row));
      if (!Array.isArray(row.history) || row.history.length > 50 || row.revision !== row.history.length + 1) recovery();
      row.history.forEach((v, index) => { validateVersion(v); if (v.revision !== index + 1) recovery(); });
      validateFinancialHistory(row);
      if (row.id !== `source-bill:${(row.history[0] ?? row).source.identity}`) recovery();
    }
    if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.source.identity)).size !== rows.length) recovery();
    for (const s of series) {
      object(s, ['id', 'occurrenceId', 'sourceOccurrenceRevision', 'sourceDigest', 'accountId', 'propertyId', 'kind', 'vendor', 'createdAt', 'history', 'revision', 'intervalMonths', 'anchorDate', 'windowBeforeDays', 'windowAfterDays', 'timeZone', 'active', 'reviewedAt', 'reviewedBy', 'reviewReason']);
      if (!/^bill-series:[a-f0-9-]{36}$/.test(s.id) || !rows.some(row => row.id === s.occurrenceId) || !/^[a-f0-9]{64}$/.test(s.sourceDigest)) recovery();
      positive(s.sourceOccurrenceRevision); at(s.createdAt); text(s.accountId, 200); text(s.propertyId, 200); text(s.kind, 80); text(s.vendor, 160);
      validateSeriesVersion(seriesVersion(s));
      if (!Array.isArray(s.history) || s.history.length > 50 || s.revision !== s.history.length + 1) recovery();
      s.history.forEach((v, index) => { validateSeriesVersion(v); if (v.revision !== index + 1) recovery(); });
    }
    if (new Set(series.map(s => s.id)).size !== series.length) recovery();
    const sourceOwners = new Map<string, string>();
    for (const row of rows) for (const version of [...row.history, row]) {
      if (sourceOwners.has(version.source.identity) && sourceOwners.get(version.source.identity) !== row.id) recovery();
      sourceOwners.set(version.source.identity, row.id);
      for (const ref of version.duplicateReview?.candidates ?? []) {
        const candidate = rows.find(other => other.id === ref.billId), versions = candidate && [...candidate.history, candidate];
        const head = versions?.find(v => v.revision === ref.revision), matched = versions?.find(v => v.revision === ref.matchedRevision);
        const match = matched && billEvidenceMatch(version, matched);
        if (!candidate || candidate.id === row.id || !head || head.state === 'cancelled' || !matched || matched.source.digest !== ref.sourceDigest || !match || match === 'invoice-conflict') recovery();
      }
    }
    for (const row of rows) if (row.seriesId && !series.some(s => s.id === row.seriesId)) recovery();
    return value as Register;
  } catch { return recovery(); }
}
/** Retained reviews must belong to a real immutable bill/source revision. */
export function validateFinancialHistory(row: SourceBillOccurrence) {
  const versions = [...row.history, row];
  for (const [index, v] of versions.entries()) {
    const previous = versions[index - 1];
    if (previous?.financialReview && !v.financialReview) recovery();
    if (!v.financialReview) continue;
    const review = v.financialReview, basis = versions.find(version => version.revision === review.basisBillRevision);
    if (!basis || basis.revision >= v.revision || basis.source.digest !== review.sourceDigest || basis.reviewedAt > review.reviewedAt) recovery();
    const first = versions.find(version => version.revision === review.basisBillRevision + 1);
    if (!first?.financialReview || hash(first.financialReview) !== hash(review)) recovery();
    if (!previous || !previous.financialReview || hash(previous.financialReview) !== hash(review)) {
      if (!previous || review.basisBillRevision !== previous.revision || review.reviewedAt !== v.reviewedAt || review.reviewedBy !== v.reviewedBy || review.reviewReason !== v.reviewReason ||
          v.source.digest !== previous.source.digest || !sameBillFacts(v.facts, previous.facts) || v.state !== previous.state || v.seriesId !== previous.seriesId || v.expectedArrivalDate !== previous.expectedArrivalDate) recovery();
    }
  }
}
/** Pure read validation for portable backup; never opens or changes a store. */
export const validateSourceBillRegister = validRegister;

const cadenceDate = (series: BillRecurrenceSeries, expected: string) => {
  const [y, m] = expected.split('-').map(Number), [ay, am] = series.anchorDate.split('-').map(Number);
  const months = (y - ay) * 12 + m - am;
  return months >= 0 && months % series.intervalMonths === 0 && anchoredBillMonth(series.anchorDate, months) === expected;
};
const byDate = (a: BillCalendarEntry, b: BillCalendarEntry) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
/** Due date plus, while the bill is received or in process and not marked
 * paid, a separately labelled payment forecast on that reviewed due date. */
export function projectBillEntries(row: SourceBillOccurrence, from: string, to: string): BillCalendarEntry[] {
  const due = row.facts.dueDate;
  if (row.state === 'cancelled' || !due || due < from || due > to) return [];
  const base = { date: due, endDate: due, propertyId: row.facts.propertyId, kind: row.facts.kind, vendor: row.facts.vendor, billId: row.id, seriesId: row.seriesId, state: row.state };
  const entries: BillCalendarEntry[] = [{ id: `due:${row.id}`, type: 'invoice-due', basis: 'human-reviewed-invoice-date', ...base }];
  // A paid claim suppresses the forecast even after a later correction makes it
  // stale; the bill's financial review asks for a fresh check instead.
  if ((row.state === 'received' || row.state === 'in-process') && row.financialReview?.payment !== 'confirmed-paid')
    entries.push({ id: `payment:${row.id}`, type: 'expected-payment', basis: 'reviewed-bill-due-date', ...base });
  return entries;
}
const MAX_PAYMENT_TERM_DAYS = 180;
/** Median days from arrival (in the pattern's timezone) to reviewed due date
 * across the pattern's current reviewed bills. Fewer than two: no forecast. */
export function patternPaymentTerms(series: BillRecurrenceSeries, rows: SourceBillOccurrence[]): BillPaymentTerms | null {
  const gaps = rows.filter(row => (row.id === series.occurrenceId || row.seriesId === series.id) && row.state !== 'cancelled' && row.facts.dueDate && sameBillKind(row.facts, series))
    .map(row => Math.round((Date.parse(`${row.facts.dueDate}T00:00:00Z`) - Date.parse(`${billDateInZone(row.source.message.at, series.timeZone)}T00:00:00Z`)) / 86_400_000))
    .filter(days => days >= 0 && days <= MAX_PAYMENT_TERM_DAYS).sort((a, b) => a - b);
  if (gaps.length < 2) return null;
  const mid = gaps.length >> 1;
  return { days: gaps.length % 2 ? gaps[mid]! : Math.round((gaps[mid - 1]! + gaps[mid]!) / 2), reviewedBills: gaps.length };
}
function seriesArrivals(series: BillRecurrenceSeries, from: string, to: string, occupied: (arrival: string) => boolean) {
  const arrivals: { arrival: string; start: string; end: string }[] = [];
  const [fy, fm] = from.split('-').map(Number), [ay, am] = series.anchorDate.split('-').map(Number);
  const first = Math.max(0, Math.floor(((fy - ay) * 12 + fm - am) / series.intervalMonths) - 1);
  for (let index = first; index < first + 24; index++) {
    const arrival = anchoredBillMonth(series.anchorDate, index * series.intervalMonths);
    const start = addBillDays(arrival, -series.windowBeforeDays), end = addBillDays(arrival, series.windowAfterDays);
    if (start > to) break;
    if (end < from || occupied(arrival)) continue;
    arrivals.push({ arrival, start, end });
  }
  return arrivals;
}
/** An active pattern's open arrival windows and, given two or more reviewed
 * bills, each window shifted by their usual terms. A received bill occupying
 * a period replaces both with its own due date and forecast. */
export function projectSeriesCalendar(series: BillRecurrenceSeries, rows: SourceBillOccurrence[], from: string, to: string, occupied: (arrival: string) => boolean): BillCalendarEntry[] {
  dateSpan(from, to);
  if (!series.active) return [];
  const base = { propertyId: series.propertyId, kind: series.kind, vendor: series.vendor, billId: null, seriesId: series.id, state: 'predicted' as const };
  const entries: BillCalendarEntry[] = seriesArrivals(series, from, to, occupied).map(({ arrival, start, end }) =>
    ({ id: `arrival:${series.id}:${arrival}`, type: 'expected-arrival', date: start, endDate: end, basis: 'approved-arrival-pattern', ...base }));
  const terms = patternPaymentTerms(series, rows);
  if (terms) for (const { arrival, start, end } of seriesArrivals(series, addBillDays(from, -terms.days), addBillDays(to, -terms.days), occupied)) {
    entries.push({ id: `payment:${series.id}:${arrival}`, type: 'expected-payment', date: addBillDays(start, terms.days), endDate: addBillDays(end, terms.days),
      basis: 'approved-pattern-payment-terms', paymentTerms: terms, ...base });
  }
  return entries.sort(byDate);
}
export function projectBillCalendar(register: Pick<Register, 'occurrences' | 'series'>, from: string, to: string): BillCalendarEntry[] {
  dateSpan(from, to);
  const entries = register.occurrences.flatMap(row => projectBillEntries(row, from, to));
  for (const series of register.series) entries.push(...projectSeriesCalendar(series, register.occurrences, from, to, arrival => register.occurrences.some(row =>
    row.state !== 'cancelled' && ((row.id === series.occurrenceId && arrival === series.anchorDate) || (row.seriesId === series.id && row.expectedArrivalDate === arrival)))));
  return entries.sort(byDate);
}


export { fail, hash, record, object, text, date, nullableDate, positive, at, state, normalized, dateSpan, facts, reviewed, versionOf, seriesVersion, fresh, recovery, sameBillKind, pattern, validateVersion, validateSeriesVersion, validRegister, cadenceDate };
export type { Register };

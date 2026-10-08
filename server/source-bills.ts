import { randomUUID } from 'node:crypto';
import type { BillFacts, BillMailSource, BillSourceEvidence, SourceBillOccurrence, BillRecurrenceSeries, SourceBillsSnapshot, SourceBillPageQuery, SourceBillPage, SourceBillCalendarQuery, SourceBillCalendarPage, SourceBillPatternQuery, BillCalendarEntry, BillDuplicateCheck, BillDuplicateCandidate, BillDuplicateReference, BillDuplicateReview } from '../shared/source-bills.ts';
import { sameBillFacts } from '../shared/source-bills.ts';
import { addBillDays, billDateInZone } from '../shared/bill-dates.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { DATA_DIR } from './config.ts';
import { listExpectedBills, type ExpectedBill } from './expected-bills.ts';
import type { JevAnswer, JevQuestion, JevRequest, JevResult } from './jev-client.ts';
import { SourceBillStorage } from './source-bill-storage.ts';
import { fail, hash, object, text, date, positive, state, dateSpan, facts, reviewed, versionOf, seriesVersion, sameBillKind, pattern, cadenceDate, previewBillSource, projectBillCalendar, projectBillEntries, projectSeriesCalendar, billEvidenceMatch, financialObservation, observationOf } from './source-bill-rules.ts';
export { previewBillSource, projectBillCalendar, validateSourceBillRegister } from './source-bill-rules.ts';

type HeadKind = 'bill-occurrence' | 'bill-series';
interface Cursor { v: 1; kind: HeadKind | 'calendar'; propertyId: string | null; high: number; before: number; seriesHigh: number; phase: HeadKind; offset: number; revision: number | null; from: string | null; to: string | null }
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
const duplicateHold = (message: string): never => { throw Object.assign(new Error(message), { status: 409, code: 'bill_duplicate_review_required' }); };
export class SourceBillRegister {
  private readonly storage: SourceBillStorage;
  private readonly db: WorkflowDatabase;
  private readonly options: { dataDir?: string; now?: () => number };
  constructor(db: WorkflowDatabase, options: { dataDir?: string; now?: () => number } = {}) { this.db = db; this.options = options; this.storage = new SourceBillStorage(db); }
  private change<T>(work: () => T): T { listExpectedBills(this.options.dataDir ?? DATA_DIR); return this.storage.run(work); }
  counts() { return this.change(() => this.storage.counts()); }
  getOccurrence(id: string) { return this.change(() => this.storage.occurrence(id)); }
  getSeries(id: string) { return this.change(() => this.storage.series(id)); }
  findBySourceIdentity(identity: string) {
    if (!/^[a-f0-9]{64}$/.test(identity)) return fail('Choose a saved source identity.');
    return this.change(() => this.storage.byIdentity(identity));
  }
  getSeriesForOccurrence(id: string) { return this.change(() => this.storage.byOrigin(id)); }
  matchingSeries(query: SourceBillPatternQuery): BillRecurrenceSeries[] {
    const input = { accountId: text(query.accountId, 200), propertyId: text(query.propertyId, 200).trim(), kind: text(query.kind, 80).trim(), vendor: text(query.vendor, 160).trim() };
    if (query.includeSeriesId !== undefined) text(query.includeSeriesId, 100);
    return this.change(() => {
      const active = this.storage.activePattern(input), linked = query.includeSeriesId ? this.storage.series(query.includeSeriesId) : undefined;
      return [active, linked].filter((s, i, all): s is BillRecurrenceSeries => !!s && s.accountId === input.accountId && sameBillKind(input, s) && all.findIndex(other => other?.id === s.id) === i);
    });
  }
  private cursor(kind: Cursor['kind'], query: SourceBillPageQuery & { from?: string; to?: string }): { cursor: Cursor; limit: number; snapshot: Cursor } {
    const propertyId = query.propertyId === undefined ? null : text(query.propertyId, 200).trim(), limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return fail('Choose a page size between 1 and 200.');
    let cursor: Cursor;
    if (query.cursor !== undefined) {
      try {
        if (typeof query.cursor !== 'string' || query.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Cursor;
        object(cursor, ['v', 'kind', 'propertyId', 'high', 'before', 'seriesHigh', 'phase', 'offset', 'revision', 'from', 'to']);
        if (cursor.v !== 1 || cursor.kind !== kind || cursor.propertyId !== propertyId || cursor.from !== (query.from ?? null) || cursor.to !== (query.to ?? null)) throw new Error();
        if (![cursor.high, cursor.before, cursor.seriesHigh].every(n => Number.isSafeInteger(n) && n >= 1) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 48) throw new Error();
        if (!['bill-occurrence', 'bill-series'].includes(cursor.phase) || cursor.before > (cursor.phase === 'bill-series' ? cursor.seriesHigh : cursor.high)) throw new Error();
        if (kind !== 'calendar' && (cursor.phase !== kind || cursor.before > cursor.high || cursor.offset !== 0 || cursor.revision !== null)) throw new Error();
        if (kind === 'calendar' && (!Number.isSafeInteger(cursor.revision) || Number(cursor.revision) < 0)) throw new Error();
      } catch { return fail('This bill page is invalid or belongs to another view. Refresh the view.'); }
      if (kind === 'calendar' && cursor.revision !== this.storage.counts().revision) return fail('Bills or arrival patterns changed. Refresh the calendar before loading more.', 409);
    } else {
      const high = this.db.highWatermark(kind === 'calendar' ? 'bill-occurrence' : kind), seriesHigh = this.db.highWatermark('bill-series');
      cursor = { v: 1, kind, propertyId, high, before: high, seriesHigh, phase: kind === 'calendar' ? 'bill-occurrence' : kind, offset: 0, revision: kind === 'calendar' ? this.storage.counts().revision : null, from: query.from ?? null, to: query.to ?? null };
    }
    return { cursor, limit, snapshot: { ...cursor, before: cursor.high, phase: kind === 'calendar' ? 'bill-occurrence' : kind, offset: 0 } };
  }
  private page<T extends SourceBillOccurrence | BillRecurrenceSeries>(kind: HeadKind, query: SourceBillPageQuery): SourceBillPage<T> {
    return this.change(() => {
      const { cursor, limit, snapshot } = this.cursor(kind, query);
      const batch = this.db.page<T>(kind, { before: cursor.before, limit: 200 });
      const items: T[] = []; let next: number | null = batch.next;
      for (let i = 0; i < batch.records.length; i++) {
        const row = batch.records[i]!.value, propertyId = 'facts' in row ? row.facts.propertyId : row.propertyId;
        if (!cursor.propertyId || propertyId === cursor.propertyId) items.push(row);
        if (items.length === limit) { next = i + 1 < batch.records.length || batch.next ? batch.sequences[i]! : null; break; }
      }
      return { items, nextCursor: next ? encode({ ...cursor, before: next }) : null, snapshotCursor: encode(snapshot), total: this.storage.total(kind, cursor.propertyId ?? undefined, cursor.high), revision: this.storage.counts().revision };
    });
  }
  occurrencePage(query: SourceBillPageQuery = {}): SourceBillPage<SourceBillOccurrence> { return this.page('bill-occurrence', query); }
  seriesPage(query: SourceBillPageQuery = {}): SourceBillPage<BillRecurrenceSeries> { return this.page('bill-series', query); }
  calendarPage(query: SourceBillCalendarQuery): SourceBillCalendarPage {
    dateSpan(query.from, query.to);
    return this.change(() => {
      const { cursor, limit } = this.cursor('calendar', query), items: BillCalendarEntry[] = [];
      let remaining = 200, next: Cursor | null = { ...cursor };
      while (next && remaining > 0 && items.length < limit) {
        const current: Cursor = next;
        const page = this.db.page<SourceBillOccurrence | BillRecurrenceSeries>(current.phase, { before: current.before, limit: Math.min(remaining, 200) });
        let cut = false;
        for (let i = 0; i < page.records.length; i++) {
          const row = page.records[i]!.value, seq = page.sequences[i]!; remaining--;
          const propertyId = 'facts' in row ? row.facts.propertyId : row.propertyId;
          let entries: BillCalendarEntry[] = [];
          if (!current.propertyId || propertyId === current.propertyId) {
            if ('facts' in row) entries = projectBillEntries(row, query.from, query.to);
            else if (row.active) entries = projectSeriesCalendar(row, this.storage.patternOccurrences(row), query.from, query.to, arrival => !!this.storage.occupied(row.id, arrival));
          }
          // Offset is within this one series's bounded range projection (at most 24 arrivals and 24 payment forecasts), never across a full lifetime list.
          const offset = i === 0 ? current.offset : 0;
          const available = entries.slice(offset), take = Math.min(limit - items.length, available.length);
          items.push(...available.slice(0, take));
          if (take < available.length) { next = { ...current, before: seq + 1, offset: offset + take }; cut = true; break; }
          if (items.length === limit || remaining === 0) {
            next = i + 1 < page.records.length || page.next ? { ...current, before: seq, offset: 0 } : current.phase === 'bill-occurrence' ? { ...current, phase: 'bill-series', before: current.seriesHigh, offset: 0 } : null;
            cut = true; break;
          }
        }
        if (!cut) next = page.next ? { ...current, before: page.next, offset: 0 } : current.phase === 'bill-occurrence' ? { ...current, phase: 'bill-series', before: current.seriesHigh, offset: 0 } : null;
      }
      return { items: items.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), nextCursor: next ? encode(next) : null, revision: this.storage.counts().revision };
    });
  }
  /** Complete compatibility projection. HTTP/UI consumers use bounded pages. */
  snapshot(range: { from: string; to: string }): SourceBillsSnapshot {
    return this.change(() => {
      const occurrences: SourceBillOccurrence[] = [], series: BillRecurrenceSeries[] = [];
      let cursor: string | undefined;
      do { const page = this.occurrencePage({ cursor, limit: 200 }); occurrences.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
      do { const page = this.seriesPage({ cursor, limit: 200 }); series.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
      return { version: 1, revision: this.storage.counts().revision, occurrences: occurrences.sort((a, b) => b.reviewedAt - a.reviewedAt), series, calendar: projectBillCalendar({ occurrences, series }, range.from, range.to) };
    });
  }
  expectedRows(): ExpectedBill[] {
    return this.change(() => {
    const rows: ExpectedBill[] = []; let cursor: string | undefined;
    do {
      const page = this.occurrencePage({ cursor, limit: 200 });
      rows.push(...page.items.map(row => ({ id: row.id, propertyId: row.facts.propertyId, kind: row.facts.kind, status: row.state,
        windowStartAt: null, windowEndAt: null, amountCents: row.facts.amountCents, note: row.facts.note,
        sourceRef: `mail:${row.source.accountId}:${row.source.threadId}:${row.source.message.id}`, createdAt: row.createdAt, updatedAt: row.reviewedAt,
        dueDate: row.facts.dueDate, vendor: row.facts.vendor, revision: row.revision, sourceKind: 'mail-reviewed' as const })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return rows;
    });
  }
  private assignment(body: Record<string, unknown>, billFacts: BillFacts, source: BillSourceEvidence, current?: SourceBillOccurrence) {
    const seriesId = body.seriesId === undefined || body.seriesId === null ? null : text(body.seriesId, 100);
    const expectedArrivalDate = body.expectedArrivalDate === undefined || body.expectedArrivalDate === null ? null : date(body.expectedArrivalDate);
    if ((seriesId === null) !== (expectedArrivalDate === null)) return fail('Choose both the recurring pattern and its expected arrival date, or neither.');
    if (seriesId) {
      const series = this.storage.series(seriesId), retained = current?.seriesId === seriesId && current.expectedArrivalDate === expectedArrivalDate;
      if (!series || (!series.active && !retained) || !sameBillKind(billFacts, series) || series.accountId !== source.accountId || !cadenceDate(series, expectedArrivalDate!)) return fail('This bill does not match an active approved arrival pattern.', 409);
      const occupied = this.storage.occupied(seriesId, expectedArrivalDate!);
      if (occupied && occupied !== current?.id) return fail('That arrival already has a received bill. Correct the saved bill instead of creating another.', 409);
    }
    return { seriesId, expectedArrivalDate };
  }
  /** Called inside the existing register transaction. Only this candidate
   * scan is bounded-memory: storage admission has its own graph validation. */
  private duplicates(source: BillSourceEvidence, billFacts: BillFacts, current?: SourceBillOccurrence): BillDuplicateCheck {
    const candidates: BillDuplicateCandidate[] = [];
    let before: number | undefined, complete = true;
    if (billFacts.invoiceNumber || source.message.body.trim() && !source.message.bodyTruncated) do {
      const page = this.db.page<SourceBillOccurrence>('bill-occurrence', { before, limit: 200 });
      for (const { value: row } of page.records) {
        // Cancellation deliberately releases the cross-message hold. Retained
        // aliases still prevent accepting the same cancelled message again.
        if (row.id === current?.id || row.state === 'cancelled') continue;
        const matched = [row, ...row.history.slice().reverse()].find(version => billEvidenceMatch({ source, facts: billFacts }, version));
        if (!matched) continue;
        if (candidates.length === 20) { complete = false; break; }
        candidates.push({ billId: row.id, revision: row.revision, matchedRevision: matched.revision, sourceDigest: matched.source.digest,
          facts: structuredClone(matched.facts), subject: matched.source.message.subject, receivedAt: matched.source.message.at,
          match: billEvidenceMatch({ source, facts: billFacts }, matched)! });
      }
      before = page.next ?? undefined;
    } while (before && complete);
    candidates.sort((a, b) => a.billId.localeCompare(b.billId));
    const references = candidates.map(({ billId, revision, matchedRevision, sourceDigest }) => ({ billId, revision, matchedRevision, sourceDigest }));
    return { version: 1, sourceDigest: source.digest, candidates, complete,
      reviewDigest: complete ? hash({ version: 1, sourceDigest: source.digest, facts: billFacts, target: current ? { id: current.id, revision: current.revision } : null, candidates: references }) : null };
  }
  duplicateCandidates(body: unknown, trustedSource: BillMailSource): BillDuplicateCheck {
    const input = object(body, ['expectedSourceDigest', 'facts', 'billId']), source = previewBillSource(trustedSource), billFacts = facts(input.facts);
    if (input.expectedSourceDigest !== source.digest) return fail('This source changed. Reopen the saved message and review it again.', 409);
    if (input.billId !== undefined && (typeof input.billId !== 'string' || !/^source-bill:[a-f0-9]{64}$/.test(input.billId))) return fail('Choose the saved bill being corrected.');
    return this.change(() => {
      const current = input.billId === undefined ? undefined : this.storage.occurrence(input.billId as string);
      if (input.billId !== undefined && !current) return fail('That saved bill is unavailable.', 404);
      if (current && source.accountId !== current.source.accountId) return fail('A correction must stay within the original source account.', 409);
      return this.duplicates(source, billFacts, current);
    });
  }
  private reviewDuplicates(input: Record<string, unknown>, source: BillSourceEvidence, billFacts: BillFacts, reason: string, actor: string, at: number, current?: SourceBillOccurrence): BillDuplicateReview | undefined {
    const check = this.duplicates(source, billFacts, current);
    if (!check.complete) return duplicateHold('More than twenty possible duplicate bills need review. Reconcile the existing records before accepting another.');
    if (check.candidates.some(candidate => candidate.match === 'invoice-conflict')) return duplicateHold('This invoice number has conflicting versions or bill facts. Review and correct the existing bill, or resolve its invoice identity before saving a separate bill.');
    if (Object.hasOwn(input, 'duplicateReview')) {
      const confirmation = object(input.duplicateReview, ['reviewDigest']);
      if (Object.keys(confirmation).length !== 1 || typeof confirmation.reviewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation.reviewDigest)) return fail('Use the current duplicate review confirmation.');
      if (!check.candidates.length || confirmation.reviewDigest !== check.reviewDigest) return duplicateHold('The duplicate review changed. Check the current candidates and confirm again.');
      const candidates: BillDuplicateReference[] = check.candidates.map(({ billId, revision, matchedRevision, sourceDigest }) => ({ billId, revision, matchedRevision, sourceDigest }));
      return { version: 1, reviewDigest: confirmation.reviewDigest, candidates, reviewedAt: at, reviewedBy: actor, reason };
    }
    if (check.candidates.length) return duplicateHold('This source has a possible duplicate bill. Review the matching saved records and explicitly confirm a separate invoice before accepting it.');
    return undefined;
  }
  accept(body: unknown, trustedSource: BillMailSource, actorId: string): SourceBillOccurrence {
    const input = object(body, ['expectedSourceDigest', 'sourceReviewed', 'limitedSourceAcknowledged', 'facts', 'reviewReason', 'seriesId', 'expectedArrivalDate', 'duplicateReview']);
    const source = previewBillSource(trustedSource), reviewedFacts = facts(input.facts), reason = reviewed(input, source), actor = text(actorId, 200);
    return this.change(() => {
      const duplicate = this.storage.byIdentity(source.identity);
      if (duplicate) {
        if (duplicate.source.digest === source.digest && sameBillFacts(duplicate.facts, reviewedFacts) && duplicate.seriesId === (input.seriesId ?? null) && duplicate.expectedArrivalDate === (input.expectedArrivalDate ?? null)) return duplicate;
        return fail('This message already has a bill review. Open it and make an explicit correction.', 409);
      }
      const now = (this.options.now ?? Date.now)(), link = this.assignment(input, reviewedFacts, source);
      const duplicateReview = this.reviewDuplicates(input, source, reviewedFacts, reason, actor, now);
      const row: SourceBillOccurrence = { id: `source-bill:${source.identity}`, revision: 1, createdAt: now, facts: reviewedFacts, state: 'received', source,
        ...link, reviewedAt: now, reviewedBy: actor, reviewReason: reason, history: [], ...(duplicateReview ? { duplicateReview } : {}) };
      this.storage.saveOccurrence(row); return row;
    });
  }
  correct(id: string, body: unknown, trustedSource: BillMailSource, actorId: string): SourceBillOccurrence {
    const input = object(body, ['expectedRevision', 'expectedSourceDigest', 'sourceReviewed', 'limitedSourceAcknowledged', 'facts', 'reviewReason', 'state', 'seriesId', 'expectedArrivalDate', 'duplicateReview']);
    const source = previewBillSource(trustedSource), reviewedFacts = facts(input.facts), reason = reviewed(input, source), actor = text(actorId, 200), expectedRevision = positive(input.expectedRevision), nextState = state(input.state);
    return this.change(() => {
      const row = this.storage.occurrence(id);
      if (!row) return fail('That received bill is unavailable.', 404);
      if (row.revision !== expectedRevision) return fail('This bill changed. Refresh it before correcting the record.', 409);
      for (const key of ['invoiceNumber', 'invoiceVersion', 'supplierReference', 'workDescription'] as const) {
        if (row.facts[key] && !Object.hasOwn(input.facts as object, key)) return fail('Keep the reviewed invoice number, version, supplier reference and work description, or explicitly clear an uncertain value before saving.', 409);
      }
      const alias = this.storage.byIdentity(source.identity);
      if (alias && alias.id !== row.id) return fail('This message belongs to another saved bill. Reconcile those records first.', 409);
      if (source.accountId !== row.source.accountId) return fail('A correction must stay within the original source account.', 409);
      const founded = this.storage.byOrigin(id);
      if (founded?.active && (nextState === 'cancelled' || !sameBillKind(reviewedFacts, founded) || source.digest !== row.source.digest)) return fail('Pause the approved arrival pattern before changing its source or property, or cancelling its founding bill.', 409);
      if (row.history.length >= 50) return fail('This bill has reached its correction history limit. Preserve its history and contact support.', 409);
      const link = this.assignment({ seriesId: input.seriesId === undefined ? row.seriesId : input.seriesId, expectedArrivalDate: input.expectedArrivalDate === undefined ? row.expectedArrivalDate : input.expectedArrivalDate }, reviewedFacts, source, row);
      const now = (this.options.now ?? Date.now)();
      const sameFacts = sameBillFacts(reviewedFacts, row.facts);
      const unchanged = source.digest === row.source.digest && sameFacts;
      // Staff can cancel or update the status of an unchanged bill without
      // another distinctness decision. Reactivation always checks afresh.
      const needsReview = nextState !== 'cancelled' && (!unchanged || row.state === 'cancelled');
      if (!needsReview && Object.hasOwn(input, 'duplicateReview')) return fail('This correction does not need a new duplicate review confirmation.');
      const duplicateReview = needsReview ? this.reviewDuplicates(input, source, reviewedFacts, reason, actor, now, row) : unchanged ? row.duplicateReview : undefined;
      row.history.push(versionOf(row));
      delete row.duplicateReview;
      Object.assign(row, { revision: row.revision + 1, facts: sameFacts ? row.facts : reviewedFacts, source, state: nextState, ...link, reviewedAt: now, reviewedBy: actor, reviewReason: reason, ...(duplicateReview ? { duplicateReview } : {}) });
      this.storage.saveOccurrence(row); return row;
    });
  }
  /** Explicit reviewer claims only. This does not call or verify an external
   * system, update invoice facts or authorize any financial operation. */
  reviewFinancial(id: string, body: unknown, actorId: string): SourceBillOccurrence {
    const input = object(body, ['expectedRevision', 'expectedSourceDigest', 'sourceReviewed', 'reviewReason', 'observation']);
    if (input.sourceReviewed !== true) return fail('Confirm that you reviewed the financial evidence and its scope.');
    const expectedRevision = positive(input.expectedRevision), observation = financialObservation(input.observation), reason = text(input.reviewReason, 1000).trim(), actor = text(actorId, 200);
    return this.change(() => {
      const row = this.storage.occurrence(id);
      if (!row) return fail('That received bill is unavailable.', 404);
      if (input.expectedSourceDigest !== row.source.digest) return fail('The bill source changed. Reopen the bill and review current evidence.', 409);
      const previous = row.financialReview;
      if (row.revision === expectedRevision + 1 && previous?.basisBillRevision === expectedRevision && previous.sourceDigest === input.expectedSourceDigest &&
          previous.reviewedBy === actor && previous.reviewReason === reason && hash(observationOf(previous)) === hash(observation)) return row;
      if (row.revision !== expectedRevision) return fail('This bill changed. Refresh it before reviewing financial evidence.', 409);
      if (row.state === 'cancelled') return fail('This bill is cancelled. Financial observations remain historical; review the current bill first.', 409);
      if (row.history.length >= 50) return fail('This bill has reached its correction history limit. Preserve its history and contact support.', 409);
      const now = (this.options.now ?? Date.now)();
      if (observation.observedAt > now) return fail('A financial observation cannot be dated in the future.');
      row.history.push(versionOf(row));
      Object.assign(row, { revision: row.revision + 1, reviewedAt: now, reviewedBy: actor, reviewReason: reason,
        financialReview: { ...observation, version: 1 as const, basisBillRevision: expectedRevision, sourceDigest: row.source.digest, reviewedAt: now, reviewedBy: actor, reviewReason: reason } });
      this.storage.saveOccurrence(row); return row;
    });
  }
  approveSeries(body: unknown, actorId: string): BillRecurrenceSeries {
    const input = object(body, ['occurrenceId', 'expectedOccurrenceRevision', 'intervalMonths', 'anchorDate', 'windowBeforeDays', 'windowAfterDays', 'timeZone', 'reviewReason']);
    const occurrenceId = text(input.occurrenceId, 100), expectedRevision = positive(input.expectedOccurrenceRevision), settings = pattern(input), reason = text(input.reviewReason, 1000).trim(), actor = text(actorId, 200);
    return this.change(() => {
      const row = this.storage.occurrence(occurrenceId);
      if (!row || row.state === 'cancelled') return fail('Choose a current received bill to confirm this arrival pattern.', 409);
      if (row.revision !== expectedRevision) return fail('The source bill changed. Review it before approving a pattern.', 409);
      const arrival = billDateInZone(row.source.message.at, settings.timeZone);
      if (arrival < addBillDays(settings.anchorDate, -settings.windowBeforeDays) || arrival > addBillDays(settings.anchorDate, settings.windowAfterDays)) return fail('The anchor window must include this source message’s actual arrival date. Choose the observed month and arrival window.');
      const previous = this.storage.byOrigin(occurrenceId);
      if (previous) {
        if (previous.sourceOccurrenceRevision === expectedRevision && previous.sourceDigest === row.source.digest && hash(pattern(previous as unknown as Record<string, unknown>)) === hash(settings) && previous.active) return previous;
        return fail('This bill already has a saved pattern. Revise that pattern explicitly.', 409);
      }
      if (this.storage.activePattern({accountId: row.source.accountId, ...row.facts})) return fail('An active arrival pattern already exists for this property, vendor and bill kind.', 409);
      const now = (this.options.now ?? Date.now)();
      const series: BillRecurrenceSeries = { id: `bill-series:${randomUUID()}`, revision: 1, occurrenceId, sourceOccurrenceRevision: row.revision, sourceDigest: row.source.digest,
        accountId: row.source.accountId, propertyId: row.facts.propertyId, kind: row.facts.kind, vendor: row.facts.vendor,
        ...settings, active: true, createdAt: now, reviewedAt: now, reviewedBy: actor, reviewReason: reason, history: [] };
      this.storage.saveSeries(series); return series;
    });
  }
  reviseSeries(id: string, body: unknown, actorId: string): BillRecurrenceSeries {
    const input = object(body, ['expectedRevision', 'intervalMonths', 'anchorDate', 'windowBeforeDays', 'windowAfterDays', 'timeZone', 'reviewReason', 'active']);
    const expectedRevision = positive(input.expectedRevision), settings = pattern(input), reason = text(input.reviewReason, 1000).trim(), actor = text(actorId, 200);
    if (typeof input.active !== 'boolean') return fail('Choose whether this approved pattern is active.');
    return this.change(() => {
      const series = this.storage.series(id);
      if (!series) return fail('That arrival pattern is unavailable.', 404);
      if (series.revision !== expectedRevision) return fail('This arrival pattern changed. Refresh before editing it.', 409);
      if ((settings.anchorDate !== series.anchorDate || settings.intervalMonths !== series.intervalMonths) && this.storage.hasLinkedOccurrences(id)) return fail('Received bills are linked to this pattern’s dates. Keep those dates, or pause this pattern and approve a replacement from a new received bill.', 409);
      const origin = this.storage.occurrence(series.occurrenceId)!;
      if (input.active && (origin.state === 'cancelled' || origin.source.digest !== series.sourceDigest || !sameBillKind(origin.facts, series))) return fail('The founding bill changed. Keep this pattern paused and review a new source bill.', 409);
      const arrival = billDateInZone(origin.source.message.at, settings.timeZone);
      if (input.active && (arrival < addBillDays(settings.anchorDate, -settings.windowBeforeDays) || arrival > addBillDays(settings.anchorDate, settings.windowAfterDays))) return fail('The anchor window must still include the founding message’s actual arrival date.');
      if (series.history.length >= 50) return fail('This pattern has reached its history retention limit.', 409);
      const activePattern = this.storage.activePattern(series);
      if (input.active && activePattern && activePattern.id !== id) return fail('Another active pattern already covers this property and bill kind.', 409);
      series.history.push(seriesVersion(series));
      Object.assign(series, settings, { active: input.active, revision: series.revision + 1, reviewedAt: (this.options.now ?? Date.now)(), reviewedBy: actor, reviewReason: reason });
      this.storage.saveSeries(series); return series;
    });
  }
}

const RANK_PAIRS_PER_CALL = 8, RANK_CALLS_IN_FLIGHT = 2;
/** Supplier, amount, dates, references and property code only: no note, work
 * description, subject, sender or message text, so no bank or tenant details. */
const rankState = (f: BillFacts) => ({ propertyId: f.propertyId, kind: f.kind, supplier: f.vendor, amountCents: f.amountCents, currency: f.currency,
  invoiceDate: f.invoiceDate, dueDate: f.dueDate, invoiceNumber: f.invoiceNumber ?? null, invoiceVersion: f.invoiceVersion ?? null, supplierReference: f.supplierReference ?? null });
/**
 * Orders duplicate candidates for the person reviewing them, most likely the
 * same bill first. Presentation only: the check's candidates, `complete` and
 * `reviewDigest` (sorted by bill id) are unchanged, so the
 * `bill_duplicate_review_required` hold stays exactly as deterministic.
 * Jev never raises, clears or skips a hold and never marks a duplicate.
 * Person-present only: call it when someone opens the review, never from an
 * unattended loop. One noul question per pair, up to 8 per call and 2 calls at
 * a time; any failure returns today's order with no labels.
 */
export async function rankDuplicateCandidates(check: BillDuplicateCheck, billFacts: BillFacts,
  decide: (request: JevRequest, options?: { signal?: AbortSignal }) => Promise<JevResult>, options: { signal?: AbortSignal } = {}): Promise<BillDuplicateCheck> {
  if (!check.candidates.length) return check;
  const groups: BillDuplicateCandidate[][] = [];
  for (let i = 0; i < check.candidates.length; i += RANK_PAIRS_PER_CALL) groups.push(check.candidates.slice(i, i + RANK_PAIRS_PER_CALL));
  const scores = new Map<string, number>();
  let next = 0, failed = false;
  const worker = async () => {
    while (next < groups.length && !failed) {
      const group = groups[next++]!;
      const questions = Object.fromEntries(group.map((_, n): [string, JevQuestion] => [`c${n}`, { type: 'noul',
        instructions: `Is candidate c${n} the same bill as "bill" in the state: the same invoice from the same supplier for the same charge, received or saved again? A repeat charge for another period with the same amount, or a matching invoice number from a different supplier, is a different bill.`,
        criteria: { true: 'The same bill.', false: 'A different bill, or not sure.' } }]));
      const state = { bill: rankState(billFacts), ...Object.fromEntries(group.map((candidate, n) => [`c${n}`, rankState(candidate.facts)])) };
      let answers: (JevAnswer | undefined)[] = [];
      try {
        const result = await decide({ state, questions }, { signal: options.signal });
        if (result.ok) answers = group.map((_, n) => result.answers[`c${n}`]);
      } catch { /* today's order */ }
      if (answers.length !== group.length || answers.some(answer => answer?.type !== 'noul')) { failed = true; return; }
      group.forEach((candidate, n) => scores.set(candidate.billId, (answers[n] as { noul: number }).noul));
    }
  };
  await Promise.all(Array.from({ length: Math.min(RANK_CALLS_IN_FLIGHT, groups.length) }, worker));
  if (failed || options.signal?.aborted || scores.size !== check.candidates.length) return check;
  const score = (candidate: BillDuplicateCandidate) => scores.get(candidate.billId)!;
  const likely = (p: number) => p >= 0.9 ? 'same' as const : p <= 0.1 ? 'different' as const : undefined;
  return { ...check, candidates: check.candidates.slice().sort((a, b) => score(b) - score(a)).map(candidate => {
    const label = likely(score(candidate));
    return label ? { ...candidate, likely: label } : candidate;
  }) };
}

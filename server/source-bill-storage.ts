import type { SourceBillOccurrence, BillRecurrenceSeries } from '../shared/source-bills.ts';
import { WorkflowDatabase, type WorkflowRecord } from './workflow-database.ts';
import { SOURCE_BILL_RECORD_KINDS, validateSourceBillRecord, validateSourceBillRecords, deriveBillLookups, aliasId, arrivalId, originId, patternId, patternKey, type SourceBillRecord, type SourceBillRecordKind, type BillMarker, type Alias, type ArrivalSlot, type PatternSlot, type Origin } from './source-bill-graph.ts';
import { validRegister, fresh, hash, recovery, fail } from './source-bill-rules.ts';

/** One transaction owns heads, permanent aliases and current reservations. No
 * cleartext property/source labels or custom SQLite tables are introduced. */
export class SourceBillStorage {
  private checkedToken?: string;
  private propertyCounts = new Map<string, { occurrences: number; series: number }>();
  readonly db: WorkflowDatabase;
  constructor(db: WorkflowDatabase) { this.db = db; }
  private allRecords(): SourceBillRecord[] {
    const rows: SourceBillRecord[] = [];
    for (const kind of SOURCE_BILL_RECORD_KINDS) {
      let before: number | undefined;
      do {
        const page = this.db.page(kind, { before, limit: 200 });
        rows.push(...page.records.map(row => ({ kind, ...row })));
        before = page.next ?? undefined;
        if (!page.next) break;
      } while (true);
    }
    return rows;
  }
  private countProperty(propertyId: string, key: 'occurrences' | 'series', change: number) {
    const counts = this.propertyCounts.get(propertyId) ?? { occurrences: 0, series: 0 };
    counts[key] += change; this.propertyCounts.set(propertyId, counts);
  }
  private ensure() {
    const token = this.db.changeToken();
    if (token === this.checkedToken) return;
    let rows = this.allRecords();
    validateSourceBillRecords(rows);
    const legacy = rows.find(r => r.kind === 'bill-register');
    if ((legacy?.value as { version?: number })?.version === 1) {
      const old = validRegister(legacy!.value);
      for (const row of old.occurrences) this.db.create('bill-occurrence', row.id, row, null);
      for (const row of old.series) this.db.create('bill-series', row.id, row, null);
      for (const [id, row] of deriveBillLookups(old.occurrences, old.series)) this.db.create(row.kind, id, row.value, null);
      const marker: BillMarker = { version: 2, migration: { sourceRevision: legacy!.revision, sourceDigest: hash(old), occurrences: old.occurrences.length, series: old.series.length }, counts: { occurrences: old.occurrences.length, series: old.series.length, activeSeries: old.series.filter(s => s.active).length } };
      this.db.update('bill-register', 'source-bills', legacy!.revision, () => marker);
      rows = this.allRecords();
      validateSourceBillRecords(rows);
    }
    this.propertyCounts.clear();
    for (const row of rows) {
      if (row.kind === 'bill-occurrence') this.countProperty((row.value as SourceBillOccurrence).facts.propertyId, 'occurrences', 1);
      if (row.kind === 'bill-series') this.countProperty((row.value as BillRecurrenceSeries).propertyId, 'series', 1);
    }
    this.checkedToken = this.db.changeToken();
  }
  run<T>(operation: () => T): T {
    try {
      return this.db.transaction(() => {
        this.ensure(); const result = operation();
        // Capture while the write lock is still held. An external commit after
        // COMMIT must invalidate this token instead of being blessed unread.
        this.checkedToken = this.db.changeToken(); return result;
      });
    } catch (error) { this.checkedToken = undefined; throw error; }
  }
  get<T>(kind: SourceBillRecordKind, id: string): WorkflowRecord<T> | undefined {
    const row = this.db.get<T>(kind, id);
    if (row) validateSourceBillRecord(kind, row.id, row.revision, row.value);
    return row;
  }
  private put<T>(kind: SourceBillRecordKind, id: string, value: T) {
    const old = this.get<T>(kind, id);
    validateSourceBillRecord(kind, id, old ? old.revision + 1 : 1, value);
    return old ? this.db.update(kind, id, old.revision, () => value) : this.db.create(kind, id, value, null);
  }
  marker(): WorkflowRecord<BillMarker> | undefined { return this.get('bill-register', 'source-bills'); }
  counts() { const marker = this.marker(); return { revision: marker?.revision ?? 0, ...(marker?.value.counts ?? { occurrences: 0, series: 0, activeSeries: 0 }) }; }
  total(kind: 'bill-occurrence' | 'bill-series', propertyId?: string, before = Number.MAX_SAFE_INTEGER) {
    if (!propertyId) return this.db.count(kind, before);
    if (before >= this.db.highWatermark(kind)) return this.propertyCounts.get(propertyId)?.[kind === 'bill-occurrence' ? 'occurrences' : 'series'] ?? 0;
    // Property labels are encrypted. A historical insertion boundary therefore
    // needs a bounded-memory scan, never a misleading current total.
    let total = 0, cursor: number | undefined = before;
    do {
      const page: { records: WorkflowRecord<SourceBillOccurrence | BillRecurrenceSeries>[]; next: number | null } = this.db.page(kind, { before: cursor, limit: 200 });
      total += page.records.filter(({ value }) => ('facts' in value ? value.facts.propertyId : value.propertyId) === propertyId).length;
      cursor = page.next ?? undefined;
    } while (cursor);
    return total;
  }
  private touch(occurrences: number, series: number, activeSeries: number) {
    const previous = this.marker();
    const marker: BillMarker = previous?.value ?? { version: 2, migration: { sourceRevision: 0, sourceDigest: hash(fresh()), occurrences: 0, series: 0 }, counts: { occurrences: 0, series: 0, activeSeries: 0 } };
    marker.counts.occurrences += occurrences; marker.counts.series += series; marker.counts.activeSeries += activeSeries;
    this.put('bill-register', 'source-bills', marker);
  }
  occurrence(id: string) { return this.get<SourceBillOccurrence>('bill-occurrence', id)?.value; }
  series(id: string) { return this.get<BillRecurrenceSeries>('bill-series', id)?.value; }
  byIdentity(identity: string) {
    const alias = this.get<Alias>('bill-source-alias', aliasId(identity))?.value;
    if (!alias) return undefined;
    const row = this.occurrence(alias.occurrenceId); if (!row) return recovery(); return row;
  }
  byOrigin(id: string) {
    const origin = this.get<Origin>('bill-origin', originId(id))?.value;
    if (!origin) return undefined;
    const series = this.series(origin.seriesId); if (!series) return recovery(); return series;
  }
  activePattern(input: { accountId: string; propertyId: string; kind: string; vendor: string }) {
    const slot = this.get<PatternSlot>('bill-pattern-slot', patternId(patternKey(input)))?.value;
    if (!slot?.seriesId) return undefined;
    const row = this.series(slot.seriesId); if (!row?.active) return recovery(); return row;
  }
  occupied(seriesId: string, date: string) { return this.get<ArrivalSlot>('bill-arrival-slot', arrivalId(seriesId, date))?.value.occurrenceId ?? null; }
  private arrival(seriesId: string, date: string, release: string | null, reserve: string | null) {
    const id = arrivalId(seriesId, date), old = this.get<ArrivalSlot>('bill-arrival-slot', id)?.value;
    let occupant = old?.occurrenceId ?? null;
    if (release && occupant === release) occupant = null;
    if (reserve) {
      if (occupant && occupant !== reserve) return fail('That arrival already has a received bill. Correct the saved bill instead of creating another.', 409);
      occupant = reserve;
    }
    this.put('bill-arrival-slot', id, { version: 1, seriesId, date, occurrenceId: occupant } satisfies ArrivalSlot);
  }
  saveOccurrence(row: SourceBillOccurrence) {
    const old = this.occurrence(row.id);
    if (old?.seriesId) this.arrival(old.seriesId, old.expectedArrivalDate!, row.id, null);
    if (row.seriesId) this.arrival(row.seriesId, row.expectedArrivalDate!, null, row.state === 'cancelled' ? null : row.id);
    const founded = this.byOrigin(row.id);
    if (founded) this.arrival(founded.id, founded.anchorDate, row.id, row.state === 'cancelled' ? null : row.id);
    for (const version of [...row.history, row]) {
      const id = aliasId(version.source.identity), alias = this.get<Alias>('bill-source-alias', id);
      if (alias && alias.value.occurrenceId !== row.id) return fail('This message belongs to another saved bill.', 409);
      if (!alias) this.put('bill-source-alias', id, { version: 1, identity: version.source.identity, occurrenceId: row.id } satisfies Alias);
    }
    this.put('bill-occurrence', row.id, row);
    if (old) this.countProperty(old.facts.propertyId, 'occurrences', -1);
    this.countProperty(row.facts.propertyId, 'occurrences', 1);
    this.touch(old ? 0 : 1, 0, 0);
  }
  saveSeries(row: BillRecurrenceSeries) {
    const old = this.series(row.id), key = patternKey(row), id = patternId(key);
    const slot = this.get<PatternSlot>('bill-pattern-slot', id)?.value;
    if (row.active && slot?.seriesId && slot.seriesId !== row.id) return fail('An active arrival pattern already exists for this property, vendor and bill kind.', 409);
    this.put('bill-pattern-slot', id, { version: 1, key, seriesId: row.active ? row.id : slot?.seriesId === row.id ? null : slot?.seriesId ?? null } satisfies PatternSlot);
    const origin = this.occurrence(row.occurrenceId); if (!origin) return recovery();
    const existing = this.byOrigin(row.occurrenceId);
    if (existing && existing.id !== row.id) return fail('This bill already has a saved pattern.', 409);
    if (!existing) this.put('bill-origin', originId(row.occurrenceId), { version: 1, occurrenceId: row.occurrenceId, seriesId: row.id } satisfies Origin);
    if (old) this.arrival(row.id, old.anchorDate, origin.id, null);
    this.arrival(row.id, row.anchorDate, null, origin.state === 'cancelled' ? null : origin.id);
    this.put('bill-series', row.id, row);
    if (!old) this.countProperty(row.propertyId, 'series', 1);
    this.touch(0, old ? 0 : 1, Number(row.active) - Number(old?.active ?? false));
  }
  hasLinkedOccurrences(seriesId: string): boolean {
    let before: number | undefined;
    do {
      const page = this.db.page<SourceBillOccurrence>('bill-occurrence', { before, limit: 200 });
      if (page.records.some(row => row.value.seriesId === seriesId && row.value.state !== 'cancelled')) return true;
      if (!page.next) return false; before = page.next;
    } while (true);
  }
}

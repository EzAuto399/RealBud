import { SOURCE_BILL_RECORD_KINDS, validateSourceBillRecord, validateSourceBillRecords, deriveBillLookups, aliasId, arrivalId, originId, patternId, patternKey } from "./source-bill-graph.js";
import { validRegister, fresh, hash, recovery, fail } from "./source-bill-rules.js";
/** One transaction owns heads, permanent aliases and current reservations. No
 * cleartext property/source labels or custom SQLite tables are introduced. */
export class SourceBillStorage {
    checkedToken;
    propertyCounts = new Map();
    db;
    constructor(db) { this.db = db; }
    allRecords() {
        const rows = [];
        for (const kind of SOURCE_BILL_RECORD_KINDS) {
            let before;
            do {
                const page = this.db.page(kind, { before, limit: 200 });
                rows.push(...page.records.map(row => ({ kind, ...row })));
                before = page.next ?? undefined;
                if (!page.next)
                    break;
            } while (true);
        }
        return rows;
    }
    countProperty(propertyId, key, change) {
        const counts = this.propertyCounts.get(propertyId) ?? { occurrences: 0, series: 0 };
        counts[key] += change;
        this.propertyCounts.set(propertyId, counts);
    }
    ensure() {
        const token = this.db.changeToken();
        if (token === this.checkedToken)
            return;
        let rows = this.allRecords();
        validateSourceBillRecords(rows);
        const legacy = rows.find(r => r.kind === 'bill-register');
        if (legacy?.value?.version === 1) {
            const old = validRegister(legacy.value);
            for (const row of old.occurrences)
                this.db.create('bill-occurrence', row.id, row, null);
            for (const row of old.series)
                this.db.create('bill-series', row.id, row, null);
            for (const [id, row] of deriveBillLookups(old.occurrences, old.series))
                this.db.create(row.kind, id, row.value, null);
            const marker = { version: 2, migration: { sourceRevision: legacy.revision, sourceDigest: hash(old), occurrences: old.occurrences.length, series: old.series.length }, counts: { occurrences: old.occurrences.length, series: old.series.length, activeSeries: old.series.filter(s => s.active).length } };
            this.db.update('bill-register', 'source-bills', legacy.revision, () => marker);
            rows = this.allRecords();
            validateSourceBillRecords(rows);
        }
        this.propertyCounts.clear();
        for (const row of rows) {
            if (row.kind === 'bill-occurrence')
                this.countProperty(row.value.facts.propertyId, 'occurrences', 1);
            if (row.kind === 'bill-series')
                this.countProperty(row.value.propertyId, 'series', 1);
        }
        this.checkedToken = this.db.changeToken();
    }
    run(operation) {
        try {
            return this.db.transaction(() => {
                this.ensure();
                const result = operation();
                // Capture while the write lock is still held. An external commit after
                // COMMIT must invalidate this token instead of being blessed unread.
                this.checkedToken = this.db.changeToken();
                return result;
            });
        }
        catch (error) {
            this.checkedToken = undefined;
            throw error;
        }
    }
    get(kind, id) {
        const row = this.db.get(kind, id);
        if (row)
            validateSourceBillRecord(kind, row.id, row.revision, row.value);
        return row;
    }
    put(kind, id, value) {
        const old = this.get(kind, id);
        validateSourceBillRecord(kind, id, old ? old.revision + 1 : 1, value);
        return old ? this.db.update(kind, id, old.revision, () => value) : this.db.create(kind, id, value, null);
    }
    marker() { return this.get('bill-register', 'source-bills'); }
    counts() { const marker = this.marker(); return { revision: marker?.revision ?? 0, ...(marker?.value.counts ?? { occurrences: 0, series: 0, activeSeries: 0 }) }; }
    total(kind, propertyId, before = Number.MAX_SAFE_INTEGER) {
        if (!propertyId)
            return this.db.count(kind, before);
        if (before >= this.db.highWatermark(kind))
            return this.propertyCounts.get(propertyId)?.[kind === 'bill-occurrence' ? 'occurrences' : 'series'] ?? 0;
        // Property labels are encrypted. A historical insertion boundary therefore
        // needs a bounded-memory scan, never a misleading current total.
        let total = 0, cursor = before;
        do {
            const page = this.db.page(kind, { before: cursor, limit: 200 });
            total += page.records.filter(({ value }) => ('facts' in value ? value.facts.propertyId : value.propertyId) === propertyId).length;
            cursor = page.next ?? undefined;
        } while (cursor);
        return total;
    }
    touch(occurrences, series, activeSeries) {
        const previous = this.marker();
        const marker = previous?.value ?? { version: 2, migration: { sourceRevision: 0, sourceDigest: hash(fresh()), occurrences: 0, series: 0 }, counts: { occurrences: 0, series: 0, activeSeries: 0 } };
        marker.counts.occurrences += occurrences;
        marker.counts.series += series;
        marker.counts.activeSeries += activeSeries;
        this.put('bill-register', 'source-bills', marker);
    }
    occurrence(id) { return this.get('bill-occurrence', id)?.value; }
    series(id) { return this.get('bill-series', id)?.value; }
    byIdentity(identity) {
        const alias = this.get('bill-source-alias', aliasId(identity))?.value;
        if (!alias)
            return undefined;
        const row = this.occurrence(alias.occurrenceId);
        if (!row)
            return recovery();
        return row;
    }
    byOrigin(id) {
        const origin = this.get('bill-origin', originId(id))?.value;
        if (!origin)
            return undefined;
        const series = this.series(origin.seriesId);
        if (!series)
            return recovery();
        return series;
    }
    activePattern(input) {
        const slot = this.get('bill-pattern-slot', patternId(patternKey(input)))?.value;
        if (!slot?.seriesId)
            return undefined;
        const row = this.series(slot.seriesId);
        if (!row?.active)
            return recovery();
        return row;
    }
    occupied(seriesId, date) { return this.get('bill-arrival-slot', arrivalId(seriesId, date))?.value.occurrenceId ?? null; }
    arrival(seriesId, date, release, reserve) {
        const id = arrivalId(seriesId, date), old = this.get('bill-arrival-slot', id)?.value;
        let occupant = old?.occurrenceId ?? null;
        if (release && occupant === release)
            occupant = null;
        if (reserve) {
            if (occupant && occupant !== reserve)
                return fail('That arrival already has a received bill. Correct the saved bill instead of creating another.', 409);
            occupant = reserve;
        }
        this.put('bill-arrival-slot', id, { version: 1, seriesId, date, occurrenceId: occupant });
    }
    saveOccurrence(row) {
        const old = this.occurrence(row.id);
        if (old?.seriesId)
            this.arrival(old.seriesId, old.expectedArrivalDate, row.id, null);
        if (row.seriesId)
            this.arrival(row.seriesId, row.expectedArrivalDate, null, row.state === 'cancelled' ? null : row.id);
        const founded = this.byOrigin(row.id);
        if (founded)
            this.arrival(founded.id, founded.anchorDate, row.id, row.state === 'cancelled' ? null : row.id);
        for (const version of [...row.history, row]) {
            const id = aliasId(version.source.identity), alias = this.get('bill-source-alias', id);
            if (alias && alias.value.occurrenceId !== row.id)
                return fail('This message belongs to another saved bill.', 409);
            if (!alias)
                this.put('bill-source-alias', id, { version: 1, identity: version.source.identity, occurrenceId: row.id });
        }
        this.put('bill-occurrence', row.id, row);
        if (old)
            this.countProperty(old.facts.propertyId, 'occurrences', -1);
        this.countProperty(row.facts.propertyId, 'occurrences', 1);
        this.touch(old ? 0 : 1, 0, 0);
    }
    saveSeries(row) {
        const old = this.series(row.id), key = patternKey(row), id = patternId(key);
        const slot = this.get('bill-pattern-slot', id)?.value;
        if (row.active && slot?.seriesId && slot.seriesId !== row.id)
            return fail('An active arrival pattern already exists for this property, vendor and bill kind.', 409);
        this.put('bill-pattern-slot', id, { version: 1, key, seriesId: row.active ? row.id : slot?.seriesId === row.id ? null : slot?.seriesId ?? null });
        const origin = this.occurrence(row.occurrenceId);
        if (!origin)
            return recovery();
        const existing = this.byOrigin(row.occurrenceId);
        if (existing && existing.id !== row.id)
            return fail('This bill already has a saved pattern.', 409);
        if (!existing)
            this.put('bill-origin', originId(row.occurrenceId), { version: 1, occurrenceId: row.occurrenceId, seriesId: row.id });
        if (old)
            this.arrival(row.id, old.anchorDate, origin.id, null);
        this.arrival(row.id, row.anchorDate, null, origin.state === 'cancelled' ? null : origin.id);
        this.put('bill-series', row.id, row);
        if (!old)
            this.countProperty(row.propertyId, 'series', 1);
        this.touch(0, old ? 0 : 1, Number(row.active) - Number(old?.active ?? false));
    }
    hasLinkedOccurrences(seriesId) {
        let before;
        do {
            const page = this.db.page('bill-occurrence', { before, limit: 200 });
            if (page.records.some(row => row.value.seriesId === seriesId && row.value.state !== 'cancelled'))
                return true;
            if (!page.next)
                return false;
            before = page.next;
        } while (true);
    }
}

/** Portable, side-effect-free source-bill graph validation. The encrypted heads
 * and all retained identity/reservation records form one restore unit. */
import { validBillDate, billDateInZone, addBillDays } from "../shared/bill-dates.js";
import { object, positive, at, text, hash, recovery, versionOf, seriesVersion, validateVersion, validateSeriesVersion, validRegister, normalized, sameBillKind, cadenceDate } from "./source-bill-rules.js";
export const SOURCE_BILL_RECORD_KINDS = ['bill-register', 'bill-occurrence', 'bill-series', 'bill-source-alias', 'bill-pattern-slot', 'bill-arrival-slot', 'bill-origin'];
const hex = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const occurrenceId = (v) => typeof v === 'string' && /^source-bill:[a-f0-9]{64}$/.test(v);
const seriesId = (v) => typeof v === 'string' && /^bill-series:[a-f0-9-]{36}$/.test(v);
const exact = (value, keys) => { const r = object(value, keys); if (Object.keys(r).length !== keys.length)
    recovery(); return r; };
export const aliasId = (identity) => `bill-source:${identity}`;
export const patternKey = (s) => hash([s.accountId, s.propertyId, normalized(s.kind), normalized(s.vendor)]);
export const patternId = (key) => `bill-pattern:${key}`;
export const arrivalId = (seriesId, date) => `bill-arrival:${hash([seriesId, date])}`;
export const originId = (occurrenceId) => `bill-origin:${hash(occurrenceId)}`;
export function validateOccurrence(value) {
    try {
        const row = exact(value, ['id', 'createdAt', 'history', 'revision', 'facts', 'state', 'source', 'seriesId', 'expectedArrivalDate', 'reviewedAt', 'reviewedBy', 'reviewReason']);
        if (!occurrenceId(row.id))
            recovery();
        at(row.createdAt);
        validateVersion(versionOf(row));
        if (!Array.isArray(row.history) || row.history.length > 50 || row.revision !== row.history.length + 1)
            recovery();
        row.history.forEach((v, i) => { validateVersion(v); if (v.revision !== i + 1)
            recovery(); });
        if (row.id !== `source-bill:${(row.history[0] ?? row).source.identity}`)
            recovery();
        for (const v of [...row.history, row]) {
            exact(v.source, ['accountId', 'threadId', 'message', 'receiptId', 'digest', 'identity']);
            exact(v.source.message, ['id', 'at', 'from', 'subject', 'body', 'bodyTruncated', 'attachments']);
            if (v.source.accountId !== row.source.accountId || (v.seriesId !== null && !seriesId(v.seriesId)))
                recovery();
        }
        return row;
    }
    catch {
        return recovery();
    }
}
export function validateSeries(value) {
    try {
        const s = exact(value, ['id', 'occurrenceId', 'sourceOccurrenceRevision', 'sourceDigest', 'accountId', 'propertyId', 'kind', 'vendor', 'createdAt', 'history', 'revision', 'intervalMonths', 'anchorDate', 'windowBeforeDays', 'windowAfterDays', 'timeZone', 'active', 'reviewedAt', 'reviewedBy', 'reviewReason']);
        if (!seriesId(s.id) || !occurrenceId(s.occurrenceId) || !hex(s.sourceDigest))
            recovery();
        positive(s.sourceOccurrenceRevision);
        at(s.createdAt);
        text(s.accountId, 200);
        text(s.propertyId, 200);
        text(s.kind, 80);
        text(s.vendor, 160);
        validateSeriesVersion(seriesVersion(s));
        if (!Array.isArray(s.history) || s.history.length > 50 || s.revision !== s.history.length + 1)
            recovery();
        s.history.forEach((v, i) => { validateSeriesVersion(v); if (v.revision !== i + 1)
            recovery(); });
        return s;
    }
    catch {
        return recovery();
    }
}
export function validateSourceBillRecord(kind, id, revision, value) {
    try {
        if (!SOURCE_BILL_RECORD_KINDS.includes(kind))
            recovery();
        positive(revision);
        if (kind === 'bill-register') {
            if (id !== 'source-bills')
                recovery();
            if (value?.version === 1) {
                validRegister(value);
                return;
            }
            const marker = exact(value, ['version', 'migration', 'counts']);
            if (marker.version !== 2)
                recovery();
            const migration = exact(marker.migration, ['sourceRevision', 'sourceDigest', 'occurrences', 'series']);
            at(migration.sourceRevision);
            if (!hex(migration.sourceDigest))
                recovery();
            at(migration.occurrences);
            at(migration.series);
            if (Number(migration.occurrences) > 500 || Number(migration.series) > 100)
                recovery();
            const counts = exact(marker.counts, ['occurrences', 'series', 'activeSeries']);
            at(counts.occurrences);
            at(counts.series);
            at(counts.activeSeries);
            if (Number(counts.activeSeries) > Number(counts.series) || Number(migration.occurrences) > Number(counts.occurrences) || Number(migration.series) > Number(counts.series))
                recovery();
            return;
        }
        if (kind === 'bill-occurrence') {
            if (validateOccurrence(value).id !== id)
                recovery();
            return;
        }
        if (kind === 'bill-series') {
            if (validateSeries(value).id !== id)
                recovery();
            return;
        }
        if (kind === 'bill-source-alias') {
            const r = exact(value, ['version', 'identity', 'occurrenceId']);
            if (r.version !== 1 || !hex(r.identity) || id !== aliasId(r.identity) || !occurrenceId(r.occurrenceId))
                recovery();
        }
        else if (kind === 'bill-pattern-slot') {
            const r = exact(value, ['version', 'key', 'seriesId']);
            if (r.version !== 1 || !hex(r.key) || id !== patternId(r.key) || (r.seriesId !== null && !seriesId(r.seriesId)))
                recovery();
        }
        else if (kind === 'bill-arrival-slot') {
            const r = exact(value, ['version', 'seriesId', 'date', 'occurrenceId']);
            if (r.version !== 1 || !seriesId(r.seriesId) || !validBillDate(r.date) || id !== arrivalId(r.seriesId, r.date) || (r.occurrenceId !== null && !occurrenceId(r.occurrenceId)))
                recovery();
        }
        else {
            const r = exact(value, ['version', 'occurrenceId', 'seriesId']);
            if (r.version !== 1 || !occurrenceId(r.occurrenceId) || !seriesId(r.seriesId) || id !== originId(r.occurrenceId))
                recovery();
        }
    }
    catch {
        recovery();
    }
}
/** Derive the exact retained lookup graph, including released historical slots. */
export function deriveBillLookups(occurrences, series) {
    const lookups = new Map();
    const rows = new Map(occurrences.map(row => [row.id, row]));
    const patterns = new Map(series.map(s => [s.id, s]));
    if (rows.size !== occurrences.length || patterns.size !== series.length)
        recovery();
    deriveBillLookupsInto(occurrences, series, id => rows.get(id), id => patterns.get(id), {
        get: id => lookups.get(id), set: (id, value) => { lookups.set(id, value); }, count: () => lookups.size,
    });
    return lookups;
}
function deriveBillLookupsInto(occurrences, series, occurrence, pattern, lookups) {
    const reserve = (s, date, occupant) => {
        const id = arrivalId(s, date), previous = lookups.get(id)?.value;
        if (previous?.occurrenceId && occupant && previous.occurrenceId !== occupant)
            recovery();
        lookups.set(id, { kind: 'bill-arrival-slot', value: { version: 1, seriesId: s, date, occurrenceId: occupant ?? previous?.occurrenceId ?? null } });
    };
    for (const row of occurrences)
        for (const v of [...row.history, row]) {
            const id = aliasId(v.source.identity), old = lookups.get(id)?.value;
            if (old && old.occurrenceId !== row.id)
                recovery();
            lookups.set(id, { kind: 'bill-source-alias', value: { version: 1, identity: v.source.identity, occurrenceId: row.id } });
            if (v.seriesId) {
                const s = pattern(v.seriesId);
                if (!s || s.accountId !== v.source.accountId || !sameBillKind(v.facts, s) || ![...s.history, s].some(p => cadenceDate({ ...s, ...p }, v.expectedArrivalDate)))
                    return recovery();
                if (v === row && row.state !== 'cancelled' && !cadenceDate(s, v.expectedArrivalDate))
                    recovery();
                reserve(v.seriesId, v.expectedArrivalDate, v === row && row.state !== 'cancelled' ? row.id : null);
            }
        }
    for (const s of series) {
        const origin = occurrence(s.occurrenceId);
        const evidence = origin && [...origin.history, origin].find(v => v.revision === s.sourceOccurrenceRevision);
        if (!origin || !evidence || evidence.source.digest !== s.sourceDigest || evidence.source.accountId !== s.accountId || !sameBillKind(evidence.facts, s))
            return recovery();
        for (const version of [...s.history, s])
            if (version.active) {
                const arrival = billDateInZone(evidence.source.message.at, version.timeZone);
                if (arrival < addBillDays(version.anchorDate, -version.windowBeforeDays) || arrival > addBillDays(version.anchorDate, version.windowAfterDays))
                    recovery();
            }
        if (s.active && (origin.state === 'cancelled' || origin.source.digest !== s.sourceDigest || !sameBillKind(origin.facts, s)))
            recovery();
        const id = originId(s.occurrenceId);
        if (lookups.get(id))
            recovery();
        lookups.set(id, { kind: 'bill-origin', value: { version: 1, occurrenceId: s.occurrenceId, seriesId: s.id } });
        const key = patternKey(s), slotId = patternId(key), old = lookups.get(slotId)?.value;
        if (old?.seriesId && s.active)
            recovery();
        lookups.set(slotId, { kind: 'bill-pattern-slot', value: { version: 1, key, seriesId: s.active ? s.id : old?.seriesId ?? null } });
        for (const version of [...s.history, s])
            reserve(s.id, version.anchorDate, version === s && origin.state !== 'cancelled' ? origin.id : null);
    }
}
/** Complete bidirectional graph validation with one decoded head at a time.
 * Lookup collisions and released historical reservations use the caller's
 * bounded accumulator; it must be empty and private to this validation. */
export function validateSourceBillGraph(reader, lookups) {
    try {
        if (lookups.count() !== 0)
            recovery();
        const counts = new Map();
        let total = 0, activeSeries = 0;
        for (const kind of SOURCE_BILL_RECORD_KINDS) {
            let count = 0;
            for (const row of reader.iterate(kind)) {
                if (row.kind !== kind)
                    recovery();
                validateSourceBillRecord(kind, row.id, row.revision, row.value);
                if (kind === 'bill-series' && row.value.active)
                    activeSeries++;
                count++;
            }
            counts.set(kind, count);
            total += count;
        }
        if (!total)
            return;
        if (counts.get('bill-register') !== 1)
            recovery();
        const marker = reader.get('bill-register', 'source-bills')?.value;
        if (!marker)
            return recovery();
        if (marker.version === 1) {
            if (total !== 1)
                recovery();
            return;
        }
        if (marker.counts.occurrences !== counts.get('bill-occurrence') || marker.counts.series !== counts.get('bill-series') || marker.counts.activeSeries !== activeSeries)
            recovery();
        function* values(kind) {
            for (const row of reader.iterate(kind))
                yield row.value;
        }
        deriveBillLookupsInto(values('bill-occurrence'), values('bill-series'), id => reader.get('bill-occurrence', id)?.value, id => reader.get('bill-series', id)?.value, lookups);
        let actual = 0;
        for (const kind of SOURCE_BILL_RECORD_KINDS) {
            if (['bill-register', 'bill-occurrence', 'bill-series'].includes(kind))
                continue;
            for (const row of reader.iterate(kind)) {
                actual++;
                const wanted = lookups.get(row.id);
                if (!wanted || wanted.kind !== kind || !Object.entries(wanted.value).every(([key, value]) => row.value[key] === value))
                    recovery();
            }
        }
        if (actual !== lookups.count())
            recovery();
    }
    catch {
        recovery();
    }
}
export function validateSourceBillRecords(input) {
    try {
        const rows = input.filter(r => SOURCE_BILL_RECORD_KINDS.includes(r.kind));
        if (!rows.length)
            return;
        const ids = new Set();
        for (const row of rows) {
            if (ids.has(row.id))
                recovery();
            ids.add(row.id);
            validateSourceBillRecord(row.kind, row.id, row.revision, row.value);
        }
        const registers = rows.filter(r => r.kind === 'bill-register');
        if (registers.length !== 1)
            recovery();
        const marker = registers[0].value;
        if (marker.version === 1) {
            if (rows.length !== 1)
                recovery();
            return;
        }
        const occurrences = rows.filter(r => r.kind === 'bill-occurrence').map(r => r.value);
        const series = rows.filter(r => r.kind === 'bill-series').map(r => r.value);
        if (marker.counts.occurrences !== occurrences.length || marker.counts.series !== series.length || marker.counts.activeSeries !== series.filter(s => s.active).length)
            recovery();
        const expected = deriveBillLookups(occurrences, series);
        const actual = rows.filter(r => !['bill-register', 'bill-occurrence', 'bill-series'].includes(r.kind));
        if (actual.length !== expected.size)
            recovery();
        for (const row of actual) {
            const wanted = expected.get(row.id);
            if (!wanted || wanted.kind !== row.kind || !Object.entries(wanted.value).every(([key, value]) => row.value[key] === value))
                recovery();
        }
    }
    catch {
        recovery();
    }
}

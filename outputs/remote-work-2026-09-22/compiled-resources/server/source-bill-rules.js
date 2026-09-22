import { createHash } from 'node:crypto';
import { validBillDate, addBillDays, anchoredBillMonth } from "../shared/bill-dates.js";
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const object = (value, keys) => {
    if (!record(value) || Object.keys(value).some(key => !keys.includes(key)))
        return fail('Use the supported bill review fields.');
    return value;
};
const text = (value, max, empty = false) => {
    if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (!empty && !value.trim()))
        return fail('Use a valid plain-text bill label or review reason.');
    return value;
};
const date = (value) => validBillDate(value) ? value : fail('Use a valid calendar date in YYYY-MM-DD format.');
const nullableDate = (value) => value === null ? null : date(value);
const positive = (value) => Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : fail('Use the current saved revision.');
const at = (value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail('The source timestamp is invalid.');
const states = ['received', 'in-process', 'hold', 'cancelled'];
const state = (value) => states.includes(value) ? value : fail('Choose received, in process, hold or cancelled. Payment confirmation is a separate workflow.');
const normalized = (value) => value.normalize('NFKC').trim().toLocaleLowerCase('en-AU');
const dateSpan = (from, to) => {
    const start = date(from), end = date(to);
    if (end < start || Date.parse(end) - Date.parse(start) > 550 * 86_400_000)
        return fail('Choose a calendar range of at most 550 days.');
    return { from: start, to: end };
};
/** The caller supplies this from its private, authenticated mail store. Never
 * pass source content from the HTTP body here. Receipt provenance is retained
 * separately from stable message identity/content, so rescans do not duplicate. */
export function previewBillSource(value) {
    if (!record(value) || !record(value.message))
        return fail('Choose an available saved mail message.');
    const message = value.message;
    const accountId = text(value.accountId, 200), receiptId = text(value.receiptId, 200), threadId = text(value.threadId, 200);
    if (!Array.isArray(message.attachments) || message.attachments.length > 100)
        return fail('The attachment metadata is invalid.');
    const attachments = message.attachments.map(value => {
        const a = object(value, ['id', 'name', 'mimeType', 'size']);
        if (a.size !== null && (!Number.isSafeInteger(a.size) || Number(a.size) < 0))
            return fail('The attachment metadata is invalid.');
        return { id: text(a.id, 512), name: text(a.name, 255, true), mimeType: text(a.mimeType, 120, true), size: a.size };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(attachments.map(a => a.id)).size !== attachments.length || (message.bodyTruncated !== undefined && typeof message.bodyTruncated !== 'boolean'))
        return fail('The saved message metadata needs review.');
    const canonical = { accountId, threadId, message: { id: text(message.id, 200), at: at(message.at),
            from: text(message.from, 2048, true), subject: text(message.subject, 2048, true), body: text(message.body, 12000, true),
            bodyTruncated: message.bodyTruncated ?? false, attachments } };
    return { ...canonical, receiptId, digest: hash(canonical), identity: hash([accountId, threadId, canonical.message.id]) };
}
function facts(value) {
    const f = object(value, ['propertyId', 'kind', 'vendor', 'amountCents', 'currency', 'invoiceDate', 'dueDate', 'note']);
    if (f.currency !== 'AUD')
        return fail('This bill workflow currently supports AUD. Confirm the source currency before accepting.');
    if (f.amountCents !== null && (!Number.isSafeInteger(f.amountCents) || Number(f.amountCents) < 0 || Number(f.amountCents) > 999_999_999_999))
        return fail('Enter a non-negative bill amount in whole cents.');
    const result = { propertyId: text(f.propertyId, 200).trim(), kind: text(f.kind, 80).trim(), vendor: text(f.vendor, 160).trim(), amountCents: f.amountCents, currency: 'AUD',
        invoiceDate: nullableDate(f.invoiceDate), dueDate: nullableDate(f.dueDate), note: text(f.note, 1000, true).trim() };
    if (result.invoiceDate && result.dueDate && result.dueDate < result.invoiceDate)
        return fail('The due date precedes the invoice date. Resolve the source dates before accepting.');
    return result;
}
function reviewed(body, source) {
    if (body.expectedSourceDigest !== source.digest)
        return fail('This source changed. Reopen the saved message and review it again.', 409);
    if (body.sourceReviewed !== true)
        return fail('Confirm that you reviewed this message and the entered bill facts.');
    if ((source.message.bodyTruncated || source.message.attachments.length > 0) && body.limitedSourceAcknowledged !== true)
        return fail('Acknowledge that attachments were not read and truncated message content may be missing.');
    return text(body.reviewReason, 1000).trim();
}
const versionOf = ({ id: _id, createdAt: _createdAt, history: _history, ...version }) => structuredClone(version);
const seriesVersion = ({ id: _id, occurrenceId: _occ, sourceOccurrenceRevision: _rev, sourceDigest: _digest, accountId: _account, propertyId: _property, kind: _kind, vendor: _vendor, createdAt: _at, history: _history, ...version }) => structuredClone(version);
const fresh = () => ({ version: 1, occurrences: [], series: [] });
const recovery = () => fail('Saved source-linked bills need recovery. Changes are paused and existing records were preserved.', 503);
const sameBillKind = (a, b) => a.propertyId === b.propertyId && normalized(a.kind) === normalized(b.kind) && normalized(a.vendor) === normalized(b.vendor);
function pattern(value) {
    if (![1, 3, 12].includes(Number(value.intervalMonths)) || typeof value.intervalMonths !== 'number')
        return fail('Choose monthly, quarterly or yearly arrival.');
    for (const key of ['windowBeforeDays', 'windowAfterDays'])
        if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 14)
            return fail('Use an arrival window of zero to fourteen days either side.');
    const timeZone = text(value.timeZone, 100);
    try {
        if (timeZone !== 'UTC' && !timeZone.includes('/'))
            throw new Error();
        new Intl.DateTimeFormat('en', { timeZone }).format(0);
    }
    catch {
        return fail('Choose a valid office timezone.');
    }
    return { intervalMonths: value.intervalMonths, anchorDate: date(value.anchorDate), windowBeforeDays: Number(value.windowBeforeDays), windowAfterDays: Number(value.windowAfterDays), timeZone };
}
function validateVersion(value) {
    const v = object(value, ['revision', 'facts', 'state', 'source', 'seriesId', 'expectedArrivalDate', 'reviewedAt', 'reviewedBy', 'reviewReason']);
    positive(v.revision);
    facts(v.facts);
    state(v.state);
    at(v.reviewedAt);
    text(v.reviewedBy, 200);
    text(v.reviewReason, 1000);
    if (!record(v.source))
        recovery();
    const storedSource = v.source;
    const source = previewBillSource(v.source);
    if (source.digest !== storedSource.digest || source.identity !== storedSource.identity)
        recovery();
    if (v.seriesId !== null)
        text(v.seriesId, 100);
    nullableDate(v.expectedArrivalDate);
    if ((v.seriesId === null) !== (v.expectedArrivalDate === null))
        recovery();
}
function validateSeriesVersion(value) {
    const v = object(value, ['revision', 'intervalMonths', 'anchorDate', 'windowBeforeDays', 'windowAfterDays', 'timeZone', 'active', 'reviewedAt', 'reviewedBy', 'reviewReason']);
    positive(v.revision);
    pattern(v);
    if (typeof v.active !== 'boolean')
        recovery();
    at(v.reviewedAt);
    text(v.reviewedBy, 200);
    text(v.reviewReason, 1000);
}
function validRegister(value) {
    try {
        const r = object(value, ['version', 'occurrences', 'series']);
        if (r.version !== 1 || !Array.isArray(r.occurrences) || r.occurrences.length > 500 || !Array.isArray(r.series) || r.series.length > 100)
            recovery();
        const rows = r.occurrences, series = r.series;
        for (const row of rows) {
            object(row, ['id', 'createdAt', 'history', 'revision', 'facts', 'state', 'source', 'seriesId', 'expectedArrivalDate', 'reviewedAt', 'reviewedBy', 'reviewReason']);
            if (!/^source-bill:[a-f0-9]{64}$/.test(row.id))
                recovery();
            at(row.createdAt);
            validateVersion(versionOf(row));
            if (!Array.isArray(row.history) || row.history.length > 50 || row.revision !== row.history.length + 1)
                recovery();
            row.history.forEach((v, index) => { validateVersion(v); if (v.revision !== index + 1)
                recovery(); });
            if (row.id !== `source-bill:${(row.history[0] ?? row).source.identity}`)
                recovery();
        }
        if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.source.identity)).size !== rows.length)
            recovery();
        for (const s of series) {
            object(s, ['id', 'occurrenceId', 'sourceOccurrenceRevision', 'sourceDigest', 'accountId', 'propertyId', 'kind', 'vendor', 'createdAt', 'history', 'revision', 'intervalMonths', 'anchorDate', 'windowBeforeDays', 'windowAfterDays', 'timeZone', 'active', 'reviewedAt', 'reviewedBy', 'reviewReason']);
            if (!/^bill-series:[a-f0-9-]{36}$/.test(s.id) || !rows.some(row => row.id === s.occurrenceId) || !/^[a-f0-9]{64}$/.test(s.sourceDigest))
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
            s.history.forEach((v, index) => { validateSeriesVersion(v); if (v.revision !== index + 1)
                recovery(); });
        }
        if (new Set(series.map(s => s.id)).size !== series.length)
            recovery();
        const sourceOwners = new Map();
        for (const row of rows)
            for (const version of [...row.history, row]) {
                if (sourceOwners.has(version.source.identity) && sourceOwners.get(version.source.identity) !== row.id)
                    recovery();
                sourceOwners.set(version.source.identity, row.id);
            }
        for (const row of rows)
            if (row.seriesId && !series.some(s => s.id === row.seriesId))
                recovery();
        return value;
    }
    catch {
        return recovery();
    }
}
/** Pure read validation for portable backup; never opens or changes a store. */
export const validateSourceBillRegister = validRegister;
const cadenceDate = (series, expected) => {
    const [y, m] = expected.split('-').map(Number), [ay, am] = series.anchorDate.split('-').map(Number);
    const months = (y - ay) * 12 + m - am;
    return months >= 0 && months % series.intervalMonths === 0 && anchoredBillMonth(series.anchorDate, months) === expected;
};
export function projectBillCalendar(register, from, to) {
    dateSpan(from, to);
    const entries = [];
    for (const row of register.occurrences)
        if (row.state !== 'cancelled' && row.facts.dueDate && row.facts.dueDate >= from && row.facts.dueDate <= to) {
            entries.push({ id: `due:${row.id}`, type: 'invoice-due', date: row.facts.dueDate, endDate: row.facts.dueDate,
                propertyId: row.facts.propertyId, kind: row.facts.kind, vendor: row.facts.vendor, billId: row.id, seriesId: row.seriesId,
                basis: 'human-reviewed-invoice-date', state: row.state });
        }
    for (const series of register.series.filter(s => s.active)) {
        const [fy, fm] = from.split('-').map(Number), [ay, am] = series.anchorDate.split('-').map(Number);
        const first = Math.max(0, Math.floor(((fy - ay) * 12 + fm - am) / series.intervalMonths) - 1);
        for (let index = first; index < first + 24; index++) {
            const arrival = anchoredBillMonth(series.anchorDate, index * series.intervalMonths);
            const start = addBillDays(arrival, -series.windowBeforeDays), end = addBillDays(arrival, series.windowAfterDays);
            if (start > to)
                break;
            if (end < from || register.occurrences.some(row => row.state !== 'cancelled' && ((row.id === series.occurrenceId && arrival === series.anchorDate) || (row.seriesId === series.id && row.expectedArrivalDate === arrival))))
                continue;
            entries.push({ id: `arrival:${series.id}:${arrival}`, type: 'expected-arrival', date: start, endDate: end,
                propertyId: series.propertyId, kind: series.kind, vendor: series.vendor, billId: null, seriesId: series.id,
                basis: 'approved-arrival-pattern', state: 'predicted' });
        }
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
export { fail, hash, record, object, text, date, nullableDate, positive, at, state, normalized, dateSpan, facts, reviewed, versionOf, seriesVersion, fresh, recovery, sameBillKind, pattern, validateVersion, validateSeriesVersion, validRegister, cadenceDate };

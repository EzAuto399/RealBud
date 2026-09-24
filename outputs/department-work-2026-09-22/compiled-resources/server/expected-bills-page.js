import { createHash } from 'node:crypto';
import { billPageQuery, billQuery, billQueryText } from "./bill-api-query.js";
import { groupExpectedBills } from "./expected-bills.js";
const fail = () => { throw Object.assign(new Error('The saved bill page no longer matches this view. Refresh the list and try again.'), { status: 400 }); };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const position = (row) => ({ createdAt: row.createdAt, id: hash(row.id) });
const groups = ['needs-you', 'due-soon', 'in-process', 'settled'];
function group(bill) {
    if (['missing', 'insufficient-funds', 'company-advance', 'owner-to-pay', 'hold'].includes(bill.status))
        return 'needs-you';
    if (bill.status === 'expected' || bill.status === 'received')
        return 'due-soon';
    return bill.status === 'in-process' ? 'in-process' : 'settled';
}
function projection(row) {
    return { id: row.id, propertyId: row.facts.propertyId, kind: row.facts.kind, status: row.state,
        windowStartAt: null, windowEndAt: null, amountCents: row.facts.amountCents, note: row.facts.note,
        sourceRef: `mail:${row.source.accountId}:${row.source.threadId}:${row.source.message.id}`,
        createdAt: row.createdAt, updatedAt: row.reviewedAt, dueDate: row.facts.dueDate, vendor: row.facts.vendor,
        revision: row.revision, sourceKind: 'mail-reviewed' };
}
function decode(raw) {
    let parsed;
    try {
        const bytes = Buffer.from(raw, 'base64url');
        if (bytes.toString('base64url') !== raw)
            return fail();
        parsed = JSON.parse(bytes.toString('utf8'));
    }
    catch {
        return fail();
    }
    if (!record(parsed) || Object.keys(parsed).sort().join(',') !== 'after,legacy,scope,snapshot,version' || parsed.version !== 1 ||
        typeof parsed.scope !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.scope) || typeof parsed.legacy !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.legacy) ||
        !(parsed.snapshot === null || typeof parsed.snapshot === 'string' && parsed.snapshot.length <= 6000 && /^[A-Za-z0-9_-]+$/.test(parsed.snapshot)) ||
        !record(parsed.after) || Object.keys(parsed.after).sort().join(',') !== 'createdAt,id' || typeof parsed.after.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(parsed.after.id) || typeof parsed.after.createdAt !== 'number' || !Number.isFinite(parsed.after.createdAt))
        return fail();
    return parsed;
}
/** Scans bounded source pages, retaining only at most limit+1 slim matches.
 * Full source bodies/history never accumulate in the summary or its response.
 * Insertions are frozen by the domain cursor; existing corrections remain live. */
export function expectedBillsPage(params, legacyRows, register) {
    billQuery(params, ['propertyId', 'origin', 'group', 'query', 'cursor', 'limit']);
    const options = billPageQuery(params), propertyId = options.propertyId ?? null;
    const origin = (params.get('origin') ?? 'all');
    if (!['all', 'legacy', 'source'].includes(origin))
        fail();
    const selectedGroup = params.get('group');
    if (selectedGroup !== null && !groups.includes(selectedGroup))
        fail();
    const query = (billQueryText(params, 'query', 200) ?? '').toLocaleLowerCase('en-AU');
    const scope = hash({ origin, propertyId, group: selectedGroup, query });
    const legacy = origin === 'source' ? [] : legacyRows();
    const legacyDigest = hash(legacy);
    const saved = options.cursor ? decode(options.cursor) : null;
    if (saved && (saved.scope !== scope || saved.legacy !== legacyDigest || (origin === 'legacy') !== (saved.snapshot === null)))
        fail();
    const selected = [], counts = { legacy: 0, source: 0 };
    const take = (row, kind) => {
        if (propertyId && row.propertyId !== propertyId || selectedGroup && group(row) !== selectedGroup || query &&
            !`${row.kind} ${row.propertyId} ${row.note} ${row.vendor ?? ''} ${row.status}`.toLocaleLowerCase('en-AU').includes(query))
            return;
        counts[kind]++;
        const key = position(row);
        if (saved && compare(key, saved.after) <= 0)
            return;
        selected.push({ row, position: key });
        selected.sort((a, b) => compare(a.position, b.position));
        if (selected.length > options.limit + 1)
            selected.pop();
    };
    for (const row of legacy)
        take(row, 'legacy');
    let snapshot = saved?.snapshot ?? null, sourceRevision;
    if (origin !== 'legacy') {
        const store = register(), visited = new Set();
        let cursor = snapshot ?? undefined;
        do {
            if (cursor && visited.has(cursor))
                throw Object.assign(new Error('The saved bill list needs recovery.'), { status: 503 });
            if (cursor)
                visited.add(cursor);
            const page = store.occurrencePage({ limit: 100, ...(propertyId ? { propertyId } : {}), ...(cursor ? { cursor } : {}) });
            if (sourceRevision !== undefined && sourceRevision !== page.revision)
                throw Object.assign(new Error('Saved bills changed while this page was being read. Refresh the view and try again.'), { status: 409 });
            snapshot ??= page.snapshotCursor;
            sourceRevision = page.revision;
            for (const row of page.items)
                take(projection(row), 'source');
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
    }
    const more = selected.length > options.limit;
    const bills = selected.slice(0, options.limit).map(item => item.row), last = bills.at(-1);
    const next = more && last ? { version: 1, scope, legacy: legacyDigest, snapshot, after: position(last) } : null;
    return { version: 2, bills, groups: groupExpectedBills(bills), total: counts.legacy + counts.source, counts,
        nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
        revision: hash({ legacy: legacyDigest, source: sourceRevision ?? 0 }) };
}

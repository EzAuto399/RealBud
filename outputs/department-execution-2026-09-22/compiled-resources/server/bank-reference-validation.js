import { isDeepStrictEqual } from 'node:util';
import { bankBatchSource, bankDigest, createBankReferenceBatch, parseBankCsv, reviewBankReferences } from "./bank-reference.js";
import { bankReviewId, bankReviewVersion } from "../shared/bank-review.js";
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const at = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hold = () => { throw Object.assign(new Error('This saved bank review failed its integrity check. Keep this review and recover the saved data.'), { status: 503 }); };
/** Pure validation shared by live reads/mutations and portable backup checks.
 * Stored row projections and even self-consistent output digests are not
 * authority to change anything beyond reviewed original reference cells. */
export function validateSavedBankBatch(id, value) {
    try {
        if (!object(value) || ![1, 2].includes(Number(value.version)) || typeof value.version !== 'number' || !at(value.createdAt) || !object(value.batch) ||
            Object.keys(value).some(key => !['version', 'createdAt', 'reviewedAt', 'batch', 'result', ...(value.version === 2 ? ['decisions', 'legacyDecisionsUnavailable', 'amends', 'supersededBy'] : [])].includes(key)) ||
            (value.reviewedAt !== undefined && (!at(value.reviewedAt) || value.result === undefined)))
            return hold();
        const saved = value, batch = saved.batch;
        const source = bankBatchSource(batch);
        const reviewVersion = bankReviewVersion(id);
        if (id !== bankReviewId(source.artifact.digest, reviewVersion))
            return hold();
        if (reviewVersion > 1) {
            const previous = saved.amends;
            if (!object(previous) || Object.keys(previous).sort().join(',') !== 'id,reason,revision' || previous.id !== bankReviewId(source.artifact.digest, reviewVersion - 1) ||
                !Number.isSafeInteger(previous.revision) || previous.revision < 1 || typeof previous.reason !== 'string' || !previous.reason.trim() || previous.reason.length > 500 || /[\x00-\x1f\x7f]/.test(previous.reason))
                return hold();
        }
        else if (saved.amends !== undefined)
            return hold();
        if (saved.supersededBy !== undefined) {
            const next = saved.supersededBy;
            if (!object(next) || Object.keys(next).sort().join(',') !== 'id,previousRevision,requestDigest' || next.id !== bankReviewId(source.artifact.digest, reviewVersion + 1) ||
                !Number.isSafeInteger(next.previousRevision) || next.previousRevision < 1 || typeof next.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(next.requestDigest))
                return hold();
        }
        if (saved.decisions !== undefined && !saved.result)
            return hold();
        if (saved.legacyDecisionsUnavailable !== undefined && (saved.legacyDecisionsUnavailable !== true || !saved.result || saved.decisions !== undefined))
            return hold();
        if (saved.version === 2 && saved.result && saved.decisions === undefined && !saved.legacyDecisionsUnavailable)
            return hold();
        const fresh = createBankReferenceBatch(batch.version === 2 ? { source: source.artifact, columns: batch.input.columns, dateFormat: batch.input.dateFormat, rules: batch.input.rules } : batch.input);
        if (!isDeepStrictEqual(batch, fresh))
            return hold();
        if (saved.result !== undefined) {
            const result = saved.result;
            if (!object(result) || Object.keys(result).some(key => !['csv', 'changes', 'originalDigest', 'outputDigest', 'bytesBase64', 'byteLength', 'encoding'].includes(key)) ||
                !Array.isArray(result.changes) || result.changes.length > fresh.rows.length || new Set(result.changes.map(change => change?.rowId)).size !== result.changes.length)
                return hold();
            const changed = new Map(result.changes.map(change => [change?.rowId, change]));
            const decisions = fresh.rows.map(row => {
                const change = changed.get(row.id);
                if (!change)
                    return { rowId: row.id, action: 'keep', reason: 'Validate retained unchanged source.' };
                if (!object(change) || Object.keys(change).sort().join(',') !== 'from,reason,rowId,to' || change.from !== row.reference || typeof change.to !== 'string' || change.to === row.reference)
                    return hold();
                const rule = fresh.input.rules.find(rule => rule.reference === change.to);
                if (!rule)
                    return hold();
                return { rowId: row.id, action: 'assign', propertyId: rule.propertyId, reason: change.reason };
            });
            const expected = reviewBankReferences(fresh, decisions);
            if (saved.decisions !== undefined) {
                if (!Array.isArray(saved.decisions) || saved.decisions.some(decision => !object(decision) ||
                    Object.keys(decision).sort().join(',') !== (decision.action === 'assign' ? 'action,propertyId,reason,rowId' : 'action,reason,rowId')))
                    return hold();
                const retained = reviewBankReferences(fresh, saved.decisions);
                if (!isDeepStrictEqual(retained, expected))
                    return hold();
            }
            const outputs = [expected];
            if (batch.version === 1) {
                // The original text-only v1 writer replaced reference spans without
                // retaining unnecessary original quotes. Admit that exact historical
                // algorithm as well as the modern writer; never normalize other cells.
                const table = parseBankCsv(batch.input.csv), ref = table[0].cells.indexOf(batch.input.columns.reference);
                const spans = new Map(fresh.rows.map((row, index) => [row.id, table[index + 1].spans[ref]]));
                let csv = batch.input.csv;
                for (const change of [...expected.changes].reverse()) {
                    const [start, end] = spans.get(change.rowId);
                    const text = /[",\r\n]/.test(change.to) ? `"${change.to.replaceAll('"', '""')}"` : change.to;
                    csv = csv.slice(0, start) + text + csv.slice(end);
                }
                const bytes = Buffer.from(csv, 'utf8');
                outputs.push({ ...expected, csv, bytesBase64: bytes.toString('base64'), byteLength: bytes.length, outputDigest: bankDigest(bytes) });
            }
            if ((batch.version === 2 && result.bytesBase64 === undefined) || !outputs.some(output => result.csv === output.csv && result.originalDigest === output.originalDigest && result.outputDigest === output.outputDigest &&
                isDeepStrictEqual(result.changes, output.changes) &&
                (result.bytesBase64 === undefined || result.bytesBase64 === output.bytesBase64) &&
                (result.byteLength === undefined || result.byteLength === output.byteLength) &&
                (result.encoding === undefined || result.encoding === output.encoding)))
                return hold();
        }
        return saved;
    }
    catch {
        return hold();
    }
}
/** Validate one hop each way without recursive traversal or retaining whole
 * bank histories. Live reads and both portable backup formats share this rule. */
export function validateBankReviewLinks(record, get) {
    const value = validateSavedBankBatch(record.id, record.value);
    if (!Number.isSafeInteger(record.revision) || record.revision < 1)
        return hold();
    const pair = (parent, child) => {
        const previous = validateSavedBankBatch(parent.id, parent.value), next = validateSavedBankBatch(child.id, child.value);
        const link = previous.supersededBy, amendment = next.amends;
        if (!link || !amendment || link.id !== child.id || amendment.id !== parent.id || link.previousRevision !== amendment.revision ||
            parent.revision !== amendment.revision + 1 || previous.batch.version !== next.batch.version ||
            !isDeepStrictEqual(previous.batch.source, next.batch.source) || previous.batch.input.csv !== next.batch.input.csv ||
            link.requestDigest !== bankDigest(JSON.stringify({ id: parent.id, revision: amendment.revision, reason: amendment.reason, input: next.batch.input })))
            return hold();
    };
    if (value.amends) {
        const parent = get(value.amends.id);
        if (!parent)
            return hold();
        pair(parent, record);
    }
    if (value.supersededBy) {
        const child = get(value.supersededBy.id);
        if (!child)
            return hold();
        pair(record, child);
    }
}

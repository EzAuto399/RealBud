import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { validateSavedBillProposal } from "./bill-proposal-validation.js";
import { BILL_REVIEW_DRAFT_LIMITS, BILL_REVIEW_DRAFT_MAX_BYTES } from "../shared/bill-review-drafts.js";
export const BILL_REVIEW_DRAFT_KIND = 'bill-review-draft';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const WORKSPACE = /^[A-Za-z0-9_-]{1,128}$/;
const VALUE_KEYS = ['workspaceId', 'state', 'billId', 'billRevision', 'itemId', 'messageId', 'sourceDigest', 'fields', 'billState', 'reason', 'seriesId', 'arrivalDate', 'proposalRequest'];
const FIELD_KEYS = ['propertyId', 'kind', 'vendor', 'amount', 'invoiceDate', 'dueDate', 'note'];
const STATES = ['editing', 'saved', 'accepted', 'discarded'];
const BILL_STATES = ['received', 'in-process', 'hold', 'cancelled'];
const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };
const invalid = () => fail('Check the saved review fields and draft identity. Drafts cannot contain source approvals or settings.', 400);
const conflict = () => fail('This bill review draft changed. Reopen the saved draft before continuing; your unsaved edits should be kept.', 409);
const recovery = () => fail('The saved bill review drafts need recovery. Their original data has been preserved.', 503);
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = (value) => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) < Number.MAX_SAFE_INTEGER;
const timestamp = (value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const nullable = (value, pattern) => value === null || typeof value === 'string' && pattern.test(value);
const closed = (value) => value.state === 'accepted' || value.state === 'discarded';
export const billReviewDraftRecordId = (id) => `${BILL_REVIEW_DRAFT_KIND}:${id}`;
function checkValue(value) {
    if (!exact(value, VALUE_KEYS))
        return invalid();
    const fields = value.fields;
    if (!exact(fields, FIELD_KEYS))
        return invalid();
    if (typeof value.workspaceId !== 'string' || !WORKSPACE.test(value.workspaceId) ||
        typeof value.state !== 'string' || !STATES.includes(value.state) || typeof value.billState !== 'string' || !BILL_STATES.includes(value.billState) ||
        !nullable(value.billId, /^source-bill:[a-f0-9]{64}$/) ||
        !(value.billRevision === null || positive(value.billRevision)) || (value.billId === null) !== (value.billRevision === null) ||
        !nullable(value.itemId, HEX) || !nullable(value.messageId, /^[a-fA-F0-9]{1,128}$/) || !nullable(value.sourceDigest, HEX) ||
        FIELD_KEYS.some(key => !text(fields[key], BILL_REVIEW_DRAFT_LIMITS[key])) ||
        !text(value.reason, BILL_REVIEW_DRAFT_LIMITS.reason) || !text(value.seriesId, BILL_REVIEW_DRAFT_LIMITS.seriesId) ||
        !text(value.arrivalDate, BILL_REVIEW_DRAFT_LIMITS.arrivalDate))
        return invalid();
    if (value.proposalRequest !== null) {
        const request = value.proposalRequest;
        if (!exact(request, ['requestId', 'itemId', 'messageId', 'expectedSourceDigest']) || typeof request.requestId !== 'string' || !UUID.test(request.requestId) ||
            typeof request.itemId !== 'string' || !HEX.test(request.itemId) || typeof request.messageId !== 'string' || !/^[a-fA-F0-9]{1,128}$/.test(request.messageId) ||
            typeof request.expectedSourceDigest !== 'string' || !HEX.test(request.expectedSourceDigest) ||
            request.itemId !== value.itemId || request.messageId !== value.messageId || request.expectedSourceDigest !== value.sourceDigest)
            invalid();
    }
}
function projection(value) {
    const { version: _version, id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = value;
    return fields;
}
function checkSize(value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    // AES-GCM preserves plaintext length. The stored envelope has fixed IV/tag
    // lengths and base64 ciphertext; account for both without allocating crypto.
    const envelopeOverhead = Buffer.byteLength(JSON.stringify({ v: 1, alg: 'aes-256-gcm', iv: '0'.repeat(16), tag: '0'.repeat(24), ct: '' }));
    if (bytes > BILL_REVIEW_DRAFT_MAX_BYTES || envelopeOverhead + 4 * Math.ceil(bytes / 3) > BILL_REVIEW_DRAFT_MAX_BYTES)
        fail('This draft is too large to save. Shorten its notes or review reason; your existing saved draft has not changed.', 413);
}
/** Pure validation for both live reads and portable backups. No source,
 * proposal or bill authority can be inferred from these untrusted hints. */
export function validateSavedBillReviewDraft(recordId, recordRevision, value, workspaceId) {
    try {
        if (!exact(value, ['version', 'id', 'revision', 'createdAt', 'updatedAt', ...VALUE_KEYS]) || value.version !== 1 || typeof value.id !== 'string' || !UUID.test(value.id) ||
            recordId !== billReviewDraftRecordId(value.id) || !positive(recordRevision) || value.revision !== recordRevision ||
            !timestamp(value.createdAt) || !timestamp(value.updatedAt) || value.updatedAt < value.createdAt)
            recovery();
        const draft = value;
        checkValue(projection(draft));
        if (workspaceId !== undefined && draft.workspaceId !== workspaceId)
            recovery();
        checkSize(draft);
        return draft;
    }
    catch {
        return recovery();
    }
}
/** Missing intent is valid: a draft is saved before a proposal is dispatched.
 * An existing intent may only belong to this exact immutable request tuple. */
export function validateBillReviewDraftProposalLink(draft, proposal, mismatchStatus = 503) {
    if (draft.proposalRequest === null || !proposal)
        return;
    const request = draft.proposalRequest;
    const saved = validateSavedBillProposal(proposal.id, proposal.value);
    const expected = createHash('sha256').update(JSON.stringify([request.itemId, request.messageId, request.expectedSourceDigest])).digest('hex');
    const document = saved.input.documents[0];
    if (proposal.id !== `bill-proposal:${request.requestId}` || saved.payloadDigest !== expected ||
        saved.sourceDigest !== request.expectedSourceDigest || document.sourceId !== request.messageId) {
        if (mismatchStatus === 409)
            conflict();
        recovery();
    }
}
function summary(draft) {
    return { id: draft.id, revision: draft.revision, state: draft.state, createdAt: draft.createdAt, updatedAt: draft.updatedAt,
        billId: draft.billId, itemId: draft.itemId, messageId: draft.messageId, propertyId: draft.fields.propertyId,
        kind: draft.fields.kind, vendor: draft.fields.vendor, hasProposalRequest: draft.proposalRequest !== null };
}
const badPage = () => fail('This draft history page is invalid. Refresh the draft list and try again.', 400);
export class BillReviewDraftStore {
    database;
    workspaceId;
    now;
    constructor(database, options) {
        if (typeof options.workspaceId !== 'string' || !WORKSPACE.test(options.workspaceId))
            invalid();
        this.database = database;
        this.workspaceId = options.workspaceId;
        this.now = options.now ?? Date.now;
    }
    identity(id) { if (typeof id !== 'string' || !UUID.test(id))
        invalid(); return billReviewDraftRecordId(id); }
    proposal(value) { return value.proposalRequest === null ? undefined : this.database.get('bill-proposal', `bill-proposal:${value.proposalRequest.requestId}`); }
    read(record) {
        const draft = validateSavedBillReviewDraft(record.id, record.revision, record.value, this.workspaceId);
        validateBillReviewDraftProposalLink(draft, this.proposal(draft));
        return draft;
    }
    input(value) {
        checkValue(value);
        if (value.workspaceId !== this.workspaceId)
            conflict();
        return structuredClone(value);
    }
    time() { const at = this.now(); if (!timestamp(at))
        recovery(); return at; }
    get(id) {
        const row = this.database.get(BILL_REVIEW_DRAFT_KIND, this.identity(id));
        if (!row)
            return fail('That saved bill review draft is unavailable.', 404);
        return this.read(row);
    }
    create(id, expectedRevision, value) {
        const recordId = this.identity(id);
        if (expectedRevision !== null)
            invalid();
        const input = this.input(value);
        return this.database.transaction(() => {
            const existing = this.database.get(BILL_REVIEW_DRAFT_KIND, recordId);
            if (existing) {
                const current = this.read(existing);
                if (!isDeepStrictEqual(projection(current), input))
                    conflict();
                return current;
            }
            const at = this.time(), draft = { version: 1, id, revision: 1, createdAt: at, updatedAt: at, ...input };
            checkSize(draft);
            validateBillReviewDraftProposalLink(draft, this.proposal(draft), 409);
            return this.read(this.database.create(BILL_REVIEW_DRAFT_KIND, recordId, draft, null));
        });
    }
    update(id, expectedRevision, value) {
        const recordId = this.identity(id);
        if (!positive(expectedRevision))
            invalid();
        const input = this.input(value);
        return this.database.transaction(() => {
            const row = this.database.get(BILL_REVIEW_DRAFT_KIND, recordId);
            if (!row)
                return fail('That saved bill review draft is unavailable.', 404);
            const current = this.read(row), prior = projection(current);
            // A lost acknowledgement may retry the exact content. Never overwrite a
            // newer winner, fabricate a revision or revive a closed draft on retry.
            if (expectedRevision <= current.revision && isDeepStrictEqual(prior, input))
                return current;
            if (expectedRevision !== current.revision || closed(current) ||
                current.proposalRequest !== null && !isDeepStrictEqual(current.proposalRequest, input.proposalRequest))
                conflict();
            const draft = { version: 1, id, revision: current.revision + 1, createdAt: current.createdAt,
                updatedAt: Math.max(current.updatedAt, this.time()), ...input };
            checkSize(draft);
            validateBillReviewDraftProposalLink(draft, this.proposal(draft), 409);
            return this.read(this.database.update(BILL_REVIEW_DRAFT_KIND, recordId, row.revision, () => draft));
        });
    }
    page(query = {}) {
        if (!object(query) || Object.keys(query).some(key => !['filter', 'limit', 'cursor'].includes(key)))
            badPage();
        const limit = query.limit ?? 20, filter = query.filter ?? 'active';
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['active', 'all'].includes(filter))
            badPage();
        return this.database.transaction(() => {
            const high = this.database.highWatermark(BILL_REVIEW_DRAFT_KIND);
            let cursor = { version: 1, kind: 'bill-review-drafts', workspaceId: this.workspaceId, filter, high, before: high };
            if (query.cursor !== undefined) {
                try {
                    const raw = query.cursor;
                    if (typeof raw !== 'string' || !raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw) || Buffer.from(raw, 'base64url').toString('base64url') !== raw)
                        badPage();
                    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
                    if (!exact(parsed, ['version', 'kind', 'workspaceId', 'filter', 'high', 'before']) || parsed.version !== 1 || parsed.kind !== 'bill-review-drafts' ||
                        parsed.workspaceId !== this.workspaceId || parsed.filter !== filter || !positive(parsed.high) || parsed.high > high ||
                        !positive(parsed.before) || parsed.before > parsed.high)
                        badPage();
                    cursor = parsed;
                }
                catch {
                    badPage();
                }
            }
            const items = [];
            let total = 0, before = cursor.high, last = 0, more = false;
            do {
                // Each chunk retains summaries only. Validate closed and off-page rows
                // too: damaged evidence must not disappear behind a filter or cursor.
                const chunk = this.database.projectPage(BILL_REVIEW_DRAFT_KIND, { before, limit: 100 }, row => summary(this.read(row)));
                for (let index = 0; index < chunk.records.length; index++) {
                    const row = chunk.records[index], sequence = chunk.sequences[index];
                    if (filter === 'active' && ['accepted', 'discarded'].includes(row.state))
                        continue;
                    total++;
                    if (sequence >= cursor.before)
                        continue;
                    if (items.length < limit) {
                        items.push(row);
                        last = sequence;
                    }
                    else
                        more = true;
                }
                before = chunk.next ?? undefined;
            } while (before !== undefined);
            return { version: 1, workspaceId: this.workspaceId, filter, items, total,
                nextCursor: more ? Buffer.from(JSON.stringify({ ...cursor, before: last })).toString('base64url') : null };
        });
    }
}

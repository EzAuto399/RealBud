import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isBillProposalRequestId } from "../shared/bill-proposals.js";
import { parseJobRun } from "./job-run-validation.js";
import { previewBillSource } from "./source-bills.js";
import { privateDirectory, writePrivateJson } from "./private-json.js";
import { validateAccountsReview } from "./accounts-review.js";
import { billProposalInput, validateSavedBillProposal } from "./bill-proposal-validation.js";
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function projectBillProposal(id, run, saved) {
    if (run.idempotencyKey !== id || run.jobId !== saved.recipeId || run.jobRevision !== saved.recipeRevision) {
        return fail('The saved worker receipt does not match this invoice request.', 503);
    }
    let proposal = null;
    if (['completed', 'awaiting-approval'].includes(run.status)) {
        const results = run.evidence.filter(item => item.kind === 'output').flatMap(item => {
            try {
                const value = JSON.parse(item.note);
                return value?.kind === 'accounts-invoice-entry-review' ? [value] : [];
            }
            catch {
                return [];
            }
        });
        if (results.length !== 1)
            return fail('The saved invoice proposal needs recovery.', 503);
        try {
            validateAccountsReview({ summary: 'Invoice proposal', outputs: [JSON.stringify(results[0])], evidence: [], needsApproval: [] }, { contract: ['accounts-invoice-entry-review', 'accounts-invoices.json', 'documents', 'documentId'],
                input: saved.input, digest: hash(saved.input), missingAttachments: false, unchanged: () => true });
        }
        catch {
            return fail('The saved invoice proposal does not match its source contract.', 503);
        }
        if (results[0].sourceReference !== saved.sourceReference) {
            return fail('The saved proposal source is inconsistent.', 503);
        }
        proposal = results[0].documents.length === 1 ? results[0].documents[0] : null;
    }
    return { run, proposal, sourceDigest: saved.sourceDigest };
}
/** Resolve retained evidence without consulting current source access, writing
 * input, or entering the executor. A missing receipt remains unresolved. */
export function readBillProposal(options, requestId) {
    if (!isBillProposalRequestId(requestId)) {
        return fail('Choose a valid invoice review request identifier.', 400);
    }
    const normalizedId = requestId.toLowerCase();
    const id = `bill-proposal:${normalizedId}`;
    const empty = {
        version: 1,
        requestId: normalizedId,
        state: 'not-recorded',
        sourceDigest: null,
        payloadDigest: null,
        run: null,
        proposal: null,
        historical: true,
    };
    try {
        const record = options.database().get('bill-proposal', id);
        if (!record)
            return empty;
        if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
            return fail('The saved invoice source intent needs recovery.', 503);
        }
        const saved = validateSavedBillProposal(id, record.value);
        const intent = {
            ...empty,
            state: 'intent-recorded',
            sourceDigest: saved.sourceDigest,
            payloadDigest: saved.payloadDigest,
        };
        let run = options.findRunByKey?.(id);
        if (!run) {
            const matching = options.runs().filter(candidate => candidate.idempotencyKey === id);
            if (matching.length > 1) {
                return fail('More than one worker receipt claims this invoice request.', 503);
            }
            run = matching[0];
        }
        if (!run)
            return intent;
        // JobRunStore already parses durable receipts. Enforce that same shape at
        // this read boundary and refuse an input that would be silently repaired,
        // truncated or stripped by the compatibility parser.
        const parsed = parseJobRun(run);
        if (!parsed || !isDeepStrictEqual(parsed, run) || !parsed.id || parsed.id.length > 300 ||
            !Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1) {
            return fail('The saved invoice worker receipt needs recovery.', 503);
        }
        const result = projectBillProposal(id, parsed, saved);
        return structuredClone({ ...intent, state: 'run-recorded', run: result.run, proposal: result.proposal });
    }
    catch {
        return fail('The saved invoice preparation needs recovery. Its evidence has been preserved.', 503);
    }
}
/** A selected saved message becomes a bounded, source-bound preparation. It
 * never creates a bill or recurrence. Those require an explicit staff review. */
export function createBillProposals(options) {
    let active = false;
    const replay = (id, saved) => {
        const run = options.findRunByKey?.(id) ?? options.runs().find(r => r.idempotencyKey === id);
        if (run)
            return projectBillProposal(id, run, saved);
        return fail('The earlier preparation stopped before a worker receipt was created. Its source intent is preserved. Start a new review request after checking Schedule.');
    };
    const sameRequest = (saved, expected) => {
        if (saved.payloadDigest !== expected.payloadDigest)
            return fail('This request identifier already belongs to another source. Reopen the message before starting a new proposal.');
        if (saved.authorityDigest !== expected.authorityDigest || saved.sourceDigest !== expected.sourceDigest || saved.recipeId !== expected.recipeId || saved.recipeRevision !== expected.recipeRevision || saved.sourceReference !== expected.sourceReference)
            return fail('The source or approved setup changed. The earlier job receipt is retained in Schedule; review current evidence before requesting another proposal.');
        // asOf records the winning preparation's clock, not a new request identity.
        if (!isDeepStrictEqual(saved.input, { ...expected.input, asOf: saved.input.asOf }))
            return fail('The saved invoice preparation does not match its source contract. Keep its evidence and recover the saved data.', 503);
    };
    return async (body) => {
        if (!body || typeof body !== 'object' || Array.isArray(body))
            return fail('Choose the saved message and a review request identifier.', 400);
        const b = body;
        if (Object.keys(b).some(k => !['requestId', 'itemId', 'messageId', 'expectedSourceDigest'].includes(k)) || typeof b.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(b.requestId) || typeof b.itemId !== 'string' || !/^[a-f0-9]{64}$/.test(b.itemId) || typeof b.messageId !== 'string' || !/^[a-fA-F0-9]{1,128}$/.test(b.messageId) || typeof b.expectedSourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(b.expectedSourceDigest))
            return fail('Choose the saved message, source revision and a valid review request identifier.', 400);
        const id = `bill-proposal:${b.requestId.toLowerCase()}`, payloadDigest = hash([b.itemId, b.messageId, b.expectedSourceDigest]);
        const requestEpoch = options.epoch();
        const unchanged = () => { if (options.epoch() !== requestEpoch)
            return fail('Source or setup changed during this request. The saved evidence is retained; review again.'); };
        const existing = options.database().get('bill-proposal', id);
        if (existing) {
            const saved = validateSavedBillProposal(id, existing.value);
            if (saved.payloadDigest !== payloadDigest)
                return fail('This request identifier already belongs to another source. Reopen the message before starting a new proposal.');
            const authority = await options.authorize(), source = previewBillSource(await options.source(b.itemId, b.messageId));
            unchanged();
            if (source.accountId !== authority.settings.gmailAccountId)
                return fail('The source or approved setup changed. The earlier job receipt is retained in Schedule; review current evidence before requesting another proposal.');
            sameRequest(saved, { payloadDigest, sourceDigest: source.digest, recipeId: authority.recipe.id, recipeRevision: authority.recipe.revision, sourceReference: `realbud-bill:${source.digest}`, authorityDigest: hash(authority), input: billProposalInput(authority.settings, source, String(saved.input.asOf)) });
            return replay(id, saved);
        }
        if (active)
            return fail('An invoice preparation is already running. Wait for its saved result.');
        active = true;
        try {
            const authority = await options.authorize(), source = previewBillSource(await options.source(b.itemId, b.messageId));
            unchanged();
            if (source.digest !== b.expectedSourceDigest || source.accountId !== authority.settings.gmailAccountId)
                return fail('This message does not match the currently reviewed source. Reopen it and check agency setup.');
            const sourceReference = `realbud-bill:${source.digest}`, input = billProposalInput(authority.settings, source, new Date().toISOString());
            const directory = join(options.workroom, 'workflow-inputs');
            await privateDirectory(directory);
            const refreshed = await options.authorize();
            unchanged();
            if (hash(refreshed) !== hash(authority))
                return fail('The invoice plan or agency authority changed during preparation. Review the current setup.');
            const checkCurrent = async () => {
                const current = await options.authorize();
                const currentSource = previewBillSource(await options.source(b.itemId, b.messageId));
                unchanged();
                if (currentSource.digest !== source.digest || hash(current) !== hash(authority))
                    return fail('The invoice source or approved setup changed during preparation. Review current evidence.');
            };
            await checkCurrent();
            const candidate = { payloadDigest, sourceDigest: source.digest, recipeId: authority.recipe.id, recipeRevision: authority.recipe.revision, sourceReference, authorityDigest: hash(authority), input };
            const database = options.database();
            const { saved, created } = database.transaction(() => {
                // Admission and winner inspection share the SQLite write lock. A late
                // competing request must never enter the executor with losing input.
                const winner = database.get('bill-proposal', id);
                if (!winner && options.runs().some(r => r.jobId === authority.recipe.id && ['queued', 'running'].includes(r.status)))
                    return fail('The invoice plan is already running. Wait before preparing another source.');
                // Permanent identities prevent old retries from becoming a second paid
                // preparation. Disk and per-record size remain the storage boundaries.
                const retained = winner ?? database.create('bill-proposal', id, candidate, null);
                const saved = validateSavedBillProposal(id, retained.value);
                sameRequest(saved, candidate);
                return { saved, created: !winner };
            });
            if (!created)
                return replay(id, saved);
            const { run } = await options.execute(authority.recipe, id, async () => {
                await checkCurrent();
                await writePrivateJson(join(directory, 'accounts-invoices.json'), saved.input);
                await checkCurrent();
            });
            // The result remains preparation evidence if access changed in flight.
            await checkCurrent();
            return projectBillProposal(id, run, saved);
        }
        finally {
            active = false;
        }
    };
}

// Review-only workflow boundary. Model prose never creates execution authority.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountsReviewSchemas } from "./accounts-review-schemas.js";
import { vaultDir } from "./vault.js";
const contracts = {
    'wf-office-core-inbox-triage': ['accounts-inbox-triage', 'accounts-inbox.json', 'threads', 'threadId'],
    'wf-office-core-invoice-review': ['accounts-invoice-entry-review', 'accounts-invoices.json', 'documents', 'documentId'],
    'wf-office-core-bill-exceptions': ['accounts-bill-exception-review', 'accounts-bill-exceptions.json', 'register', 'occurrenceId'],
    'wf-office-core-bank-reference-prep': ['accounts-anz-reference-candidates', 'accounts-bank-reference.json', 'rows', 'rowId'],
    "wf-austin-accounts-inbox-triage": ["accounts-inbox-triage", "accounts-inbox.json", "threads", "threadId"],
    "wf-austin-accounts-invoice-review": ["accounts-invoice-entry-review", "accounts-invoices.json", "documents", "documentId"],
    "wf-austin-accounts-bill-exceptions": ["accounts-bill-exception-review", "accounts-bill-exceptions.json", "register", "occurrenceId"],
    "wf-austin-accounts-anz-reference-prep": ["accounts-anz-reference-candidates", "accounts-bank-reference.json", "rows", "rowId"],
};
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const fail = (code) => { throw Object.assign(new Error(`Accounts review held (${code}). Check the bound sources or prepare again; no result was accepted and no execution permission was created.`), { code }); };
const digest = (text) => createHash("sha256").update(text).digest("hex");
/** Capture before the worker starts and reject replacement while it runs. These
 * files are deliberately local inputs; source references are not a mailbox grant. */
export function captureAccountsReview(recipe, workroom = vaultDir()) {
    const contract = contracts[recipe.id];
    if (!contract)
        return null;
    if (!recipe.capabilities.includes("read-files"))
        return fail("read-files-required");
    const read = () => {
        let path = workroom;
        for (const part of ["", "workflow-inputs", contract[1]]) {
            if (part)
                path = join(path, part);
            const stat = lstatSync(path);
            if (stat.isSymbolicLink() || (part === contract[1] ? !stat.isFile() || stat.size > 1_000_000 : !stat.isDirectory()))
                return fail("unsafe-input");
        }
        return readFileSync(path, "utf8");
    };
    let raw;
    let input;
    try {
        raw = read();
        input = object(JSON.parse(raw));
    }
    catch {
        return fail("input-unavailable");
    }
    if (!input || typeof input.sourceReference !== "string" || !input.sourceReference.trim())
        return fail("source-reference-missing");
    const capturedDigest = digest(raw);
    const paths = input.allowedAttachmentPaths ?? [];
    if (!Array.isArray(paths) || paths.length > 100 || paths.some(path => typeof path !== "string" || !/^workflow-inputs\/attachments\/[A-Za-z0-9_.-]+$/.test(path) || path.endsWith("/..")))
        return fail("unsafe-attachment-path");
    const attachmentHash = (path) => {
        try {
            if (lstatSync(join(workroom, "workflow-inputs/attachments")).isSymbolicLink())
                return "unavailable";
            const target = join(workroom, path), stat = lstatSync(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000)
                return "unavailable";
            return digest(readFileSync(target));
        }
        catch {
            return "unavailable";
        }
    };
    const attachmentHashes = new Map(paths.map(path => [path, attachmentHash(path)]));
    return { contract, input, digest: capturedDigest, missingAttachments: [...attachmentHashes.values()].includes("unavailable"), unchanged: () => { try {
            return digest(read()) === capturedDigest && [...attachmentHashes].every(([path, hash]) => attachmentHash(path) === hash);
        }
        catch {
            return false;
        } } };
}
function valid(value, schema) {
    if (Object.hasOwn(schema, "const") && value !== schema.const)
        return false;
    if (schema.enum && !schema.enum.includes(value))
        return false;
    if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum)
        return false;
    const hasType = (t) => t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "object" ? !!object(value) : t === "integer" ? Number.isSafeInteger(value) : typeof value === t;
    if (schema.type && !(typeof schema.type === "string" ? [schema.type] : schema.type).some(hasType))
        return false;
    if (typeof value === "string" && (value.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)))
        return false;
    const row = object(value);
    if (row) {
        if (schema.required?.some(key => !Object.hasOwn(row, key)))
            return false;
        if (schema.additionalProperties === false && Object.keys(row).some(key => !Object.hasOwn(schema.properties ?? {}, key)))
            return false;
        for (const [key, child] of Object.entries(schema.properties ?? {}))
            if (Object.hasOwn(row, key) && !valid(row[key], child))
                return false;
    }
    if (Array.isArray(value) && (value.length > (schema.maxItems ?? 200) || (schema.items && value.some(item => !valid(item, schema.items)))))
        return false;
    return true;
}
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
const safeHoldId = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 150 && !/[\u0000-\u001f]/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function outputObject(text) {
    try {
        return object(JSON.parse(text));
    }
    catch { /* Some workers escape the entire embedded JSON twice. */ }
    // Decode exactly one complete JSON string layer, never replace individual
    // escapes or infer missing fields. The normal schema/source checks still run.
    try {
        return object(JSON.parse(JSON.parse(`"${text}"`)));
    }
    catch {
        return null;
    }
}
/** Known prerequisites require no model judgment. Missing format/mapping is a
 * source hold, not a reason to spend an inference or invent a repair recipe. */
export function preflightAccountsReview(binding) {
    if (binding.contract[0] !== "accounts-anz-reference-candidates")
        return null;
    const input = binding.input, batch = object(input.batch), coverage = object(input.coverage);
    const holds = [];
    if (input.bankBrand !== "ANZ")
        holds.push({ itemId: "bankBrand", reason: "Confirm the source bank for this ANZ preparation plan." });
    if (input.formatConfirmed !== true)
        holds.push({ itemId: "formatConfirmed", reason: "Confirm the export layout using the original source file before preparing references." });
    if (input.mappingApproved !== true)
        holds.push({ itemId: "mappingApproved", reason: "Provide the reviewed property-reference mapping." });
    if (coverage?.complete !== true || Array.isArray(coverage.failedSources) && coverage.failedSources.length)
        holds.push({ itemId: "coverage", reason: "Provide a complete agreed export scope." });
    if (typeof input.batchId !== "string" || !input.batchId || !Number.isSafeInteger(input.batchRevision) || Number(input.batchRevision) < 1 || typeof batch?.originalDigest !== "string" || !/^[a-f0-9]{64}$/.test(batch.originalDigest) || !Array.isArray(batch.rows))
        holds.push({ itemId: "batchIdentity", reason: "Bind the original file to a host-created batch with its revision and digest." });
    if (!holds.length)
        return null;
    const originalDigest = typeof batch?.originalDigest === "string" ? batch.originalDigest : null;
    const result = { version: 1, kind: "accounts-anz-reference-candidates", sourceReference: String(input.sourceReference), status: "blocked", coverageComplete: false, originalDigest, rows: [], hostValidation: { required: true, batchId: typeof input.batchId === "string" ? input.batchId : null, batchRevision: Number.isSafeInteger(input.batchRevision) && Number(input.batchRevision) >= 1 ? Number(input.batchRevision) : null, originalDigest, applied: false }, holds, actionsPerformed: [] };
    const prepared = validateAccountsReview({ summary: "Source input needed", evidence: [], outputs: [JSON.stringify(result)], needsApproval: [] }, binding);
    prepared.evidence.unshift("Host preflight: source prerequisites are missing; the model was not started.");
    prepared.outputs[0] += `\n\nBefore preparation:\n${holds.map(hold => `${hold.itemId}: ${hold.reason}`).join("\n")}`;
    prepared.needsApproval = holds.map(hold => `[${hold.itemId}] source-owner: ${hold.reason}`);
    return prepared;
}
/** Single typed record drives both the readable report and Needs you. Do not
 * retain independent model-written approval prose beside it. */
export function validateAccountsReview(prepared, binding) {
    if (!binding.unchanged())
        return fail("source-changed");
    const { contract, input } = binding;
    const objects = prepared.outputs.flatMap(text => { const row = outputObject(text); return row ? [row] : []; });
    if (objects.length !== 1 || !valid(objects[0], accountsReviewSchemas[contract[0]]))
        return fail("invalid-output-contract");
    const result = objects[0];
    if (result.sourceReference !== input.sourceReference)
        return fail("source-reference-mismatch");
    if (result.status !== "complete" && (result.coverageComplete || !result.holds.length))
        return fail("incomplete-without-hold");
    if (result.status === "complete" && !result.coverageComplete)
        return fail("false-completion");
    const rows = result.kind === "accounts-inbox-triage" ? result.threads : result.kind === "accounts-invoice-entry-review" ? result.documents : result.kind === "accounts-bill-exception-review" ? result.findings : result.rows;
    const sourceRows = result.kind === "accounts-anz-reference-candidates" ? object(input.batch)?.rows : input[contract[2]];
    const ids = rows.map(row => row[contract[3]]);
    if (!ids.every(safeId) || new Set(ids).size !== ids.length)
        return fail("invalid-item-identity");
    if (!result.holds.every(hold => safeHoldId(hold.itemId)))
        return fail("invalid-hold-label");
    if (!result.holds.every(hold => hold.reason.trim()))
        return fail("empty-hold-reason");
    if (result.status === "blocked") {
        if (rows.length)
            return fail("blocked-with-items");
    }
    else if (!Array.isArray(sourceRows) || !same(ids, sourceRows.map(row => object(row)?.[result.kind === "accounts-anz-reference-candidates" ? "id" : contract[3]])))
        return fail("source-items-incomplete");
    const coverage = object(input.coverage);
    const accounts = Array.isArray(coverage?.accounts) ? coverage.accounts.map(object) : [];
    const agreedAccounts = Array.isArray(coverage?.agreedAccounts) ? coverage.agreedAccounts : [];
    const missingAccount = agreedAccounts.some(id => accounts.filter(account => account?.accountId === id).length !== 1);
    const countMismatch = (Array.isArray(input.threads) && (input.threadCount !== undefined && input.threadCount !== input.threads.length || input.threads.some(thread => object(thread)?.historyComplete === false))) || (Array.isArray(input.documents) && input.documentCount !== undefined && input.documentCount !== input.documents.length);
    const hasGap = binding.missingAttachments || missingAccount || countMismatch || coverage?.complete !== true || [coverage.failedSources, coverage.missingAttachments].some(value => Array.isArray(value) && value.length > 0) || accounts.some(account => !account || account.paginationComplete !== true || account.threadHistoryComplete !== true || account.expectedThreadCount !== account.returnedThreadCount || (Array.isArray(account.failedPages) && account.failedPages.length > 0));
    if (result.coverageComplete && hasGap)
        return fail("source-coverage-gap");
    if (result.kind === "accounts-anz-reference-candidates" && result.status !== "blocked" && (hasGap || input.bankBrand !== "ANZ" || input.formatConfirmed !== true || input.mappingApproved !== true || typeof input.batchId !== "string" || !Number.isSafeInteger(input.batchRevision) || Number(input.batchRevision) < 1))
        return fail("bank-prerequisites-missing");
    const queue = [];
    const lines = [];
    const add = (id, owner, action) => queue.push(`[${id}] ${owner}: ${action}.`);
    const ensureHold = (itemId, reason) => {
        if (!result.holds.some(hold => hold.itemId === itemId))
            result.holds.push({ itemId, reason });
    };
    if (result.kind === "accounts-inbox-triage") {
        for (const row of result.threads) {
            const source = sourceRows.find(item => item.threadId === row.threadId);
            const messages = Array.isArray(source.messages) ? source.messages.map(item => object(item)?.messageId) : [];
            if (!row.sourceMessageIds.length || row.sourceMessageIds.some(id => !messages.includes(id)))
                return fail("unknown-message-source");
            if (source.historyComplete === false && row.disposition !== "hold")
                return fail("incomplete-history-not-held");
            const reference = row.disposition === "reference" || row.disposition === "noise";
            if (reference && (row.missingFacts.length || result.holds.some(hold => hold.itemId === row.threadId)))
                return fail("reference-has-invented-followup");
            if (row.disposition === "hold")
                ensureHold(row.threadId, row.reason);
            const action = row.disposition === "urgent-review" ? "Urgent internal review" : row.disposition === "reply-review" ? "Review the question and source facts" : row.disposition === "action-review" ? "Review the internal decision or handoff" : row.disposition === "hold" ? "Resolve the source hold" : row.disposition === "waiting" ? "Waiting on the recorded response" : "Reference only; no new task";
            lines.push(`[${row.threadId}] ${row.owner} · ${row.priority} · ${action}`);
            if (!reference && row.disposition !== "waiting")
                add(row.threadId, row.owner, action);
        }
    }
    else if (result.kind === "accounts-invoice-entry-review") {
        for (const row of result.documents) {
            const source = sourceRows.find(item => item.documentId === row.documentId);
            const attachments = Array.isArray(source.attachmentIds) ? source.attachmentIds : [];
            const allowedPaths = Array.isArray(input.allowedAttachmentPaths) ? input.allowedAttachmentPaths : [];
            const attachmentPaths = (Array.isArray(input.attachments) ? input.attachments : []).map(object).filter(item => item && attachments.includes(item.attachmentId) && allowedPaths.includes(item.path)).map(item => item.path);
            const sourceIds = [source.sourceId, ...attachments, ...attachmentPaths];
            if (!row.sourceIds.length || row.sourceIds.some(id => !sourceIds.includes(id)))
                return fail("unknown-invoice-source");
            if (row.decision === "duplicate" && (!row.duplicateOf || row.duplicateOf === row.documentId || !result.documents.some(target => target.documentId === row.duplicateOf && target.decision !== "duplicate")))
                return fail("invalid-duplicate-link");
            if (row.decision === "hold")
                ensureHold(row.documentId, row.reason);
            lines.push(`[${row.documentId}] ${row.decision}`);
            if (row.decision !== "duplicate")
                add(row.documentId, "accounts-reviewer", row.decision === "hold" ? "Resolve the source hold" : "Review the proposed invoice facts");
        }
    }
    else if (result.kind === "accounts-bill-exception-review") {
        const register = Array.isArray(sourceRows) ? sourceRows.map(object).filter(row => row !== null) : [];
        const invoices = (Array.isArray(input.invoices) ? input.invoices : []).map(object).filter(row => row !== null);
        // Unmatched source evidence is a deterministic review obligation. Keep its
        // stable source identity even if the model omits it or uses an invoice alias.
        for (const invoice of result.status === "blocked" ? [] : invoices) {
            if (register.some(row => row.occurrenceId === invoice.occurrenceId && row.propertyId === invoice.propertyId))
                continue;
            const id = safeHoldId(invoice.sourceId) ? invoice.sourceId : invoice.invoiceId;
            if (!safeHoldId(id))
                return fail("unmapped-invoice-source-missing");
            const alias = invoice.invoiceId;
            if (safeHoldId(alias) && alias !== id && invoices.filter(row => row.invoiceId === alias).length === 1 &&
                !register.some(row => row.occurrenceId === alias) && !invoices.some(row => row.sourceId === alias)) {
                result.holds = result.holds.filter(hold => hold.itemId !== alias);
            }
            ensureHold(id, "Invoice source has no exact bill occurrence and property match. Review its mapping before accepting it into bill history.");
        }
        for (const row of result.findings) {
            const source = sourceRows.find(item => item.occurrenceId === row.occurrenceId);
            if (row.propertyId !== source.propertyId)
                return fail("bill-property-mismatch");
            const related = [...(Array.isArray(input.invoices) ? input.invoices : []), ...(Array.isArray(input.states) ? input.states : [])].map(object).filter(item => item?.occurrenceId === row.occurrenceId && (!item.propertyId || item.propertyId === row.propertyId));
            const sourceIds = [row.occurrenceId, ...(Array.isArray(coverage?.failedSources) ? coverage.failedSources : []), ...related.flatMap(item => Object.entries(item).filter(([key]) => key.endsWith("Id")).map(([, value]) => value))];
            if (row.sourceIds.some(id => !sourceIds.includes(id)))
                return fail("unknown-bill-source");
            if (row.flags.length)
                ensureHold(row.occurrenceId, row.reason);
            lines.push(`[${row.occurrenceId}] arrival ${row.arrival}; payment ${row.payment}; funding ${row.funding}; advance ${row.advance}${row.flags.length ? `; ${row.flags.join(", ")}` : ""}`);
            if (row.flags.length)
                add(row.occurrenceId, "accounts-reviewer", "Review the recorded exceptions and supporting facts");
        }
    }
    else {
        const host = result.hostValidation;
        const batch = object(input.batch);
        if (result.status !== "blocked" && (host.batchId !== input.batchId || host.batchRevision !== input.batchRevision || result.originalDigest !== batch?.originalDigest || host.originalDigest !== batch?.originalDigest))
            return fail("bank-batch-mismatch");
        // A complete, approved host batch has no model-created global mapping task.
        // Keep rows require no correction. Any uncertainty must identify a held row.
        if (result.status !== "blocked")
            result.holds = result.rows.filter(row => row.decision === "hold").map(row => ({ itemId: row.rowId, reason: row.reason }));
        for (const [index, row] of result.rows.entries()) {
            if (row.sourceRow !== index + 1)
                return fail("bank-source-row-mismatch");
            lines.push(`[${row.rowId}] source row ${row.sourceRow}: ${row.decision}`);
            if (row.decision !== "keep")
                add(row.rowId, "accounts-reviewer", row.decision === "hold" ? "Resolve the row identity hold" : "Review the reference candidate in the host validator");
        }
    }
    if (result.status !== "complete" && !result.holds.length)
        return fail("partial-without-actionable-hold");
    if (result.holds.some(hold => !hold.reason.trim()))
        return fail("empty-hold-reason");
    for (const hold of result.holds)
        if (!queue.some(line => line.startsWith(`[${hold.itemId}]`)))
            add(hold.itemId, "source-owner", "Resolve the named source or coverage hold in the structured report");
    // The durable store permits 20 requests of 500 characters. Group complete
    // entries, then fail closed rather than silently discarding the tail.
    const requests = [];
    for (const line of queue) {
        const last = requests.length - 1;
        if (last >= 0 && requests[last].length + line.length + 1 <= 480)
            requests[last] += `\n${line}`;
        else
            requests.push(line);
    }
    if (requests.length > 20)
        return fail("review-queue-too-large");
    const summary = `${input.synthetic === true ? "Synthetic rehearsal." : "Saved-source review."} Accounts preparation ${result.status}: ${rows.length} items; ${queue.length} internal reviews or source holds. No external action performed.`;
    const outputs = [summary + "\n\n" + lines.join("\n"), JSON.stringify(result)];
    if (outputs.some(text => text.length > 12_000) || outputs.reduce((n, text) => n + text.length, 0) > 32_000)
        return fail("review-output-too-large");
    return { summary, evidence: [`Bound input SHA256 ${binding.digest}. Source references, item coverage and attachment stability checked; model interpretation still requires human review.`, "Item holds and Needs you were derived from the structured decisions. Review does not authorize external action."], outputs, needsApproval: requests };
}

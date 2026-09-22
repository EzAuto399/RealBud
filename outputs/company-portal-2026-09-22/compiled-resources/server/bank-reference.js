import { createHash } from "node:crypto";
function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }
export const bankDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeText = (value, max) => typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const formula = (text) => /^[\s\uFEFF]*[=+@\-]/u.test(text);
const normalized = (text) => text.normalize("NFKC").toLocaleLowerCase("en-AU").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function decodeBankSource(source) {
    if (!source || typeof source.filename !== "string" || !source.filename.trim() || source.filename.length > 255 ||
        /[\\/\x00-\x1f\x7f]/.test(source.filename) || [".", ".."].includes(source.filename))
        fail("Choose a bank CSV with a valid filename.");
    if (typeof source.bytesBase64 !== "string" || source.bytesBase64.length > 1_000_000 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.bytesBase64))
        fail("The bank file bytes are not valid. Choose the original CSV again.");
    const bytes = Buffer.from(source.bytesBase64, "base64");
    if (!bytes.length || bytes.length > 750_000 || bytes.toString("base64") !== source.bytesBase64)
        fail("Choose a non-empty CSV smaller than 750 KB.");
    let csv;
    try {
        csv = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        fail("This bank file is not UTF-8. Export a UTF-8 CSV from the bank; the source file has not been changed.");
    }
    if (csv.includes("\0"))
        fail("This bank file contains unsupported encoding or NUL bytes. Export a UTF-8 CSV from the bank.");
    return { csv, bytes, artifact: { filename: source.filename, bytesBase64: source.bytesBase64,
            encoding: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "utf-8-bom" : "utf-8",
            byteLength: bytes.length, digest: bankDigest(bytes) } };
}
/** Old reviews captured text only. Their UTF-8 reconstruction remains available,
 * but it must never be presented as verified original upload bytes. */
export function bankBatchSource(batch) {
    if (!batch || !batch.input || typeof batch.input.csv !== "string")
        fail("The source batch failed its integrity check.");
    if (batch.version === 2) {
        if (!batch.source)
            fail("The source batch failed its integrity check.");
        const decoded = decodeBankSource(batch.source);
        if (decoded.csv !== batch.input.csv || decoded.artifact.digest !== batch.originalDigest ||
            decoded.artifact.digest !== batch.source.digest || decoded.artifact.encoding !== batch.source.encoding ||
            decoded.artifact.byteLength !== batch.source.byteLength)
            fail("The source batch failed its integrity check.");
        return { ...decoded, originalBytesCaptured: true };
    }
    if (batch.version !== 1 || bankDigest(batch.input.csv) !== batch.originalDigest)
        fail("The source batch failed its integrity check.");
    const decoded = decodeBankSource({ filename: `bank-saved-text-${batch.originalDigest.slice(0, 12)}.csv`, bytesBase64: Buffer.from(batch.input.csv, "utf8").toString("base64") });
    if (decoded.csv !== batch.input.csv)
        fail("This older saved text cannot be recovered without changing it. Keep the saved review and upload the original file separately.");
    return { ...decoded, originalBytesCaptured: false };
}
/** Strict RFC-style CSV. Offsets let export replace only reference cells,
 * preserving original bytes, order, quoting, dates, signed amounts and BOM. */
export function parseBankCsv(csv) {
    if (typeof csv !== "string" || Buffer.byteLength(csv) > 750_000 || !csv.length)
        fail("Choose a non-empty CSV smaller than 750 KB.");
    const rows = [];
    let i = csv.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (i < csv.length) {
        const cells = [], spans = [];
        for (;;) {
            const start = i;
            let value = "";
            if (csv[i] === '"') {
                i++;
                let closed = false;
                while (i < csv.length) {
                    if (csv[i] === '"') {
                        i++;
                        if (csv[i] === '"') {
                            value += '"';
                            i++;
                        }
                        else {
                            closed = true;
                            break;
                        }
                    }
                    else
                        value += csv[i++];
                }
                if (!closed)
                    fail("The CSV has an unfinished quoted field.");
                if (i < csv.length && ![",", "\r", "\n"].includes(csv[i]))
                    fail("The CSV has characters after a quoted field.");
            }
            else {
                while (i < csv.length && ![",", "\r", "\n"].includes(csv[i])) {
                    if (csv[i] === '"')
                        fail("The CSV has an unexpected quote.");
                    value += csv[i++];
                }
            }
            if (!safeText(value, 10_000))
                fail("The CSV contains an unsupported or oversized field.");
            cells.push(value);
            spans.push([start, i]);
            if (cells.length > 100)
                fail("The CSV has too many columns.");
            if (csv[i] !== ",")
                break;
            i++;
        }
        rows.push({ cells, spans });
        if (rows.length > 3001)
            fail("Use batches of at most 3,000 transactions.");
        if (csv[i] === "\r") {
            i++;
            if (csv[i] === "\n")
                i++;
        }
        else if (csv[i] === "\n")
            i++;
    }
    if (rows.length < 2)
        fail("The CSV needs a header and at least one transaction.");
    const headers = rows[0].cells;
    if (headers.some(h => !h.trim() || formula(h)) || new Set(headers.map(h => h.trim().toLowerCase())).size !== headers.length)
        fail("CSV headers must be named, unique and plain text.");
    if (rows.some(row => row.cells.length !== headers.length))
        fail("CSV rows have different column counts.");
    return rows;
}
function validDate(text, format) {
    const match = format === "YYYY-MM-DD" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
    if (!match)
        return false;
    const [y, m, d] = format === "YYYY-MM-DD" ? [+match[1], +match[2], +match[3]] : [+match[3], +match[2], +match[1]];
    const date = new Date(Date.UTC(y, m - 1, d));
    return y >= 1900 && y <= 2200 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export function createBankReferenceBatch(upload) {
    if (!upload || !["YYYY-MM-DD", "DD/MM/YYYY"].includes(upload.dateFormat))
        fail("Choose the date format used in this bank export.");
    const decoded = "source" in upload ? decodeBankSource(upload.source) : null;
    if (decoded && upload.csv !== undefined)
        fail("Choose one original bank file; do not supply a second text copy.");
    const input = { csv: decoded?.csv ?? upload.csv, columns: upload.columns, dateFormat: upload.dateFormat, rules: upload.rules };
    const table = parseBankCsv(input.csv), headers = table[0].cells;
    const names = input.columns && [input.columns.date, input.columns.amount, input.columns.narrative, input.columns.reference];
    if (!names || new Set(names).size !== 4 || names.some(n => typeof n !== "string" || !headers.includes(n)))
        fail("Map four different existing columns: date, signed amount, description and reference.");
    const indexes = names.map(n => headers.indexOf(n));
    if (!Array.isArray(input.rules) || input.rules.length > 2000)
        fail("Use at most 2,000 property reference rules.");
    const ids = new Set(), references = new Set();
    for (const rule of input.rules) {
        if (!rule || !safeText(rule.propertyId, 100) || !rule.propertyId.trim() || !safeText(rule.reference, 100) || !rule.reference.trim() || formula(rule.reference) || /[\r\n\t]/.test(rule.reference))
            fail("Each property needs a valid identity and a plain reference number.");
        if (ids.has(rule.propertyId) || references.has(rule.reference))
            fail("Property identities and reference numbers must be unique.");
        ids.add(rule.propertyId);
        references.add(rule.reference);
        if (!Array.isArray(rule.aliases) || rule.aliases.length > 20 || rule.aliases.some(a => !safeText(a, 200) || normalized(a).length < 3))
            fail("Use clear payer aliases with at least three letters or digits.");
    }
    // The reference directory is fixed for this batch. Normalize its aliases
    // once, including when validating historical rows against the original CSV.
    const matchingRules = input.rules.map(rule => ({ propertyId: rule.propertyId, aliases: rule.aliases.map(alias => ` ${normalized(alias)} `) }));
    const originalDigest = bankDigest(input.csv), duplicateKeys = new Map();
    const rows = table.slice(1).map(({ cells }, index) => {
        const [date, amount, narrative, reference] = indexes.map(i => cells[i]);
        const issues = [];
        if (!validDate(date, input.dateFormat))
            fail(`Transaction ${index + 1} has an invalid date for the selected format.`);
        if (!/^-?(?:0|[1-9]\d{0,11})\.\d{2}$/.test(amount))
            fail(`Transaction ${index + 1} needs a signed decimal amount with two cents digits; debit/credit layouts need a separate mapping.`);
        if (BigInt(amount.replace(".", "")) <= 0n)
            issues.push("Not an incoming payment; keep unchanged for separate review.");
        // Never emit spreadsheet formulas from any untrusted textual field.
        if (cells.some((value, i) => i !== indexes[1] && formula(value)))
            fail(`Transaction ${index + 1} contains a spreadsheet formula-like value. Review the source safely before importing.`);
        const haystack = ` ${normalized(narrative)} `;
        const candidates = matchingRules.filter(rule => rule.aliases.some(alias => haystack.includes(alias))).map(rule => rule.propertyId);
        if (reference.trim())
            issues.push("Existing reference; keep unless a reviewed correction is needed.");
        if (!candidates.length)
            issues.push("No property match; review manually.");
        if (candidates.length > 1)
            issues.push("More than one property matches; review manually.");
        const key = JSON.stringify([date, amount, narrative, reference]);
        duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
        return { id: `${originalDigest}:${index + 1}`, date, amount, narrative, reference, candidates, issues };
    });
    for (const row of rows)
        if (duplicateKeys.get(JSON.stringify([row.date, row.amount, row.narrative, row.reference])) > 1)
            row.issues.push("Possible duplicate; both source rows are preserved. Confirm before import.");
    const batch = { version: decoded ? 2 : 1, originalDigest, input: structuredClone(input), rows,
        ...(decoded ? { source: decoded.artifact } : {}) };
    bankBatchSource(batch);
    return batch;
}
export function reviewBankReferences(batch, decisions) {
    // Re-derive from the immutable original; do not trust client candidate rows.
    const source = bankBatchSource(batch);
    const fresh = createBankReferenceBatch(batch.input), table = parseBankCsv(batch.input.csv);
    if (!Array.isArray(decisions) || decisions.length !== fresh.rows.length || new Set(decisions.map(d => d?.rowId)).size !== decisions.length)
        fail("Review every row exactly once before preparing the export.");
    const refIndex = table[0].cells.indexOf(batch.input.columns.reference);
    const changes = [];
    const replacements = [];
    const map = new Map(decisions.map(d => [d.rowId, d]));
    fresh.rows.forEach((row, index) => {
        const decision = map.get(row.id);
        if (!decision || !["assign", "keep"].includes(decision.action) || !safeText(decision.reason, 500) || !decision.reason.trim())
            fail("Every row needs a decision and a short review reason.");
        if (decision.action === "keep") {
            if (decision.propertyId)
                fail("A keep decision cannot assign a property.");
            return;
        }
        if (BigInt(row.amount.replace(".", "")) <= 0n)
            fail("Only incoming payments can receive a property reference in this workflow.");
        const rule = batch.input.rules.find(r => r.propertyId === decision.propertyId);
        if (!rule)
            fail("Choose a property from this batch's saved reference directory.");
        if (rule.reference === row.reference)
            return;
        changes.push({ rowId: row.id, from: row.reference, to: rule.reference, reason: decision.reason.trim() });
        const span = table[index + 1].spans[refIndex];
        replacements.push({ span, text: batch.input.csv[span[0]] === '"' || /[",\r\n]/.test(rule.reference) ? `"${rule.reference.replaceAll('"', '""')}"` : rule.reference });
    });
    // Slice unchanged bytes from the captured source. Convert UTF-16 parser
    // offsets incrementally so multibyte characters cannot shift a replacement.
    const chunks = [];
    let charOffset = 0, byteOffset = 0;
    for (const { span: [start, end], text } of replacements) {
        const byteStart = byteOffset + Buffer.byteLength(batch.input.csv.slice(charOffset, start), "utf8");
        chunks.push(source.bytes.subarray(byteOffset, byteStart), Buffer.from(text, "utf8"));
        byteOffset = byteStart + Buffer.byteLength(batch.input.csv.slice(start, end), "utf8");
        charOffset = end;
    }
    chunks.push(source.bytes.subarray(byteOffset));
    const bytes = Buffer.concat(chunks), csv = bytes.toString("utf8");
    const output = parseBankCsv(csv);
    if (output.length !== table.length || output.some((row, i) => row.cells.some((value, c) => c !== refIndex && value !== table[i].cells[c])))
        fail("The output failed its transaction integrity check.");
    return { csv, bytesBase64: bytes.toString("base64"), byteLength: bytes.length, encoding: source.artifact.encoding,
        changes, originalDigest: batch.originalDigest, outputDigest: bankDigest(bytes) };
}

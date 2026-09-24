// Read-only PMS/ledger CSV. A bad cell rejects that row, not the file.
// Fixture CSVs keep `propertyId`. Live exports may key by address or property code.
import { asFiniteInteger, asNonEmptyString, asNullableNumber } from "./decode.js";
const STREET = {
    street: "st",
    st: "st",
    road: "rd",
    rd: "rd",
    avenue: "ave",
    ave: "ave",
    close: "cl",
    cl: "cl",
    drive: "dr",
    dr: "dr",
    place: "pl",
    pl: "pl",
};
function normHeader(h) {
    return h.toLowerCase().replace(/[\s_-]+/g, "");
}
function pickHeader(headers, aliases) {
    const wanted = new Set(aliases.map(normHeader));
    return headers.find((h) => wanted.has(normHeader(h))) ?? null;
}
/** Quoted CSV (RFC 4180-ish). Addresses often contain commas. */
export function parseCsvTable(text) {
    const src = text.replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    cell += '"';
                    i++;
                }
                else
                    quoted = false;
            }
            else
                cell += ch;
            continue;
        }
        if (ch === '"') {
            quoted = true;
            continue;
        }
        if (ch === ",") {
            row.push(cell);
            cell = "";
            continue;
        }
        if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && src[i + 1] === "\n")
                i++;
            row.push(cell);
            cell = "";
            if (row.some((c) => c.trim()))
                rows.push(row);
            row = [];
            continue;
        }
        cell += ch;
    }
    if (quoted)
        throw Object.assign(new Error("csv has an unclosed quote"), { status: 400 });
    if (cell.length || row.length) {
        row.push(cell);
        if (row.some((c) => c.trim()))
            rows.push(row);
    }
    return rows;
}
const ID_ALIASES = ["propertyId", "property_id", "id"];
const ADDRESS_ALIASES = [
    "address",
    "propertyAddress",
    "property_address",
    "property address",
    "property",
    "street address",
    "address line 1",
    "property name",
];
const CODE_ALIASES = [
    "propertyCode",
    "property_code",
    "code",
    "property code",
    "prop code",
    "ref",
    "reference",
    "property ref",
];
const DAYS_ALIASES = [
    "daysSinceDue",
    "daysLate",
    "days_late",
    "days late",
    "daysOverdue",
    "days overdue",
    "days in arrears",
    "arrears days",
    "days arrears",
    "days behind",
];
const RENT_ALIASES = [
    "rentLanded",
    "rent_landed",
    "rentPaid",
    "rent_paid",
    "rentIn",
    "rent in",
    "rent paid",
    "rent received",
    "rent cleared",
    "paid",
];
const LEVY_ALIASES = ["levyPaid", "levy_paid", "levy", "levy paid", "levy settled", "admin fee paid"];
function parseBoolCell(raw, field) {
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "y" || v === "paid" || v === "landed")
        return true;
    if (v === "false" || v === "0" || v === "no" || v === "n" || v === "unpaid")
        return false;
    throw Object.assign(new Error(`${field} must be true or false`), { status: 400, field });
}
function mappedHeader(headers, wanted) {
    if (!wanted)
        return null;
    const want = wanted.trim();
    if (!want)
        return null;
    const hit = headers.find((h) => h === want || h.toLowerCase() === want.toLowerCase());
    if (!hit)
        throw Object.assign(new Error(`csv missing column ${want}`), { status: 400 });
    return hit;
}
function classifyIdentityKind(header) {
    if (pickHeader([header], ID_ALIASES))
        return "id";
    if (pickHeader([header], CODE_ALIASES))
        return "code";
    return "address";
}
export function readCsvMapping(value) {
    if (value == null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const rec = value;
    const out = {};
    if (typeof rec.identity === "string" && rec.identity.trim())
        out.identity = rec.identity.trim();
    if (typeof rec.daysSinceDue === "string" && rec.daysSinceDue.trim())
        out.daysSinceDue = rec.daysSinceDue.trim();
    if (typeof rec.rentLanded === "string" && rec.rentLanded.trim())
        out.rentLanded = rec.rentLanded.trim();
    if (typeof rec.levyPaid === "string" && rec.levyPaid.trim())
        out.levyPaid = rec.levyPaid.trim();
    return out.identity || out.daysSinceDue || out.rentLanded || out.levyPaid ? out : undefined;
}
function cell(rec, key) {
    if (!key)
        return "";
    return rec[key] ?? rec[key.toLowerCase()] ?? "";
}
export function normalizeAddress(value) {
    const words = value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => STREET[w] ?? w);
    return words.join(" ");
}
export function matchExportRow(properties, row) {
    const hits = [];
    for (const property of properties) {
        if (row.identity.kind === "id" || row.identity.kind === "code") {
            const want = row.identity.value.trim().toLowerCase();
            // A "code" row matches the office's own PMS code first, then the
            // RealBud id (fixture books are keyed by id).
            if (property.propertyCode && property.propertyCode.toLowerCase() === want)
                hits.push(property.id);
            else if (property.id.toLowerCase() === want)
                hits.push(property.id);
        }
        else if (normalizeAddress(property.address) === normalizeAddress(row.identity.value)) {
            hits.push(property.id);
        }
    }
    const unique = [...new Set(hits)];
    if (unique.length === 1)
        return { ok: true, propertyId: unique[0] };
    if (unique.length > 1)
        return { ok: false, reason: "ambiguous", ids: unique };
    return { ok: false, reason: "unmatched" };
}
export function resolveExportRows(properties, rows) {
    const matched = [];
    const unmatched = [];
    const ambiguous = [];
    for (const row of rows) {
        const hit = matchExportRow(properties, row);
        if (!hit.ok && hit.reason === "ambiguous") {
            ambiguous.push({ row, ids: hit.ids });
            continue;
        }
        if (!hit.ok) {
            unmatched.push(row);
            continue;
        }
        matched.push({
            propertyId: hit.propertyId,
            daysSinceDue: row.daysSinceDue,
            rentLanded: row.rentLanded,
            levyPaid: row.levyPaid,
            daysSinceCourtesy: row.daysSinceCourtesy,
            amountPaidCents: row.amountPaidCents,
            reversed: row.reversed,
        });
    }
    return { matched, unmatched, ambiguous };
}
export function parsePmsExport(text, observedAt, sourceId = "src-csv", mapping) {
    const table = parseCsvTable(text);
    if (table.length < 2) {
        throw Object.assign(new Error("csv batch is empty"), { status: 400 });
    }
    const headers = table[0].map((h) => h.trim());
    if (!headers.some((h) => h)) {
        throw Object.assign(new Error("csv batch is empty"), { status: 400 });
    }
    let idCol = null;
    let addressCol = null;
    let codeCol = null;
    const mappedIdentity = mappedHeader(headers, mapping?.identity);
    if (mappedIdentity) {
        const kind = classifyIdentityKind(mappedIdentity);
        if (kind === "id")
            idCol = mappedIdentity;
        else if (kind === "code")
            codeCol = mappedIdentity;
        else
            addressCol = mappedIdentity;
    }
    else {
        idCol = pickHeader(headers, ID_ALIASES);
        addressCol = pickHeader(headers, ADDRESS_ALIASES);
        codeCol = pickHeader(headers, CODE_ALIASES);
    }
    const daysCol = mappedHeader(headers, mapping?.daysSinceDue) ?? pickHeader(headers, DAYS_ALIASES);
    const rentCol = mappedHeader(headers, mapping?.rentLanded) ?? pickHeader(headers, RENT_ALIASES);
    const levyCol = mappedHeader(headers, mapping?.levyPaid) ?? pickHeader(headers, LEVY_ALIASES);
    if (!idCol && !addressCol && !codeCol) {
        throw Object.assign(new Error("csv missing column propertyId"), { status: 400 });
    }
    if (!daysCol)
        throw Object.assign(new Error("csv missing column daysSinceDue"), { status: 400 });
    if (!rentCol)
        throw Object.assign(new Error("csv missing column rentLanded"), { status: 400 });
    if (!levyCol)
        throw Object.assign(new Error("csv missing column levyPaid"), { status: 400 });
    const courtesyCol = pickHeader(headers, ["daysSinceCourtesy", "days_since_courtesy"]);
    const amountCol = pickHeader(headers, ["amountPaidCents", "amount_paid_cents"]);
    const reversedCol = pickHeader(headers, ["reversed"]);
    const detected = {
        identity: idCol ?? codeCol ?? addressCol ?? undefined,
        daysSinceDue: daysCol,
        rentLanded: rentCol,
        levyPaid: levyCol,
    };
    const rows = [];
    const rejected = [];
    for (let i = 1; i < table.length; i++) {
        const cols = table[i];
        if (cols.length !== headers.length) {
            rejected.push({ row: i, reason: `csv row ${i} is incomplete` });
            continue;
        }
        try {
            const rec = {};
            headers.forEach((h, idx) => {
                rec[h] = cols[idx] ?? "";
            });
            let identity;
            const idVal = cell(rec, idCol).trim();
            const codeVal = cell(rec, codeCol).trim();
            const addressVal = cell(rec, addressCol).trim();
            if (idCol)
                identity = { kind: "id", value: asNonEmptyString(idVal, "propertyId") };
            else if (codeCol)
                identity = { kind: "code", value: asNonEmptyString(codeVal, "propertyCode") };
            else
                identity = { kind: "address", value: asNonEmptyString(addressVal, "address") };
            const daysRaw = cell(rec, daysCol).trim();
            if (!daysRaw)
                throw Object.assign(new Error("daysSinceDue is missing"), { status: 400, field: "daysSinceDue" });
            const daysSinceDue = asFiniteInteger(Number(daysRaw), "daysSinceDue");
            const rentLanded = parseBoolCell(cell(rec, rentCol), "rentLanded");
            const levyPaid = parseBoolCell(cell(rec, levyCol), "levyPaid");
            const courtesyRaw = cell(rec, courtesyCol).trim();
            const daysSinceCourtesy = courtesyRaw === "" || courtesyRaw === "null" ? null : asNullableNumber(Number(courtesyRaw), "daysSinceCourtesy");
            const amountRaw = cell(rec, amountCol).trim();
            const amountPaidCents = amountRaw === "" ? null : asFiniteInteger(Number(amountRaw), "amountPaidCents");
            const reversedRaw = cell(rec, reversedCol).trim();
            const reversed = reversedRaw === "" ? false : parseBoolCell(reversedRaw, "reversed");
            rows.push({ identity, daysSinceDue, rentLanded, levyPaid, daysSinceCourtesy, amountPaidCents, reversed });
        }
        catch (cause) {
            rejected.push({ row: i, reason: cause instanceof Error ? cause.message : String(cause) });
        }
    }
    if (!rows.length && !rejected.length)
        throw Object.assign(new Error("csv batch has no rows"), { status: 400 });
    return { sourceId, observedAt, rows, rejected, headers, detected };
}
/** Fixture-shaped import: identity becomes `propertyId` (unmatched until Desk maps it). */
export function parseLedgerCsv(text, observedAt, sourceId = "src-csv") {
    const batch = parsePmsExport(text, observedAt, sourceId);
    return {
        sourceId: batch.sourceId,
        observedAt: batch.observedAt,
        rows: batch.rows.map((row) => ({
            propertyId: row.identity.value,
            daysSinceDue: row.daysSinceDue,
            rentLanded: row.rentLanded,
            levyPaid: row.levyPaid,
            daysSinceCourtesy: row.daysSinceCourtesy,
            amountPaidCents: row.amountPaidCents,
            reversed: row.reversed,
        })),
    };
}
export { asBoolean } from "./decode.js";

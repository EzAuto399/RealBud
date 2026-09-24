import { createHash } from "node:crypto";
import { parsePmsExport, resolveExportRows } from "./csv-ledger.js";
// The HTTP body owner caps JSON at 1 MB. Keep enough headroom for escaped
// CSV cells so anything accepted here can also be committed through the same
// local API without an inconsistent second size limit.
export const MAX_PMS_CSV_BYTES = 450_000;
function codedError(message, status, code) {
    return Object.assign(new Error(message), { status, code });
}
export function pmsCsvDigest(csv) {
    return createHash("sha256").update(csv).digest("hex");
}
export function assertPmsCsvInput(csv) {
    if (typeof csv !== "string" || !csv.trim()) {
        throw codedError("Choose a non-empty PMS CSV export.", 400, "invalid-pms-export");
    }
    if (Buffer.byteLength(csv, "utf8") > MAX_PMS_CSV_BYTES) {
        throw codedError("That CSV is too large. Export only the current property ledger (450 KB maximum).", 413, "pms-export-too-large");
    }
}
function safeHeader(value) {
    return value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
}
function column(field, label, sourceHeader, required) {
    return { field, label, sourceHeader: safeHeader(sourceHeader), required };
}
function previewColumns(batch) {
    const columns = [
        column("property-identity", "Property identity", batch.columns.identity.header, true),
        column("days-since-due", "Days since due", batch.columns.daysSinceDue, true),
        column("rent-landed", "Rent received", batch.columns.rentLanded, true),
        column("levy-paid", "Levy paid", batch.columns.levyPaid, true),
    ];
    if (batch.columns.daysSinceCourtesy) {
        columns.push(column("days-since-courtesy", "Days since courtesy", batch.columns.daysSinceCourtesy, false));
    }
    if (batch.columns.amountPaidCents) {
        columns.push(column("amount-paid", "Amount received", batch.columns.amountPaidCents, false));
    }
    if (batch.columns.reversed) {
        columns.push(column("reversed", "Reversed payment", batch.columns.reversed, false));
    }
    return columns;
}
/** Parses and resolves an export without mutating Desk. The projection is
 * intentionally aggregate-only so opening the review sheet never copies a
 * tenant, property identity, amount or source row into renderer state. */
export function createPmsImportPreview(input) {
    assertPmsCsvInput(input.csv);
    if (!Number.isFinite(input.observedAt) || input.observedAt < 0) {
        throw codedError("PMS export observation time is invalid.", 400, "invalid-pms-export");
    }
    const batch = parsePmsExport(input.csv, input.observedAt, "src-preview");
    const resolved = resolveExportRows(input.desk.properties, batch.rows);
    const rowsByProperty = new Map();
    for (const row of resolved.matched) {
        rowsByProperty.set(row.propertyId, (rowsByProperty.get(row.propertyId) ?? 0) + 1);
    }
    const conflictedIds = new Set();
    let duplicateRows = 0;
    for (const [propertyId, count] of rowsByProperty) {
        if (count > 1) {
            conflictedIds.add(propertyId);
            duplicateRows += count;
        }
    }
    for (const item of resolved.ambiguous) {
        for (const propertyId of item.ids)
            conflictedIds.add(propertyId);
    }
    const matchedProperties = resolved.matched.filter((row) => !conflictedIds.has(row.propertyId)).length;
    const rowsNeedingLink = resolved.unmatched.length + resolved.ambiguous.length;
    const missingProperties = Math.max(0, input.desk.properties.length - matchedProperties - conflictedIds.size);
    const warnings = [];
    if (matchedProperties === 0) {
        warnings.push("No row currently matches the property book. The import will stay held and will not verify live balances.");
    }
    if (rowsNeedingLink > 0) {
        warnings.push(`${rowsNeedingLink} ${rowsNeedingLink === 1 ? "row needs" : "rows need"} a property link or rejection on Desk.`);
    }
    if (duplicateRows > 0) {
        warnings.push(`${duplicateRows} rows repeat a matched property. Those properties will be held instead of using the last row.`);
    }
    if (missingProperties > 0) {
        warnings.push(`${missingProperties} active ${missingProperties === 1 ? "property is" : "properties are"} absent from this export and will remain held.`);
    }
    return {
        kind: "realbud.pms-import-preview.v1",
        deskRevision: input.desk.revision,
        csvDigest: pmsCsvDigest(input.csv),
        observedAt: input.observedAt,
        bytes: Buffer.byteLength(input.csv, "utf8"),
        totalRows: batch.rows.length,
        identityKind: batch.columns.identity.kind,
        columns: previewColumns(batch),
        matchedProperties,
        rowsNeedingLink,
        conflictingProperties: conflictedIds.size,
        duplicateRows,
        missingProperties,
        willVerifyLiveBook: matchedProperties > 0,
        warnings,
    };
}

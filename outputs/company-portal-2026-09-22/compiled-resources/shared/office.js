// Eight visit fields from docs/PILOT-CONTRACT.md. Empty until a named
// office fills them. Training names do not count as an agency.
import { parseRentWorkflow } from "./rent-workflow.js";
export const AU_JURISDICTIONS = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"];
export const PMS_BRANDS = ["propertyme", "property-tree", "reapit-pm", "other"];
export const EXPORT_CADENCES = ["daily", "twice-weekly", "weekly", "other"];
export const EXPORT_IDENTITY_COLUMNS = ["property-id", "address", "property-code"];
export const OFFICE_OS = ["macos", "windows", "linux"];
export const PMS_BRAND_LABELS = {
    propertyme: "PropertyMe",
    "property-tree": "Property Tree",
    "reapit-pm": "Reapit PM",
    other: "Other",
};
export const EXPORT_CADENCE_LABELS = {
    daily: "Daily",
    "twice-weekly": "Twice weekly",
    weekly: "Weekly",
    other: "Other",
};
export const EXPORT_IDENTITY_LABELS = {
    "property-id": "Property id",
    address: "Address",
    "property-code": "Property code",
};
export const OFFICE_OS_LABELS = {
    macos: "macOS",
    windows: "Windows",
    linux: "Linux",
};
const TRAINING_AGENCY = new Set(["demo agency", "realbud demo book"]);
const FIELD_MAX = 80;
/**
 * How long a closed or wound-down office's encrypted book is kept before its
 * key may be destroyed. This is the office's own policy, not a statutory
 * period: RealBud must never invent a legal clock, so the default is a plain
 * operational choice the office can change.
 *
 * `null` means "keep until a person decides" — never destroy automatically.
 */
export const DEFAULT_RETENTION_DAYS = 90;
/** Below a week the window is almost certainly a typo rather than a policy. */
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 3650;
/**
 * Retention is whole days, or null to keep until a person decides. The floor
 * matters because this number decides when a book becomes unreadable: a typo of
 * 0 would mean "destroy now".
 */
export function parseRetentionDays(value) {
    if (value === null)
        return { ok: true, value: null };
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return { ok: false, error: "Retention must be a whole number of days, or empty to keep the book until you decide." };
    }
    if (value < MIN_RETENTION_DAYS) {
        return { ok: false, error: `Retention must be at least ${MIN_RETENTION_DAYS} days. A shorter window would destroy the book almost immediately.` };
    }
    if (value > MAX_RETENTION_DAYS) {
        return { ok: false, error: `Retention must be ${MAX_RETENTION_DAYS} days or fewer. Choose no value to keep the book until you decide.` };
    }
    return { ok: true, value };
}
export function emptyOffice() {
    return {
        pmUser: "",
        pmsBrand: "",
        namedExporter: "",
        exportCadence: "",
        exportIdentity: "",
        officeOs: "",
        vendorTestAccount: "",
    };
}
export function coerceOffice(value) {
    const raw = value ?? emptyOffice();
    const rentWorkflow = raw.rentWorkflow === undefined ? undefined : parseRentWorkflow(raw.rentWorkflow);
    return {
        pmUser: String(raw.pmUser ?? ""),
        pmsBrand: readClosed(String(raw.pmsBrand ?? ""), PMS_BRANDS),
        namedExporter: String(raw.namedExporter ?? ""),
        exportCadence: readClosed(String(raw.exportCadence ?? ""), EXPORT_CADENCES),
        exportIdentity: readClosed(String(raw.exportIdentity ?? ""), EXPORT_IDENTITY_COLUMNS),
        officeOs: readClosed(String(raw.officeOs ?? ""), OFFICE_OS),
        vendorTestAccount: String(raw.vendorTestAccount ?? ""),
        ...(rentWorkflow?.ok ? { rentWorkflow: rentWorkflow.value } : {}),
    };
}
export function agencyIsNamed(name) {
    const trimmed = String(name ?? "").trim();
    return trimmed.length > 0 && !TRAINING_AGENCY.has(trimmed.toLowerCase());
}
export function officeTicks(input) {
    const office = input.office;
    return [
        {
            id: "agency-pm",
            label: "Agency and named PM",
            done: agencyIsNamed(input.agencyName) && office.pmUser.trim().length > 0,
        },
        { id: "pms-brand", label: "PMS brand", done: office.pmsBrand !== "" },
        { id: "exporter", label: "Named exporter", done: office.namedExporter.trim().length > 0 },
        { id: "cadence", label: "Export cadence", done: office.exportCadence !== "" },
        { id: "identity", label: "Export identity column", done: office.exportIdentity !== "" },
        { id: "office-os", label: "Office OS", done: office.officeOs !== "" },
        { id: "jurisdictions", label: "Book jurisdictions", done: input.jurisdictions.length > 0 },
        { id: "vendor-test", label: "Vendor test account", done: office.vendorTestAccount.trim().length > 0 },
    ];
}
export function officeFilledCount(input) {
    return officeTicks(input).filter((tick) => tick.done).length;
}
export function officeContractComplete(input) {
    return officeTicks(input).every((tick) => tick.done);
}
function closedOrEmpty(value, allowed, field) {
    if (value === "" || value === undefined || value === null)
        return { ok: true, value: "" };
    if (typeof value === "string" && allowed.includes(value)) {
        return { ok: true, value: value };
    }
    return { ok: false, error: `${field} is not a known value` };
}
function shortText(value, field) {
    if (typeof value !== "string")
        return { ok: false, error: `${field} must be a string` };
    const trimmed = value.trim();
    if (trimmed.length > FIELD_MAX)
        return { ok: false, error: `${field} is too long` };
    return { ok: true, value: trimmed };
}
export function parseOfficePatch(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { ok: false, error: "office must be an object" };
    }
    const rec = input;
    const value = {};
    if ("rentWorkflow" in rec) {
        const parsed = parseRentWorkflow(rec.rentWorkflow);
        if (!parsed.ok)
            return parsed;
        value.rentWorkflow = parsed.value;
    }
    if ("pmUser" in rec) {
        const parsed = shortText(rec.pmUser, "pm user");
        if (!parsed.ok)
            return parsed;
        value.pmUser = parsed.value;
    }
    if ("namedExporter" in rec) {
        const parsed = shortText(rec.namedExporter, "named exporter");
        if (!parsed.ok)
            return parsed;
        value.namedExporter = parsed.value;
    }
    if ("vendorTestAccount" in rec) {
        const parsed = shortText(rec.vendorTestAccount, "vendor test account");
        if (!parsed.ok)
            return parsed;
        value.vendorTestAccount = parsed.value;
    }
    if ("pmsBrand" in rec) {
        const parsed = closedOrEmpty(rec.pmsBrand, PMS_BRANDS, "pmsBrand");
        if (!parsed.ok)
            return parsed;
        value.pmsBrand = parsed.value;
    }
    if ("exportCadence" in rec) {
        const parsed = closedOrEmpty(rec.exportCadence, EXPORT_CADENCES, "exportCadence");
        if (!parsed.ok)
            return parsed;
        value.exportCadence = parsed.value;
    }
    if ("exportIdentity" in rec) {
        const parsed = closedOrEmpty(rec.exportIdentity, EXPORT_IDENTITY_COLUMNS, "exportIdentity");
        if (!parsed.ok)
            return parsed;
        value.exportIdentity = parsed.value;
    }
    if ("officeOs" in rec) {
        const parsed = closedOrEmpty(rec.officeOs, OFFICE_OS, "officeOs");
        if (!parsed.ok)
            return parsed;
        value.officeOs = parsed.value;
    }
    return { ok: true, value };
}
export function readClosed(value, allowed) {
    if (value === "")
        return "";
    for (const item of allowed) {
        if (item === value)
            return item;
    }
    return "";
}
export function parseJurisdictions(input) {
    if (!Array.isArray(input))
        return [];
    const allowed = new Set(AU_JURISDICTIONS);
    const seen = new Set();
    const next = [];
    for (const item of input) {
        const token = String(item).trim().toUpperCase();
        if (!allowed.has(token) || seen.has(token))
            continue;
        seen.add(token);
        next.push(token);
    }
    return next;
}

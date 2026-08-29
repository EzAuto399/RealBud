// Eight visit fields from docs/PILOT-CONTRACT.md. Empty until a named
// office fills them. Training names do not count as an agency.

export const AU_JURISDICTIONS = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;
export const PMS_BRANDS = ["propertyme", "property-tree", "reapit-pm", "other"] as const;
export const EXPORT_CADENCES = ["daily", "twice-weekly", "weekly", "other"] as const;
export const EXPORT_IDENTITY_COLUMNS = ["property-id", "address", "property-code"] as const;
export const OFFICE_OS = ["macos", "windows", "linux"] as const;

export type AuJurisdiction = (typeof AU_JURISDICTIONS)[number];
export type PmsBrand = (typeof PMS_BRANDS)[number];
export type ExportCadence = (typeof EXPORT_CADENCES)[number];
export type ExportIdentity = (typeof EXPORT_IDENTITY_COLUMNS)[number];
export type OfficeOs = (typeof OFFICE_OS)[number];

export interface Office {
  pmUser: string;
  pmsBrand: PmsBrand | "";
  namedExporter: string;
  exportCadence: ExportCadence | "";
  exportIdentity: ExportIdentity | "";
  officeOs: OfficeOs | "";
  vendorTestAccount: string;
}

export const PMS_BRAND_LABELS: Record<PmsBrand, string> = {
  propertyme: "PropertyMe",
  "property-tree": "Property Tree",
  "reapit-pm": "Reapit PM",
  other: "Other",
};

export const EXPORT_CADENCE_LABELS: Record<ExportCadence, string> = {
  daily: "Daily",
  "twice-weekly": "Twice weekly",
  weekly: "Weekly",
  other: "Other",
};

export const EXPORT_IDENTITY_LABELS: Record<ExportIdentity, string> = {
  "property-id": "Property id",
  address: "Address",
  "property-code": "Property code",
};

export const OFFICE_OS_LABELS: Record<OfficeOs, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

const TRAINING_AGENCY = new Set(["demo agency", "realbud demo book"]);
const FIELD_MAX = 80;

export function emptyOffice(): Office {
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

export type OfficeInput = {
  pmUser?: string;
  pmsBrand?: string;
  namedExporter?: string;
  exportCadence?: string;
  exportIdentity?: string;
  officeOs?: string;
  vendorTestAccount?: string;
};

export function coerceOffice(value: OfficeInput | null | undefined): Office {
  const raw = value ?? emptyOffice();
  return {
    pmUser: String(raw.pmUser ?? ""),
    pmsBrand: readClosed(String(raw.pmsBrand ?? ""), PMS_BRANDS),
    namedExporter: String(raw.namedExporter ?? ""),
    exportCadence: readClosed(String(raw.exportCadence ?? ""), EXPORT_CADENCES),
    exportIdentity: readClosed(String(raw.exportIdentity ?? ""), EXPORT_IDENTITY_COLUMNS),
    officeOs: readClosed(String(raw.officeOs ?? ""), OFFICE_OS),
    vendorTestAccount: String(raw.vendorTestAccount ?? ""),
  };
}

export function agencyIsNamed(name: string | undefined): boolean {
  const trimmed = String(name ?? "").trim();
  return trimmed.length > 0 && !TRAINING_AGENCY.has(trimmed.toLowerCase());
}

export type OfficeTickId =
  | "agency-pm"
  | "pms-brand"
  | "exporter"
  | "cadence"
  | "identity"
  | "office-os"
  | "jurisdictions"
  | "vendor-test";

export interface OfficeTick {
  id: OfficeTickId;
  label: string;
  done: boolean;
}

export function officeTicks(input: {
  agencyName: string;
  jurisdictions: readonly string[];
  office: Office;
}): OfficeTick[] {
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

export function officeFilledCount(input: {
  agencyName: string;
  jurisdictions: readonly string[];
  office: Office;
}): number {
  return officeTicks(input).filter((tick) => tick.done).length;
}

export function officeContractComplete(input: {
  agencyName: string;
  jurisdictions: readonly string[];
  office: Office;
}): boolean {
  return officeTicks(input).every((tick) => tick.done);
}

function closedOrEmpty<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): { ok: true; value: T | "" } | { ok: false; error: string } {
  if (value === "" || value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  return { ok: false, error: `${field} is not a known value` };
}

function shortText(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length > FIELD_MAX) return { ok: false, error: `${field} is too long` };
  return { ok: true, value: trimmed };
}

export function parseOfficePatch(input: unknown): { ok: true; value: Partial<Office> } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "office must be an object" };
  }
  const rec = input as Record<string, unknown>;
  const value: Partial<Office> = {};
  if ("pmUser" in rec) {
    const parsed = shortText(rec.pmUser, "pm user");
    if (!parsed.ok) return parsed;
    value.pmUser = parsed.value;
  }
  if ("namedExporter" in rec) {
    const parsed = shortText(rec.namedExporter, "named exporter");
    if (!parsed.ok) return parsed;
    value.namedExporter = parsed.value;
  }
  if ("vendorTestAccount" in rec) {
    const parsed = shortText(rec.vendorTestAccount, "vendor test account");
    if (!parsed.ok) return parsed;
    value.vendorTestAccount = parsed.value;
  }
  if ("pmsBrand" in rec) {
    const parsed = closedOrEmpty(rec.pmsBrand, PMS_BRANDS, "pmsBrand");
    if (!parsed.ok) return parsed;
    value.pmsBrand = parsed.value;
  }
  if ("exportCadence" in rec) {
    const parsed = closedOrEmpty(rec.exportCadence, EXPORT_CADENCES, "exportCadence");
    if (!parsed.ok) return parsed;
    value.exportCadence = parsed.value;
  }
  if ("exportIdentity" in rec) {
    const parsed = closedOrEmpty(rec.exportIdentity, EXPORT_IDENTITY_COLUMNS, "exportIdentity");
    if (!parsed.ok) return parsed;
    value.exportIdentity = parsed.value;
  }
  if ("officeOs" in rec) {
    const parsed = closedOrEmpty(rec.officeOs, OFFICE_OS, "officeOs");
    if (!parsed.ok) return parsed;
    value.officeOs = parsed.value;
  }
  return { ok: true, value };
}

export function readClosed<T extends string>(value: string, allowed: readonly T[]): T | "" {
  if (value === "") return "";
  for (const item of allowed) {
    if (item === value) return item;
  }
  return "";
}

export function parseJurisdictions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<string>(AU_JURISDICTIONS);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of input) {
    const token = String(item).trim().toUpperCase();
    if (!allowed.has(token) || seen.has(token)) continue;
    seen.add(token);
    next.push(token);
  }
  return next;
}

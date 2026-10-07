// REI Cloud read → Desk. Maps the rows of the pack's read recipes (tenants list,
// arrears, owners) onto Desk facts; Desk applies them with the source-of-truth
// rule (docs/decisions/2026-10-06-rei-source-of-truth-and-client-packs.md):
// REI wins, a Desk edit is held as "Differs from REI", a new property is a
// card, and an unmatched or ambiguous row is held work.
// Read-only: this only reads a finished run's rows. It never drives the
// browser and never writes to REI.
// The column names are the fictional portal's (server/testing/fictional-rei-portal.ts),
// shaped after a read-only look at live REI. They need a real REI export sample
// before a live read is trusted.
import type { Property, ReiField, ReiFieldValue, ReiRefs } from "../shared/contracts.ts";
import { matchExportRow } from "./csv-ledger.ts";
import type { Desk, ReiDeskApplied, ReiDeskRead } from "./desk.ts";
import type { PortalRunRequest } from "./portal-recipe-runner.ts";
import type { FilteredPortalResult } from "./portal-recipe.ts";
import { reiPartsFreshness } from "./source-gate.ts";

export const REI_PARTS = ["tenants", "arrears", "owners"] as const;
export type ReiPart = (typeof REI_PARTS)[number];

/** The Desk part a recipe run reads, or null. A search (find-record with a query) reads some rows of a part, never all of it. */
export function reiPartOf(run: PortalRunRequest): { part: ReiPart; whole: boolean } | null {
  if (run.recipe === "arrears-review") return { part: "arrears", whole: true };
  const whole = !run.inputs?.query?.trim();
  if (run.recipe === "find-record" && run.inputs?.list === "Tenants") return { part: "tenants", whole };
  if (run.recipe === "find-record" && run.inputs?.list === "Owners") return { part: "owners", whole };
  return null;
}

/** Every page was read: the run finished the recipe, no page came back cut short, and the grid showed its own record count and every one was read
 * (counted before RealBud's row filter, server/portal-recipe.ts). Without that count nothing proves the read whole. */
const complete = (result: FilteredPortalResult) =>
  result.outcome === "completed" && result.table !== "unread" && !result.truncated && result.footer !== undefined && (result.filtered?.read ?? result.rows.length) >= result.footer;

const tidy = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
function cell(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const key = Object.keys(row).find((header) => tidy(header) === tidy(name));
    if (key && row[key].trim()) return row[key].trim();
  }
  return "";
}
function cents(text: string): number | undefined {
  const clean = text.replace(/[$,\s]/g, "");
  return /^-?\d+(\.\d{1,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : undefined;
}
/** "$540.00 per week", "$660.00 per fortnight", "$2,400.00 per month" → weekly cents. */
function weeklyCents(text: string): number | undefined {
  const match = /\$?([\d,]+(?:\.\d{1,2})?)\s*(?:per\s+|\/\s*)?(week|wk|fortnight|month)/i.exec(text);
  const amount = match ? cents(match[1]) : undefined;
  if (!match || !amount) return undefined;
  const per = match[2].toLowerCase();
  return per === "fortnight" ? Math.round(amount / 2) : per === "month" ? Math.round((amount * 12) / 52) : amount;
}
function isoDate(text: string): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  return dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : undefined;
}
const defined = (values: Partial<Record<ReiField, ReiFieldValue | undefined>>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== "")) as Partial<Record<ReiField, ReiFieldValue>>;

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** Maps a read onto Desk. Pure: `properties` is the book as it stands. */
export function reiDeskRead(properties: Property[], runs: PortalRunRequest[], results: FilteredPortalResult[], observedAt: number): ReiDeskRead {
  const read: ReiDeskRead = { observedAt, updates: [], proposals: [], holds: [], fresh: [] };
  const parts = new Map<ReiPart, Array<Record<string, string>>>();
  // A part is fresh only when every read of it in this run was whole and complete.
  const fresh = new Map<ReiPart, boolean>();
  runs.forEach((run, index) => {
    const part = reiPartOf(run);
    const result = results[index];
    if (!part) return;
    fresh.set(part.part, (fresh.get(part.part) ?? true) && Boolean(result) && part.whole && complete(result));
    if (result && result.table !== "unread") parts.set(part.part, [...(parts.get(part.part) ?? []), ...result.rows]);
  });
  read.fresh = [...fresh].filter(([, ok]) => ok).map(([part]) => part);
  // Only a part read whole is applied: rows of a partial read neither change Desk nor raise holds
  // (a row missing from a cut-off page is not proof that anything is unmatched).
  for (const part of [...parts.keys()]) if (!read.fresh.includes(part)) parts.delete(part);
  const hold = (identity: string, kind: "unmatched" | "ambiguous", detail: string) => read.holds.push({ identity, kind, detail });
  /** Owner names this read gives each property (and new ones), so an owners row can find its property in the same read. */
  const ownerOf = new Map<string, string>();
  const ownersSeen = new Set<string>();

  // Tenants: one row per tenancy, keyed by REI's property reference (or address).
  const tenants = parts.get("tenants") ?? [];
  const byProperty = groupBy(tenants, (row) => tidy(cell(row, "Property")));
  for (const [key, rows] of byProperty) {
    const first = rows[0];
    const propertyRef = cell(first, "Property");
    if (!key) {
      for (const row of rows) hold(`REI tenant ${cell(row, "Reference") || cell(row, "Surname", "Name")}`, "unmatched", "REI shows no property for this tenant");
      continue;
    }
    if (rows.length > 1) {
      hold(`REI property ${propertyRef}`, "ambiguous", `${rows.length} REI tenancies show this property (${rows.map((row) => cell(row, "Reference")).join(", ")})`);
      continue;
    }
    const tenantName = [cell(first, "Firstname", "First name"), cell(first, "Surname")].filter(Boolean).join(" ") || cell(first, "Name");
    const ownerName = cell(first, "Owner");
    if (ownerName) ownersSeen.add(tidy(ownerName));
    const values = defined({
      tenantName,
      weeklyRentCents: weeklyCents(cell(first, "Rent")),
      paidTo: isoDate(cell(first, "Paid To")),
      amountOwingCents: cents(cell(first, "Amount Owing")),
      ownerName,
    });
    const refs: ReiRefs = { property: propertyRef, ...(cell(first, "Reference") ? { tenancy: cell(first, "Reference") } : {}) };
    let hit = matchExportRow(properties, { identity: { kind: "code", value: propertyRef } });
    if (!hit.ok && hit.reason === "unmatched") hit = matchExportRow(properties, { identity: { kind: "address", value: propertyRef } });
    if (hit.ok) {
      read.updates.push({ propertyId: hit.propertyId, values, refs });
      if (ownerName) ownerOf.set(hit.propertyId, ownerName);
    } else if (hit.reason === "ambiguous") {
      hold(`REI property ${propertyRef}`, "ambiguous", `REI's property ${propertyRef} matches ${hit.ids.length} Desk properties (${hit.ids.join(", ")})`);
    } else if (tenantName && typeof values.weeklyRentCents === "number") {
      read.proposals.push({ address: propertyRef, tenantName, weeklyRentCents: values.weeklyRentCents, ...(ownerName ? { ownerName } : {}), rei: refs });
    } else {
      hold(`REI property ${propertyRef}`, "unmatched", "REI shows this property without a tenant or rent RealBud can read");
    }
  }

  // Arrears: keyed by tenant name only, so a name must match exactly one Desk tenant.
  const arrears = parts.get("arrears") ?? [];
  for (const [key, rows] of groupBy(arrears, (row) => tidy(cell(row, "Name")))) {
    const name = cell(rows[0], "Name");
    if (!key) continue;
    if (rows.length > 1) {
      hold(`REI arrears ${name}`, "ambiguous", `${rows.length} REI arrears rows show this name`);
      continue;
    }
    const ids = properties.filter((property) => tidy(property.tenantName) === key).map((property) => property.id);
    if (ids.length > 1) hold(`REI arrears ${name}`, "ambiguous", `this name matches ${ids.length} Desk tenants (${ids.join(", ")})`);
    else if (!ids.length) hold(`REI arrears ${name}`, "unmatched", "no Desk tenant has this name");
    else read.updates.push({ propertyId: ids[0], values: defined({ paidTo: isoDate(cell(rows[0], "Paid to")), amountOwingCents: cents(cell(rows[0], "Amount owing")) }) });
  }

  // Owners: an owner may hold several properties; each gets the owner's contact and reference.
  for (const row of parts.get("owners") ?? []) {
    const name = cell(row, "Name", "Owner");
    if (!name) continue;
    const ref = cell(row, "Reference");
    const ids = properties
      .filter((property) => (ref && property.rei?.owner === ref) || tidy(ownerOf.get(property.id) ?? property.owner?.name ?? "") === tidy(name))
      .map((property) => property.id);
    if (!ids.length) {
      if (!ownersSeen.has(tidy(name))) hold(`REI owner ${name}`, "unmatched", "no Desk property has this owner");
      continue;
    }
    const contact = cell(row, "Email", "Mobile", "Phone");
    for (const propertyId of ids) {
      read.updates.push({ propertyId, values: defined({ ownerName: name, ownerContact: contact }), ...(ref ? { refs: { owner: ref } } : {}) });
    }
  }
  return read;
}

export interface ReiDeskSync extends ReiDeskApplied { stale: ReiPart[] }

/** Applies a finished REI read to Desk; null when the run read no Desk part. */
export function syncReiReadIntoDesk(desk: Desk, input: { runs: PortalRunRequest[]; results: FilteredPortalResult[]; observedAt: number; now?: number }): ReiDeskSync | null {
  if (!input.runs.some((run) => reiPartOf(run))) return null;
  const read = reiDeskRead(desk.snapshot().properties, input.runs, input.results, input.observedAt);
  const applied = desk.applyReiRead(read);
  const fresh = reiPartsFreshness(REI_PARTS, desk.snapshot().sources, input.now ?? input.observedAt);
  return { ...applied, stale: REI_PARTS.filter((part) => !fresh[part]) };
}

/** One line for the person, after the portal read's own reply. `freshness: false` leaves out the freshness sentence. */
export function reiDeskSyncLine(sync: ReiDeskSync, freshness = true): string {
  const bits = [`${sync.updated} propert${sync.updated === 1 ? "y" : "ies"} updated from REI`];
  if (sync.differs) bits.push(`${sync.differs} Desk value${sync.differs === 1 ? "" : "s"} differ${sync.differs === 1 ? "s" : ""} from REI and wait${sync.differs === 1 ? "s" : ""} for you to pick`);
  if (sync.proposed) bits.push(`${sync.proposed} new propert${sync.proposed === 1 ? "y" : "ies"} proposed for you to add`);
  if (sync.held) bits.push(`${sync.held} row${sync.held === 1 ? "" : "s"} held for you to match`);
  if (!freshness) return `Desk: ${bits.join("; ")}.`;
  return `Desk: ${bits.join("; ")}. ${sync.stale.length ? `Not fresh from REI: ${sync.stale.join(", ")}.` : "Every part is fresh from REI."}`;
}

// What a properly created property record looks like — derived from the
// snapshot's own data, never stored. An incomplete record still works;
// this is a quiet guide, not a blocker. See docs/LAW-LAYER.md.
import type { Property } from "./desk";

/** The slice of the book completeness reads — the card's own filtered rows
 * or the snapshot's book view; both carry these shapes. */
export interface CompletenessBook {
  tenancies: ReadonlyArray<{ propertyId: string; status: string }>;
  contacts: ReadonlyArray<{ propertyId: string; role: string; name: string }>;
}

export interface Completeness {
  have: number;
  total: number;
  /** PM-language labels for what's missing, in the order a PM would care. */
  missing: string[];
}

export function propertyCompleteness(property: Property, book?: CompletenessBook | null): Completeness {
  const missing: string[] = [];
  if (!property.address?.trim()) missing.push("address");
  if (!property.tenantName?.trim()) missing.push("tenant name");
  if (!property.tenantPhone?.trim()) missing.push("tenant phone");
  if (!(property.weeklyRentCents > 0)) missing.push("weekly rent");

  const hasOwner = Boolean(
    book?.contacts.some((c) => c.propertyId === property.id && c.role === "owner" && c.name.trim()),
  );
  if (!hasOwner) missing.push("owner contact");
  const hasCurrentTenancy = Boolean(
    book?.tenancies.some((t) => t.propertyId === property.id && t.status === "current"),
  );
  if (!hasCurrentTenancy) missing.push("current tenancy");
  if (!property.propertyCode?.trim()) missing.push("property code");
  if (!property.notes?.trim()) missing.push("notes");

  return { have: 8 - missing.length, total: 8, missing };
}

/** Highlight useful missing facts without turning optional notes/codes into chores. */
export function completenessLine(c: Completeness): string | null {
  const missing = c.missing.filter(field => field !== "notes" && field !== "property code");
  return missing.length ? `Not recorded: ${missing.join(", ")}` : null;
}

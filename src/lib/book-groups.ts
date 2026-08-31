// Portfolio shape for real books: at 20+ properties a flat list stops working.
// Grouping is derived from the address — no extra data entry. Units cluster
// under their building, buildings under their suburb.
import type { LedgerFacts, Property } from "./desk";

/** "4/22 Harbour Rd, Kingston ACT" and "Unit 3, 12 Oak St, Dickson ACT" share
 * a building when their stems match: unit designators stripped, rest lowered. */
export function buildingKey(address: string): string {
  let rest = address.trim();
  rest = rest.replace(/^(unit|apt|apartment|shop|suite|flat|villa|townhouse|lot)\s+\S+?\s*,\s*/i, "");
  rest = rest.replace(/^[a-z0-9]+\s*\/\s*/i, "");
  return rest.toLowerCase();
}

/** Everything after the first comma — "4/22 Harbour Rd, Kingston ACT" → "Kingston ACT". */
export function suburbOf(address: string): string {
  const i = address.indexOf(",");
  return (i >= 0 ? address.slice(i + 1) : "").trim() || "No suburb";
}

const byAddress = (a: Property, b: Property) => a.address.localeCompare(b.address, "en-AU", { numeric: true });

export interface SuburbGroup {
  suburb: string;
  weeklyRentCents: number;
  properties: Property[];
}

/** Suburb groups, A-Z; inside one, buildings cluster and units order naturally. */
export function groupBySuburb(properties: Property[]): SuburbGroup[] {
  const groups = new Map<string, Property[]>();
  for (const property of properties) {
    const suburb = suburbOf(property.address);
    groups.set(suburb, [...(groups.get(suburb) ?? []), property]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([suburb, props]) => ({
      suburb,
      weeklyRentCents: props.reduce((sum, p) => sum + p.weeklyRentCents, 0),
      properties: [...props].sort((a, b) => buildingKey(a.address).localeCompare(buildingKey(b.address)) || byAddress(a, b)),
    }));
}

export type BookSort = "address" | "rent" | "late";

/** Flat orderings for when the PM is hunting, not browsing. */
export function sortBook(properties: Property[], ledger: LedgerFacts[], sort: BookSort): Property[] {
  const daysLate = new Map(ledger.map((row) => [row.propertyId, row.daysSinceDue]));
  const sorted = [...properties];
  if (sort === "rent") sorted.sort((a, b) => b.weeklyRentCents - a.weeklyRentCents || byAddress(a, b));
  else if (sort === "late") {
    // Unknown facts sort last — a miss must never read as zero days late.
    sorted.sort((a, b) => (daysLate.get(b.id) ?? -1) - (daysLate.get(a.id) ?? -1) || byAddress(a, b));
  } else sorted.sort(byAddress);
  return sorted;
}

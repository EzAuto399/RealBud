// Portfolio shape for real books: at 20+ properties a flat list stops working.
// Grouping is derived from the address — no extra data entry. Units cluster
// under their building, buildings under their suburb.
import type { LedgerFacts, Property } from "./desk";

/** Only explicit unit prefixes are removed. Locality remains part of identity. */
export function buildingAddress(address: string): string {
  return address.trim()
    .replace(/^(?:unit|apt|apartment|shop|suite|flat|villa|townhouse)\s+[a-z0-9-]+\s*(?:,\s*|\s+)(?=\d)/i, "")
    .replace(/^[a-z0-9-]+\s*\/\s*(?=\d)/i, "")
    .replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ");
}
export function buildingKey(address: string): string {
  return buildingAddress(address).toLowerCase().replace(/\b(street|road|avenue|drive|court|close|crescent|lane|parade)\b(?=,|$)/g,
    word => ({ street: "st", road: "rd", avenue: "ave", drive: "dr", court: "ct", close: "cl", crescent: "cres", lane: "ln", parade: "pde" })[word]!);
}

/** Remove a unit prefix before finding the locality separator. */
export function suburbOf(address: string): string {
  const building = buildingAddress(address);
  const i = building.indexOf(",");
  return (i >= 0 ? building.slice(i + 1) : "").trim() || "No suburb";
}

export type PropertyGrouping = "none" | "building" | "suburb" | "portal";
export interface PropertyScope { label: string; ids: string[] }
export interface PropertyGroup { key: string; label: string; detail: string; properties: Property[]; weeklyRentCents: number }

/** Each property occurs once. These are browsing groups, never record merges. */
export function groupProperties(properties: Property[], grouping: Exclude<PropertyGrouping, "none">,
  portals: NonNullable<import("./desk").DeskSnapshot["book"]>["propertyPortals"] = []): PropertyGroup[] {
  const links = new Map(portals.map(row => [row.propertyId, row]));
  const groups = new Map<string, PropertyGroup>();
  for (const property of properties) {
    let key: string, label: string, detail: string;
    if (grouping === "building") {
      const identified = suburbOf(property.address) !== "No suburb" && /^\d/.test(buildingAddress(property.address));
      key = identified ? buildingKey(property.address) : `unresolved:${property.id}`;
      label = identified ? buildingAddress(property.address) : property.address;
      detail = identified ? "Grouped by street address" : "Address needs a locality to group safely";
    } else if (grouping === "suburb") {
      label = suburbOf(property.address); key = label.toLowerCase(); detail = "Properties in this area";
    } else {
      const link = links.get(property.id);
      const origins = [...new Set(link?.origins ?? [])].sort();
      key = link?.unresolved ? "unresolved" : origins.length ? JSON.stringify(origins) : "unlinked";
      label = link?.unresolved ? "Portal link needs review" : origins.length ? origins.join(" · ") : "No portal linked";
      detail = link?.unresolved ? "A saved link could not be resolved" : origins.length ? "Saved portal links · connection not checked" : "No saved portal binding for these properties";
    }
    let group = groups.get(key);
    if (!group) { group = { key, label, detail, properties: [], weeklyRentCents: 0 }; groups.set(key, group); }
    group.properties.push(property); group.weeklyRentCents += property.weeklyRentCents;
  }
  return [...groups.values()].sort((a,b) => a.label.localeCompare(b.label, "en-AU", { numeric: true }))
    .map(group => ({ ...group, properties: group.properties.sort(byAddress) }));
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
    const members = groups.get(suburb) ?? [];
    members.push(property);
    groups.set(suburb, members);
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

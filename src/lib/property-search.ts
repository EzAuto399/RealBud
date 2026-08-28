import type { Property } from "./desk";

function searchable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-AU")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Search the book by the labels a PM is likely to have in front of them.
 * Results are stable and address-sorted, so a 200-property book does not
 * jump around while the PM narrows it. */
export function filterProperties(properties: readonly Property[], query: string): Property[] {
  const phrase = searchable(query);
  const terms = phrase.split(" ").filter(Boolean);
  return properties
    .map((property, index) => ({
      property,
      index,
      address: searchable(property.address),
      details: searchable(`${property.address} ${property.tenantName}`),
      propertyId: searchable(property.id),
    }))
    .filter((entry) => {
      if (!terms.length) return true;
      // Do not let one token match a tenant while another happens to match
      // digits in an opaque UUID. Human-facing details take token search;
      // an id is searched as the single phrase the PM actually entered.
      return terms.every((term) => entry.details.includes(term)) || (phrase.length >= 4 && entry.propertyId.includes(phrase));
    })
    .sort((left, right) => {
      if (terms.length) {
        const leftRank = left.address.startsWith(phrase) ? 0 : left.address.includes(phrase) ? 1 : 2;
        const rightRank = right.address.startsWith(phrase) ? 0 : right.address.includes(phrase) ? 1 : 2;
        if (leftRank !== rightRank) return leftRank - rightRank;
      }
      return left.property.address.localeCompare(right.property.address, "en-AU", { numeric: true }) || left.index - right.index;
    })
    .map((entry) => entry.property);
}

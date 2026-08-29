/** Named Composio reads and any safe toolkit slug. Not the marketplace catalog. */

export const OFFICE_COMPOSIO_SLUGS = ["gmail", "googlecalendar", "outlook"] as const;

export type OfficeComposioSlug = (typeof OFFICE_COMPOSIO_SLUGS)[number];

export function isOfficeComposioSlug(value: string): value is OfficeComposioSlug {
  return (OFFICE_COMPOSIO_SLUGS as readonly string[]).includes(value);
}

export function isSafeToolkitSlug(value: string): boolean {
  return /^[a-z][a-z0-9]{1,31}$/.test(value);
}

export function parseOfficeSourceServices(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const slug = part.trim().toLowerCase();
    if (isSafeToolkitSlug(slug)) seen.add(slug);
  }
  return [...seen];
}

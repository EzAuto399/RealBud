export type ConnectionCategoryId = "common" | "all" | "portfolio" | "inbox" | "desktop" | "pocket";

export type ConnectionDiscoveryId =
  | "property-book"
  | "inbound-mail-calendar"
  | "advanced-work"
  | "computer-use"
  | "desktop-reminders"
  | "telegram"
  | "whatsapp-business";

export interface ConnectionDiscoveryItem {
  id: ConnectionDiscoveryId;
  category: Exclude<ConnectionCategoryId, "all" | "common">;
  label: string;
  description: string;
  keywords: string[];
  common?: boolean;
}

/** Closed product index for the approved capabilities visible in You.
 * Search changes presentation only; it never discovers or grants tools. */
export const CONNECTION_DISCOVERY_ITEMS: readonly ConnectionDiscoveryItem[] = [
  {
    id: "property-book",
    category: "portfolio",
    label: "Property and money source",
    description: "Structured PMS exports, read-only bank comparison, portfolio matching and current money evidence.",
    keywords: ["property", "portfolio", "book", "money", "rent", "arrears", "bank", "payment", "credit", "pms", "propertyme", "property tree", "reapit", "csv", "excel", "spreadsheet", "pdf", "document", "screenshot", "photo", "paste", "manual", "import", "export", "ledger", "source", "browser", "direct", "api"],
    common: true,
  },
  {
    id: "inbound-mail-calendar",
    category: "inbox",
    label: "Incoming mail and calendar",
    description: "Named read-only inbox triage, calendar context and reply drafts.",
    keywords: ["email", "mail", "inbox", "gmail", "outlook", "hotmail", "calendar", "reply", "triage", "api", "composio", "mcp"],
    common: true,
  },
  {
    id: "advanced-work",
    category: "desktop",
    label: "Advanced work methods",
    description: "Governed APIs, restricted connectors, isolated task recipes, cloud acceleration and recovery history.",
    keywords: ["advanced", "api", "composio", "mcp", "connector", "cloud", "history", "computer history", "cli", "task", "sandbox", "browser", "parallel"],
  },
  {
    id: "computer-use",
    category: "desktop",
    label: "Computer use",
    description: "Approved case-scoped browser handoffs on this Mac.",
    keywords: ["computer", "browser", "portal", "pms", "click", "cua", "driver", "desktop", "mac"],
    common: true,
  },
  {
    id: "desktop-reminders",
    category: "desktop",
    label: "Desktop reminders",
    description: "Private local alerts for failed or held routine work.",
    keywords: ["alert", "notification", "reminder", "routine", "schedule", "held", "failed", "desktop", "mac"],
  },
  {
    id: "telegram",
    category: "pocket",
    label: "Telegram",
    description: "One exact PM identity in a private Telegram chat.",
    keywords: ["telegram", "mobile", "phone", "message", "bot", "pocket", "channel"],
  },
  {
    id: "whatsapp-business",
    category: "pocket",
    label: "WhatsApp Business",
    description: "One exact PM number through Meta's official Cloud API.",
    keywords: ["whatsapp", "meta", "mobile", "phone", "message", "business", "cloud", "pocket", "channel"],
  },
] as const;

function searchableText(item: ConnectionDiscoveryItem): string {
  return [item.label, item.description, ...item.keywords]
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-AU");
}

export function filterConnectionDiscovery(
  query: string,
  category: ConnectionCategoryId,
): ConnectionDiscoveryItem[] {
  const terms = query
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-AU")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);

  return CONNECTION_DISCOVERY_ITEMS.filter((item) => {
    if (category === "common" && !item.common) return false;
    if (category !== "all" && category !== "common" && item.category !== category) return false;
    if (!terms.length) return true;
    const haystack = searchableText(item);
    return terms.every((term) => haystack.includes(term));
  });
}

export function categoryForYouFocus(focus?: string | null): ConnectionCategoryId {
  if (focus === "desktop-reminders" || focus === "computer-use") return "desktop";
  if (focus === "composio-account") return "inbox";
  return "common";
}

export function connectionSearchRequestsMethods(query: string): boolean {
  const terms = query
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-AU")
    .match(/[a-z0-9]+/g) ?? [];
  return terms.some((term) => term === "api" || term === "composio" || term === "mcp" || term === "bank" || term === "browser" || term === "cloud" || term === "history" || term === "cli" || term === "import" || term === "export" || term === "spreadsheet" || term === "screenshot" || term === "paste");
}

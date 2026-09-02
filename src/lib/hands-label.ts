import type { HandsSource } from "@shared/contracts";

/** User chrome only. Advanced diagnostics may still say Hermes. */
export function handsChip(hands: HandsSource): string {
  if (hands === "hermes") return "Bud live";
  if (hands === "csv") return "CSV live";
  if (hands === "held") return "Held";
  return "Demo";
}

export function handsFactSource(hands: HandsSource): string {
  if (hands === "hermes") return "from Bud";
  if (hands === "csv") return "from CSV";
  if (hands === "held") return "held";
  return "Demo";
}

export function sourceKindLabel(kind: string): string {
  if (kind === "hermes") return "Bud";
  return kind;
}

export type MissAction = { label: string; hash: "attach-model" | "you-worker" };

/** One recovery door from a Recheck miss detail. Null when the line has no implied next step. */
export function missAction(detail: string): MissAction | null {
  const text = detail.toLowerCase();
  if (/key|model connection|billing|credits|no model/.test(text)) {
    return { label: "Open model connection", hash: "attach-model" };
  }
  if (/not installed|cli not found|install|supported build/.test(text)) {
    return { label: "Install Bud", hash: "you-worker" };
  }
  if (/pack|safeguards|approvals|workroom/.test(text)) {
    return { label: "Open Bud setup", hash: "you-worker" };
  }
  return null;
}

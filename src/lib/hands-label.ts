import type { HandsSource } from "@shared/contracts";

/** User chrome only. Advanced diagnostics may still say Hermes. */
export function handsChip(hands: HandsSource): string {
  if (hands === "hermes") return "Worker live";
  if (hands === "csv") return "CSV live";
  if (hands === "held") return "Held";
  return "Demo";
}

export function handsFactSource(hands: HandsSource): string {
  if (hands === "hermes") return "from worker";
  if (hands === "csv") return "from CSV";
  if (hands === "held") return "held";
  return "Demo";
}

export function sourceKindLabel(kind: string): string {
  if (kind === "hermes") return "worker";
  return kind;
}

/** Micro-USD (1 USD = 1_000_000) keeps model cents off floating point. */

export const MICRO_PER_USD = 1_000_000;

export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd)) return 0;
  return Math.round(usd * MICRO_PER_USD);
}

export function microToUsd(micro: number): number {
  if (!Number.isFinite(micro)) return 0;
  return Math.round(micro) / MICRO_PER_USD;
}

/** Office-facing money. Tiny model calls stay visible below one cent. */
export function formatUsd(micro: number): string {
  const usd = microToUsd(micro);
  if (usd === 0) return "US$0.00";
  const abs = Math.abs(usd);
  const digits = abs < 0.01 ? 4 : 2;
  const signed = usd < 0 ? "-" : "";
  return `${signed}US$${abs.toFixed(digits)}`;
}

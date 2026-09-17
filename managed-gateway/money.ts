import { UNIT_NAMES, exact, integer, nano, object, requireThat, id, type RateCard, type Units, type ModelRate } from './contracts.ts';

export const NANO_PER_CENT = 10_000_000n;
export function cents(n: bigint): bigint { return n < 0n ? -cents(-n) : (n + NANO_PER_CENT / 2n) / NANO_PER_CENT; }
export function gstCents(grossCents: bigint): bigint { return grossCents < 0n ? -gstCents(-grossCents) : (grossCents + 5n) / 11n; }
export function validateUnits(value: unknown): asserts value is Units {
  object(value);
  for (const [unit, count] of Object.entries(value)) {
    requireThat(UNIT_NAMES.includes(unit as typeof UNIT_NAMES[number]), 'unsupported_unit'); integer(count);
  }
}
export function validateRateCard(card: RateCard) {
  object(card); exact(card as unknown as Record<string,unknown>, ['version','currency','gstInclusive','gstBasisPoints','publishedAt','effectiveAt','models']);
  id(card.version); requireThat(card.currency === 'AUD' && card.gstInclusive === true && card.gstBasisPoints === 1000, 'invalid_tax_currency');
  integer(card.publishedAt, Number.MAX_SAFE_INTEGER); integer(card.effectiveAt, Number.MAX_SAFE_INTEGER);
  requireThat(card.effectiveAt >= card.publishedAt && Array.isArray(card.models) && card.models.length > 0 && card.models.length <= 100, 'invalid_rate_card');
  const seen = new Set<string>();
  for (const model of card.models) {
    object(model); exact(model as unknown as Record<string,unknown>, ['model','label','units']); id(model.model);
    requireThat(!seen.has(model.model) && typeof model.label === 'string' && model.label.length > 0 && model.label.length <= 120, 'invalid_model_rate'); seen.add(model.model);
    object(model.units); requireThat(Object.keys(model.units).length > 0, 'missing_rates');
    for (const [unit, rate] of Object.entries(model.units)) {
      requireThat(UNIT_NAMES.includes(unit as typeof UNIT_NAMES[number]), 'unsupported_unit'); object(rate); exact(rate, ['nanoAud','perUnits']);
      nano(rate.nanoAud); integer(rate.perUnits); requireThat(rate.perUnits > 0, 'invalid_rate_denominator');
    }
  }
}
/** Round each measured unit category up only to 1 nano-AUD; round to cents once at invoice close. */
export function price(rate: ModelRate, units: Units): bigint {
  validateUnits(units); let total = 0n;
  for (const [unit,count] of Object.entries(units)) {
    const item = rate.units[unit as keyof Units]; requireThat(item, 'unpriced_unit', 409);
    const numerator = BigInt(count) * nano(item.nanoAud); const denominator = BigInt(item.perUnits);
    total += (numerator + denominator - 1n) / denominator;
  }
  return total;
}
export function modelRate(card: RateCard, model: string): ModelRate {
  const rate = card.models.find(r => r.model === model); requireThat(rate, 'model_not_in_rate_card', 409); return rate;
}
export function withinBound(usage: Units, bound: Units): boolean {
  return Object.entries(usage).every(([unit,count]) => count <= (bound[unit as keyof Units] ?? 0));
}
/** Brisbane has no DST. Billing periods and go-live anniversaries use its UTC+10 civil clock. */
export function periodAt(time: number): string { return new Date(time + 36_000_000).toISOString().slice(0,7); }
export function twoMonthsAfter(time: number): number {
  const d = new Date(time + 36_000_000); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 2);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 0)).getUTCDate(); d.setUTCDate(Math.min(day,lastDay)); return d.getTime() - 36_000_000;
}

export type RetailPolicy = { method: 'markup' | 'margin'; basisPoints: number; apply?: boolean };

/** Operator toggle: apply=false (or basisPoints 0) is GST-only pass-through. Clients never see this. */
export function effectiveBasisPoints(policy: RetailPolicy): number {
  integer(policy.basisPoints, 100_000);
  requireThat(policy.method === 'markup' || policy.method === 'margin', 'invalid_margin_method');
  requireThat(policy.method !== 'margin' || policy.basisPoints < 10_000, 'invalid_margin');
  requireThat(policy.apply === undefined || typeof policy.apply === 'boolean', 'invalid_margin_apply');
  return policy.apply === false ? 0 : policy.basisPoints;
}

/** Private operator-only proposal helper. Never publish or accept its result automatically.
 * Source cost is explicit foreign minor-units; FX is a documented rational AUD conversion.
 * margin: price = cost/(1-margin); markup: price = cost*(1+markup). Adds 10% GST last.
 * apply:false keeps the stored % for later but bills GST-only. */
export function retailProposal(input: { costNano: string; fxNumerator: string; fxDenominator: string } & RetailPolicy): string {
  const cost = nano(input.costNano), numerator = nano(input.fxNumerator), denominator = nano(input.fxDenominator);
  requireThat(denominator > 0n && numerator > 0n, 'invalid_fx');
  const basisPoints = effectiveBasisPoints(input);
  const top = cost * numerator * 11n * (input.method === 'markup' ? BigInt(10_000 + basisPoints) : 10_000n);
  const bottom = denominator * 10n * (input.method === 'margin' ? BigInt(10_000 - basisPoints) : 10_000n);
  return ((top + bottom - 1n) / bottom).toString();
}

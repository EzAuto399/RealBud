/**
 * Hermios CRM plan catalog (spec `docs/HERMIOS-PLANS-AND-CHECKOUT-2026-10-01.md`).
 *
 * Prices are operator data, not code: the versioned catalog lives in
 * `hermios-catalog.json` (or a file the operator names) and is validated here.
 * Nothing in a browser body sets a price, a minimum or a trial; a request names
 * an option key and a number of people, and this module prices it.
 *
 * Every option is A$ incl GST with quantity = people. An option includes
 * `includedPeople` for `baseCents` per cadence; people above that are a
 * quantity add-on at `extraPersonCents` each (or not offered, when null). A
 * seat change is the same option at a new quantity, never a different plan.
 * Roles: exactly one `default` (preselected), at most one `anchor` (a list
 * price shown for comparison, never sold), any number of `offer`s. An option
 * billed `realbud_invoice` is the bundle: it rides the office's RB invoice and
 * needs the RealBud care fee.
 *
 * Pure: no Square call, no database. `hermios-square-catalog.ts` turns a catalog
 * into Square Catalog objects.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, exact, id, object, requireThat } from './contracts.ts';
import { gstCents } from './money.ts';

export type HermiosRole = 'default' | 'anchor' | 'offer';
export type HermiosCadence = 'monthly' | 'yearly';
export interface HermiosPlanOption {
  key: string; name: string; role: HermiosRole;
  billing: 'square_subscription' | 'realbud_invoice';
  cadence: HermiosCadence;
  includedPeople: number;
  /** Price per cadence for `includedPeople`. */
  baseCents: string;
  /** Each person above `includedPeople`, per cadence; null when extra people are not offered. */
  extraPersonCents: string | null;
  requiresCareFee: boolean;
  /** Exact Square Catalog names. When `baseItem` equals `extraItem` the option is per person. */
  square: { variationName: string; baseItem: string; extraItem: string | null };
}
export interface HermiosCatalog {
  version: string;
  productId: 'hermios-crm';
  capability: 'hermios.crm';
  currency: 'AUD'; gstInclusive: true; gstBasisPoints: 1000;
  trialDays: number;
  /** The card is captured before the trial starts (Square hosted flow). */
  trialCardRequired: boolean;
  /** Reference the billing owner accepts; the terms text is published separately. */
  termsReference: string;
  square: { planName: string };
  options: HermiosPlanOption[];
}
export interface HermiosQuote {
  catalogVersion: string; option: string; role: HermiosRole; purchasable: boolean;
  billing: HermiosPlanOption['billing']; cadence: HermiosCadence;
  people: number; includedPeople: number; extraPeople: number;
  baseCents: string; extraPersonCents: string | null;
  totalCents: string; gstCents: string; exGstCents: string;
  trialDays: number;
}
/** One Square item the catalog needs: a fixed price per cadence. */
export interface HermiosSquareItem { name: string; priceCents: string; cadence: HermiosCadence }
/** The options Square bills; the bundle rides the RB invoice and has no Square entry. */
export const squareBilledOptions = (catalog: HermiosCatalog) => catalog.options.filter(option => option.billing === 'square_subscription');

/** A sanity bound, not a commercial limit. */
export const HERMIOS_MAX_PEOPLE = 500;
export const DEFAULT_HERMIOS_CATALOG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'hermios-catalog.json');
const CENTS = /^[1-9][0-9]{0,8}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CATALOG_FIELDS = ['version', 'productId', 'capability', 'currency', 'gstInclusive', 'gstBasisPoints', 'trialDays', 'trialCardRequired', 'termsReference', 'square', 'options'];
const OPTION_FIELDS = ['key', 'name', 'role', 'billing', 'cadence', 'includedPeople', 'baseCents', 'extraPersonCents', 'requiresCareFee', 'square'];
const meaningful = (value: unknown, max = 120): value is string => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** Every Square item the options name, each with one price and cadence. */
export function hermiosSquareItems(catalog: HermiosCatalog, options: readonly HermiosPlanOption[] = catalog.options): HermiosSquareItem[] {
  const items = new Map<string, HermiosSquareItem>();
  const add = (name: string, priceCents: string, cadence: HermiosCadence) => {
    const prior = items.get(name);
    requireThat(!prior || (prior.priceCents === priceCents && prior.cadence === cadence), 'hermios_catalog_item_price_conflict');
    items.set(name, { name, priceCents, cadence });
  };
  for (const option of options) {
    add(option.square.baseItem, option.square.baseItem === option.square.extraItem ? option.extraPersonCents! : option.baseCents, option.cadence);
    if (option.square.extraItem) add(option.square.extraItem, option.extraPersonCents!, option.cadence);
  }
  return [...items.values()];
}

export function validateHermiosCatalog(catalog: HermiosCatalog): void {
  object(catalog); exact(catalog as unknown as Record<string, unknown>, CATALOG_FIELDS);
  id(catalog.version);
  requireThat(catalog.productId === 'hermios-crm' && catalog.capability === 'hermios.crm', 'hermios_catalog_product_invalid');
  requireThat(catalog.currency === 'AUD' && catalog.gstInclusive === true && catalog.gstBasisPoints === 1000, 'hermios_catalog_tax_invalid');
  requireThat(Number.isSafeInteger(catalog.trialDays) && catalog.trialDays >= 0 && catalog.trialDays <= 31 && typeof catalog.trialCardRequired === 'boolean', 'hermios_catalog_trial_invalid');
  id(catalog.termsReference);
  object(catalog.square); exact(catalog.square, ['planName']); requireThat(meaningful(catalog.square.planName), 'hermios_catalog_square_names_invalid');
  requireThat(Array.isArray(catalog.options) && catalog.options.length > 0 && catalog.options.length <= 20, 'hermios_catalog_options_invalid');
  const keys = new Set<string>(), names = new Set<string>(), variations = new Set<string>();
  for (const option of catalog.options) {
    object(option); exact(option as unknown as Record<string, unknown>, OPTION_FIELDS);
    requireThat(KEY.test(option.key) && meaningful(option.name), 'hermios_catalog_option_invalid');
    requireThat(!keys.has(option.key) && !names.has(option.name), 'hermios_catalog_option_duplicate');
    keys.add(option.key); names.add(option.name);
    requireThat(['default', 'anchor', 'offer'].includes(option.role) && ['monthly', 'yearly'].includes(option.cadence), 'hermios_catalog_option_invalid');
    requireThat((option.billing === 'realbud_invoice') === option.requiresCareFee && ['square_subscription', 'realbud_invoice'].includes(option.billing), 'hermios_catalog_billing_invalid');
    requireThat(Number.isSafeInteger(option.includedPeople) && option.includedPeople >= 1 && option.includedPeople <= HERMIOS_MAX_PEOPLE, 'hermios_catalog_people_invalid');
    requireThat(CENTS.test(option.baseCents) && (option.extraPersonCents === null || CENTS.test(option.extraPersonCents)), 'hermios_catalog_price_invalid');
    object(option.square); exact(option.square, ['variationName', 'baseItem', 'extraItem']);
    const { variationName, baseItem, extraItem } = option.square;
    requireThat(meaningful(variationName) && meaningful(baseItem) && (extraItem === null || meaningful(extraItem)) && !variations.has(variationName), 'hermios_catalog_square_names_invalid');
    variations.add(variationName);
    requireThat((extraItem === null) === (option.extraPersonCents === null), 'hermios_catalog_extra_item_invalid');
    // A per-person option is one item at quantity = people.
    if (baseItem === extraItem) requireThat(option.includedPeople === 1 && option.baseCents === option.extraPersonCents, 'hermios_catalog_per_person_invalid');
  }
  requireThat(catalog.options.filter(option => option.role === 'default').length === 1, 'hermios_catalog_default_required');
  requireThat(catalog.options.filter(option => option.role === 'anchor').length <= 1, 'hermios_catalog_anchor_duplicate');
  const items = hermiosSquareItems(catalog);
  requireThat(items.every(item => !variations.has(item.name) && item.name !== catalog.square.planName), 'hermios_catalog_square_names_invalid');
}

/** Parse and validate an operator catalog. A malformed file is refused, never partly used. */
export function parseHermiosCatalog(text: string): HermiosCatalog {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { requireThat(false, 'hermios_catalog_invalid_json'); }
  validateHermiosCatalog(parsed as HermiosCatalog);
  return parsed as HermiosCatalog;
}
export function loadHermiosCatalog(path = DEFAULT_HERMIOS_CATALOG_PATH): HermiosCatalog {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { requireThat(false, 'hermios_catalog_unreadable', 503); }
  return parseHermiosCatalog(text);
}

export function hermiosOption(catalog: HermiosCatalog, key: unknown): HermiosPlanOption {
  validateHermiosCatalog(catalog);
  const option = catalog.options.find(entry => entry.key === key);
  requireThat(option, 'hermios_plan_unknown', 404);
  return option;
}

/** Price one option for a number of people. Below the included people is refused, never rounded up silently. */
export function quoteHermiosPlan(catalog: HermiosCatalog, key: unknown, people: unknown): HermiosQuote {
  const option = hermiosOption(catalog, key);
  requireThat(Number.isSafeInteger(people) && Number(people) >= 1 && Number(people) <= HERMIOS_MAX_PEOPLE, 'hermios_people_invalid');
  const count = Number(people);
  requireThat(count >= option.includedPeople, 'hermios_people_below_minimum', 409);
  const extraPeople = count - option.includedPeople;
  requireThat(extraPeople === 0 || option.extraPersonCents !== null, 'hermios_extra_people_unavailable', 409);
  const total = BigInt(option.baseCents) + BigInt(extraPeople) * BigInt(option.extraPersonCents ?? '0');
  const gst = gstCents(total);
  return { catalogVersion: catalog.version, option: option.key, role: option.role, purchasable: option.role !== 'anchor',
    billing: option.billing, cadence: option.cadence, people: count, includedPeople: option.includedPeople, extraPeople,
    baseCents: option.baseCents, extraPersonCents: option.extraPersonCents,
    totalCents: String(total), gstCents: String(gst), exGstCents: String(total - gst), trialDays: catalog.trialDays };
}

/** A seat change is the same option at a new quantity. */
export function hermiosSeatChange(catalog: HermiosCatalog, key: unknown, fromPeople: unknown, toPeople: unknown): { from: HermiosQuote; to: HermiosQuote; deltaCents: string } {
  const from = quoteHermiosPlan(catalog, key, fromPeople), to = quoteHermiosPlan(catalog, key, toPeople);
  requireThat(to.purchasable, 'hermios_plan_not_purchasable', 409);
  requireThat(from.people !== to.people, 'hermios_seat_change_noop', 409);
  return { from, to, deltaCents: String(BigInt(to.totalCents) - BigInt(from.totalCents)) };
}

/** What every purchasable option costs over a year for `people`, against the anchor and the default, for anchoring copy. */
export function hermiosYearlyComparison(catalog: HermiosCatalog, people: number): { option: string; yearlyCents: string; versusAnchorCents: string | null; versusDefaultCents: string }[] {
  validateHermiosCatalog(catalog);
  const yearly = (option: HermiosPlanOption) => {
    const quote = quoteHermiosPlan(catalog, option.key, people);
    return BigInt(quote.totalCents) * (option.cadence === 'monthly' ? 12n : 1n);
  };
  const anchor = catalog.options.find(option => option.role === 'anchor');
  const fallback = catalog.options.find(option => option.role === 'default')!;
  const anchorYear = anchor ? yearly(anchor) : null, defaultYear = yearly(fallback);
  return catalog.options.filter(option => option.role !== 'anchor').map(option => {
    const year = yearly(option);
    return { option: option.key, yearlyCents: String(year), versusAnchorCents: anchorYear === null ? null : String(anchorYear - year), versusDefaultCents: String(defaultYear - year) };
  });
}

/** Square ids the catalog script printed for this deployment, by item name. */
export interface HermiosSquareIds { locationId: string; itemVariationIds: Record<string, string> }

/**
 * The DRAFT order a Square subscription uses as its relative-priced phase
 * template: the option's base item once and its extra-person item at quantity
 * = extra people (or, for a per-person option, its one item at quantity =
 * people), GST inclusive. Changing seats is a new template at the new quantity.
 */
export function hermiosOrderTemplate(catalog: HermiosCatalog, key: unknown, people: unknown, ids: HermiosSquareIds, customerId: string, reference: string): Record<string, unknown> {
  const quote = quoteHermiosPlan(catalog, key, people);
  requireThat(quote.purchasable && quote.billing === 'square_subscription', 'hermios_plan_not_square_billed', 409);
  const option = hermiosOption(catalog, key);
  [ids.locationId, customerId, reference].forEach(id);
  requireThat(reference.length <= 40, 'hermios_reference_too_long');
  const item = (name: string) => { const value = ids.itemVariationIds[name]; id(value); return value; };
  const lines = option.square.baseItem === option.square.extraItem
    ? [{ catalog_object_id: item(option.square.baseItem), quantity: String(quote.people) }]
    : [{ catalog_object_id: item(option.square.baseItem), quantity: '1' },
      ...(quote.extraPeople > 0 ? [{ catalog_object_id: item(option.square.extraItem!), quantity: String(quote.extraPeople) }] : [])];
  return {
    idempotency_key: createHash('sha256').update(canonical([catalog.version, option.key, quote.people, customerId, reference])).digest('hex').slice(0, 40),
    order: { location_id: ids.locationId, customer_id: customerId, state: 'DRAFT', reference_id: reference, line_items: lines,
      taxes: [{ uid: 'gst', name: 'GST', percentage: '10', type: 'INCLUSIVE', scope: 'ORDER' }] },
  };
}

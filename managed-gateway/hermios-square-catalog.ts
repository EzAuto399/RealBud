/**
 * Trusted operator command: create the Hermios subscription plan in Square's
 * Catalog from the operator catalog (`hermios-catalog.json`, or `--catalog
 * <file>`; validated by `hermios-plans.ts`). Never an HTTP route.
 *
 *   cd managed-gateway
 *   node --experimental-strip-types hermios-square-catalog.ts           # plan only: reads Square, writes nothing
 *   node --experimental-strip-types hermios-square-catalog.ts --apply   # create what is missing (sandbox)
 *   node --experimental-strip-types hermios-square-catalog.ts --apply --live   # production, see below
 *
 * Credentials come only from the gateway's environment (`.env.local` beside
 * this file or the process), under the same rules as care-fee collection
 * (`composition.ts` `composeCareCollection`): `REALBUD_PAYMENT_MODE` must be
 * `sandbox` or `live`, `REALBUD_AUTHORIZE_COLLECTION=1`, and the Square token,
 * merchant and location set. Live additionally needs the reviewed seller-basis
 * digest and the three approval references, and `--live` on the command line,
 * so a sandbox habit cannot write to production. The host follows the mode.
 *
 * Idempotent: every object is first looked up by its exact catalog name (and a
 * variation within its plan); an existing entry is reused only when it matches
 * the catalog exactly, otherwise the run stops with `square_catalog_drift:<key>`
 * (Square phases cannot be edited; a price change is a new named variation).
 * Each create also carries a deterministic idempotency key, so a retried call
 * Square already applied returns the same object.
 *
 * Objects: one ITEM per priced line (A$ incl GST: a pack, an extra person, a
 * per-person list price), the SUBSCRIPTION_PLAN eligible for those items, and
 * one SUBSCRIPTION_PLAN_VARIATION per Square-billed option: a zero-price DAILY trial
 * phase for `trialDays`, then a MONTHLY or ANNUAL RELATIVE phase whose price is
 * the subscription's order template (pack x1 plus extra people as quantity;
 * see `hermiosOrderTemplate`). Options billed on the RB invoice (the bundle)
 * have no Square entry.
 *
 * Prints JSON lines of keys, states and Square ids; never a token or a Square
 * response body. Exit 0 only when every object is found or created.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abortable } from './abort.ts';
import { canonical, GatewayError, object, requireThat } from './contracts.ts';
import { hermiosSquareItems, loadHermiosCatalog, squareBilledOptions, validateHermiosCatalog, type HermiosCadence, type HermiosCatalog } from './hermios-plans.ts';
import { LIVE_APPROVAL_ENV } from './composition.ts';
import { loadLocalEnv } from './local-env.ts';
import type { SquareEnvironment } from './square-mapping.ts';

const HOSTS: Record<SquareEnvironment, string> = { production: 'https://connect.squareup.com', sandbox: 'https://connect.squareupsandbox.com' };
/** Same API version as `square-payment.ts`. */
const VERSION = '2026-08-19';
/** `composition.ts` `SQUARE_ENV` minus the webhook-only names; live approvals are imported from there. */
const SQUARE_ENV = ['SQUARE_ACCESS_TOKEN', 'SQUARE_MERCHANT_ID', 'SQUARE_LOCATION_ID'] as const;
const MAX_PAGES = 50;
const USAGE = 'Usage: hermios-square-catalog.ts [--catalog <file>] [--apply] [--live]';

export interface SquareCatalogTarget { environment: SquareEnvironment; accessToken: string; merchantId: string; locationId: string }
type SquareObject = Record<string, unknown> & { id: string; type: string; is_deleted?: boolean };
export type CatalogEntryState = 'found' | 'created' | 'would_create';
export interface CatalogEntryResult { key: string; type: string; name: string; state: CatalogEntryState; id: string | null; itemVariationId?: string }

/** The collection rules applied to a catalog write. Names a variable, never a value. */
export function squareCatalogTarget(env: NodeJS.ProcessEnv, live: boolean): SquareCatalogTarget {
  const value = (name: string) => (env[name] ?? '').trim();
  const mode = value('REALBUD_PAYMENT_MODE') || 'local';
  requireThat(mode === 'sandbox' || mode === 'live', 'square_catalog_unconfigured:REALBUD_PAYMENT_MODE', 503);
  requireThat(live === (mode === 'live'), live ? 'square_catalog_live_mode_mismatch' : 'square_catalog_live_flag_required', 409);
  requireThat(value('REALBUD_AUTHORIZE_COLLECTION') === '1', 'square_catalog_unconfigured:REALBUD_AUTHORIZE_COLLECTION', 503);
  for (const name of SQUARE_ENV) requireThat(value(name), `square_catalog_unconfigured:${name}`, 503);
  if (mode === 'live') {
    requireThat(/^[a-f0-9]{64}$/.test(value('REALBUD_SELLER_BASIS_DIGEST')), 'square_catalog_unconfigured:REALBUD_SELLER_BASIS_DIGEST', 503);
    for (const name of LIVE_APPROVAL_ENV) requireThat(value(name), `square_catalog_unconfigured:${name}`, 503);
  }
  return { environment: mode === 'live' ? 'production' : 'sandbox', accessToken: value('SQUARE_ACCESS_TOKEN'), merchantId: value('SQUARE_MERCHANT_ID'), locationId: value('SQUARE_LOCATION_ID') };
}

const aud = (amount: bigint) => ({ amount: Number(amount), currency: 'AUD' });
const sameMoney = (value: unknown, amount: bigint) => !!value && typeof value === 'object' && (value as Record<string, unknown>).currency === 'AUD' && (value as Record<string, unknown>).amount === Number(amount);
/** Bound to the exact object, so a retry dedupes and a changed object never reuses a key. */
const idempotencyKey = (catalog: HermiosCatalog, key: string, entry: unknown) => createHash('sha256').update(canonical(['hermios-square-catalog', catalog.version, key, entry])).digest('hex').slice(0, 40);
const data = (entry: SquareObject, field: string): Record<string, unknown> => {
  const value = entry[field];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

/** The phases a plan variation must have; Square fixes them at creation. */
function phases(catalog: HermiosCatalog, cadence: HermiosCadence): Record<string, unknown>[] {
  return [
    ...(catalog.trialDays > 0 ? [{ ordinal: 0, cadence: 'DAILY', periods: catalog.trialDays, pricing: { type: 'STATIC', price_money: aud(0n) } }] : []),
    { ordinal: catalog.trialDays > 0 ? 1 : 0, cadence: cadence === 'yearly' ? 'ANNUAL' : 'MONTHLY', pricing: { type: 'RELATIVE' } },
  ];
}
function phasesMatch(actual: unknown, expected: Record<string, unknown>[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((want, index) => {
    const got = actual[index] as Record<string, unknown> | undefined;
    if (!got || Number(got.ordinal) !== want.ordinal || got.cadence !== want.cadence || (got.periods ?? null) !== (want.periods ?? null)) return false;
    const gotPricing = (got.pricing ?? {}) as Record<string, unknown>, wantPricing = want.pricing as Record<string, unknown>;
    if (gotPricing.type !== wantPricing.type) return false;
    if (wantPricing.type === 'STATIC' && !sameMoney(gotPricing.price_money, 0n)) return false;
    return !Array.isArray(gotPricing.discount_ids) || gotPricing.discount_ids.length === 0;
  });
}

export class SquareCatalogWriter {
  private readonly host: string;
  private readonly target: SquareCatalogTarget;
  private readonly transport: typeof fetch;
  constructor(target: SquareCatalogTarget, transport: typeof fetch) {
    requireThat(target.environment === 'sandbox' || target.environment === 'production', 'square_environment_invalid');
    this.target = target; this.host = HOSTS[target.environment]; this.transport = transport;
  }
  private async request(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(15_000);
    const response = await abortable(this.transport(`${this.host}${path}`, { method, redirect: 'error', signal,
      headers: { Authorization: `Bearer ${this.target.accessToken}`, 'Square-Version': VERSION, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: canonical(payload) }) }), signal);
    // Status only: a Square error body can echo request content.
    if (!response.ok) { void response.body?.cancel().catch(() => {}); requireThat(false, `square_request_failed:${response.status}`, 502); }
    const text = await abortable(response.text(), signal);
    requireThat(text.length <= 2_000_000, 'square_response_too_large', 502);
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { requireThat(false, 'invalid_square_response', 502); }
    object(parsed); requireThat(!parsed.errors, 'square_api_error', 502);
    return parsed;
  }
  /** The seller the gateway collects for: an active AU merchant and AUD location. */
  async checkSeller(): Promise<void> {
    const merchant = await this.request('GET', `/v2/merchants/${encodeURIComponent(this.target.merchantId)}`); object(merchant.merchant);
    requireThat(merchant.merchant.id === this.target.merchantId && merchant.merchant.status === 'ACTIVE' && merchant.merchant.country === 'AU' && merchant.merchant.currency === 'AUD', 'square_merchant_mismatch', 403);
    const location = await this.request('GET', `/v2/locations/${encodeURIComponent(this.target.locationId)}`); object(location.location);
    requireThat(location.location.id === this.target.locationId && location.location.merchant_id === this.target.merchantId && location.location.status === 'ACTIVE' && location.location.currency === 'AUD', 'square_location_mismatch', 403);
  }
  /** Every live catalog object of the kinds this command writes, plan variations included. */
  async existing(): Promise<SquareObject[]> {
    const found = new Map<string, SquareObject>();
    const add = (entry: unknown) => {
      if (!entry || typeof entry !== 'object') return;
      const candidate = entry as SquareObject;
      if (typeof candidate.id === 'string' && typeof candidate.type === 'string' && candidate.is_deleted !== true) found.set(candidate.id, candidate);
    };
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ types: 'ITEM,SUBSCRIPTION_PLAN,SUBSCRIPTION_PLAN_VARIATION', ...(cursor ? { cursor } : {}) });
      const response = await this.request('GET', `/v2/catalog/list?${query}`);
      for (const entry of Array.isArray(response.objects) ? response.objects : []) {
        add(entry);
        const nested = (entry as SquareObject)?.subscription_plan_data as Record<string, unknown> | undefined;
        if (Array.isArray(nested?.subscription_plan_variations)) nested.subscription_plan_variations.forEach(add);
      }
      cursor = typeof response.cursor === 'string' && response.cursor ? response.cursor : undefined;
      if (!cursor) return [...found.values()];
    }
    requireThat(false, 'square_catalog_too_large', 502);
  }
  async create(catalog: HermiosCatalog, key: string, entry: Record<string, unknown>): Promise<SquareObject> {
    const response = await this.request('POST', '/v2/catalog/object', { idempotency_key: idempotencyKey(catalog, key, entry), object: entry });
    object(response.catalog_object);
    const created = response.catalog_object as SquareObject;
    requireThat(typeof created.id === 'string' && created.id && created.type === entry.type, 'invalid_square_response', 502);
    return created;
  }
}

/**
 * Find or create each Hermios object in order: one ITEM per priced line, the
 * SUBSCRIPTION_PLAN eligible for exactly those items, then one
 * SUBSCRIPTION_PLAN_VARIATION per Square-billed option. Without `apply`, nothing is written:
 * a missing object, and anything that depends on it, is `would_create`.
 */
export async function ensureHermiosSquareCatalog(writer: SquareCatalogWriter, catalog: HermiosCatalog, apply: boolean): Promise<CatalogEntryResult[]> {
  validateHermiosCatalog(catalog);
  await writer.checkSeller();
  const existing = await writer.existing();
  const results: CatalogEntryResult[] = [];
  const FIELDS: Record<string, string> = { ITEM: 'item_data', SUBSCRIPTION_PLAN: 'subscription_plan_data', SUBSCRIPTION_PLAN_VARIATION: 'subscription_plan_variation_data' };
  const named = (type: string, name: string) => existing.filter(entry => entry.type === type && data(entry, FIELDS[type]).name === name);
  const resolveOne = async (key: string, type: string, name: string, matches: SquareObject[], fits: (entry: SquareObject) => boolean, build: (() => Record<string, unknown>) | null): Promise<SquareObject | null> => {
    requireThat(matches.length <= 1, `square_catalog_ambiguous:${key}`, 409);
    if (matches.length === 1) {
      requireThat(fits(matches[0]), `square_catalog_drift:${key}`, 409);
      results.push({ key, type, name, state: 'found', id: matches[0].id });
      return matches[0];
    }
    if (!apply || !build) { results.push({ key, type, name, state: 'would_create', id: null }); return null; }
    const created = await writer.create(catalog, key, build());
    results.push({ key, type, name, state: 'created', id: created.id });
    return created;
  };

  // Each priced line is an item with one FIXED_PRICING variation; a relative
  // phase charges the order template's lines at these prices.
  const items: SquareObject[] = [];
  const itemIds = new Map<string, string>();
  const sellable = (entry: SquareObject) => {
    const variations = data(entry, 'item_data').variations;
    return Array.isArray(variations) ? (variations as SquareObject[]).filter(variation => variation.is_deleted !== true) : [];
  };
  const billed = squareBilledOptions(catalog), wanted = hermiosSquareItems(catalog, billed);
  for (const [index, item] of wanted.entries()) {
    const key = `item_${index + 1}`;
    const found = await resolveOne(key, 'ITEM', item.name, named('ITEM', item.name), entry => {
      const variations = sellable(entry);
      return variations.length === 1 && data(variations[0], 'item_variation_data').pricing_type === 'FIXED_PRICING' && sameMoney(data(variations[0], 'item_variation_data').price_money, BigInt(item.priceCents));
    }, () => ({ type: 'ITEM', id: `#hermios-item-${index + 1}`, item_data: { name: item.name,
      description: `Hermios CRM, ${item.cadence} (A$ incl GST). Catalog ${catalog.version}.`,
      variations: [{ type: 'ITEM_VARIATION', id: `#hermios-item-${index + 1}-variation`, item_variation_data: { name: item.cadence === 'yearly' ? 'Yearly' : 'Monthly', pricing_type: 'FIXED_PRICING', price_money: aud(BigInt(item.priceCents)) } }] } }));
    if (found) {
      items.push(found);
      const variationId = sellable(found)[0]?.id;
      if (typeof variationId === 'string') { itemIds.set(item.name, variationId); results[results.length - 1].itemVariationId = variationId; }
    }
  }
  const allItems = items.length === wanted.length;

  const plan = await resolveOne('plan', 'SUBSCRIPTION_PLAN', catalog.square.planName, named('SUBSCRIPTION_PLAN', catalog.square.planName), entry => {
    const plan = data(entry, 'subscription_plan_data');
    return plan.all_items !== true && Array.isArray(plan.eligible_item_ids) && items.every(item => (plan.eligible_item_ids as unknown[]).includes(item.id));
  }, allItems ? () => ({ type: 'SUBSCRIPTION_PLAN', id: '#hermios-plan', subscription_plan_data: { name: catalog.square.planName, all_items: false, eligible_item_ids: items.map(item => item.id) } }) : null);

  for (const option of billed) {
    const key = `variation_${option.key}`, name = option.square.variationName, want = phases(catalog, option.cadence);
    const matches = plan ? named('SUBSCRIPTION_PLAN_VARIATION', name).filter(entry => data(entry, FIELDS.SUBSCRIPTION_PLAN_VARIATION).subscription_plan_id === plan.id) : [];
    await resolveOne(key, 'SUBSCRIPTION_PLAN_VARIATION', name, matches,
      entry => phasesMatch(data(entry, FIELDS.SUBSCRIPTION_PLAN_VARIATION).phases, want),
      plan ? () => ({ type: 'SUBSCRIPTION_PLAN_VARIATION', id: `#hermios-${option.key}`, subscription_plan_variation_data: { name, subscription_plan_id: plan.id, phases: want } }) : null);
  }
  return results;
}

export async function runHermiosSquareCatalog(args: string[], options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; out?: (line: string) => void; err?: (line: string) => void } = {}): Promise<number> {
  const out = options.out ?? (line => process.stdout.write(`${line}\n`)), err = options.err ?? (line => process.stderr.write(`${line}\n`));
  try {
    let apply = false, live = false, catalogPath: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--apply' && !apply) apply = true;
      else if (arg === '--live' && !live) live = true;
      else if (arg === '--catalog' && catalogPath === undefined && args[index + 1]) catalogPath = args[++index];
      else requireThat(false, 'invalid_arguments');
    }
    const catalog = loadHermiosCatalog(catalogPath);
    const target = squareCatalogTarget(options.env ?? process.env, live);
    const writer = new SquareCatalogWriter(target, options.fetchImpl ?? fetch);
    const results = await ensureHermiosSquareCatalog(writer, catalog, apply);
    for (const result of results) out(JSON.stringify({ environment: target.environment, catalogVersion: catalog.version, ...result }));
    return results.every(result => result.state !== 'would_create') || !apply ? 0 : 1;
  } catch (error) {
    // A code only: never a stack, an environment value or a Square body.
    err(JSON.stringify({ error: error instanceof GatewayError ? error.code : 'square_catalog_failed' }));
    if (error instanceof GatewayError && error.code === 'invalid_arguments') err(USAGE);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadLocalEnv();
  process.exitCode = await runHermiosSquareCatalog(process.argv.slice(2));
}

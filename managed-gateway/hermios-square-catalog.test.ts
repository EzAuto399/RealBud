/** Hermios Square catalog command against an in-memory fake of Square's
 * Catalog API. Tokens, merchants and locations are fictional; no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHermiosCatalog } from './hermios-plans.ts';
import { ensureHermiosSquareCatalog, runHermiosSquareCatalog, SquareCatalogWriter, squareCatalogTarget } from './hermios-square-catalog.ts';

const TOKEN = 'fictional-square-sandbox-token';
const SANDBOX: NodeJS.ProcessEnv = { REALBUD_PAYMENT_MODE: 'sandbox', REALBUD_AUTHORIZE_COLLECTION: '1', SQUARE_ACCESS_TOKEN: TOKEN, SQUARE_MERCHANT_ID: 'merchant-a', SQUARE_LOCATION_ID: 'location-a' };
const LIVE: NodeJS.ProcessEnv = { ...SANDBOX, REALBUD_PAYMENT_MODE: 'live', REALBUD_SELLER_BASIS_DIGEST: 'a'.repeat(64),
  REALBUD_SELLER_BASIS_APPROVAL_REF: 'synthetic-a', REALBUD_PRODUCTION_INVOICE_APPROVAL_REF: 'synthetic-b', REALBUD_MANAGED_PROJECT_VERIFIED_REF: 'synthetic-c' };
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as { code?: string }).code; } return 'no_error'; };

type Obj = Record<string, unknown> & { id: string; type: string };
/** Enough of Square's Catalog API: merchant/location reads, paged list, single upsert with idempotency keys. */
function fakeSquare(options: { pageSize?: number } = {}) {
  const objects: Obj[] = [], keys = new Map<string, Obj>(), calls: string[] = [], hosts = new Set<string>(), auth = new Set<string>();
  let next = 1;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const assign = (entry: Obj): Obj => {
    const real = { ...entry, id: `SQ${next++}` } as Obj;
    const item = real.item_data as { variations?: Obj[] } | undefined;
    if (item?.variations) item.variations = item.variations.map(variation => ({ ...variation, id: `SQ${next++}`, is_deleted: false }));
    return real;
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); hosts.add(url.origin); auth.add(String((init?.headers as Record<string, string>).Authorization));
    calls.push(`${init?.method} ${url.pathname}`);
    if (url.pathname === '/v2/merchants/merchant-a') return json({ merchant: { id: 'merchant-a', status: 'ACTIVE', country: 'AU', currency: 'AUD' } });
    if (url.pathname === '/v2/locations/location-a') return json({ location: { id: 'location-a', merchant_id: 'merchant-a', status: 'ACTIVE', currency: 'AUD' } });
    if (url.pathname === '/v2/catalog/list') {
      const size = options.pageSize ?? 100, start = Number(url.searchParams.get('cursor') ?? '0');
      // Square nests plan variations in their plan; list them only there.
      const plans = objects.filter(entry => entry.type !== 'SUBSCRIPTION_PLAN_VARIATION').map(entry => entry.type !== 'SUBSCRIPTION_PLAN' ? entry
        : { ...entry, subscription_plan_data: { ...(entry.subscription_plan_data as object), subscription_plan_variations: objects.filter(variation => variation.type === 'SUBSCRIPTION_PLAN_VARIATION' && (variation.subscription_plan_variation_data as { subscription_plan_id: string }).subscription_plan_id === entry.id) } });
      const page = plans.slice(start, start + size);
      return json({ objects: page, ...(start + size < plans.length ? { cursor: String(start + size) } : {}) });
    }
    if (url.pathname === '/v2/catalog/object' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { idempotency_key: string; object: Obj };
      const prior = keys.get(body.idempotency_key);
      if (prior) return json({ catalog_object: prior });
      const created = assign(body.object); objects.push(created); keys.set(body.idempotency_key, created);
      return json({ catalog_object: created });
    }
    return new Response(JSON.stringify({ errors: [{ detail: `secret-echo ${TOKEN}` }] }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, objects, calls, hosts, auth };
}
const writer = (fake: ReturnType<typeof fakeSquare>) => new SquareCatalogWriter(squareCatalogTarget(SANDBOX, false), fake.fetchImpl);

test('collection rules gate the catalog write; live needs every approval and --live', () => {
  assert.equal(code(() => squareCatalogTarget({}, false)), 'square_catalog_unconfigured:REALBUD_PAYMENT_MODE');
  assert.equal(code(() => squareCatalogTarget({ ...SANDBOX, REALBUD_PAYMENT_MODE: 'local' }, false)), 'square_catalog_unconfigured:REALBUD_PAYMENT_MODE');
  assert.equal(code(() => squareCatalogTarget({ ...SANDBOX, REALBUD_AUTHORIZE_COLLECTION: '' }, false)), 'square_catalog_unconfigured:REALBUD_AUTHORIZE_COLLECTION');
  assert.equal(code(() => squareCatalogTarget({ ...SANDBOX, SQUARE_LOCATION_ID: ' ' }, false)), 'square_catalog_unconfigured:SQUARE_LOCATION_ID');
  assert.equal(code(() => squareCatalogTarget(SANDBOX, true)), 'square_catalog_live_mode_mismatch');
  assert.equal(code(() => squareCatalogTarget(LIVE, false)), 'square_catalog_live_flag_required');
  assert.equal(code(() => squareCatalogTarget({ ...LIVE, REALBUD_SELLER_BASIS_DIGEST: 'short' }, true)), 'square_catalog_unconfigured:REALBUD_SELLER_BASIS_DIGEST');
  assert.equal(code(() => squareCatalogTarget({ ...LIVE, REALBUD_PRODUCTION_INVOICE_APPROVAL_REF: '' }, true)), 'square_catalog_unconfigured:REALBUD_PRODUCTION_INVOICE_APPROVAL_REF');
  assert.equal(squareCatalogTarget(SANDBOX, false).environment, 'sandbox');
  assert.equal(squareCatalogTarget(LIVE, true).environment, 'production');
});

test('apply creates items, the plan and one variation per option in sandbox; a rerun creates nothing', async () => {
  const fake = fakeSquare({ pageSize: 2 }), catalog = loadHermiosCatalog();
  const first = await ensureHermiosSquareCatalog(writer(fake), catalog, true);
  assert.deepEqual([...fake.hosts], ['https://connect.squareupsandbox.com']);
  assert.deepEqual(first.map(result => result.state), Array(first.length).fill('created'));
  assert.deepEqual(first.map(result => result.type), ['ITEM', 'ITEM', 'ITEM', 'ITEM', 'ITEM', 'SUBSCRIPTION_PLAN', ...Array(3).fill('SUBSCRIPTION_PLAN_VARIATION')]);
  // The bundle rides the RB invoice: no Square item or variation for it.
  assert.ok(!first.some(result => /RealBud/.test(result.name)));
  assert.ok(first.filter(result => result.type === 'ITEM').every(result => typeof result.itemVariationId === 'string'));

  const items = fake.objects.filter(entry => entry.type === 'ITEM').map(entry => {
    const data = entry.item_data as { name: string; variations: { item_variation_data: { price_money: { amount: number; currency: string } } }[] };
    return [data.name, data.variations[0].item_variation_data.price_money.amount, data.variations[0].item_variation_data.price_money.currency];
  });
  assert.deepEqual(items, [['Hermios CRM person', 4900, 'AUD'], ['Hermios Office pack (3 people), monthly', 12900, 'AUD'], ['Hermios extra person, monthly', 3900, 'AUD'],
    ['Hermios Office pack (3 people), yearly', 129000, 'AUD'], ['Hermios extra person, yearly', 39000, 'AUD']]);
  const plan = fake.objects.find(entry => entry.type === 'SUBSCRIPTION_PLAN')!;
  assert.deepEqual((plan.subscription_plan_data as { eligible_item_ids: string[] }).eligible_item_ids, fake.objects.filter(entry => entry.type === 'ITEM').map(entry => entry.id));
  const yearly = fake.objects.find(entry => (entry.subscription_plan_variation_data as { name?: string } | undefined)?.name === 'Hermios Office pack, yearly')!;
  assert.deepEqual((yearly.subscription_plan_variation_data as { phases: unknown }).phases, [
    { ordinal: 0, cadence: 'DAILY', periods: 14, pricing: { type: 'STATIC', price_money: { amount: 0, currency: 'AUD' } } },
    { ordinal: 1, cadence: 'ANNUAL', pricing: { type: 'RELATIVE' } }]);

  const before = fake.objects.length, posts = fake.calls.filter(call => call.startsWith('POST')).length;
  const second = await ensureHermiosSquareCatalog(writer(fake), catalog, true);
  assert.deepEqual(second.map(result => result.state), Array(second.length).fill('found'));
  assert.deepEqual(second.map(result => result.id), first.map(result => result.id));
  assert.equal(fake.objects.length, before);
  assert.equal(fake.calls.filter(call => call.startsWith('POST')).length, posts);
});

test('without --apply nothing is written; a partial catalog is completed, not duplicated', async () => {
  const fake = fakeSquare(), catalog = loadHermiosCatalog();
  const plan = await ensureHermiosSquareCatalog(writer(fake), catalog, false);
  assert.deepEqual(plan.map(result => result.state), Array(plan.length).fill('would_create'));
  assert.equal(fake.objects.length, 0);
  assert.ok(!fake.calls.some(call => call.startsWith('POST')));

  const partial = structuredClone(catalog); partial.options = partial.options.slice(0, 2);
  await ensureHermiosSquareCatalog(writer(fake), partial, true);
  const created = fake.objects.length;
  // The full catalog then adds only what was missing; the plan's eligible items
  // no longer cover the new ones, which is drift, never a silent edit.
  await assert.rejects(ensureHermiosSquareCatalog(writer(fake), catalog, true), { code: 'square_catalog_drift:plan' });
  assert.equal(fake.objects.filter(entry => entry.type === 'ITEM').length, 5);
  assert.ok(fake.objects.length > created);
});

test('an existing entry that differs from the catalog stops the run', async () => {
  const fake = fakeSquare(), catalog = loadHermiosCatalog();
  await ensureHermiosSquareCatalog(writer(fake), catalog, true);
  const pack = fake.objects.find(entry => (entry.item_data as { name?: string } | undefined)?.name === 'Hermios Office pack (3 people), monthly')!;
  ((pack.item_data as { variations: { item_variation_data: { price_money: { amount: number } } }[] }).variations[0].item_variation_data.price_money.amount) = 12000;
  await assert.rejects(ensureHermiosSquareCatalog(writer(fake), catalog, true), { code: 'square_catalog_drift:item_2' });

  const twice = fakeSquare();
  await ensureHermiosSquareCatalog(writer(twice), catalog, true);
  twice.objects.push({ ...twice.objects[0], id: 'SQ-duplicate' });
  await assert.rejects(ensureHermiosSquareCatalog(writer(twice), catalog, true), { code: 'square_catalog_ambiguous:item_1' });
});

test('the command prints ids and states, never the token or a Square body', async () => {
  const fake = fakeSquare(), out: string[] = [], err: string[] = [];
  assert.equal(await runHermiosSquareCatalog(['--apply'], { env: SANDBOX, fetchImpl: fake.fetchImpl, out: line => out.push(line), err: line => err.push(line) }), 0);
  assert.equal(out.length, 9); assert.deepEqual(err, []);
  assert.ok(out.every(line => JSON.parse(line).environment === 'sandbox' && JSON.parse(line).catalogVersion === 'hermios-2026-10-02-r3'));
  assert.deepEqual([...fake.auth], [`Bearer ${TOKEN}`]);
  assert.ok(!out.join('\n').includes(TOKEN));

  const failing = fakeSquare(), errors: string[] = [];
  const env = { ...SANDBOX, SQUARE_MERCHANT_ID: 'merchant-unknown' };
  assert.equal(await runHermiosSquareCatalog([], { env, fetchImpl: failing.fetchImpl, out: () => {}, err: line => errors.push(line) }), 1);
  assert.deepEqual(errors, [JSON.stringify({ error: 'square_request_failed:404' })]);

  const usage: string[] = [];
  assert.equal(await runHermiosSquareCatalog(['--apply', '--apply'], { env: SANDBOX, fetchImpl: fake.fetchImpl, out: () => {}, err: line => usage.push(line) }), 1);
  assert.equal(JSON.parse(usage[0]).error, 'invalid_arguments');
  assert.equal(await runHermiosSquareCatalog(['--live'], { env: SANDBOX, fetchImpl: fake.fetchImpl, out: () => {}, err: () => {} }), 1);
});

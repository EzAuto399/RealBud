/** Hermios plan catalog. The fixture is the owner's 2 October 2026 price list;
 * the shipped operator catalog must say exactly the same. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_HERMIOS_CATALOG_PATH, hermiosOrderTemplate, hermiosSeatChange, hermiosSquareItems, hermiosYearlyComparison, loadHermiosCatalog, parseHermiosCatalog,
  quoteHermiosPlan, validateHermiosCatalog, type HermiosCatalog } from './hermios-plans.ts';

const FIXTURE: HermiosCatalog = {
  version: 'hermios-2026-10-02-r3', productId: 'hermios-crm', capability: 'hermios.crm',
  currency: 'AUD', gstInclusive: true, gstBasisPoints: 1000, trialDays: 14, trialCardRequired: true,
  termsReference: 'hermios-crm-terms-2026-10-02', square: { planName: 'Hermios CRM' },
  options: [
    { key: 'per_person', name: 'Per person', role: 'anchor', billing: 'square_subscription', cadence: 'monthly', includedPeople: 1, baseCents: '4900', extraPersonCents: '4900', requiresCareFee: false,
      square: { variationName: 'Hermios CRM per person, monthly', baseItem: 'Hermios CRM person', extraItem: 'Hermios CRM person' } },
    { key: 'office_monthly', name: 'Office pack', role: 'default', billing: 'square_subscription', cadence: 'monthly', includedPeople: 3, baseCents: '12900', extraPersonCents: '3900', requiresCareFee: false,
      square: { variationName: 'Hermios Office pack, monthly', baseItem: 'Hermios Office pack (3 people), monthly', extraItem: 'Hermios extra person, monthly' } },
    { key: 'office_yearly', name: 'Office pack, paid yearly', role: 'offer', billing: 'square_subscription', cadence: 'yearly', includedPeople: 3, baseCents: '129000', extraPersonCents: '39000', requiresCareFee: false,
      square: { variationName: 'Hermios Office pack, yearly', baseItem: 'Hermios Office pack (3 people), yearly', extraItem: 'Hermios extra person, yearly' } },
    { key: 'bundle', name: 'RealBud + Hermios bundle', role: 'offer', billing: 'realbud_invoice', cadence: 'monthly', includedPeople: 3, baseCents: '9900', extraPersonCents: '3900', requiresCareFee: true,
      square: { variationName: 'Hermios with RealBud, monthly', baseItem: 'Hermios with RealBud (3 people), monthly', extraItem: 'Hermios extra person, monthly' } },
  ],
};
const copy = (): HermiosCatalog => structuredClone(FIXTURE);
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as { code?: string }).code; } return 'no_error'; };

test('the shipped operator catalog is the owner price list, as data', () => {
  assert.deepEqual(loadHermiosCatalog(), FIXTURE);
  assert.deepEqual(parseHermiosCatalog(readFileSync(DEFAULT_HERMIOS_CATALOG_PATH, 'utf8')), FIXTURE);
  validateHermiosCatalog(FIXTURE);
});

test('office pack: A$129 for 3 people, extra people A$39 each as a quantity add-on', () => {
  const three = quoteHermiosPlan(FIXTURE, 'office_monthly', 3);
  assert.equal(three.totalCents, '12900'); assert.equal(three.gstCents, '1173'); assert.equal(three.exGstCents, '11727');
  assert.equal(three.extraPeople, 0); assert.equal(three.trialDays, 14); assert.equal(three.role, 'default'); assert.equal(three.purchasable, true);
  assert.equal(quoteHermiosPlan(FIXTURE, 'office_monthly', 4).totalCents, '16800');
  assert.equal(quoteHermiosPlan(FIXTURE, 'office_monthly', 7).totalCents, '28500');
  assert.equal(code(() => quoteHermiosPlan(FIXTURE, 'office_monthly', 2)), 'hermios_people_below_minimum');
});

test('per-person list price anchors at A$49 and is never sold', () => {
  const anchor = quoteHermiosPlan(FIXTURE, 'per_person', 3);
  assert.equal(anchor.totalCents, '14700'); assert.equal(anchor.purchasable, false);
  assert.equal(code(() => hermiosSeatChange(FIXTURE, 'per_person', 3, 4)), 'hermios_plan_not_purchasable');
});

test('yearly office pack is A$1,290 for 3 people, extra people A$390 a year each', () => {
  const yearly = quoteHermiosPlan(FIXTURE, 'office_yearly', 3);
  assert.equal(yearly.totalCents, '129000'); assert.equal(yearly.cadence, 'yearly');
  assert.equal(quoteHermiosPlan(FIXTURE, 'office_yearly', 4).totalCents, '168000');
  const noExtras = copy(); noExtras.options[2].extraPersonCents = null; noExtras.options[2].square.extraItem = null;
  assert.equal(code(() => quoteHermiosPlan(noExtras, 'office_yearly', 4)), 'hermios_extra_people_unavailable');
});

test('bundle add-on is A$99 for 3 on the RB invoice, extra people A$39, and needs the care fee', () => {
  const bundle = quoteHermiosPlan(FIXTURE, 'bundle', 5);
  assert.equal(quoteHermiosPlan(FIXTURE, 'bundle', 3).totalCents, '9900');
  assert.equal(bundle.totalCents, '17700'); assert.equal(bundle.billing, 'realbud_invoice');
});

test('anchoring figures match the spec: save A$18/month, 2 months free, bundle saves A$360 a year', () => {
  const rows = Object.fromEntries(hermiosYearlyComparison(FIXTURE, 3).map(row => [row.option, row]));
  assert.deepEqual(Object.keys(rows), ['office_monthly', 'office_yearly', 'bundle']);
  assert.equal(rows.office_monthly.versusAnchorCents, String(1800 * 12));
  assert.equal(rows.office_yearly.versusDefaultCents, String(12900 * 2));
  assert.equal(rows.bundle.versusDefaultCents, '36000');
});

test('a seat change is the same option at a new quantity', () => {
  const change = hermiosSeatChange(FIXTURE, 'office_monthly', 3, 5);
  assert.equal(change.from.option, change.to.option); assert.equal(change.deltaCents, '7800');
  assert.equal(hermiosSeatChange(FIXTURE, 'office_monthly', 5, 3).deltaCents, '-7800');
  assert.equal(code(() => hermiosSeatChange(FIXTURE, 'office_monthly', 3, 3)), 'hermios_seat_change_noop');
});

test('quotes take only an option key and a whole number of people', () => {
  for (const people of [0, 2.5, '3', 501, null]) assert.equal(code(() => quoteHermiosPlan(FIXTURE, 'office_monthly', people)), 'hermios_people_invalid');
  assert.equal(code(() => quoteHermiosPlan(FIXTURE, 'gold', 3)), 'hermios_plan_unknown');
});

test('order template: the pack once plus extra people as quantity, GST inclusive', () => {
  const ids = { locationId: 'location-a', itemVariationIds: { 'Hermios Office pack (3 people), monthly': 'var-pack', 'Hermios extra person, monthly': 'var-extra', 'Hermios Office pack (3 people), yearly': 'var-yearly' } };
  const five = hermiosOrderTemplate(FIXTURE, 'office_monthly', 5, ids, 'customer-a', 'hermios-ref-a') as { order: { line_items: unknown[]; state: string; taxes: { type: string }[] } };
  assert.deepEqual(five.order.line_items, [{ catalog_object_id: 'var-pack', quantity: '1' }, { catalog_object_id: 'var-extra', quantity: '2' }]);
  assert.equal(five.order.state, 'DRAFT'); assert.equal(five.order.taxes[0].type, 'INCLUSIVE');
  const three = hermiosOrderTemplate(FIXTURE, 'office_monthly', 3, ids, 'customer-a', 'hermios-ref-a') as { order: { line_items: unknown[] } };
  assert.deepEqual(three.order.line_items, [{ catalog_object_id: 'var-pack', quantity: '1' }]);
  assert.equal(code(() => hermiosOrderTemplate(FIXTURE, 'per_person', 3, ids, 'customer-a', 'r')), 'hermios_plan_not_square_billed');
  assert.equal(code(() => hermiosOrderTemplate(FIXTURE, 'bundle', 3, ids, 'customer-a', 'r')), 'hermios_plan_not_square_billed');
});

test('square items are deduplicated by name with one price each', () => {
  assert.deepEqual(hermiosSquareItems(FIXTURE).map(item => [item.name, item.priceCents, item.cadence]), [
    ['Hermios CRM person', '4900', 'monthly'],
    ['Hermios Office pack (3 people), monthly', '12900', 'monthly'],
    ['Hermios extra person, monthly', '3900', 'monthly'],
    ['Hermios Office pack (3 people), yearly', '129000', 'yearly'],
    ['Hermios extra person, yearly', '39000', 'yearly'],
    ['Hermios with RealBud (3 people), monthly', '9900', 'monthly'],
  ]);
});

test('a malformed catalog is refused, never partly used', () => {
  const twoDefaults = copy(); twoDefaults.options[2].role = 'default';
  assert.equal(code(() => validateHermiosCatalog(twoDefaults)), 'hermios_catalog_default_required');
  const conflict = copy(); conflict.options[3].extraPersonCents = '4500';
  assert.equal(code(() => validateHermiosCatalog(conflict)), 'hermios_catalog_item_price_conflict');
  const orphanExtra = copy(); orphanExtra.options[2].square.extraItem = null;
  assert.equal(code(() => validateHermiosCatalog(orphanExtra)), 'hermios_catalog_extra_item_invalid');
  const perPerson = copy(); perPerson.options[0].includedPeople = 3;
  assert.equal(code(() => validateHermiosCatalog(perPerson)), 'hermios_catalog_per_person_invalid');
  const bundleWithoutCare = copy(); bundleWithoutCare.options[3].requiresCareFee = false;
  assert.equal(code(() => validateHermiosCatalog(bundleWithoutCare)), 'hermios_catalog_billing_invalid');
  const exGst = copy() as unknown as Record<string, unknown>; exGst.gstInclusive = false;
  assert.equal(code(() => validateHermiosCatalog(exGst as unknown as HermiosCatalog)), 'hermios_catalog_tax_invalid');
  const extraField = copy() as unknown as { options: Record<string, unknown>[] }; extraField.options[1].discountCents = '100';
  assert.equal(code(() => validateHermiosCatalog(extraField as unknown as HermiosCatalog)), 'invalid_fields');
  const zero = copy(); zero.options[1].baseCents = '0';
  assert.equal(code(() => validateHermiosCatalog(zero)), 'hermios_catalog_price_invalid');
  assert.equal(code(() => parseHermiosCatalog('{')), 'hermios_catalog_invalid_json');
  assert.equal(code(() => loadHermiosCatalog('/nonexistent/hermios-catalog.json')), 'hermios_catalog_unreadable');
});

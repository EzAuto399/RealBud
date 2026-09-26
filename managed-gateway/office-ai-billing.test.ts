/** One monthly invoice per office: care + AI resale consolidated from Modelvia's
 * finalized customer invoices, and the owner's margin view. Modelvia is a
 * fictional stand-in shaped from its client-key routes (`main` 927a5c2); every
 * identity, key and amount is fictional and nothing reaches a network. */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { careTermsDraft, fixture } from './testing.ts';
import { BillingService, type HostedPaymentAdapter } from './billing.ts';
import { resaleAcceptanceReference, type AiUsageTerms } from './commercial-terms.ts';
import type { HttpTransport } from './composio-org.ts';
import { composeGateway } from './composition.ts';
import { createGatewayServer } from './http.ts';
import { invoiceHtml } from './invoice-html.ts';
import { modelviaClientBilling } from './modelvia-client-billing.ts';
import { customerTermsPolicy, PRODUCTION_RESALE_MARKUP_BASIS_POINTS, PRODUCTION_RESALE_TERMS_REFERENCE, termsForCompany } from './modelvia-keys.ts';
import { closeOfficeMonth, marginCsv, officeMargins, previousPeriod } from './office-ai-billing.ts';
import { signOperatorToken } from './operator-token.ts';
import { bindOfficeCustomer } from './provisioning.ts';

type Row = Record<string, unknown>;
const INTERNAL = 'realbud-internal', CLIENT = 'realbud', CUSTOMER = 'realbud-company-a';
const CLIENT_KEY = `mgt_${'a1'.repeat(8)}_${'K'.repeat(43)}`;
const SELLER_ABN = '12345678901';
const RESALE: AiUsageTerms = { billing: 'resale', markupBasisPoints: PRODUCTION_RESALE_MARKUP_BASIS_POINTS, termsReference: PRODUCTION_RESALE_TERMS_REFERENCE };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/** Modelvia's client-key routes: `/billing` (the only invoice list), one
 * finalized invoice with its payment summary, client-scope analytics and,
 * optionally, the margin report. */
function fakeModelvia(options: { marginReport?: Row[]; customerCheckout?: string | null } = {}) {
  const invoices = new Map<string, Row>();
  const usage = new Map<string, { grossNano: string; pending?: number }>();
  const analytics = new Map<string, { customerNet: string | null; platformNet: string; pending?: number }>();
  const calls: string[] = [];
  const fetchLike: HttpTransport = async (url, init) => {
    const u = new URL(url), path = u.pathname;
    calls.push(`${init.method} ${path}${u.search}`);
    if ((init.headers as Record<string, string>).authorization !== `Bearer ${CLIENT_KEY}`) return Response.json({ error: 'invalid_client_key' }, { status: 401 });
    const billing = /^\/v1\/client\/customers\/([^/]+)\/billing$/.exec(path);
    if (billing) {
      const period = u.searchParams.get('period')!, used = usage.get(`${billing[1]}:${period}`);
      return Response.json({ clientId: CLIENT, customerId: billing[1], period, currency: 'AUD', payer: 'client',
        ...(options.customerCheckout === null ? {} : { customerCheckout: options.customerCheckout ?? 'off' }),
        customerGrossNanoAud: used?.grossNano ?? '0', customerNetNanoAud: used?.grossNano ?? '0', unknownCustomerPriceRequests: 0,
        pendingRequests: used?.pending ?? 0, unreconciledRequests: 0, usageAvailable: true, statementKind: 'customer_invoice',
        invoices: [...invoices.values()].filter(i => i.customerId === billing[1]).map(i => ({ id: i.id, kind: i.kind, period: i.period, currency: 'AUD', gstInclusive: true,
          totalCents: i.totalCents, gstCents: i.gstCents, documentAvailable: true, paid: i.paid, paymentState: i.paymentState })) });
    }
    const one = /^\/v1\/client\/customers\/([^/]+)\/invoices\/([^/]+)$/.exec(path);
    if (one) { const found = invoices.get(one[2]); return found && found.customerId === one[1] ? Response.json(found) : Response.json({ error: 'customer_invoice_not_found' }, { status: 404 }); }
    if (path === '/v1/client/analytics') {
      const a = analytics.get(`${u.searchParams.get('customerId')}:${u.searchParams.get('period')}`) ?? { customerNet: '0', platformNet: '0' };
      return Response.json({ schemaVersion: 1, period: u.searchParams.get('period'), summary: { pending: a.pending ?? 0, unknown: 0,
        money: { currency: 'AUD', customerGrossNanoAud: a.customerNet, customerCreditsNanoAud: '0', customerNetNanoAud: a.customerNet, unknownCustomerPriceRequests: 0,
          platformGrossNanoAud: a.platformNet, platformCreditsNanoAud: '0', platformNetNanoAud: a.platformNet, commercialSnapshotRequests: 1 } } });
    }
    if (path === '/v1/client/margin-report' && options.marginReport) return Response.json({ period: u.searchParams.get('period'), customers: options.marginReport });
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  const finalize = (id: string, period: string, totalCents: string, gstCents: string, override: Row = {}) =>
    invoices.set(id, { id, state: 'final', kind: 'Tax Invoice', clientId: CLIENT, customerId: CUSTOMER, period, currency: 'AUD', gstInclusive: true, totalCents, gstCents,
      totalNanoAud: /^-?\d+$/.test(totalCents) ? (BigInt(totalCents) * 10_000_000n).toString() : totalCents, seller: { legalName: 'Fictional RealBud Seller', abn: SELLER_ABN, address: '1 Example Seller Street', gstRegistered: true },
      customer: { name: 'Fictional Agency A', address: '1 Example Street, Brisbane QLD' }, chargeDetail: 'all_in', usedBy: { kind: 'customer', customerId: CUSTOMER, displayName: 'Fictional Agency A', projectId: null },
      lines: /^-?\d+$/.test(totalCents) ? [{ description: 'AI usage — DeepSeek V4.1 Flash — 1 request', amountNanoAud: `${totalCents}0000000`, amountCents: totalCents, gstCents, model: 'deepseek-v4.1-flash', requestCount: 1, usagePeriod: period,
        usedBy: { kind: 'customer', customerId: CUSTOMER, displayName: 'Fictional Agency A', projectId: null } }] : [], paid: false, paymentState: 'not_started', ...override });
  const client = modelviaClientBilling({ serviceOrigin: 'https://api.modelvia.dev', clientId: CLIENT, clientKey: () => CLIENT_KEY, fetch: fetchLike });
  return { client, fetchLike, calls, invoices, usage, analytics, finalize };
}

/** A resale office: bound to its Modelvia customer, September terms at care A$125
 * + AI resale at 30%, accepted by its billing owner. The clock is 1 October. */
function resaleOffice(aiUsage: AiUsageTerms | null = RESALE, clientFunded: string[] = []) {
  const f = fixture(); cleanups.push(f.close);
  const billing = new BillingService(f.ledger, undefined, { internalCompanyId: INTERNAL });
  const published = billing.commercialTerms!.publish(careTermsDraft(f, 'care-v1', '12500', aiUsage ? { aiUsage } : {}));
  const acceptance = billing.commercialTerms!.accept(f.owner, '2026-09', 'care-v1', published.digest);
  bindOfficeCustomer(f.ledger, f.tenant.companyId, CUSTOMER);
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const m = fakeModelvia();
  const options = { billing, modelvia: m.client, clientFundedCompanies: new Set(clientFunded) };
  return { f, billing, acceptance, m, options, close: (period = '2026-09', version = 'care-v1', deferAi = false) => closeOfficeMonth(options, f.tenant.companyId, period, version, { deferAi }) };
}

test('production resale terms: 30% markup, and each office policy carries that office\'s own acceptance reference', () => {
  const policy = customerTermsPolicy({ REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS: '3000', REALBUD_MODELVIA_RESALE_TERMS_REFERENCE: PRODUCTION_RESALE_TERMS_REFERENCE, REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES: 'company-owner' });
  assert.ok(!('unavailable' in policy));
  assert.deepEqual(policy.resale, { clientMarkupBasisPoints: 3000, termsReference: PRODUCTION_RESALE_TERMS_REFERENCE });
  const { f, acceptance } = resaleOffice();
  const accepted = f.db.all<{ body: string }>("SELECT body FROM events WHERE kind='ai_resale_terms_accepted'").map(r => JSON.parse(r.body));
  const reference = resaleAcceptanceReference(PRODUCTION_RESALE_TERMS_REFERENCE, acceptance);
  assert.deepEqual(accepted, [{ period: '2026-09', version: 'care-v1', markupBasisPoints: 3000, termsReference: PRODUCTION_RESALE_TERMS_REFERENCE, acceptanceReference: reference }]);
  assert.ok(reference.length <= 200);
  assert.deepEqual(termsForCompany(policy, 'company-a', () => ({ markupBasisPoints: 3000, acceptanceReference: reference })), { terms: { customerBilling: 'resale', clientMarkupBasisPoints: 3000, acceptanceReference: reference } });
  assert.deepEqual(termsForCompany(policy, 'company-b', () => undefined), { state: 'acceptance_required' });
  // The owner's own office stays client-funded (free), accepted or not.
  assert.deepEqual(termsForCompany(policy, 'company-owner', () => ({ markupBasisPoints: 3000, acceptanceReference: reference })), { terms: { customerBilling: 'client_funded', acceptanceReference: 'realbud-owner-decision-2026-09-24-internal-ai' } });
});

test('month close: one invoice = care + the finalized Modelvia AI invoice at its exact cents and GST, collected as one Square amount', async () => {
  const { f, billing, m, close } = resaleOffice();
  m.usage.set(`${CUSTOMER}:2026-09`, { grossNano: '12340000000' });
  m.finalize('CI-00000007', '2026-09', '1234', '112');
  const closed = await close();
  const invoice = closed.invoice;
  assert.equal(closed.ai, 'consolidated');
  assert.deepEqual(invoice.lines.map(l => [l.description, l.amountCents, l.gstCents, l.modelviaInvoice ?? null]), [
    ['RealBud software and routine maintenance — monthly care', '12500', '1137', null],
    ['AI usage — DeepSeek V4.1 Flash — 1 request', '1234', '112', 'CI-00000007']]);
  // A$125.00 + A$12.34 = A$137.34; GST is the one total's inclusive GST (Square's), the AI line keeps Modelvia's.
  assert.equal(invoice.totalCents, '13734'); assert.equal(invoice.gstCents, '1249');
  assert.deepEqual(invoice.aiUsage, { modelviaInvoices: [{ id: 'CI-00000007', period: '2026-09', totalCents: '1234', gstCents: '112' }], modelviaCustomerId: CUSTOMER, usedBy: 'Fictional Agency A', chargeDetail: 'all_in' });
  assert.deepEqual(f.db.all('SELECT modelvia_invoice,tenant,period,invoice FROM office_ai_consolidations').map(r => ({ ...(r as Row) })),
    [{ modelvia_invoice: 'CI-00000007', tenant: 'company-a', period: '2026-09', invoice: invoice.id }]);
  const html = invoiceHtml(invoice);
  assert.match(html, /Modelvia invoice CI-00000007/); assert.match(html, /A\$12\.34/); assert.match(html, /Total A\$137\.34/);
  assert.doesNotMatch(html, /never appears on this invoice/);
  // ONE amount through RealBud's Square checkout.
  const requested: string[] = [];
  const adapter: HostedPaymentAdapter = { id: 'square-sandbox', mode: 'sandbox',
    async createCheckout(request) { requested.push(request.amountCents); return { sessionId: `order-${request.attemptId}`, url: 'https://connect.squareupsandbox.com/checkout/one', expiresAt: f.now() + 60_000 }; },
    async verifyWebhook() { return null; }, async requestRefund() {}, async verifyRefundWebhook() { return null; } };
  const collecting = new BillingService(f.ledger, adapter, { authorizeCollection: true, internalCompanyId: INTERNAL });
  await collecting.checkout(f.owner, invoice.id);
  assert.deepEqual(requested, ['13734']);
  // Idempotent re-run: the same invoice, and Modelvia is not asked again.
  const calls = m.calls.length;
  const again = await close();
  assert.equal(again.ai, 'already_closed'); assert.deepEqual(again.invoice, invoice); assert.equal(m.calls.length, calls);
  // Never double-billed: the next month's close leaves CI-00000007 alone, and a direct attempt is refused.
  billing.commercialTerms!.accept(f.owner, '2026-10', 'care-v2', billing.commercialTerms!.publish(careTermsDraft(f, 'care-v2', '12500', { period: '2026-10', aiUsage: RESALE })).digest);
  f.setTime(Date.parse('2026-11-01T00:00:00Z'));
  const october = await close('2026-10', 'care-v2');
  assert.equal(october.ai, 'no_ai_usage');
  assert.deepEqual(october.invoice.lines.map(l => l.amountCents), ['12500']);
  assert.equal(october.invoice.aiUsage, undefined);
  billing.commercialTerms!.accept(f.owner, '2026-11', 'care-v3', billing.commercialTerms!.publish(careTermsDraft(f, 'care-v3', '12500', { period: '2026-11', aiUsage: RESALE })).digest);
  f.setTime(Date.parse('2026-12-01T00:00:00Z'));
  assert.throws(() => billing.finalizeCommercialInvoice('company-a', '2026-11', 'care-v3', { invoices: [{ id: 'CI-00000007', period: '2026-09', totalCents: '1234', gstCents: '112' }] }), /modelvia_invoice_already_consolidated/);
  assert.equal(f.db.all("SELECT id FROM invoices WHERE period='2026-11'").length, 0);
  assert.throws(() => f.db.run("DELETE FROM office_ai_consolidations"), /immutable_record/);
  f.db.verify();
});

test('not finalized at Modelvia: the close waits by default; --defer-ai issues care only and the next month consolidates it once', async () => {
  const { f, billing, m, close } = resaleOffice();
  m.usage.set(`${CUSTOMER}:2026-09`, { grossNano: '50000000000' });
  await assert.rejects(close(), /modelvia_invoice_not_finalized/);
  assert.equal(f.db.all('SELECT id FROM invoices').length, 0);
  // Pending requests alone also mean usage that needs an invoice.
  m.usage.set(`${CUSTOMER}:2026-09`, { grossNano: '0', pending: 1 });
  await assert.rejects(close(), /modelvia_invoice_not_finalized/);
  const deferred = await close('2026-09', 'care-v1', true);
  assert.equal(deferred.ai, 'deferred');
  assert.deepEqual(deferred.invoice.lines.map(l => l.amountCents), ['12500']);
  assert.deepEqual(deferred.invoice.aiUsage, { modelviaInvoices: [], deferredPeriods: ['2026-09'], modelviaCustomerId: CUSTOMER, chargeDetail: 'all_in' });
  assert.match(invoiceHtml(deferred.invoice), /AI usage for 2026-09 was not yet finalized/);
  assert.equal(f.db.all("SELECT seq FROM events WHERE kind='ai_usage_deferred'").length, 1);
  // Modelvia finalizes September; October's close carries it, at its exact total.
  m.finalize('CI-00000009', '2026-09', '65000', '5909');
  billing.commercialTerms!.accept(f.owner, '2026-10', 'care-v2', billing.commercialTerms!.publish(careTermsDraft(f, 'care-v2', '12500', { period: '2026-10', aiUsage: RESALE })).digest);
  f.setTime(Date.parse('2026-11-01T00:00:00Z'));
  const october = await close('2026-10', 'care-v2');
  assert.equal(october.ai, 'consolidated');
  assert.deepEqual(october.invoice.lines.map(l => [l.amountCents, l.modelviaInvoice ?? null]), [['12500', null], ['65000', 'CI-00000009']]);
  assert.equal(october.invoice.totalCents, '77500');
});

test('refusals: payment started at Modelvia, another seller, an unbound office, no client key', async () => {
  const paid = resaleOffice();
  paid.m.finalize('CI-00000011', '2026-09', '1000', '91', { paymentState: 'ready' });
  await assert.rejects(paid.close(), /modelvia_invoice_payment_started/);
  const foreign = resaleOffice();
  foreign.m.finalize('CI-00000012', '2026-09', '1000', '91', { seller: { legalName: 'Someone Else', abn: '99999999999' } });
  await assert.rejects(foreign.close(), /modelvia_invoice_seller_mismatch/);
  const keyless = resaleOffice();
  await assert.rejects(closeOfficeMonth({ ...keyless.options, modelvia: undefined }, 'company-a', '2026-09', 'care-v1'), /modelvia_client_unconfigured/);
  assert.equal(paid.f.db.all('SELECT id FROM invoices').length + foreign.f.db.all('SELECT id FROM invoices').length + keyless.f.db.all('SELECT id FROM invoices').length, 0);
});

test('an internal or client-funded office stays free: care only, Modelvia never asked; AI terms for it are refused', async () => {
  const free = resaleOffice(null, ['company-a']);
  free.m.finalize('CI-00000013', '2026-09', '1000', '91');
  const closed = await free.close();
  assert.equal(closed.ai, 'care_only'); assert.deepEqual(closed.invoice.lines.map(l => l.amountCents), ['12500']); assert.equal(free.m.calls.length, 0);
  const mistaken = resaleOffice(RESALE, ['company-a']);
  await assert.rejects(mistaken.close(), /client_funded_office_ai_not_billable/);
  // The internal cost account is never billable at all.
  assert.throws(() => free.billing.finalizeCommercialInvoice(INTERNAL, '2026-09', 'care-v1'), /internal_usage_not_billable/);
});

test('margin view: AI retail, Modelvia cost, markup, care, total and margin per office, from analytics or the margin report, with CSV', async () => {
  const { f, billing, m, options, close } = resaleOffice();
  f.ledger.provisionTenant({ ...f.tenant, companyId: 'company-owner', licenseId: 'license-owner', customerName: 'Owner, "Office" =HQ', goLiveAt: f.tenant.goLiveAt });
  bindOfficeCustomer(f.ledger, 'company-owner', 'realbud-owner');
  // Resale: A$13.00 retail on A$10.00 Modelvia cost (30%). Owner: A$2.00 cost, no retail.
  m.analytics.set(`${CUSTOMER}:2026-09`, { customerNet: '1300000000', platformNet: '1000000000' });
  m.analytics.set('realbud-owner:2026-09', { customerNet: '0', platformNet: '200000000', pending: 1 });
  m.usage.set(`${CUSTOMER}:2026-09`, { grossNano: '1300000000' });
  m.finalize('CI-00000021', '2026-09', '130', '12');
  await close();
  const report = await officeMargins({ ...options, clientFundedCompanies: new Set(['company-owner']) }, '2026-09');
  const [a, owner] = report.rows;
  assert.deepEqual({ ...a, invoiceId: undefined }, { companyId: 'company-a', customerName: 'Fictional Agency A', billing: 'resale', markupBasisPoints: 3000, proposedMarkupBasisPoints: null, markupPolicy: 'not_synced', aiRetailCents: '130', modelviaCostCents: '100', markupCents: '30',
    careCents: '12500', totalCents: '12630', marginCents: '12530', invoiceId: undefined, invoiceState: 'closed', aiBilledCents: '130', modelviaInvoices: ['CI-00000021'], modelviaSource: 'analytics', note: null });
  assert.deepEqual([owner.billing, owner.aiRetailCents, owner.modelviaCostCents, owner.markupCents, owner.careCents, owner.totalCents, owner.marginCents, owner.invoiceState],
    ['client_funded', '0', '20', '-20', '0', '0', '-20', 'not_closed']);
  assert.match(owner.note!, /provisional/);
  assert.deepEqual(report.totals, { aiRetailCents: '130', modelviaCostCents: '120', markupCents: '10', careCents: '12500', totalCents: '12630', marginCents: '12510' });
  const csv = marginCsv(report).split('\r\n');
  assert.equal(csv[0], 'period,company_id,office,billing,ai_retail_aud,modelvia_cost_aud,realbud_markup_aud,care_fee_aud,total_aud,margin_aud,realbud_invoice,invoice_state,ai_billed_aud,modelvia_invoices,modelvia_source,note,markup_percent,proposed_markup_percent,markup_policy');
  assert.match(csv[1], /^2026-09,company-a,Fictional Agency A,resale,1\.30,1\.00,0\.30,125\.00,126\.30,125\.30,RB-000001,closed,1\.30,CI-00000021,analytics,,30\.00,,not_synced$/);
  assert.match(csv[2], /^2026-09,company-owner,"Owner, ""Office"" =HQ",client_funded,0\.00,0\.20,-0\.20,0\.00,0\.00,-0\.20,,not_closed,0\.00,,analytics,/);
  assert.equal(csv[3], '2026-09,,Total,,1.30,1.20,0.10,125.00,126.30,125.10,,,,,,,,,');
  // The margin report, once Modelvia serves it, replaces analytics without a RealBud change.
  const reported = fakeModelvia({ marginReport: [{ customerId: CUSTOMER, customerNetNanoAud: '2600000000', platformNetNanoAud: '2000000000' }] });
  const fromReport = await officeMargins({ billing, modelvia: reported.client, clientFundedCompanies: new Set() }, '2026-09');
  assert.deepEqual([fromReport.rows[0].modelviaSource, fromReport.rows[0].aiRetailCents, fromReport.rows[0].markupCents], ['margin_report', '260', '60']);
  assert.ok(!reported.calls.some(c => c.includes('/v1/client/analytics?') && c.includes(CUSTOMER)), 'no analytics read for a reported customer');
  // No client key: care still shows, Modelvia columns are empty and say why.
  const bare = await officeMargins({ billing, clientFundedCompanies: new Set() }, '2026-09');
  assert.deepEqual([bare.rows[0].careCents, bare.rows[0].aiRetailCents, bare.rows[0].modelviaSource], ['12500', null, 'unavailable']);
  assert.match(bare.rows[0].note!, /client key is not configured/);
  assert.equal(previousPeriod(Date.parse('2026-01-05T00:00:00Z')), '2025-12');
});

test('operator margin route: composed from the environment, operator bearer only, JSON or CSV', async () => {
  const { f, m } = resaleOffice();
  const operatorSecret = 'fictional-gateway-operator-secret-000001';
  const composed = composeGateway({ env: { REALBUD_GATEWAY_OPERATOR_SECRET: operatorSecret, REALBUD_GATEWAY_PORTAL_SECRET: 'fictional-gateway-portal-secret-00000001',
    REALBUD_ENABLE_PROVIDER: '1', REALBUD_MODELVIA_BASE_URL: 'https://api.modelvia.dev', REALBUD_MODELVIA_CLIENT_ID: CLIENT, REALBUD_MODELVIA_CLIENT_KEY: CLIENT_KEY,
    REALBUD_INTERNAL_COMPANY_ID: INTERNAL }, ledger: f.ledger, fetch: m.fetchLike, portal: { async authenticate() { throw new Error('no portal'); } }, allowedOrigins: new Set() });
  m.analytics.set(`${CUSTOMER}:2026-09`, { customerNet: '1300000000', platformNet: '1000000000' });
  const server = createGatewayServer(composed.server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/operator/billing/margins`;
  const token = signOperatorToken('ops@realbud.example', operatorSecret);
  const get = (query: string, bearer: string | null = token) => fetch(base + query, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
  assert.equal((await get('?period=2026-09', null)).status, 401);
  assert.equal((await get('?period=2026-09', signOperatorToken('ops@realbud.example', 'another-secret-that-is-long-enough-000001'))).status, 401);
  assert.deepEqual(await (await get('?period=2026-13')).json(), { error: 'invalid_billing_period' });
  const json = await (await get('?period=2026-09')).json() as { rows: Row[] };
  assert.deepEqual([json.rows[0].companyId, json.rows[0].aiRetailCents, json.rows[0].markupCents, json.rows[0].careCents], ['company-a', '130', '30', '12500']);
  const csv = await get('?period=2026-09&format=csv');
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="realbud-margins-2026-09.csv"');
  assert.match(await csv.text(), /^period,company_id,/);
  // The client key never reaches a response.
  assert.doesNotMatch(JSON.stringify(json), /mgt_/);
});

// ---------------------------------------------------------------------------
// Review fixes: GST, checkout, unconsolidated AI, pre-acceptance, filtering, rebinding, races
// ---------------------------------------------------------------------------

/** 1,200 requests priced in nanoAUD and rounded the way Modelvia's customer
 * invoice rounds them: once for the gross, GST = gross/11 once, then allocated.
 * `naive` instead rounds GST per request line, which drifts by many cents. */
function modelviaInvoiceTotals(requests: number, seed: number, naive = false) {
  let x = seed; const next = () => { x = (x * 1103515245 + 12345) % 2147483648; return x; };
  const nanos = Array.from({ length: requests }, () => BigInt(1_000_000 + next() % 900_000_000));
  const toCents = (n: bigint) => (n + 5_000_000n) / 10_000_000n, gstOf = (c: bigint) => (c + 5n) / 11n;
  const gross = toCents(nanos.reduce((a, b) => a + b, 0n));
  const gst = naive ? nanos.map(toCents).reduce((a, c) => a + gstOf(c), 0n) : gstOf(gross);
  return { totalCents: gross.toString(), gstCents: gst.toString() };
}

test('GST over 1,000+ requests: the AI line keeps Modelvia\'s GST, the one total\'s GST differs by at most a cent, and drift is refused', async () => {
  for (const [seed, care] of [[7, '12500'], [11, '12501'], [13, '9999'], [17, '0']] as const) {
    const { f, billing, m } = resaleOffice();
    if (care !== '12500') {
      // Same office, a different care amount this month.
      billing.commercialTerms!.accept(f.owner, '2026-09', 'care-b', billing.commercialTerms!.publish(careTermsDraft(f, 'care-b', care, { aiUsage: RESALE })).digest);
    }
    const totals = modelviaInvoiceTotals(1_200, seed);
    m.usage.set(`${CUSTOMER}:2026-09`, { grossNano: '1' });
    m.finalize('CI-00001200', '2026-09', totals.totalCents, totals.gstCents);
    const { invoice } = await closeOfficeMonth({ billing, modelvia: m.client, clientFundedCompanies: new Set() }, 'company-a', '2026-09', care === '12500' ? 'care-v1' : 'care-b');
    const ai = invoice.lines.find(l => l.modelviaInvoice)!;
    assert.equal(ai.gstCents, totals.gstCents, 'AI GST is exactly Modelvia\'s');
    assert.equal(invoice.lines.reduce((s, l) => s + BigInt(l.gstCents), 0n).toString(), invoice.gstCents, 'lines sum to the invoice GST');
    assert.equal(invoice.gstCents, ((BigInt(invoice.totalCents) + 5n) / 11n).toString(), 'invoice GST is the one total\'s (Square\'s)');
    const others = invoice.lines.filter(l => !l.modelviaInvoice);
    const adjusted = others.reduce((s, l) => s + BigInt(l.gstCents) - (BigInt(l.amountCents) + (BigInt(l.amountCents) >= 0n ? 5n : -5n)) / 11n, 0n);
    assert.ok(adjusted >= -1n && adjusted <= 1n, `care-side adjustment ${adjusted} is within a cent`);
    if (care === '0') assert.ok(others.every(l => l.description === 'GST rounding adjustment' && l.amountCents === '0'));
  }
  // Per-request GST rounding drifts by many cents over 1,200 requests: refused, nothing written.
  const { f, m, close } = resaleOffice();
  const drifted = modelviaInvoiceTotals(1_200, 7, true), clean = modelviaInvoiceTotals(1_200, 7);
  assert.ok(Math.abs(Number(drifted.gstCents) - Number(clean.gstCents)) > 1, 'the naive rounding really drifts');
  m.finalize('CI-00001201', '2026-09', drifted.totalCents, drifted.gstCents);
  await assert.rejects(close(), /gst_reconciliation_required/);
  assert.equal(f.db.all('SELECT id FROM invoices').length, 0);
});

test('Modelvia must not offer the office its own checkout: customerCheckout other than off, or a payable invoice, is refused', async () => {
  for (const surface of ['client_app', 'portal', 'both', null]) {
    const o = resaleOffice(); const m = fakeModelvia({ customerCheckout: surface });
    m.finalize('CI-00000031', '2026-09', '1000', '91');
    await assert.rejects(closeOfficeMonth({ ...o.options, modelvia: m.client }, 'company-a', '2026-09', 'care-v1'), /modelvia_checkout_enabled/, String(surface));
    assert.equal(o.f.db.all('SELECT id FROM invoices').length, 0);
  }
  const payable = resaleOffice();
  payable.m.finalize('CI-00000032', '2026-09', '1000', '91', { directPaymentAvailable: true });
  await assert.rejects(payable.close(), /modelvia_invoice_payment_started/);
});

test('an office that accepted resale keeps being read: owed AI under care-only terms is refused, as is a still-missing deferred month', async () => {
  const { f, billing, m, close } = resaleOffice();
  m.usage.set(`${CUSTOMER}:2026-09`, { grossNano: '10000000000' });
  await close('2026-09', 'care-v1', true);
  // October's terms drop AI resale, but September's AI is still owed.
  billing.commercialTerms!.accept(f.owner, '2026-10', 'care-v2', billing.commercialTerms!.publish(careTermsDraft(f, 'care-v2', '12500', { period: '2026-10' })).digest);
  f.setTime(Date.parse('2026-11-01T00:00:00Z'));
  await assert.rejects(close('2026-10', 'care-v2'), /ai_usage_unconsolidated/);
  m.finalize('CI-00000041', '2026-09', '11000', '1000');
  await assert.rejects(close('2026-10', 'care-v2'), /ai_usage_unconsolidated/);
  assert.equal(f.db.all("SELECT id FROM invoices WHERE period='2026-10'").length, 0);
  // With AI resale in October's terms, a September still not finalized blocks too.
  const again = resaleOffice();
  again.m.usage.set(`${CUSTOMER}:2026-09`, { grossNano: '10000000000' });
  await again.close('2026-09', 'care-v1', true);
  again.billing.commercialTerms!.accept(again.f.owner, '2026-10', 'care-v2', again.billing.commercialTerms!.publish(careTermsDraft(again.f, 'care-v2', '12500', { period: '2026-10', aiUsage: RESALE })).digest);
  again.f.setTime(Date.parse('2026-11-01T00:00:00Z'));
  await assert.rejects(again.close('2026-10', 'care-v2'), /modelvia_invoice_not_finalized/);
  const carried = await again.close('2026-10', 'care-v2', true);
  assert.deepEqual(carried.invoice.aiUsage, { modelviaInvoices: [], deferredPeriods: ['2026-09'], modelviaCustomerId: CUSTOMER, chargeDetail: 'all_in' });
});

test('an invoice dated before the office accepted resale is refused; later or unrelated invoices are not validated', async () => {
  const early = resaleOffice();
  early.m.finalize('CI-00000051', '2026-08', '1000', '91');
  await assert.rejects(early.close(), /modelvia_invoice_before_acceptance/);
  // A malformed invoice for a LATER month does not stop September's close.
  const later = resaleOffice();
  later.m.finalize('CI-00000052', '2026-09', '1000', '91');
  later.m.finalize('CI-00000053', '2026-10', 'not-cents', '0', { gstInclusive: false });
  const closed = await later.close();
  assert.deepEqual(closed.invoice.aiUsage?.modelviaInvoices.map(i => i.id), ['CI-00000052']);
  // One inside the window is still validated strictly.
  const bad = resaleOffice();
  bad.m.finalize('CI-00000054', '2026-09', 'not-cents', '0');
  await assert.rejects(bad.close(), /modelvia_unreadable/);
});

test('an office that accepted resale cannot be moved to another Modelvia customer; one that did not can', () => {
  const { f } = resaleOffice();
  assert.throws(() => bindOfficeCustomer(f.ledger, 'company-a', 'realbud-company-a-2'), /office_customer_rebind_blocked/);
  bindOfficeCustomer(f.ledger, 'company-a', CUSTOMER);
  const plain = resaleOffice(null);
  bindOfficeCustomer(plain.f.ledger, 'company-a', 'realbud-company-a-2');
});

test('a close that loses a race to another process reports already_closed, and the Modelvia invoice is billed once', async () => {
  const { f, m, options } = resaleOffice();
  m.finalize('CI-00000061', '2026-09', '1000', '91');
  const other = new BillingService(f.ledger, undefined, { internalCompanyId: INTERNAL });
  const racing = { ...m.client, async customerInvoice(customerId: string, invoiceId: string) {
    const found = await m.client.customerInvoice(customerId, invoiceId);
    other.finalizeCommercialInvoice('company-a', '2026-09', 'care-v1', { invoices: [{ id: found.id, period: found.period, totalCents: found.totalCents, gstCents: found.gstCents }] });
    return found;
  } };
  const closed = await closeOfficeMonth({ ...options, modelvia: racing }, 'company-a', '2026-09', 'care-v1');
  assert.equal(closed.ai, 'already_closed');
  assert.equal(f.db.all('SELECT modelvia_invoice FROM office_ai_consolidations').length, 1);
});

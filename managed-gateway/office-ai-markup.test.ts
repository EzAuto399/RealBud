/** Per-office AI markup and office-recognisable invoices. Modelvia is a
 * fictional stand-in built from its sources (`main` bb73139): `commercial.ts`
 * policy rules (append-only ids, effective order, effectiveAt no more than five
 * minutes behind ITS clock, priced by the latest active policy with effectiveAt
 * <= admission time, markup = ceil(due × bps / 10000)), its node:http Date header,
 * the client-key invoice routes with grouped lines, `usedBy`, `components` (only
 * when itemized) and `requests.csv`, and client analytics request pages. Every
 * identity, key and amount is fictional; nothing reaches a network. */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { careTermsDraft, fixture } from './testing.ts';
import { BillingService } from './billing.ts';
import { customerTermsPolicy, modelviaKeyClient } from './modelvia-keys.ts';
import { GatewayError } from './contracts.ts';
import type { HttpTransport } from './composio-org.ts';
import { createGatewayServer } from './http.ts';
import { invoiceHtml, presentInvoice } from './invoice-html.ts';
import { modelviaClientBilling } from './modelvia-client-billing.ts';
import { closeOfficeMonth, officeMargins } from './office-ai-billing.ts';
import { officeAiTermsRoutes, officeMarkup, syncOfficeResalePolicy, withOfficeMarkup } from './office-ai-terms.ts';
import { AI_USAGE_CSV_HEADER, officeAiUsageCsv } from './office-ai-usage-csv.ts';
import { OPERATOR_ROLE } from './operator-token.ts';
import { bindOfficeCustomer } from './provisioning.ts';

type Row = Record<string, unknown>;
const INTERNAL = 'realbud-internal', CLIENT = 'realbud', TERMS_REF = 'fictional-office-terms-ai-resale';
const CLIENT_KEY = `mgt_${'b2'.repeat(8)}_${'Q'.repeat(43)}`;
const OPERATOR = { subject: 'operator:ops@realbud.example', role: OPERATOR_ROLE } as const;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const toCents = (nano: bigint) => (nano + 5_000_000n) / 10_000_000n;
/** Largest-remainder split of `total` in proportion to `weights`. */
function allocate(weights: bigint[], total: bigint): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n); if (sum === 0n) return weights.map(() => 0n);
  const base = weights.map(w => w * total / sum); let left = total - base.reduce((a, b) => a + b, 0n);
  const order = weights.map((w, i) => ({ i, r: w * total % sum })).sort((a, b) => Number(b.r - a.r) || a.i - b.i);
  for (const { i } of order) { if (left <= 0n) break; base[i]++; left--; }
  return base;
}

function fakeModelvia(options: { chargeDetail?: 'all_in' | 'itemized' } = {}) {
  let serverNow = Date.parse('2026-09-10T02:00:00.750Z');
  const policies: Row[] = [], requests: Row[] = [], invoices = new Map<string, Row>(), calls: string[] = [];
  let dateHeader = true, seq = 0;
  const customers = new Map<string, Row>();
  const date = () => dateHeader ? { date: new Date(serverNow).toUTCString() } : undefined;
  const json = (body: unknown, status = 200) => Response.json(body, { status, ...(date() ? { headers: date() } : {}) });
  const active = (customerId: string, at: number) => policies.filter(p => p.customerId === customerId && p.state === 'active' && (p.effectiveAt as number) <= at)
    .sort((a, b) => (b.effectiveAt as number) - (a.effectiveAt as number))[0];
  const fetchLike: HttpTransport = async (url, init) => {
    const u = new URL(url), path = u.pathname, body = init.body === undefined ? undefined : JSON.parse(String(init.body)) as Row;
    calls.push(`${init.method} ${path}${u.search}`);
    const auth = (init.headers as Record<string, string>).authorization ?? '';
    if (path.startsWith('/v1/operator/')) {
      if (path === '/v1/operator/clients') return json({ accounts: [{ id: CLIENT, billingMode: 'client' }] });
      if (path === '/v1/operator/customers') return json({ accounts: [...customers.values()] });
      if (path === '/v1/operator/commercial-policies' && init.method === 'GET') return json({ policies: policies.map(p => ({ ...p })) });
      if (path === '/v1/operator/commercial-policies' && init.method === 'POST') {
        const v = body!;
        if (policies.some(p => p.id === v.id)) return json({ error: 'policy_version_exists' }, 409);
        if ((v.effectiveAt as number) < serverNow - 5 * 60_000 || !String(v.acceptanceReference).trim()) return json({ error: 'commercial_acceptance_required' }, 409);
        if (policies.some(p => p.customerId === v.customerId && p.state === 'active' && (p.effectiveAt as number) >= (v.effectiveAt as number))) return json({ error: 'policy_effective_order' }, 409);
        const saved = { ...v, createdAt: serverNow, createdBy: 'realbud-provisioning' }; policies.push(saved); return json(saved);
      }
      return json({ error: 'not_found' }, 404);
    }
    if (auth !== `Bearer ${CLIENT_KEY}`) return json({ error: 'invalid_client_key' }, 401);
    const billing = /^\/v1\/client\/customers\/([^/]+)\/billing$/.exec(path);
    if (billing) {
      const period = u.searchParams.get('period')!;
      return json({ clientId: CLIENT, customerId: billing[1], period, payer: 'client', customerCheckout: 'off', customerGrossNanoAud: '0', pendingRequests: 0, unreconciledRequests: 0,
        unknownCustomerPriceRequests: 0, usageAvailable: true,
        invoices: [...invoices.values()].filter(i => i.customerId === billing[1]).map(i => ({ id: i.id, kind: i.kind, period: i.period, currency: 'AUD', gstInclusive: true, totalCents: i.totalCents, gstCents: i.gstCents })) });
    }
    const document = /^\/v1\/client\/customers\/([^/]+)\/invoices\/([^/]+?)(\/requests\.csv)?$/.exec(path);
    if (document) {
      const found = invoices.get(document[2]);
      if (!found || found.customerId !== document[1]) return json({ error: 'customer_invoice_not_found' }, 404);
      if (document[3]) {
        const rows = (found.requests as Row[]).map(r => [found.id, r.requestId, r.usagePeriod, '', (found.lines as Row[])[r.line as number].model, r.line, r.amountNanoAud, r.amountCents, r.gstCents].join(','));
        return new Response(['invoice_id,request_id,usage_period,usage_date,model,line,amount_nano_aud,amount_cents,gst_cents', ...rows].join('\r\n') + '\r\n', { headers: { 'content-type': 'text/csv; charset=utf-8' } });
      }
      // charge-presentation.ts: requests left out, usedBy added, components only when itemized.
      const { requests: _requests, ...stored } = found;
      const detail = options.chargeDetail ?? 'all_in';
      return json({ ...stored, chargeDetail: detail, usedBy: { kind: 'customer', customerId: found.customerId, displayName: found.displayName, projectId: null },
        lines: (found.lines as Row[]).map(({ split, ...line }) => ({ ...line, ...(detail === 'itemized' ? { components: split } : {}) })),
        paid: false, paymentState: 'not_started', checkoutAvailable: false, directPaymentAvailable: false });
    }
    if (path === '/v1/client/analytics') {
      const customerId = u.searchParams.get('customerId'), period = u.searchParams.get('period');
      const mine = requests.filter(r => r.customerId === customerId && r.period === period);
      const limit = Number(u.searchParams.get('requestsLimit') ?? 100), start = Number(u.searchParams.get('requestsCursor') ?? 0);
      const page = mine.slice(start, start + limit);
      return json({ schemaVersion: 1, period, summary: { pending: 0, unknown: 0, money: { customerNetNanoAud: '0', platformNetNanoAud: '0', unknownCustomerPriceRequests: 0 } },
        recentRequests: page.map(r => ({ requestId: r.id, createdAt: r.createdAt, projectId: r.projectId, model: r.model, tokens: { input: String(r.tokensIn), output: String(r.tokensOut), totalInput: String(r.tokensIn) },
          usedBy: { kind: 'customer', customerId, displayName: r.user, projectId: r.projectId }, provider: 'never-shown-supplier', money: { platformNetNanoAud: 'never-shown' } })),
        recentRequestsPage: { limit, cursor: start ? String(start) : null, nextCursor: start + limit < mine.length ? String(start + limit) : null } });
    }
    return json({ error: 'not_found' }, 404);
  };
  const operator = modelviaKeyClient({ serviceOrigin: 'https://api.modelvia.dev', environment: 'production', clientId: CLIENT, allowedModels: ['deepseek-v4.1-flash'],
    scopedSecret: () => 'fictional-modelvia-operator-secret-32ch', operatorSubject: 'realbud-provisioning', fetch: fetchLike,
    // RealBud's own clock is deliberately far from Modelvia's: it must never stamp a policy.
    now: () => Date.parse('2031-01-01T00:00:00Z') });
  const client = modelviaClientBilling({ serviceOrigin: 'https://api.modelvia.dev', clientId: CLIENT, clientKey: () => CLIENT_KEY, fetch: fetchLike });
  return {
    operator, client, calls, policies, requests,
    addCustomer(id: string) { customers.set(id, { id, name: id, active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2, allowedModels: ['deepseek-v4.1-flash'], version: 1, clientId: CLIENT, payer: 'client' }); },
    setServerNow(at: number) { serverNow = at; }, get serverNow() { return serverNow; }, noDateHeader() { dateHeader = false; },
    /** Admission: priced under the policy in force at `at` (Modelvia's clock). */
    admit(customerId: string, r: { baseNano: bigint; model: string; user: string; projectId: string | null; tokensIn: number; tokensOut: number }) {
      const policy = active(customerId, serverNow); assert.ok(policy, 'a policy is in force');
      const markup = ceilDiv(r.baseNano * BigInt(policy.clientMarkupBasisPoints as number), 10_000n);
      const id = `req:${++seq}`;
      requests.push({ id, customerId, period: new Date(serverNow + 36_000_000).toISOString().slice(0, 7), createdAt: serverNow, policyId: policy.id, priceNano: r.baseNano + markup, ...r });
      return { id, policyId: policy.id as string, priceNano: r.baseNano + markup };
    },
    /** An operator finalizing the customer's month: one grouped line per model. */
    finalize(customerId: string, displayName: string, id: string, period: string) {
      const mine = requests.filter(r => r.customerId === customerId && r.period === period);
      const models = [...new Set(mine.map(r => r.model as string))];
      const gross = toCents(mine.reduce((n, r) => n + (r.priceNano as bigint), 0n));
      const perRequest = allocate(mine.map(r => r.priceNano as bigint), gross), perRequestGst = allocate(perRequest, (gross + 5n) / 11n);
      const lines = models.map(model => {
        const idx = mine.map((r, i) => r.model === model ? i : -1).filter(i => i >= 0);
        const cents = idx.reduce((n, i) => n + perRequest[i], 0n), gst = idx.reduce((n, i) => n + perRequestGst[i], 0n);
        const [modelUsage, routing] = [cents * 80n / 100n, cents * 5n / 100n];
        return { description: `AI usage — ${model === 'deepseek-v4.1-flash' ? 'DeepSeek V4.1 Flash' : 'Kimi K3'} — ${idx.length} ${idx.length === 1 ? 'request' : 'requests'}`, amountNanoAud: `${cents}0000000`,
          amountCents: cents.toString(), gstCents: gst.toString(), model, requestCount: idx.length, usagePeriod: period,
          usedBy: { kind: 'customer', customerId, displayName, projectId: new Set(idx.map(i => mine[i].projectId)).size === 1 ? mine[idx[0]].projectId : null },
          split: { modelUsageCents: modelUsage.toString(), routingCents: routing.toString(), serviceFeeCents: (cents - modelUsage - routing).toString() } };
      });
      const reqs = mine.map((r, i) => ({ requestId: r.id, line: models.indexOf(r.model as string), usagePeriod: period, amountNanoAud: (r.priceNano as bigint).toString(), amountCents: perRequest[i].toString(), gstCents: perRequestGst[i].toString() }));
      invoices.set(id, { id, state: 'final', kind: 'Tax Invoice', clientId: CLIENT, customerId, displayName, period, currency: 'AUD', gstInclusive: true,
        totalCents: lines.reduce((n, l) => n + BigInt(l.amountCents), 0n).toString(), gstCents: lines.reduce((n, l) => n + BigInt(l.gstCents), 0n).toString(),
        seller: { legalName: 'Fictional RealBud Seller', abn: '12345678901', address: '1 Example Seller Street', gstRegistered: true }, lines, requests: reqs });
      return invoices.get(id)!;
    },
  };
}

/** Two offices, each bound to its own Modelvia customer. */
function offices(options: { chargeDetail?: 'all_in' | 'itemized' } = {}) {
  const f = fixture(); cleanups.push(f.close);
  f.ledger.provisionTenant({ ...f.tenant, companyId: 'company-b', licenseId: 'license-b', customerName: 'Fictional Agency B', customerAddress: '2 Example Road, Brisbane QLD', customerAbn: '98765432109' });
  const billing = new BillingService(f.ledger, undefined, { internalCompanyId: INTERNAL });
  const m = fakeModelvia(options);
  const owners = { 'company-a': f.owner, 'company-b': { subject: 'portal-owner-b', companyId: 'company-b', role: 'billing_owner' as const } };
  const customers = { 'company-a': 'realbud-company-a', 'company-b': 'realbud-company-b' };
  for (const [company, customer] of Object.entries(customers)) { bindOfficeCustomer(f.ledger, company, customer); m.addCustomer(customer); }
  const draft = (company: 'company-a' | 'company-b', version: string, markup?: number, override: Row = {}) => {
    const base = careTermsDraft(f, version, '12500', { companyId: company, aiUsage: { billing: 'resale', termsReference: TERMS_REF, ...(markup === undefined ? {} : { markupBasisPoints: markup }) } as never, ...override });
    return company === 'company-b' ? { ...base, customer: { name: 'Fictional Agency B', address: '2 Example Road, Brisbane QLD', abn: '98765432109', ...(override.customer as Row ?? {}) } } : base;
  };
  const accept = (company: 'company-a' | 'company-b', version: string, markup?: number, override: Row = {}) => {
    const published = billing.commercialTerms!.publish(withOfficeMarkup(f.ledger, draft(company, version, markup, override), 3000));
    return billing.commercialTerms!.accept(owners[company], '2026-09', version, published.digest);
  };
  const sync = (company: string) => syncOfficeResalePolicy({ ledger: f.ledger, modelvia: m.operator, clientFundedCompanies: new Set() }, company);
  return { f, billing, m, owners, customers, draft, accept, sync };
}

test('two offices at 20% and 40%: each gets its own Modelvia resale policy at Modelvia\'s time, with its own acceptance reference', async () => {
  const { f, m, accept, sync } = offices();
  const a = accept('company-a', 'care-a1', 2000), b = accept('company-b', 'care-b1', 4000);
  const ra = await sync('company-a'), rb = await sync('company-b');
  assert.deepEqual([ra.state, (ra as Row).created, (ra as Row).clientMarkupBasisPoints], ['active', true, 2000]);
  assert.deepEqual([rb.state, (rb as Row).created, (rb as Row).clientMarkupBasisPoints], ['active', true, 4000]);
  const [pa, pb] = m.policies;
  assert.deepEqual([pa.customerId, pa.clientMarkupBasisPoints, pa.customerBilling, pa.payer, pa.platformFeeBasisPoints], ['realbud-company-a', 2000, 'resale', 'client', 0]);
  assert.deepEqual([pb.customerId, pb.clientMarkupBasisPoints], ['realbud-company-b', 4000]);
  assert.notEqual(pa.acceptanceReference, pb.acceptanceReference);
  assert.match(String(pa.acceptanceReference), new RegExp(`^${TERMS_REF}@[a-f0-9]{32}$`));
  // effectiveAt is Modelvia's Date header (whole seconds), never RealBud's clock (2031 in the fake client).
  assert.equal(pa.effectiveAt, Date.parse('2026-09-10T02:00:00Z'));
  assert.ok((pa.effectiveAt as number) <= m.serverNow && (pa.effectiveAt as number) >= m.serverNow - 5 * 60_000);
  // The second office's policy in the same second is independent of the first.
  assert.equal(pb.effectiveAt, Date.parse('2026-09-10T02:00:00Z'));
  // Idempotent: nothing new when the accepted markup is already in force, and the journal says synced.
  const again = await sync('company-a');
  assert.deepEqual([again.state, (again as Row).created], ['active', false]);
  assert.equal(m.policies.length, 2);
  assert.equal(officeMarkup(f.ledger, 'company-a').policy, 'synced');
  assert.ok(a && b);
});

test('a markup change mid-month: new policy supersedes at Modelvia\'s now, the old one is untouched, and earlier usage keeps its price', async () => {
  const { f, billing, m, accept, sync } = offices();
  f.setTime(Date.parse('2026-09-05T00:00:00Z'));
  accept('company-a', 'care-a1', 2000);
  await sync('company-a');
  const original = structuredClone(m.policies[0]);
  // Early September: 20%.
  m.setServerNow(Date.parse('2026-09-12T01:00:00Z'));
  const early = m.admit('realbud-company-a', { baseNano: 1_000_000_000n, model: 'deepseek-v4.1-flash', user: 'Sam Agent', projectId: 'rb-install-one', tokensIn: 1200, tokensOut: 300 });
  // The operator proposes 30%; nothing changes until the office accepts.
  const routes = officeAiTermsRoutes({ ledger: f.ledger, clientFundedCompanies: new Set(), defaultMarkupBasisPoints: 3000, modelvia: m.operator });
  await routes.proposeMarkup(OPERATOR, { companyId: 'company-a', markupBasisPoints: 3000, reason: 'Owner review September 2026' });
  assert.equal(m.policies.length, 1);
  const pending = m.admit('realbud-company-a', { baseNano: 1_000_000_000n, model: 'deepseek-v4.1-flash', user: 'Sam Agent', projectId: 'rb-install-one', tokensIn: 10, tokensOut: 5 });
  // The office accepts new terms (markup filled from the proposal) mid-month.
  f.setTime(Date.parse('2026-09-15T00:00:00Z'));
  m.setServerNow(Date.parse('2026-09-15T04:30:10.400Z'));
  accept('company-a', 'care-a2');
  const synced = await sync('company-a') as Row;
  assert.deepEqual([synced.created, synced.clientMarkupBasisPoints, synced.supersedes, synced.effectiveAt], [true, 3000, original.id, Date.parse('2026-09-15T04:30:10Z')]);
  assert.deepEqual(m.policies[0], original, 'the superseded policy is never changed');
  assert.equal(m.policies.length, 2);
  m.setServerNow(Date.parse('2026-09-20T01:00:00Z'));
  const late = m.admit('realbud-company-a', { baseNano: 1_000_000_000n, model: 'kimi-k3', user: 'Alex Manager', projectId: 'rb-install-two', tokensIn: 2000, tokensOut: 800 });
  assert.deepEqual([early.priceNano, pending.priceNano, late.priceNano], [1_200_000_000n, 1_200_000_000n, 1_300_000_000n]);
  assert.deepEqual([early.policyId, pending.policyId, late.policyId], [original.id, original.id, synced.policyId]);
  // September closes at exactly Modelvia's lines: 2 × A$1.20 + 1 × A$1.30.
  const mv = m.finalize('realbud-company-a', 'Fictional Agency A', 'CI-00000101', '2026-09');
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const { invoice } = await closeOfficeMonth({ billing, modelvia: m.client, clientFundedCompanies: new Set() }, 'company-a', '2026-09', 'care-a2');
  const ai = invoice.lines.filter(l => l.modelviaInvoice);
  assert.deepEqual(ai.map(l => [l.description, l.amountCents, l.gstCents, l.requestCount]), (mv.lines as Row[]).map(l => [l.description, l.amountCents, l.gstCents, l.requestCount]));
  assert.deepEqual(ai.map(l => l.amountCents), ['240', '130']);
  assert.equal(ai.reduce((n, l) => n + BigInt(l.amountCents), 0n).toString(), mv.totalCents);
});

test('markup validation, proposal audit, the env default and a file that disagrees with a pending proposal', async () => {
  const { f, billing, m, draft, accept } = offices();
  const routes = officeAiTermsRoutes({ ledger: f.ledger, clientFundedCompanies: new Set(['company-owner']), defaultMarkupBasisPoints: 3000, modelvia: m.operator });
  for (const bad of [10_001, 1.5, -1, '2000', null])
    await assert.rejects(routes.proposeMarkup(OPERATOR, { companyId: 'company-a', markupBasisPoints: bad, reason: 'x' }), /invalid_markup/, String(bad));
  await assert.rejects(routes.proposeMarkup(OPERATOR, { companyId: 'company-a', markupBasisPoints: 2000 }), /invalid_fields/);
  await assert.rejects(routes.proposeMarkup(OPERATOR, { companyId: 'company-a', markupBasisPoints: 2000, reason: '' }), /invalid_markup_reason/);
  await assert.rejects(routes.proposeMarkup({ subject: 'x', role: 'billing_owner' } as never, { companyId: 'company-a', markupBasisPoints: 2000, reason: 'x' }), /operator_unauthenticated/);
  await assert.rejects(routes.proposeMarkup(OPERATOR, { companyId: INTERNAL, markupBasisPoints: 2000, reason: 'x' }), /tenant_unavailable|internal_usage_not_billable/);
  // No proposal, nothing accepted: new terms take the deployment default.
  assert.equal(withOfficeMarkup(f.ledger, draft('company-b', 'care-b1'), 3000).aiUsage!.markupBasisPoints, 3000);
  const proposed = await routes.proposeMarkup(OPERATOR, { companyId: 'company-b', markupBasisPoints: 1500, reason: 'Pilot pricing' }) as Row;
  assert.deepEqual([proposed.markupBasisPoints, proposed.acceptedBasisPoints, proposed.proposedBasisPoints, proposed.nextTermsBasisPoints, proposed.duplicate], [1500, null, 1500, 1500, false]);
  assert.equal(((await routes.proposeMarkup(OPERATOR, { companyId: 'company-b', markupBasisPoints: 1500, reason: 'Pilot pricing' })) as Row).duplicate, true);
  const audit = f.db.all<{ body: string }>("SELECT body FROM events WHERE tenant='company-b' AND kind='ai_markup_proposed'").map(r => JSON.parse(r.body));
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].subject, audit[0].markupBasisPoints, audit[0].reason], [OPERATOR.subject, 1500, 'Pilot pricing']);
  // A reviewed file stating another markup while 15% is pending is refused.
  assert.throws(() => billing.commercialTerms!.publish(draft('company-b', 'care-b1', 4000)), /ai_markup_differs_from_proposal/);
  assert.throws(() => billing.commercialTerms!.publish(draft('company-b', 'care-b1', 10_001)), /ai_usage_terms_invalid/);
  accept('company-b', 'care-b1');
  const status = officeMarkup(f.ledger, 'company-b', 3000);
  assert.deepEqual([status.acceptedBasisPoints, status.proposedBasisPoints, status.policy], [1500, null, 'not_synced']);
  // The env value is a 0..10000 default for new terms.
  assert.deepEqual(customerTermsPolicy({ REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS: '10001', REALBUD_MODELVIA_RESALE_TERMS_REFERENCE: TERMS_REF }), { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS' });
  // The margin view shows each office's markup.
  const report = await officeMargins({ billing, clientFundedCompanies: new Set(), defaultMarkupBasisPoints: 3000 }, '2026-09');
  assert.deepEqual(report.rows.map(r => [r.companyId, r.markupBasisPoints, r.proposedMarkupBasisPoints, r.markupPolicy]), [['company-a', null, null, null], ['company-b', 1500, null, 'not_synced']]);
  // Charge detail: validated and audited per office.
  await assert.rejects(routes.setChargeDetail(OPERATOR, { companyId: 'company-a', chargeDetail: 'wholesale' }), /invalid_charge_detail/);
  assert.deepEqual(await routes.setChargeDetail(OPERATOR, { companyId: 'company-a', chargeDetail: 'itemized' }), { companyId: 'company-a', chargeDetail: 'itemized', duplicate: false });
  assert.equal(f.db.all("SELECT seq FROM events WHERE tenant='company-a' AND kind='ai_charge_detail_set'").length, 1);
});

test('sync refusals: no Date header from Modelvia writes nothing and is journalled; a later retry succeeds; a client-funded policy is never turned into resale', async () => {
  const { f, m, accept, sync } = offices();
  accept('company-a', 'care-a1', 2000);
  m.noDateHeader();
  assert.deepEqual(await sync('company-a'), { state: 'failed', error: 'modelvia_clock_unavailable' });
  assert.equal(m.policies.length, 0);
  assert.equal(officeMarkup(f.ledger, 'company-a').policy, 'sync_failed');
  const retry = offices();
  retry.accept('company-a', 'care-a1', 2000);
  retry.m.policies.push({ id: 'fictional-funded', clientId: CLIENT, customerId: 'realbud-company-a', state: 'active', effectiveAt: retry.m.serverNow - 1000, customerBilling: 'client_funded', clientMarkupBasisPoints: 0 });
  assert.deepEqual(await retry.sync('company-a'), { state: 'failed', error: 'modelvia_terms_billing_mismatch' });
  assert.equal(retry.m.policies.length, 1);
  // A policy waiting to start is never jumped.
  const later = offices();
  later.accept('company-a', 'care-a1', 2000);
  later.m.policies.push({ id: 'fictional-future', clientId: CLIENT, customerId: 'realbud-company-a', state: 'active', effectiveAt: later.m.serverNow + 60_000, customerBilling: 'resale', clientMarkupBasisPoints: 1000 });
  assert.deepEqual(await later.sync('company-a'), { state: 'failed', error: 'modelvia_terms_pending' });
});

async function closedWithUsage(chargeDetail: 'all_in' | 'itemized', officeDetail: 'all_in' | 'itemized' = chargeDetail) {
  const o = offices({ chargeDetail });
  o.accept('company-a', 'care-a1', 2000, { customer: { name: 'Fictional Agency A', address: '1 Example Street, Brisbane QLD', tradingName: 'Agency A Realty' } });
  await o.sync('company-a');
  if (officeDetail === 'itemized') await officeAiTermsRoutes({ ledger: o.f.ledger, clientFundedCompanies: new Set() }).setChargeDetail(OPERATOR, { companyId: 'company-a', chargeDetail: 'itemized' });
  o.m.setServerNow(Date.parse('2026-09-12T01:00:00Z'));
  for (let i = 0; i < 1234; i++) o.m.admit('realbud-company-a', { baseNano: 12_345_678n, model: 'deepseek-v4.1-flash', user: 'Sam Agent', projectId: 'rb-install-one', tokensIn: 1000 + i, tokensOut: 200 });
  o.m.admit('realbud-company-a', { baseNano: 2_000_000_000n, model: 'kimi-k3', user: 'Alex, "Principal"', projectId: 'rb-install-two', tokensIn: 5000, tokensOut: 900 });
  const mv = o.m.finalize('realbud-company-a', 'Agency A Realty', 'CI-00000201', '2026-09');
  o.f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const closed = await closeOfficeMonth({ billing: o.billing, modelvia: o.m.client, clientFundedCompanies: new Set() }, 'company-a', '2026-09', 'care-a1');
  return { ...o, mv, invoice: closed.invoice };
}

test('the office invoice names the office, lists Modelvia\'s grouped model lines with counts and users, and totals exactly; all-in shows no split', async () => {
  const { invoice, mv } = await closedWithUsage('itemized', 'all_in');
  const ai = invoice.lines.filter(l => l.modelviaInvoice);
  assert.deepEqual(ai.map(l => [l.description, l.model, l.requestCount, l.usedBy]), [
    ['AI usage — DeepSeek V4.1 Flash — 1,234 requests', 'deepseek-v4.1-flash', 1234, 'Agency A Realty · project rb-install-one'],
    ['AI usage — Kimi K3 — 1 request', 'kimi-k3', 1, 'Agency A Realty · project rb-install-two']]);
  assert.deepEqual(ai.map(l => [l.amountCents, l.gstCents]), (mv.lines as Row[]).map(l => [l.amountCents, l.gstCents]));
  assert.equal(ai.reduce((n, l) => n + BigInt(l.amountCents), 0n).toString(), mv.totalCents);
  assert.equal(invoice.totalCents, (12500n + BigInt(mv.totalCents as string)).toString());
  assert.equal(invoice.lines.reduce((n, l) => n + BigInt(l.gstCents), 0n).toString(), invoice.gstCents);
  assert.equal(invoice.dueAt, invoice.issuedAt);
  assert.deepEqual([invoice.customer.tradingName, invoice.aiUsage!.modelviaCustomerId, invoice.aiUsage!.usedBy, invoice.aiUsage!.chargeDetail], ['Agency A Realty', 'realbud-company-a', 'Agency A Realty', 'all_in']);
  // Office all-in: Modelvia itemized for the client, but this office's invoice keeps no split.
  assert.ok(ai.every(l => l.components === undefined));
  const html = invoiceHtml(invoice);
  for (const expected of ['Bill to Fictional Agency A', 'Trading as Agency A Realty', '1 Example Street, Brisbane QLD', 'RealBud account company-a', `Invoice ${invoice.id}`,
    'Issued 2026-10-01', 'Due 2026-10-01 (on receipt)', 'Billing month 2026-09', 'Usage by Agency A Realty', 'Modelvia customer ID <b>realbud-company-a</b>',
    'AI usage — DeepSeek V4.1 Flash — 1,234 requests', 'AI usage — Kimi K3 — 1 request', 'Reference: Modelvia invoice CI-00000201', 'Used by Agency A Realty · project rb-install-one',
    `href="/api/account/invoices/${invoice.id}/ai-usage"`])
    assert.ok(html.includes(expected), expected);
  assert.doesNotMatch(html, /wholesale|platform fee|markup|Model usage A\$|Routing A\$|Service fee/i);
  const json = JSON.stringify(presentInvoice(invoice));
  assert.doesNotMatch(json, /wholesale|platformFee|platformNet|markup|components|never-shown/i);
  assert.deepEqual(presentInvoice(invoice).links, { document: `/api/account/invoices/${invoice.id}?kind=document`, aiUsageCsv: `/api/account/invoices/${invoice.id}/ai-usage` });
  for (const field of ['Fictional Agency A', 'Agency A Realty', 'company-a', '2026-09', invoice.id, 'realbud-company-a', '"requestCount":1234'])
    assert.ok(json.includes(field), field);
});

test('an itemized office sees Modelvia\'s split under each line; the amounts are unchanged', async () => {
  const { invoice, mv } = await closedWithUsage('itemized');
  const ai = invoice.lines.filter(l => l.modelviaInvoice);
  assert.deepEqual(ai.map(l => l.components), (mv.lines as Row[]).map(l => l.split));
  assert.deepEqual(ai.map(l => l.amountCents), (mv.lines as Row[]).map(l => l.amountCents));
  const html = invoiceHtml(invoice);
  const split = (mv.lines as Row[])[0].split as Record<string, string>;
  const aud = (c: string) => `A$${BigInt(c) / 100n}.${String(BigInt(c) % 100n).padStart(2, '0')}`;
  assert.ok(html.includes(`Model usage ${aud(split.modelUsageCents)} · Routing ${aud(split.routingCents)} · Service fee ${aud(split.serviceFeeCents)}`));
  assert.doesNotMatch(html, /wholesale|markup/i);
  // Itemized at RealBud but not at Modelvia: nothing to show, and nothing invented.
  const { invoice: plain } = await closedWithUsage('all_in', 'itemized');
  assert.ok(plain.lines.every(l => l.components === undefined));
  assert.equal(plain.aiUsage!.chargeDetail, 'itemized');
});

test('the per-request CSV: Modelvia\'s request amounts joined with date/time, user/project and tokens, served only to the office through the portal', async () => {
  const { f, m, billing, invoice, mv, owners } = await closedWithUsage('all_in');
  const csv = await officeAiUsageCsv({ ledger: f.ledger, modelvia: m.client }, invoice);
  const rows = csv.trimEnd().split('\r\n');
  assert.equal(rows[0], AI_USAGE_CSV_HEADER.join(','));
  assert.equal(AI_USAGE_CSV_HEADER.join(','), 'realbud_invoice,modelvia_invoice,request_id,date_time,used_by,project,model,tokens_in,tokens_out,amount_aud,gst_aud');
  assert.equal(rows.length, 1 + 1235);
  const dollars = (c: unknown) => `${BigInt(c as string) / 100n}.${String(BigInt(c as string) % 100n).padStart(2, '0')}`;
  const first = (mv.requests as Row[])[0];
  assert.equal(rows[1], `${invoice.id},CI-00000201,req:1,2026-09-12T11:00:00+10:00,Sam Agent,rb-install-one,deepseek-v4.1-flash,1000,200,${dollars(first.amountCents)},${dollars(first.gstCents)}`);
  assert.equal(rows[1235], `${invoice.id},CI-00000201,req:1235,2026-09-12T11:00:00+10:00,"Alex, ""Principal""",rb-install-two,kimi-k3,5000,900,2.40,0.22`);
  // Every request's amount, summed, is the Modelvia invoice.
  const cents = rows.slice(1).map(r => r.split(',').at(-2)!).reduce((n, d) => n + BigInt(d.replace('.', '')), 0n);
  assert.equal(cents.toString(), mv.totalCents);
  assert.doesNotMatch(csv, /never-shown|wholesale|markup/);
  // Portal route: the office's billing owner or reader gets it; another office never does.
  const server = createGatewayServer({ allowedOrigins: new Set(), billing, aiUsageCsv: inv => officeAiUsageCsv({ ledger: f.ledger, modelvia: m.client }, inv), portal: { async authenticate(bearer) {
    if (bearer === 'synthetic-portal-token-owner-a-00001') return owners['company-a'];
    if (bearer === 'synthetic-portal-token-owner-b-00001') return owners['company-b'];
    throw new GatewayError('unauthenticated', 401); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, bearer: string) => fetch(base + path, { headers: { Authorization: `Bearer ${bearer}` } });
  const mine = await get(`/v1/portal/invoices/${invoice.id}/ai-usage`, 'synthetic-portal-token-owner-a-00001');
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(mine.headers.get('content-disposition'), `attachment; filename="realbud-ai-usage-${invoice.id}.csv"`);
  assert.equal(await mine.text(), csv);
  assert.equal((await get(`/v1/portal/invoices/${invoice.id}/ai-usage`, 'synthetic-portal-token-owner-b-00001')).status, 404);
  const list = await (await get('/v1/portal/invoices', 'synthetic-portal-token-owner-a-00001')).json() as { invoices: Row[] };
  assert.equal(list.invoices[0].aiUsageCsv, true);
  const one = await (await get(`/v1/portal/invoices/${invoice.id}`, 'synthetic-portal-token-owner-a-00001')).json() as Row;
  assert.deepEqual(one.links, { document: `/api/account/invoices/${invoice.id}?kind=document`, aiUsageCsv: `/api/account/invoices/${invoice.id}/ai-usage` });
});

test('a portal acceptance brings Modelvia to the accepted markup; a failed sync never fails the acceptance', async () => {
  const { f, billing, m, draft } = offices();
  const published = billing.commercialTerms!.publish(draft('company-a', 'care-a1', 2500));
  let failing = false;
  const server = createGatewayServer({ allowedOrigins: new Set(), billing,
    afterTermsAccepted: async companyId => { if (failing) throw new Error('boom'); return syncOfficeResalePolicy({ ledger: f.ledger, modelvia: m.operator, clientFundedCompanies: new Set() }, companyId); },
    portal: { async authenticate(bearer) { if (bearer === 'synthetic-portal-token-owner-a-00001') return f.owner; throw new GatewayError('unauthenticated', 401); } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const accept = (version: string, digest: string) => fetch(`${base}/v1/portal/commercial-terms/accept`, { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-portal-token-owner-a-00001', 'Content-Type': 'application/json' }, body: JSON.stringify({ period: '2026-09', version, digest }) });
  assert.equal((await accept('care-a1', published.digest)).status, 200);
  assert.deepEqual(m.policies.map(p => p.clientMarkupBasisPoints), [2500]);
  failing = true;
  const next = billing.commercialTerms!.publish(draft('company-a', 'care-a2', 3500));
  assert.equal((await accept('care-a2', next.digest)).status, 200);
  assert.deepEqual(m.policies.map(p => p.clientMarkupBasisPoints), [2500]);
  assert.equal(officeMarkup(f.ledger, 'company-a').policy, 'not_synced');
});

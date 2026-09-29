// Module-level billing checks against real local source. Fictional data only.
// No network. Modelvia = git archive of origin/main in scratch; RealBud = working tree.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCR = '/private/tmp/claude-501/-Users-yoda-projects-RealBud/1e5b5f5f-34c1-402c-9819-6956729fe386/scratchpad/billing';
const OUT = process.env.OUT;
const MV = pathToFileURL(SCR + '/mv/managed-gateway/').href;
const RB = pathToFileURL('/Users/yoda/projects/RealBud/.claude/worktrees/agent-a1cd71bab01bdf6f7/managed-gateway/').href;
const WEB = pathToFileURL('/Users/yoda/projects/RealBud/.claude/worktrees/agent-a1cd71bab01bdf6f7/website/lib/').href;
const results = [];
async function check(id, scenario, expected, fn) {
  const row = { id, scenario, expected, actual: null, pass: false, evidence: 'billing/module-checks.json#' + id };
  try { row.actual = await fn(); row.pass = true; }
  catch (e) { row.actual = 'FAIL: ' + (e?.message ?? String(e)).split('\n').slice(0, 6).join(' | '); }
  results.push(row); console.log(`${row.pass ? 'PASS' : 'FAIL'} ${id} ${scenario} -> ${typeof row.actual === 'string' ? row.actual : JSON.stringify(row.actual)}`);
}
const rejectsCode = async (p, code) => { try { await p; } catch (e) { const got = e?.code ?? e?.message; assert.match(String(got), new RegExp(code)); return { refused: got, status: e?.status }; } throw new Error(`expected ${code}, got success`); };

// ---------------- RealBud managed-gateway money ----------------
const rbMoney = await import(RB + 'money.ts');
const mvMoney = await import(MV + 'money.ts');
await check('R-money-cents', 'nanoAUD -> cents rounding (RealBud money.ts cents)', 'half-up: 4_999_999->0, 5_000_000->1, 14_999_999->1, 15_000_000->2, -5_000_000->-1',
  () => { const r = [4_999_999n, 5_000_000n, 14_999_999n, 15_000_000n, -5_000_000n, -4_999_999n].map(n => rbMoney.cents(n).toString()); assert.deepEqual(r, ['0', '1', '1', '2', '-1', '0']); return r.join(','); });
await check('MV-money-cents', 'nanoAUD -> cents rounding (Modelvia money.ts cents)', 'identical to RealBud', () => {
  const inputs = [0n, 1n, 4_999_999n, 5_000_000n, 14_999_999n, 15_000_000n, -5_000_000n, 123_456_789_012n];
  const a = inputs.map(n => mvMoney.cents(n).toString()), b = inputs.map(n => rbMoney.cents(n).toString());
  assert.deepEqual(a, b); return a.join(',');
});
await check('R-gst', 'GST inclusive 1/11 of gross cents (gstCents)', '1100->100, 12500->1136, 11->1, 5->0, 6->1, -1100->-100; MV identical',
  () => { const inp = [1100n, 12500n, 11n, 5n, 6n, -1100n, 0n]; const r = inp.map(n => rbMoney.gstCents(n).toString()); assert.deepEqual(r, ['100', '1136', '1', '0', '1', '-100', '0']); assert.deepEqual(inp.map(n => mvMoney.gstCents(n).toString()), r); return r.join(','); });
await check('R-price', 'units x rate (price) rounds each unit category up to 1 nano', '1234*1 + ceil(567*7000001/1000)=3970235; MV identical', () => {
  const rate = { model: 'm', label: 'm', units: { input_tokens: { nanoAud: '1', perUnits: 1 }, output_tokens: { nanoAud: '7000001', perUnits: 1000 } } };
  const units = { input_tokens: 1234, output_tokens: 567 };
  const a = rbMoney.price(rate, units), b = mvMoney.price(rate, units); assert.equal(a, 3970235n); assert.equal(b, a); return a.toString();
});

// ---------------- RealBud care invoice + Square-shaped payment idempotency ----------------
const rbTesting = await import(RB + 'testing.ts');
const { BillingService: RbBilling } = await import(RB + 'billing.ts');
const { invoiceHtml: rbInvoiceHtml } = await import(RB + 'invoice-html.ts');
{
  const f = rbTesting.fixture();
  try {
    // second office in the same ledger
    const officeB = { ...f.tenant, companyId: 'fictional-office-b', licenseId: 'license-b', customerName: 'Fictional Agency B' };
    f.ledger.provisionTenant(officeB);
    const ownerB = { subject: 'portal-owner-b', companyId: officeB.companyId, role: 'billing_owner' };
    let createCalls = 0; let settle = null;
    const adapter = { id: 'square-sandbox', mode: 'sandbox',
      async createCheckout(req) { createCalls++; return { sessionId: `order-${req.attemptId}`, url: 'https://connect.squareupsandbox.com/checkout/fictional', expiresAt: f.now() + 60_000 }; },
      async verifyWebhook() { return settle; }, async requestRefund() {}, async verifyRefundWebhook() { return null; } };
    const billing = new RbBilling(f.ledger, adapter, { authorizeCollection: true, internalCompanyId: 'realbud-internal' });
    const pubA = billing.commercialTerms.publish(rbTesting.careTermsDraft(f, 'care-a', '12500'));
    billing.commercialTerms.accept(f.owner, '2026-09', 'care-a', pubA.digest);
    const pubB = billing.commercialTerms.publish(rbTesting.careTermsDraft({ tenant: officeB }, 'care-b', '9999'));
    billing.commercialTerms.accept(ownerB, '2026-09', 'care-b', pubB.digest);
    f.setTime(Date.parse('2026-10-01T00:00:00Z'));
    let invA, invB;
    await check('R-care-invoice', 'RealBud care invoice: AUD, GST-inclusive, 10% (1/11)', 'A: 12500c GST 1136c; B: 9999c GST 909c; currency AUD, gstInclusive', () => {
      invA = billing.finalizeCommercialInvoice(f.tenant.companyId, '2026-09', 'care-a');
      invB = billing.finalizeCommercialInvoice(officeB.companyId, '2026-09', 'care-b');
      assert.equal(invA.currency, 'AUD'); assert.equal(invA.gstInclusive, true); assert.equal(invA.totalCents, '12500'); assert.equal(invA.gstCents, '1136');
      assert.equal(invB.totalCents, '9999'); assert.equal(invB.gstCents, '909');
      const html = rbInvoiceHtml(invA); assert.match(html, /A\$125\.00/); assert.match(html, /A\$11\.36/);
      return { A: [invA.id, invA.totalCents, invA.gstCents], B: [invB.id, invB.totalCents, invB.gstCents] };
    });
    await check('R-care-isolation', 'RealBud care invoices are per office', 'office B cannot read A invoice (404); list shows own only', async () => {
      const r = await rejectsCode(Promise.resolve().then(() => billing.invoice(ownerB, invA.id)), 'invoice_not_found');
      assert.deepEqual(billing.portalInvoices(ownerB).map(i => i.id), [invB.id]); assert.deepEqual(billing.portalInvoices(f.owner).map(i => i.id), [invA.id]);
      await rejectsCode(billing.checkout(ownerB, invA.id), 'invoice_not_found');
      return r;
    });
    await check('R-checkout-double', 'RealBud checkout double submit', 'one provider createCheckout, same session twice', async () => {
      const [s1, s2] = await Promise.all([billing.checkout(f.owner, invA.id), billing.checkout(f.owner, invA.id)].map(p => p.catch(e => ({ error: e.code }))));
      const s3 = await billing.checkout(f.owner, invA.id);
      assert.equal(createCalls, 1, `createCheckout calls ${createCalls}`);
      return { concurrent: [s1.sessionId ?? s1.error, s2.sessionId ?? s2.error], sequentialRepeatSame: s3.sessionId === (s1.sessionId ?? s2.sessionId), createCalls };
    });
    await check('R-webhook-double', 'RealBud payment webhook replay', 'one payment row; replay duplicate; checkout after paid refused', async () => {
      const stored = JSON.parse(f.db.get('SELECT body FROM checkouts WHERE invoice=?', invA.id).body);
      settle = { eventId: 'evt-1', transactionId: 'txn-1', invoiceId: invA.id, attemptId: stored.attemptId, sessionId: stored.session.sessionId, amountCents: '12500', currency: 'AUD', settledAt: f.now() };
      const a = await billing.webhook(Buffer.from('{}'), 'sig'); const b = await billing.webhook(Buffer.from('{}'), 'sig');
      settle = { ...settle, eventId: 'evt-2' }; const c = await billing.webhook(Buffer.from('{}'), 'sig');
      settle = { ...settle, eventId: 'evt-3', transactionId: 'txn-2' }; const d = await billing.webhook(Buffer.from('{}'), 'sig').then(x => x, e => ({ error: e.code }));
      const payments = f.db.all('SELECT id FROM payments').length; assert.equal(payments, 1);
      const after = await rejectsCode(billing.checkout(f.owner, invA.id), 'invoice_already_paid');
      assert.equal(a.duplicate, false); assert.equal(b.duplicate, true); assert.equal(c.duplicate, true);
      return { first: a, replay: b, newEventSameTxn: c, secondTxnSameInvoice: d, paymentRows: payments, checkoutAfterPaid: after.refused };
    });
  } finally { f.close(); }
}

// ---------------- RealBud provisioning caps + label ----------------
const prov = await import(RB + 'provisioning.ts');
await check('R-projectCaps', 'projectCaps: request cap = min(service request cap, customer monthly)', 'monthly A$0.50 -> request 500000000; monthly A$200 -> request A$1 default', () => {
  const a = prov.projectCaps({ active: true, monthlyCapNanoAud: '500000000', maxConcurrent: 2 });
  const b = prov.projectCaps({ active: true, monthlyCapNanoAud: '200000000000', maxConcurrent: 2 });
  assert.equal(a.requestCapNanoAud, '500000000'); assert.equal(b.requestCapNanoAud, '1000000000');
  return { a, b, labelA: prov.spendCapLabel(a), labelBoundary: prov.spendCapLabel({ monthlyCapNanoAud: '4999999', requestCapNanoAud: '4999999', maxConcurrent: 1 }), labelBoundary2: prov.spendCapLabel({ monthlyCapNanoAud: '5000000', requestCapNanoAud: '5000000', maxConcurrent: 1 }) };
});

// ---------------- Website display money + access parsing + payment attempt ----------------
const webMoney = await import(WEB + 'money.ts');
await check('W-display-vs-invoice', 'Website formatAudFromNano vs invoice cents() for same nano', 'display equals invoice rounding at 5_000_000 / 15_000_000 / 25_000_000 / 4_999_999 nano', () => {
  const rows = [4_999_999, 5_000_000, 15_000_000, 25_000_000, 35_000_000, 1_005_000_000].map(n => ({ nano: n, display: webMoney.formatAudFromNano(String(n)), invoiceCents: rbMoney.cents(BigInt(n)).toString() }));
  const mismatch = rows.filter(r => r.display.replace(/[^0-9]/g, '').replace(/^0+/, '') !== r.invoiceCents.replace(/^0+/, ''));
  assert.equal(mismatch.length, 0, 'display/invoice mismatch: ' + JSON.stringify(mismatch));
  return rows;
});
const webAccess = await import(WEB + 'office-ai-access.ts');
await check('W-cap-input', 'Website custom cap input A$1..A$10,000 -> nanoAUD', '1 -> 1e9; 10000 -> 1e13; 0.99, 10000.01, 1.005 refused', () => {
  const r = Object.fromEntries(['1', '1.00', '10000', '0.99', '10000.01', '1.005', '12.5'].map(v => [v, webAccess.audToNano(v)]));
  assert.equal(r['1'], '1000000000'); assert.equal(r['10000'], '10000000000000'); assert.equal(r['0.99'], null); assert.equal(r['10000.01'], null); assert.equal(r['1.005'], null);
  return r;
});
const attempt = await import(WEB + 'payment-attempt.ts');
await check('W-attempt-double', 'Website Pay double click (payment-attempt receipt)', 'second record for same invoice throws payment_attempt_held', () => {
  const m = new Map(); const storage = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  attempt.recordPaymentAttempt(storage, 'fictional-office-a', 'AI-LOCAL-000001');
  assert.throws(() => attempt.recordPaymentAttempt(storage, 'fictional-office-a', 'AI-LOCAL-000001'), /payment_attempt_held/);
  attempt.recordPaymentAttempt(storage, 'fictional-office-b', 'AI-LOCAL-000001');
  return 'held for A; B independent';
});

// ---------------- Modelvia: two offices, two installation projects each ----------------
const mvTesting = await import(MV + 'testing.ts');
const { Accounts } = await import(MV + 'accounts.ts');
const { ProjectKeys } = await import(MV + 'keys.ts');
const { BillingService: MvBilling } = await import(MV + 'billing.ts');
const { digest: mvDigest } = await import(MV + 'ledger.ts');
{
  const f = await mvTesting.fixture();
  const card = { version: 'fictional-nano-r1', currency: 'AUD', gstInclusive: true, gstBasisPoints: 1000, publishedAt: f.now() - 1000, effectiveAt: f.now() - 1000,
    models: [{ model: 'fictional-model', label: 'Fictional model', units: { input_tokens: { nanoAud: '1', perUnits: 1 }, output_tokens: { nanoAud: '7000001', perUnits: 1000 }, cache_read_tokens: { nanoAud: '1', perUnits: 1 } } }] };
  await f.ledger.publishCard(card);
  const accounts = new Accounts(f.db, f.now), keys = new ProjectKeys(f.ledger);
  const common = { active: true, maxConcurrent: 8, allowedModels: ['fictional-model'] };
  await accounts.put('client', { ...common, monthlyCapNanoAud: '100000000000000', version: 0, id: 'rb-platform', name: 'Fictional RealBud platform', billingMode: 'customer' }, 'operator');
  const offices = {};
  const bigCaps = { monthlyCapNanoAud: '1000000000000', requestCapNanoAud: '100000000000' };
  for (const office of ['office-a', 'office-b', 'office-r1', 'office-r2', 'office-r3', 'office-r4']) {
    await f.ledger.provisionTenant({ ...f.tenant, companyId: office, licenseId: 'lic-' + office, customerName: 'Fictional ' + office, plan: 'platform', includedUntil: f.tenant.goLiveAt, ...bigCaps, creditLimitNanoAud: '1000000000000' });
    await f.ledger.acceptCard({ ...f.owner, companyId: office }, card.version, mvDigest(card));
    await accounts.put('customer', { ...common, monthlyCapNanoAud: '100000000000', version: 0, id: 'cust-' + office, name: 'Customer ' + office, clientId: 'rb-platform', billingCompanyId: office }, 'operator');
    offices[office] = {};
    for (const inst of ['1', '2']) {
      const project = `rb-${office}-inst${inst}`;
      await accounts.put('project', { ...common, monthlyCapNanoAud: '100000000000', version: 0, id: project, name: project, clientId: 'rb-platform', customerId: 'cust-' + office, environments: ['development'], requestCapNanoAud: '100000000000' }, 'operator');
      const minted = await keys.mint({ companyId: office, project, environment: 'development' });
      offices[office][inst] = { companyId: office, keyId: minted.record.id, project };
    }
  }
  let n = 0;
  const admit = async (auth, idem, bound = { input_tokens: 20_000_000, output_tokens: 1000 }, fp = 'fp-' + idem) => (await f.ledger.admitKey(auth, 'fictional-model', card.version, fp, bound,
    { idempotencyKey: idem, scope: (await accounts.resolve(auth.project, 'development')).scope, requestedModel: 'auto', configuration: 'fictional-config', routingSource: 'fixture' }));
  const run = async (auth, units, idem = 'call-' + (++n)) => {
    const { record, duplicate } = await admit(auth, idem, { input_tokens: Math.max(units.input_tokens ?? 0, 1), output_tokens: Math.max(units.output_tokens ?? 0, 1), ...(units.cache_read_tokens ? { cache_read_tokens: units.cache_read_tokens } : {}) });
    if (!duplicate) { await f.ledger.dispatchKey(record.id, auth, f.provider.id); await f.ledger.settle(record.id, f.provider.id, f.evidence({ evidenceId: 'ev-' + idem, providerRequestId: 'prov-' + idem, units })); }
    return { ...(await f.ledger.request(record.id)), duplicate };
  };
  const A1 = offices['office-a']['1'], A2 = offices['office-a']['2'], B1 = offices['office-b']['1'], B2 = offices['office-b']['2'];
  const charged = {};
  await check('MV-usage-amount', 'Usage charge = units x rate (settled ledger record)', 'input 1234 x 1 nano + ceil(567 x 7000001/1000) = 3970235 nano', async () => {
    const r = await run(A1, { input_tokens: 1234, output_tokens: 567 }, 'a1-first'); charged.a1 = BigInt(r.chargedNanoAud);
    assert.equal(r.chargedNanoAud, '3970235'); assert.equal(r.project, A1.project); return { requestId: r.id, charged: r.chargedNanoAud, project: r.project, state: r.state };
  });
  await check('MV-idem-usage', 'Same idempotency key twice -> one charge', 'second admit returns duplicate:true with same record; request rows unchanged; no second usage_settled', async () => {
    const before = (await f.ledger.requests('office-a')).length;
    const again = await run(A1, { input_tokens: 1234, output_tokens: 567 }, 'a1-first');
    const after = (await f.ledger.requests('office-a')).length;
    const settledEvents = (await f.db.all("SELECT seq FROM events WHERE tenant='office-a' AND kind='usage_settled'")).length;
    // replaying settle with the same evidence must not double-bill
    const reSettle = await f.ledger.settle(again.id, f.provider.id, f.evidence({ evidenceId: 'ev-a1-first', providerRequestId: 'prov-a1-first', units: { input_tokens: 1234, output_tokens: 567 } })).then(x => 'ok:' + JSON.stringify(x)?.slice(0, 80), e => 'refused:' + e.code);
    const settledEvents2 = (await f.db.all("SELECT seq FROM events WHERE tenant='office-a' AND kind='usage_settled'")).length;
    assert.equal(again.duplicate, true); assert.equal(after, before); assert.equal(settledEvents, 1); assert.equal(settledEvents2, 1);
    const conflict = await rejectsCode(admit(A1, 'a1-first', { input_tokens: 5, output_tokens: 5 }, 'fp-different-body').then(x => { if (x.duplicate) throw Object.assign(new Error('duplicate'), { code: 'duplicate_returned' }); return x; }), 'idempotency_conflict|duplicate_returned');
    return { duplicate: again.duplicate, requestRows: after, usageSettledEvents: settledEvents2, reSettle, differentBodySameKey: conflict.refused };
  });
  await check('MV-attribution', 'Per-office / per-installation attribution in ledger', 'A requests only in office-a ledger with A projects; B only in B', async () => {
    const a2 = await run(A2, { input_tokens: 1000, output_tokens: 1000 }); charged.a2 = BigInt(a2.chargedNanoAud);
    const b1 = await run(B1, { input_tokens: 2000, output_tokens: 0 }); const b2 = await run(B2, { input_tokens: 3000, output_tokens: 0 });
    const reqA = await f.ledger.requests('office-a'), reqB = await f.ledger.requests('office-b');
    assert.deepEqual(reqA.map(r => r.project).sort(), [A1.project, A2.project]); assert.deepEqual(reqB.map(r => r.project).sort(), [B1.project, B2.project]);
    assert(reqA.every(r => r.companyId === 'office-a')); assert(reqB.every(r => r.companyId === 'office-b'));
    // a B key cannot admit against an A project
    const cross = await rejectsCode(f.ledger.admitKey({ ...B1, project: A1.project }, 'fictional-model', card.version, 'fp-x', { input_tokens: 1, output_tokens: 1 }, { idempotencyKey: 'x', scope: (await accounts.resolve(A1.project, 'development')).scope, requestedModel: 'auto', configuration: 'fictional-config', routingSource: 'fixture' }), 'invalid_key');
    return { officeA: reqA.map(r => [r.project, r.chargedNanoAud]), officeB: reqB.map(r => [r.project, r.chargedNanoAud]), crossKeyAdmit: cross.refused };
  });
  await check('MV-cap-request', 'Per-request cap enforced at admission', 'reservation > project requestCap -> 402 project_request_cap_exceeded, nothing reserved', async () => {
    const proj = await accounts.get('project', A2.project);
    await accounts.put('project', { ...proj, requestCapNanoAud: '1000' }, 'operator');
    const before = (await f.ledger.requests('office-a')).length;
    const r = await rejectsCode(admit(A2, 'a2-too-big', { input_tokens: 1001, output_tokens: 0 }), 'request_cap_exceeded');
    const ok = await admit(A2, 'a2-fits', { input_tokens: 1000, output_tokens: 0 });
    await f.ledger.dispatchKey(ok.record.id, A2, f.provider.id); await f.ledger.settle(ok.record.id, f.provider.id, f.evidence({ evidenceId: 'ev-fits', providerRequestId: 'p-fits', units: { input_tokens: 10, output_tokens: 0 } }));
    const p2 = await accounts.get('project', A2.project); await accounts.put('project', { ...p2, requestCapNanoAud: '100000000000' }, 'operator');
    assert.equal((await f.ledger.requests('office-a')).length, before + 1);
    return { ...r, atCapAdmitted: true };
  });
  await check('MV-cap-monthly-hold', 'Monthly cap counts reservation holds; customer cap spans both installations', 'hold on inst1 blocks inst2 beyond customer cap (402 customer_monthly_cap_exceeded); release frees it', async () => {
    const cust = await accounts.get('customer', 'cust-office-a');
    const exposure = (await f.ledger.requests('office-a')).filter(r => r.state === 'settled').reduce((s, r) => s + BigInt(r.chargedNanoAud), 0n);
    // mid-month cap change: customer cap = exposure + 1_500_000
    await accounts.put('customer', { ...cust, monthlyCapNanoAud: (exposure + 1_500_000n).toString() }, 'operator');
    const hold = await admit(A1, 'a1-hold', { input_tokens: 1_000_000, output_tokens: 0 });  // reserve 1_000_000
    const blocked = await rejectsCode(admit(A2, 'a2-blocked', { input_tokens: 1_000_000, output_tokens: 0 }), 'monthly_cap_exceeded');
    await f.ledger.dispatchKey(hold.record.id, A1, f.provider.id); await f.ledger.settle(hold.record.id, f.provider.id, f.evidence({ evidenceId: 'ev-hold', providerRequestId: 'p-hold', units: { input_tokens: 100, output_tokens: 0 } }));
    const after = await admit(A2, 'a2-after', { input_tokens: 1_000_000, output_tokens: 0 });
    await f.ledger.dispatchKey(after.record.id, A2, f.provider.id); await f.ledger.settle(after.record.id, f.provider.id, f.evidence({ evidenceId: 'ev-after', providerRequestId: 'p-after', units: { input_tokens: 100, output_tokens: 0 } }));
    // B unaffected by A's cap
    const b = await run(B1, { input_tokens: 5, output_tokens: 0 });
    const c2 = await accounts.get('customer', 'cust-office-a'); await accounts.put('customer', { ...c2, monthlyCapNanoAud: '100000000000' }, 'operator');
    return { blocked: blocked.refused, status: blocked.status, afterReleaseAdmitted: after.record.state ?? 'reserved', officeBUnaffected: b.state };
  });
  await check('MV-disabled-customer', 'Disabled customer / revoked key stop admission', 'inactive customer -> refused; revoked key -> 401 key_revoked; office B still admits', async () => {
    const cust = await accounts.get('customer', 'cust-office-a');
    await accounts.put('customer', { ...cust, active: false }, 'operator');
    const disabled = await rejectsCode(admit(A1, 'a1-disabled', { input_tokens: 1, output_tokens: 1 }), '.');
    const c2 = await accounts.get('customer', 'cust-office-a'); await accounts.put('customer', { ...c2, active: true }, 'operator');
    await keys.revoke(B2.keyId, 'operator').catch(async e => { if (/is not a function/.test(e.message)) return keys.revoke({ id: B2.keyId }); throw e; });
    const revoked = await rejectsCode(admit(B2, 'b2-revoked', { input_tokens: 1, output_tokens: 1 }), 'key_revoked');
    const b1 = await run(B1, { input_tokens: 7, output_tokens: 0 });
    return { disabledCustomer: disabled, revokedKey: revoked, siblingStillServes: b1.state };
  });
  // Rounding-boundary billing accounts (one request each, input rate 1 nano / token)
  await run(offices['office-r1']['1'], { input_tokens: 4_999_999 });
  await run(offices['office-r2']['1'], { input_tokens: 5_000_000 });
  await run(offices['office-r3']['1'], { input_tokens: 4_999_999 }); await run(offices['office-r3']['2'], { input_tokens: 4_999_999 });
  let r4Error = null; await run(offices['office-r4']['1'], { input_tokens: 1_000_000_000, cache_read_tokens: 100_000_000 }).catch(e => { r4Error = e.code ?? e.message; });
  await run(offices['office-r4']['2'], { input_tokens: 1_000_000_000, cache_read_tokens: 100_000_000 }).catch(e => { r4Error = e.code ?? e.message; }); // 2 x 1.1e9 x ... see below
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing = new MvBilling(f.ledger, f.payment, { platformSupplier: { legalName: 'Fictional Platform Seller', product: 'Fictional AI', abn: '00000000000', gstRegistered: true } });
  const inv = {};
  await check('MV-invoice-rounding', 'Invoice nano->cents at close (boundaries)', 'r1 4_999_999 -> 0c; r2 5_000_000 -> 1c GST 0; r3 2x4_999_999 -> 1c via rounding adjustment line; all AUD gstInclusive', async () => {
    for (const o of ['office-r1', 'office-r2', 'office-r3']) inv[o] = await billing.finalizeLocalInvoice(o, '2026-09');
    const s = o => ({ total: inv[o].totalCents, gst: inv[o].gstCents, kind: inv[o].kind, currency: inv[o].currency, gstInclusive: inv[o].gstInclusive, lines: inv[o].lines.map(l => [l.description.slice(0, 30), l.amountNanoAud, l.amountCents, l.gstCents]) });
    assert.equal(inv['office-r1'].totalCents, '0'); assert.equal(inv['office-r2'].totalCents, '1'); assert.equal(inv['office-r2'].gstCents, '0'); assert.equal(inv['office-r3'].totalCents, '1');
    assert(inv['office-r3'].lines.some(l => /rounding/i.test(l.description)));
    for (const o of ['office-r1', 'office-r2', 'office-r3']) { assert.equal(inv[o].currency, 'AUD'); assert.equal(inv[o].gstInclusive, true); }
    return { r1: s('office-r1'), r2: s('office-r2'), r3: s('office-r3') };
  });
  await check('MV-invoice-gst', 'Invoice GST = round-half-up(total/11) and lines sum to total', 'r4 2 x 1.1e9 nano = 220c -> GST 20c; A/B lines and line GST sum to totals', async () => {
    let r4 = null;
    if (r4Error) throw new Error('r4 usage not admitted: ' + r4Error);
    inv['office-r4'] = await billing.finalizeLocalInvoice('office-r4', '2026-09'); r4 = { total: inv['office-r4'].totalCents, gst: inv['office-r4'].gstCents, lines: inv['office-r4'].lines.map(l => [l.amountNanoAud, l.amountCents, l.gstCents]) };
    inv.A = await billing.finalizeLocalInvoice('office-a', '2026-09'); inv.B = await billing.finalizeLocalInvoice('office-b', '2026-09');
    for (const i of [inv.A, inv.B]) {
      assert.equal(i.lines.reduce((s, l) => s + BigInt(l.amountCents), 0n).toString(), i.totalCents);
      assert.equal(i.lines.reduce((s, l) => s + BigInt(l.gstCents), 0n).toString(), i.gstCents);
      assert.equal(mvMoney.gstCents(BigInt(i.totalCents)).toString(), i.gstCents);
    }
    assert.equal(r4.total, '220'); assert.equal(r4.gst, '20');
    return { r4, A: { total: inv.A.totalCents, gst: inv.A.gstCents, lines: inv.A.lines.length }, B: { total: inv.B.totalCents, gst: inv.B.gstCents, lines: inv.B.lines.length } };
  });
  await check('MV-invoice-isolation', 'Office A invoice holds only A usage; per-installation visible', 'A lines reference only A request ids; B only B; totals = cents(sum of settled charges)', async () => {
    const reqA = (await f.ledger.requests('office-a')).filter(r => r.state === 'settled'), reqB = (await f.ledger.requests('office-b')).filter(r => r.state === 'settled');
    const idsA = new Set(reqA.map(r => r.id)), idsB = new Set(reqB.map(r => r.id));
    const linesA = inv.A.lines.filter(l => l.requestId), linesB = inv.B.lines.filter(l => l.requestId);
    assert(linesA.every(l => idsA.has(l.requestId)) && linesA.length === reqA.filter(r => BigInt(r.chargedNanoAud) > 0n).length);
    assert(linesB.every(l => idsB.has(l.requestId)));
    assert.equal(inv.A.totalCents, mvMoney.cents(reqA.reduce((s, r) => s + BigInt(r.chargedNanoAud), 0n)).toString());
    assert.equal(inv.B.totalCents, mvMoney.cents(reqB.reduce((s, r) => s + BigInt(r.chargedNanoAud), 0n)).toString());
    const ownerB = { ...f.owner, companyId: 'office-b' };
    const cross = await rejectsCode(billing.invoice(ownerB, inv.A.id), 'invoice_not_found');
    const again = await billing.finalizeLocalInvoice('office-a', '2026-09');
    assert.equal(again.id, inv.A.id);
    const usedBy = [...new Set(linesA.map(l => l.usedBy?.customerId ?? l.usedBy?.kind))];
    return { A: { lines: linesA.length, total: inv.A.totalCents, usedBy }, B: { lines: linesB.length, total: inv.B.totalCents }, crossRead: cross.refused, reCloseSameInvoice: again.id };
  });
  await check('MV-payment-idem', 'Modelvia invoice checkout + webhook double submit', 'same session twice; replayed webhook duplicate; one payment row', async () => {
    const owner = { ...f.owner, companyId: 'office-a' };
    const [s1, s2] = await Promise.all([billing.checkout(owner, inv.A.id), billing.checkout(owner, inv.A.id)].map(p => p.catch(e => ({ error: e.code }))));
    const s3 = await billing.checkout(owner, inv.A.id);
    const stored = JSON.parse((await f.db.get('SELECT body FROM checkouts WHERE invoice=?', inv.A.id)).body);
    const payment = { eventId: 'evt-a', transactionId: 'txn-a', invoiceId: inv.A.id, attemptId: stored.attemptId, sessionId: s3.sessionId, amountCents: inv.A.totalCents, currency: 'AUD', settledAt: f.now() };
    const ev = f.signedEvent({ mode: 'local', status: 'settled', payment });
    const w1 = await billing.webhook(ev.raw, ev.signature), w2 = await billing.webhook(ev.raw, ev.signature);
    const ev2 = f.signedEvent({ mode: 'local', status: 'settled', payment: { ...payment, eventId: 'evt-a2' } }); const w3 = await billing.webhook(ev2.raw, ev2.signature);
    const rows = (await f.db.all('SELECT id FROM payments WHERE invoice=?', inv.A.id)).length; assert.equal(rows, 1);
    const after = await rejectsCode(billing.checkout(owner, inv.A.id), 'invoice_already_paid|already');
    assert.equal(s3.sessionId, s1.sessionId ?? s2.sessionId);
    return { concurrent: [s1.sessionId ?? s1.error, s2.sessionId ?? s2.error], w1, w2, w3, paymentRows: rows, checkoutAfterPaid: after.refused };
  });
  await f.close();
}
const summary = { at: new Date().toISOString(), tier: 'local source modules, fictional data, no network', passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results };
if (OUT) writeFileSync(OUT, JSON.stringify(summary, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed }));

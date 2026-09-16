import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './testing.ts';
import { SquareBilling } from './square.ts';
import { digest, UsageLedger } from './ledger.ts';
import { LedgerDatabase } from './database.ts';

async function setup(path = ':memory:') {
  const f = fixture(path), notificationUrl = 'https://fixture.invalid/square', key = 'fixture-signature-key';
  let order: Record<string, any>, invoice: Record<string, any>;
  let pause: { path: string; reached: () => void; wait: Promise<void> } | undefined;
  let posts = 0;
  let secretPause: { reached: () => void; wait: Promise<void> } | undefined;
  const transport = (async (input, options) => {
    const pathname = new URL(String(input)).pathname, body = JSON.parse(String(options?.body ?? '{}'));
    if (options?.method === 'POST') posts++;
    if (pause?.path === pathname) { const active = pause; pause = undefined; active.reached(); await active.wait; }
    if (pathname === '/v2/merchants/m') return Response.json({ merchant: { id: 'm' } });
    if (pathname === '/v2/locations/l') return Response.json({ location: { id: 'l', merchant_id: 'm', status: 'ACTIVE', currency: 'AUD' } });
    if (pathname === '/v2/orders') { const amount = body.order.line_items[0].base_price_money.amount; order = { ...body.order, id: `o-${posts}`, total_money: { amount, currency: 'AUD' }, total_tax_money: { amount: Math.floor((amount + 5) / 11), currency: 'AUD' } }; return Response.json({ order }); }
    if (pathname === '/v2/invoices') { invoice = { ...body.invoice, id: 'i', version: 0, status: 'DRAFT', payment_requests: [{ ...body.invoice.payment_requests[0], computed_amount_money: order.total_money }] }; return Response.json({ invoice }); }
    if (pathname === '/v2/invoices/i') return Response.json({ invoice });
    if (pathname === '/v2/payments/p') return Response.json({ payment: { id: 'p', status: 'COMPLETED', location_id: 'l', order_id: order.id, customer_id: 'c', source_type: 'CARD', total_money: { amount: 2, currency: 'AUD' }, updated_at: '2026-10-15T00:00:00Z' } });
    if (pathname === '/v2/refunds/r') return Response.json({ refund: { id: 'r', payment_id: 'p', status: 'COMPLETED', location_id: 'l', amount_money: { amount: 2, currency: 'AUD' }, updated_at: '2026-11-15T00:00:00Z' } });
    throw Error('Unrecognized synthetic path');
  }) as typeof fetch;
  const squareFor = (ledger: UsageLedger) => new SquareBilling({ ledger, fetch: transport, secret: async () => { if(secretPause && ledger.db.get("SELECT id FROM square_outbox WHERE state='running'")) { const active=secretPause;secretPause=undefined;active.reached();await active.wait; } return 'fixture-only'; }, signatureKey: async () => key, notificationUrl });
  const square = squareFor(f.ledger);
  const event = async (type: string, id: string, target = square) => {
    const raw = Buffer.from(JSON.stringify({ event_id: `event-${id}`, merchant_id: 'm', type, data: { id } }));
    await target.webhook(raw, createHmac('sha256', key).update(notificationUrl).update(raw).digest('base64'));
  };
  await f.run(); const request = f.ledger.requests('company-a')[0];
  square.map({ companyId: 'company-a', merchantId: 'm', customerId: 'c', locationId: 'l', evidence: 'fixture' });
  f.setTime(Date.parse('2026-10-15T00:00:00Z'));
  const original = square.closeStatement('company-a', '2026-09');
  square.accept(f.owner, original.id, digest(original)); await square.createDraft(f.owner, original.id, '2026-10-30');
  await event('payment.updated', 'p');
  const credit = () => f.ledger.credit(request.id, 'credit', '10000000', 'fixture-source-credit');
  const closeNext = () => { f.setTime(Date.parse('2026-11-15T00:00:00Z')); return square.closeStatement('company-a', '2026-10', 'fictional-care'); };
  const pauseNext = (pathname: string) => {
    let reached!: () => void, release!: () => void;
    const arrived = new Promise<void>(resolve => { reached = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    pause = { path: pathname, reached, wait }; return { arrived, release };
  };
  const pausePostSecret = () => { let reached!:()=>void,release!:()=>void;const arrived=new Promise<void>(resolve=>{reached=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});secretPause={reached,wait};return {arrived,release}; };
  return { f, square, squareFor, event, original, credit, closeNext, pauseNext, pausePostSecret, posts: () => posts };
}

for (const ordering of ['refund_then_credit', 'credit_then_refund', 'applied_credit_then_refund'] as const) {
  test(`${ordering}: preserve real refund and immutable statements, flag allocation and hold further affected billing`, async () => {
    const s = await setup();
    try {
      let next: ReturnType<typeof s.closeNext> | undefined;
      if (ordering === 'refund_then_credit') { await s.event('refund.updated', 'r'); s.credit(); }
      else { s.credit(); if (ordering === 'applied_credit_then_refund') next = s.closeNext(); await s.event('refund.updated', 'r'); }
      await s.event('refund.updated', 'r');
      const money = s.square.paymentSummary(s.f.owner, s.original.id) as unknown as Record<string, any>;
      assert.equal(money.refundedCents, 2); assert.equal(money.netReceivedCents, 0);
      assert.equal(money.reconciliationRequired, true);
      assert.equal(money.allocationIssues.length, 1);
      assert.equal(money.allocationIssues[0].sourceStatementId, s.original.id);
      assert.equal(money.allocationIssues[0].creditStatementId, next?.id ?? null);
      if (next) { assert.equal(next.totalCents, 12499); assert.deepEqual(s.square.statement(s.f.owner, next.id), next); }
      else assert.throws(s.closeNext, /refund_credit_allocation_required/);
      s.f.setTime(Date.parse('2026-12-15T00:00:00Z'));
      assert.throws(() => s.square.closeStatement('company-a', '2026-11', 'care'), /refund_credit_allocation_required/);
      assert.throws(() => s.f.billing.finalizeLocalInvoice('company-a', '2026-11', 'care'), /refund_credit_allocation_required/);
      const postCount = s.posts(); await assert.rejects(s.square.createDraft(s.f.owner, next?.id ?? s.original.id, '2026-12-30'), /refund_credit_allocation_required/); assert.equal(s.posts(), postCount);
      assert.equal((s.f.ledger.portalUsage(s.f.owner) as unknown as Record<string, any>).billingReconciliation.required, true);
      assert.equal(s.f.db.all('SELECT id FROM square_refunds').length, 1);
      s.f.ledger.provisionTenant({ ...s.f.tenant, companyId: 'company-b', licenseId: 'license-b' });
      assert.equal(s.square.closeStatement('company-b', '2026-11', 'unrelated-care').totalCents, 12500);
      s.f.db.verify();
    } finally { s.f.close(); }
  });
}

test('refund readback racing with credit close across two SQLite connections remains visible after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'realbud-refund-race-')), path = join(dir, 'ledger.sqlite'), s = await setup(path);
  const otherDb = new LedgerDatabase(path), other = s.squareFor(new UsageLedger(otherDb, s.f.now));
  try {
    s.credit(); const pause = s.pauseNext('/v2/invoices/i');
    const refund = s.event('refund.updated', 'r', other); await pause.arrived;
    const next = s.closeNext(); pause.release(); await refund;
    assert.equal(next.creditNanoAud, '10000000');
    assert.equal((s.square.paymentSummary(s.f.owner, s.original.id) as unknown as Record<string, any>).reconciliationRequired, true);
    assert.throws(() => other.closeStatement('company-a', '2026-10', 'fictional-care'), /refund_credit_allocation_required/);
  } finally { otherDb.close(); s.f.close(); }
  const reopened = new LedgerDatabase(path);
  try {
    const restored = s.squareFor(new UsageLedger(reopened, s.f.now));
    const status = restored.paymentSummary(s.f.owner, s.original.id) as unknown as Record<string, any>;
    assert.equal(status.refundedCents, 2); assert.equal(status.reconciliationRequired, true);
    assert.throws(() => restored.closeStatement('company-a', '2026-10', 'fictional-care'), /refund_credit_allocation_required/);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('refund arriving during Square draft preflight blocks the write at its transaction boundary', async () => {
  const s = await setup();
  try {
    s.credit(); const next = s.closeNext(); s.square.accept(s.f.owner, next.id, digest(next));
    const pause = s.pauseNext('/v2/merchants/m'), postCount = s.posts();
    const draft = s.square.createDraft(s.f.owner, next.id, '2026-11-30'); await pause.arrived;
    await s.event('refund.updated', 'r'); pause.release();
    await assert.rejects(draft, /refund_credit_allocation_required/);
    assert.equal(s.posts(), postCount);
    assert.equal(s.f.db.all("SELECT id FROM square_outbox WHERE statement=? AND state IN ('running','unknown','done')", next.id).length, 0);
  } finally { s.f.close(); }
});


test('refund arriving after the outbox claim but before transport prevents the pending POST', async () => {
  const s = await setup();
  try {
    s.credit(); const next=s.closeNext();s.square.accept(s.f.owner,next.id,digest(next));
    const pause=s.pausePostSecret(),postCount=s.posts();
    const draft=s.square.createDraft(s.f.owner,next.id,'2026-11-30');await pause.arrived;
    await s.event('refund.updated','r');pause.release();
    await assert.rejects(draft,/refund_credit_allocation_required/);assert.equal(s.posts(),postCount);
    assert.equal(s.f.db.get<{state:string}>('SELECT state FROM square_outbox WHERE statement=?',next.id)!.state,'unknown');
    assert.equal(s.square.paymentSummary(s.f.owner,s.original.id).reconciliationRequired,true);
  } finally {s.f.close();}
});

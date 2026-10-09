/** Local provider transport fixture. Exercises the real SDK readback and journal,
 * never injects an active boolean/event and never sends an external request. */
import assert from 'node:assert/strict';
import type { UsageLedger } from './ledger.ts';
import { latestResaleAcceptance } from './commercial-terms.ts';
import { modelviaKeyClient } from './modelvia-keys.ts';
import { syncOfficeResalePolicy } from './office-ai-terms.ts';
const fixtures = new WeakMap<UsageLedger, { time: number; policies: Record<string, unknown>[] }>();
export async function syncTestResalePolicy(ledger: UsageLedger, companyId: string) {
  if (!latestResaleAcceptance(ledger, companyId)) return;
  const customer = ledger.db.get<{ customer: string }>('SELECT customer FROM office_modelvia_customer WHERE tenant=?', companyId)?.customer;
  assert.ok(customer, 'synthetic customer is bound before policy sync');
  let fixture = fixtures.get(ledger);
  if (!fixture) { fixture = { time: Date.parse('2026-09-01T00:00:00Z'), policies: [] }; fixtures.set(ledger, fixture); }
  fixture.time += 1000;
  const state = fixture;
  const sdk = modelviaKeyClient({ serviceOrigin: 'https://synthetic.modelvia.invalid', environment: 'production', clientId: 'realbud', allowedModels: ['synthetic'],
    scopedSecret: () => 'synthetic-test-only-operator-secret-at-least-32', operatorSubject: 'synthetic-test', now: () => state.time,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const json = (body: unknown) => Response.json(body, { headers: { date: new Date(state.time).toUTCString() } });
      if (path === '/v1/operator/customers') return json({ accounts: [{ id: customer, clientId: 'realbud', name: 'Fictional office', active: true, version: 1, payer: 'client', monthlyCapNanoAud: '200000000000', maxConcurrent: 2, allowedModels: ['synthetic'] }] });
      if (path === '/v1/operator/clients') return json({ accounts: [{ id: 'realbud', billingMode: 'client' }] });
      if (path === '/v1/operator/commercial-policies' && init.method === 'GET') return json({ policies: state.policies });
      if (path === '/v1/operator/commercial-policies' && init.method === 'POST') { const saved = JSON.parse(String(init.body)); state.policies.push(saved); return json(saved); }
      throw new Error(`synthetic_policy_route_denied:${path}`);
    } });
  const receipt = await syncOfficeResalePolicy({ ledger, modelvia: sdk, clientFundedCompanies: new Set() }, companyId);
  assert.equal(receipt.state, 'active', 'actual SDK verified the fictional provider policy');
  return receipt;
}

/**
 * One office's Square customer mapping: a reviewed, immutable operator record
 * (`commercial-cli.ts map`) naming the RealBud merchant, its AUD location and
 * the office's Square customer. No portal route and no Square call: the hosted
 * collection adapter (`square-payment.ts`) reads it before any checkout.
 */
import { canonical, exact, id, object, requireThat } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';

/** Square runs two entirely separate hosts with separate tokens. The host follows
 * the configured mode and is never inferred from a token's shape. */
export type SquareEnvironment = 'production' | 'sandbox';
export interface SquareMapping { companyId: string; merchantId: string; customerId: string; locationId: string; evidence: string }

export function recordSquareMapping(ledger: UsageLedger, mapping: SquareMapping, internalCompanyId?: string): void {
  object(mapping); exact(mapping as unknown as Record<string, unknown>, ['companyId', 'merchantId', 'customerId', 'locationId', 'evidence']);
  requireThat(!internalCompanyId || mapping.companyId !== internalCompanyId, 'internal_usage_not_billable', 403);
  Object.values(mapping).forEach(id);
  requireThat(ledger.tenant(mapping.companyId).billingMode !== 'internal_cost', 'internal_usage_not_billable', 403);
  ledger.db.transaction(() => {
    const prior = ledger.db.get<{ body: string }>('SELECT body FROM square_mappings WHERE tenant=?', mapping.companyId);
    if (prior) { requireThat(prior.body === canonical(mapping), 'square_mapping_conflict', 409); return; }
    ledger.db.run('INSERT INTO square_mappings(tenant,merchant,customer,body) VALUES(?,?,?,?)', mapping.companyId, mapping.merchantId, mapping.customerId, canonical(mapping));
    ledger.db.append(mapping.companyId, 'square_mapping_recorded', null, ledger.now(), mapping);
  });
}

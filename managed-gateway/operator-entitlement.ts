/**
 * One office's RealBud service entitlement, set by a RealBud operator over HTTP
 * instead of `entitlement-cli.ts set` on the machine. The rules are the
 * command's (`entitlementFromFlags`) and the write is the ledger's
 * (`putEntitlement`), so the route and the command cannot disagree.
 *
 *   PUT /v1/operator/offices/entitlement          operator bearer (operator-token.ts)
 *     { companyId, licenseId, name, address, evidence, goLiveEvidence,
 *       goLive: "YYYY-MM-DD", expires: "YYYY-MM-DD", active?: boolean }
 *   → { result: "created" | "updated" | "unchanged", entitlement }
 *   GET /v1/operator/offices/entitlement?companyId=…  → { entitlement } | 404 not_found
 *
 * Every field is given on every call, so the body is the whole entitlement; an
 * ABN stays as the command last stored it. `active` defaults as in the command.
 * A body equal to what is stored writes no entitlement change and answers
 * `unchanged`. Writes are serialized per company. One audit line per successful
 * write carries the operator subject, company and result only; the entitlement
 * events the ledger itself writes are the command's.
 */
import { GatewayError, id, requireThat, type Tenant } from './contracts.ts';
import { entitlementFromFlags, entitlementView } from './entitlement-cli.ts';
import type { UsageLedger } from './ledger.ts';
import { OPERATOR_ROLE, type OperatorPrincipal } from './operator-token.ts';
import { serialized } from './provisioning.ts';

export interface OperatorEntitlement {
  companyId: string; licenseId: string; active: boolean; serviceAvailable: boolean;
  goLiveAt: string; serviceExpiresAt: string; customerName: string; customerAddress: string;
}
export interface OperatorEntitlementRoutes {
  set(actor: OperatorPrincipal, value: unknown): Promise<{ result: 'created' | 'updated' | 'unchanged'; entitlement: OperatorEntitlement }>;
  get(actor: OperatorPrincipal, companyId: string | null): { entitlement: OperatorEntitlement };
}

const REQUIRED = ['companyId', 'licenseId', 'name', 'address', 'evidence', 'goLiveEvidence', 'goLive', 'expires'] as const;
const COMPARED = ['companyId', 'licenseId', 'active', 'serviceExpiresAt', 'customerName', 'customerAddress', 'customerAbn', 'goLiveAt', 'goLiveEvidence'] as const;

function operator(actor: OperatorPrincipal) {
  requireThat(actor && actor.role === OPERATOR_ROLE && typeof actor.subject === 'string', 'operator_unauthenticated', 401);
}
/** A calendar date, exactly YYYY-MM-DD; the command reads it as UTC midnight. */
function date(value: string, code: string) {
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), code);
}
function view(tenant: Tenant, now: number): OperatorEntitlement {
  const { companyId, licenseId, active, serviceAvailable, goLiveAt, serviceExpiresAt, customerName, customerAddress } = entitlementView(tenant, now);
  return { companyId, licenseId, active, serviceAvailable, goLiveAt, serviceExpiresAt, customerName, customerAddress };
}
function stored(ledger: UsageLedger, companyId: string): Tenant | undefined {
  const row = ledger.db.get<{ body: string }>('SELECT body FROM tenants WHERE id=?', companyId);
  return row ? JSON.parse(row.body) as Tenant : undefined;
}

export function operatorEntitlementRoutes(options: { ledger: UsageLedger }): OperatorEntitlementRoutes {
  const { ledger } = options;
  return {
    async set(actor, value) {
      operator(actor);
      requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid_entitlement');
      const body = value as Record<string, unknown>;
      const keys = Object.keys(body);
      requireThat(REQUIRED.every(key => keys.includes(key)) && keys.every(key => (REQUIRED as readonly string[]).includes(key) || key === 'active'), 'invalid_entitlement');
      requireThat(REQUIRED.every(key => typeof body[key] === 'string' && (body[key] as string).length > 0), 'invalid_entitlement');
      requireThat(body.active === undefined || typeof body.active === 'boolean', 'invalid_entitlement');
      const field = (key: typeof REQUIRED[number]) => body[key] as string;
      id(field('companyId')); id(field('evidence'));
      date(field('goLive'), 'invalid_go_live'); date(field('expires'), 'invalid_service_expiry');
      const companyId = field('companyId');
      return serialized(`operator-entitlement:${companyId}`, async () => {
        const current = stored(ledger, companyId);
        const entitlement = entitlementFromFlags({
          company: companyId, license: field('licenseId'), name: field('name'), address: field('address'),
          goLive: field('goLive'), goLiveEvidence: field('goLiveEvidence'), expires: field('expires'),
          ...(body.active === undefined ? {} : { active: String(body.active) }),
        }, current);
        let result: 'created' | 'updated' | 'unchanged', tenant: Tenant;
        if (current && COMPARED.every(key => current[key] === entitlement[key])) { result = 'unchanged'; tenant = current; }
        else { const saved = ledger.putEntitlement(entitlement, field('evidence')); result = saved.created ? 'created' : 'updated'; tenant = saved.tenant; }
        // The entitlement itself is journalled by the ledger with its evidence.
        ledger.db.transaction(() => ledger.db.append(companyId, 'operator_entitlement_set', null, ledger.now(), { subject: actor.subject, companyId, result }));
        return { result, entitlement: view(tenant, ledger.now()) };
      });
    },
    get(actor, companyId) {
      operator(actor);
      requireThat(typeof companyId === 'string', 'invalid_entitlement');
      id(companyId);
      const current = stored(ledger, companyId!);
      if (!current) throw new GatewayError('not_found', 404);
      return { entitlement: view(current, ledger.now()) };
    },
  };
}

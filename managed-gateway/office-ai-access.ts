/**
 * Office AI access, set by a RealBud operator (owner requirement, 24 September
 * 2026). Each office's Modelvia customer gets an AI monthly cap of A$200 by
 * default; an operator may set a custom cap or disable AI for the office.
 * Modelvia is the only source of caps, and this gateway alone holds the Modelvia
 * operator credential, so it owns the write.
 *
 *   POST /v1/operator/offices/ai-access
 *     { companyId, customerId, name, access }   operator bearer (operator-token.ts)
 *     access: {mode:'default'} | {mode:'custom', monthlyCapNanoAud} | {mode:'disabled'}
 *   → { customer: { active, monthlyCapNanoAud, created }, projects: [{ installationId, state, error? }] }
 *
 * Order: the company's entitlement record must exist (a typo guard, as in
 * caps-cli.ts); one audit line is journalled before any Modelvia call; the
 * customer is created or updated under RealBud's client only; then, unless AI
 * was disabled, the new cap is pushed to the company's ready installation
 * projects (`applyCustomerCaps`). A disabled customer needs no push: Modelvia
 * refuses serving for an inactive customer. Audit lines carry the operator
 * subject, company, mode and cap, never the Modelvia customer id or a secret.
 *
 * Commercial terms follow, unless AI was disabled: Modelvia refuses every request
 * of a customer RealBud's client pays for until an active commercial policy is in
 * force (`customer_terms_required`). A company listed in
 * `REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES` gets a client-funded policy (RealBud
 * absorbs its AI); any other office gets a resale policy only once its billing
 * owner accepted RealBud's monthly terms carrying AI resale, at the markup THOSE
 * terms stated and under that acceptance's own reference (`terms.state:
 * "acceptance_required"` until then; `"unconfigured"` when resale is not
 * configured and nothing was accepted). A resale office whose accepted markup
 * differs from the policy in force gets one NEW policy effective at Modelvia's
 * own time (`syncResaleTerms`); no policy is ever changed. A client-funded
 * policy is never replaced here: changing who pays is a dated migration at Modelvia.
 */
import { exact, GatewayError, id, object, requireThat } from './contracts.ts';
import type { HttpTransport } from './composio-org.ts';
import type { UsageLedger } from './ledger.ts';
import { DEFAULT_OFFICE_AI_CAP_NANO_AUD, parseOfficeAiAccess, type ModelviaOperatorClient } from './modelvia-keys.ts';
import { customerTermsPolicy, hasCustomerTerms, termsForCompany, type CustomerTermsPolicy, type CustomerTermsResult, type ModelviaTermsClient, type OfficeTermsDecision, type ResaleSyncResult } from './modelvia-keys.ts';
import { latestResaleAcceptance } from './commercial-terms.ts';
import type { MarginReport } from './office-ai-billing.ts';
import type { OfficeAiTermsRoutes } from './office-ai-terms.ts';
import { OPERATOR_ROLE, verifyOperatorToken, type OperatorPrincipal } from './operator-token.ts';
import { operatorEntitlementRoutes, type OperatorEntitlementRoutes } from './operator-entitlement.ts';
import { applyCustomerCaps, bindOfficeCustomer, composeModelvia, MODELVIA_CUSTOMER, MODELVIA_SCOPED_ENV, serialized, type CapsApplied } from './provisioning.ts';

export interface OfficeAiAccessResult {
  customer: { active: boolean; monthlyCapNanoAud: string; created: boolean };
  projects: CapsApplied[];
  /** The office's commercial terms at Modelvia. Present when the service was
   * composed with a terms policy and AI is on. `unconfigured`: this deployment
   * has not said how the office is billed, so nothing was written and the office
   * cannot be provisioned until it does. `failed` carries a code only. */
  terms?: CustomerTermsResult | ResaleSyncResult | { state: 'unconfigured' } | { state: 'acceptance_required' } | { state: 'failed'; error: string };
}

export class OfficeAiAccessService {
  private readonly options: { ledger: UsageLedger; modelvia: ModelviaOperatorClient; requestCapNanoAud?: string; terms?: CustomerTermsPolicy };
  constructor(options: { ledger: UsageLedger; modelvia: ModelviaOperatorClient; requestCapNanoAud?: string; terms?: CustomerTermsPolicy }) { this.options = options; }

  async set(actor: OperatorPrincipal, value: unknown): Promise<OfficeAiAccessResult> {
    requireThat(actor && actor.role === OPERATOR_ROLE && typeof actor.subject === 'string', 'operator_unauthenticated', 401);
    object(value); exact(value, ['companyId', 'customerId', 'name', 'access']);
    id(value.companyId);
    requireThat(typeof value.customerId === 'string' && MODELVIA_CUSTOMER.test(value.customerId), 'invalid_modelvia_customer');
    requireThat(typeof value.name === 'string' && value.name.trim().length > 0 && value.name.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value.name), 'invalid_ai_access');
    const access = parseOfficeAiAccess(value.access);
    const companyId = value.companyId as string, customerId = value.customerId as string, name = (value.name as string).trim();
    const { ledger, modelvia } = this.options;
    // A company with no entitlement record is a typo or the wrong database.
    ledger.tenant(companyId);
    return serialized(`office-ai-access:${companyId}`, async () => {
      const requestedCap = access.mode === 'custom' ? access.monthlyCapNanoAud : access.mode === 'default' ? DEFAULT_OFFICE_AI_CAP_NANO_AUD : undefined;
      // Journalled before any Modelvia call. No customer id, no secret.
      ledger.db.transaction(() => ledger.db.append(companyId, 'office_ai_access_requested', null, ledger.now(),
        { subject: actor.subject, companyId, mode: access.mode, ...(requestedCap ? { monthlyCapNanoAud: requestedCap } : {}) }));
      // The binding provisioning checks, recorded before any Modelvia call. A
      // customer another office already holds is refused here.
      bindOfficeCustomer(ledger, companyId, customerId);
      // An office's Modelvia billing account is its company id.
      const customer = await modelvia.setCustomerAccess(customerId, { name, access, billingCompanyId: companyId });
      const projects = access.mode === 'disabled' ? [] : await applyCustomerCaps({ ledger, modelvia, requestCapNanoAud: this.options.requestCapNanoAud }, companyId);
      // Commercial terms once the customer exists (Modelvia's order: customer,
      // then policy). Reported, never thrown: the customer and caps above are
      // already applied. An existing policy is left exactly as it is.
      // A resale office's policy carries its own acceptance reference, recorded
      // when its billing owner accepted RealBud's monthly terms with AI resale.
      const terms = access.mode === 'disabled' || !this.options.terms ? undefined : await officeTerms(modelvia, customerId,
        termsForCompany(this.options.terms, companyId, () => latestResaleAcceptance(ledger, companyId)));
      try {
        ledger.db.transaction(() => ledger.db.append(companyId, 'office_ai_access_set', null, ledger.now(),
          { subject: actor.subject, companyId, mode: access.mode, active: customer.active, monthlyCapNanoAud: customer.monthlyCapNanoAud, created: customer.created, projects, ...(terms ? { terms } : {}) }));
      } catch { /* Already applied at Modelvia; never lose the answer. */ }
      return { customer, projects, ...(terms ? { terms } : {}) };
    });
  }
}

/** Ensure the office's terms, as a result rather than an exception. The policy
 * id is Modelvia's and carries no customer id, so it may be audited. */
async function officeTerms(modelvia: ModelviaOperatorClient, customerId: string, decision: OfficeTermsDecision): Promise<NonNullable<OfficeAiAccessResult['terms']>> {
  if (!('terms' in decision)) return decision;
  const terms = decision.terms;
  if (!hasCustomerTerms(modelvia)) return { state: 'failed', error: 'modelvia_terms_unsupported' };
  try {
    // Resale follows the office's accepted markup; client-funded is written once.
    if (terms.customerBilling === 'resale' && modelvia.syncResaleTerms)
      return await modelvia.syncResaleTerms(customerId, { clientMarkupBasisPoints: terms.clientMarkupBasisPoints, acceptanceReference: terms.acceptanceReference });
    return await modelvia.ensureCustomerTerms(customerId, terms);
  }
  catch (error) { return { state: 'failed', error: error instanceof GatewayError ? error.code : 'modelvia_terms_failed' }; }
}

/** What `http.ts` needs for the operator routes. `officeAiAccess` is absent when
 * the Modelvia operator configuration is, which answers `operator_unconfigured`. */
export interface OperatorRoutes {
  authenticate(bearer: string): Promise<OperatorPrincipal>;
  officeAiAccess?: Pick<OfficeAiAccessService, 'set'>;
  /** Per-office AI billing: proposed markup and invoice charge detail
   * (`office-ai-terms.ts`). Local writes only; composed with care billing. */
  officeAiTerms?: OfficeAiTermsRoutes;
  /** The owner's per-office margin for one month (`office-ai-billing.ts`). Composed
   * with care billing; absent answers `billing_unavailable`. */
  margins?: (period: string) => Promise<MarginReport>;
  /** One office's service entitlement (`operator-entitlement.ts`): the ledger
   * write `entitlement-cli.ts set` makes. Composed whenever operators can
   * authenticate. */
  entitlements?: OperatorEntitlementRoutes;
}

export const OPERATOR_SECRET_ENV = 'REALBUD_GATEWAY_OPERATOR_SECRET';
/** `configured` only for a secret of 32+ characters that differs from the portal
 * secret. Presence only; never a value. */
export function operatorAccessState(env: NodeJS.ProcessEnv): 'configured' | 'missing' {
  const secret = (env[OPERATOR_SECRET_ENV] ?? '').trim(), portal = (env.REALBUD_GATEWAY_PORTAL_SECRET ?? '').trim();
  return secret.length >= 32 && secret !== portal ? 'configured' : 'missing';
}

/**
 * Operator routes from the environment alone. No operator secret, a short one,
 * or one equal to the portal secret composes nothing (the route answers 503
 * `operator_unconfigured`). Without the Modelvia operator variables, or with the
 * provider gate closed, operators can authenticate and set entitlements, but the
 * AI access write is not composed.
 */
export function composeOperatorRoutes(options: { env: NodeJS.ProcessEnv; ledger: UsageLedger; fetch: HttpTransport; modelvia?: ModelviaOperatorClient }): OperatorRoutes | undefined {
  const env = options.env;
  if (operatorAccessState(env) !== 'configured') return undefined;
  const verify = async (bearer: string) => verifyOperatorToken(bearer, (env[OPERATOR_SECRET_ENV] ?? '').trim());
  // Service entitlement is a local ledger write, so it needs no Modelvia configuration.
  const base: OperatorRoutes = { authenticate: verify, entitlements: operatorEntitlementRoutes({ ledger: options.ledger }) };
  const value = (name: string) => (env[name] ?? '').trim();
  if (value('REALBUD_ENABLE_PROVIDER') !== '1' || MODELVIA_SCOPED_ENV.some(name => !value(name))) return base;
  const composed = composeModelvia({ env, fetch: options.fetch });
  if ('unavailable' in composed) return base;
  // A malformed terms variable leaves the write off rather than guessing terms.
  const terms = customerTermsPolicy(env);
  if ('unavailable' in terms) return base;
  return { ...base, officeAiAccess: new OfficeAiAccessService({ ledger: options.ledger, modelvia: options.modelvia ?? composed.modelvia, requestCapNanoAud: composed.requestCapNanoAud, terms }) };
}

/** The Modelvia operator terms client for resale sync, from the environment:
 * undefined unless the provider gate is open and every Modelvia operator
 * variable is present. `modelvia` is a test seam. */
export function composeResaleTermsClient(options: { env: NodeJS.ProcessEnv; fetch: HttpTransport; modelvia?: ModelviaOperatorClient }): Pick<ModelviaTermsClient, 'syncResaleTerms'> | undefined {
  const value = (name: string) => (options.env[name] ?? '').trim();
  if (value('REALBUD_ENABLE_PROVIDER') !== '1' || MODELVIA_SCOPED_ENV.some(name => !value(name))) return undefined;
  const client = options.modelvia ?? (() => { const composed = composeModelvia({ env: options.env, fetch: options.fetch }); return 'unavailable' in composed ? undefined : composed.modelvia; })();
  return client && hasCustomerTerms(client) && client.syncResaleTerms ? client : undefined;
}

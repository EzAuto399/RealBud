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
 * absorbs its AI); any other office gets a resale policy only when resale is
 * explicitly configured, and otherwise nothing (`terms.state: "unconfigured"`).
 * An existing policy is never replaced here: changing how an office is billed is
 * a dated migration at Modelvia.
 */
import { exact, GatewayError, id, object, requireThat } from './contracts.ts';
import type { HttpTransport } from './composio-org.ts';
import type { UsageLedger } from './ledger.ts';
import { DEFAULT_OFFICE_AI_CAP_NANO_AUD, parseOfficeAiAccess, type ModelviaOperatorClient } from './modelvia-keys.ts';
import { customerTermsPolicy, hasCustomerTerms, termsForCompany, type CustomerTerms, type CustomerTermsPolicy, type CustomerTermsResult } from './modelvia-keys.ts';
import { OPERATOR_ROLE, verifyOperatorToken, type OperatorPrincipal } from './operator-token.ts';
import { applyCustomerCaps, bindOfficeCustomer, composeModelvia, MODELVIA_CUSTOMER, MODELVIA_OPERATOR_ENV, serialized, type CapsApplied } from './provisioning.ts';

export interface OfficeAiAccessResult {
  customer: { active: boolean; monthlyCapNanoAud: string; created: boolean };
  projects: CapsApplied[];
  /** The office's commercial terms at Modelvia. Present when the service was
   * composed with a terms policy and AI is on. `unconfigured`: this deployment
   * has not said how the office is billed, so nothing was written and the office
   * cannot be provisioned until it does. `failed` carries a code only. */
  terms?: CustomerTermsResult | { state: 'unconfigured' } | { state: 'failed'; error: string };
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
      const terms = access.mode === 'disabled' || !this.options.terms ? undefined : await officeTerms(modelvia, customerId, termsForCompany(this.options.terms, companyId));
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
async function officeTerms(modelvia: ModelviaOperatorClient, customerId: string, terms: CustomerTerms | undefined): Promise<NonNullable<OfficeAiAccessResult['terms']>> {
  if (!terms) return { state: 'unconfigured' };
  if (!hasCustomerTerms(modelvia)) return { state: 'failed', error: 'modelvia_terms_unsupported' };
  try { return await modelvia.ensureCustomerTerms(customerId, terms); }
  catch (error) { return { state: 'failed', error: error instanceof GatewayError ? error.code : 'modelvia_terms_failed' }; }
}

/** What `http.ts` needs for the operator routes. `officeAiAccess` is absent when
 * the Modelvia operator configuration is, which answers `operator_unconfigured`. */
export interface OperatorRoutes {
  authenticate(bearer: string): Promise<OperatorPrincipal>;
  officeAiAccess?: Pick<OfficeAiAccessService, 'set'>;
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
 * provider gate closed, operators can authenticate but the write is not composed.
 */
export function composeOperatorRoutes(options: { env: NodeJS.ProcessEnv; ledger: UsageLedger; fetch: HttpTransport; modelvia?: ModelviaOperatorClient }): OperatorRoutes | undefined {
  const env = options.env;
  if (operatorAccessState(env) !== 'configured') return undefined;
  const authenticate = async (bearer: string) => verifyOperatorToken(bearer, (env[OPERATOR_SECRET_ENV] ?? '').trim());
  const value = (name: string) => (env[name] ?? '').trim();
  if (value('REALBUD_ENABLE_PROVIDER') !== '1' || MODELVIA_OPERATOR_ENV.some(name => !value(name))) return { authenticate };
  const composed = composeModelvia({ env, fetch: options.fetch });
  if ('unavailable' in composed) return { authenticate };
  // A malformed terms variable leaves the write off rather than guessing terms.
  const terms = customerTermsPolicy(env);
  if ('unavailable' in terms) return { authenticate };
  return { authenticate, officeAiAccess: new OfficeAiAccessService({ ledger: options.ledger, modelvia: options.modelvia ?? composed.modelvia, requestCapNanoAud: composed.requestCapNanoAud, terms }) };
}

/**
 * Per-office AI resale terms (owner requirement, 26 September 2026): each office
 * pays AI at Modelvia's price plus ITS OWN markup, stated in the monthly terms its
 * billing owner accepts (`CommercialTerms.aiUsage.markupBasisPoints`, 0..10000).
 *
 *   1. An operator PROPOSES a markup for one office (`commercial-cli.ts
 *      propose-markup`, or POST /v1/operator/offices/ai-markup). Audited, local
 *      only; nothing changes at Modelvia and the office's price is unchanged.
 *   2. The office's next published terms carry it: a reviewed terms file that
 *      omits `aiUsage.markupBasisPoints` gets the pending proposal, else the
 *      office's current accepted markup, else the deployment default
 *      (REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS). A file stating a different
 *      markup while a proposal is pending is refused (`commercial-terms.ts`).
 *   3. The office's billing owner accepts those terms: that acceptance
 *      (`ai_resale_terms_accepted`, with its own reference) is the only thing that
 *      changes the office's price.
 *   4. `syncOfficeResalePolicy` then appends ONE new Modelvia resale policy at the
 *      accepted markup, effective at Modelvia's own time (the Date header of its
 *      response, never this service's clock), carrying that acceptance reference.
 *      The superseded policy is never changed, so usage Modelvia admitted under it
 *      keeps its price. Idempotent: when the policy in force already carries the
 *      accepted markup nothing is written. Runs after a portal acceptance, from
 *      the operator AI access route, `commercial-cli.ts sync-markup` and POST
 *      /v1/operator/offices/ai-markup/sync.
 *
 * Invoice charge detail is per office too: `all_in` (default) shows each AI line
 * at its all-in price only; `itemized` also shows the split Modelvia returns
 * (model usage, routing, service fee) when Modelvia itemizes for RealBud's client.
 * Neither ever shows Modelvia's wholesale, its platform fee or RealBud's markup.
 */
import { exact, GatewayError, id, object, requireThat } from './contracts.ts';
import type { UsageLedger } from './ledger.ts';
import { latestResaleAcceptance, resaleAcceptanceReference, type CommercialTermsStore, type CommercialTerms, type ResaleAcceptance, MAX_OFFICE_MARKUP_BASIS_POINTS, proposedOfficeMarkup, type CommercialTermsDraft, type MarkupProposal } from './commercial-terms.ts';
import type { ModelviaTermsClient, ResaleSyncResult } from './modelvia-keys.ts';
import { OPERATOR_ROLE, type OperatorPrincipal } from './operator-token.ts';
import { serialized } from './provisioning.ts';

export type AiChargeDetail = 'all_in' | 'itemized';
export const MARKUP_PROPOSED = 'ai_markup_proposed', CHARGE_DETAIL_SET = 'ai_charge_detail_set';
export const POLICY_SYNCED = 'ai_resale_policy_synced', POLICY_SYNC_FAILED = 'ai_resale_policy_sync_failed';
const TEXT = /^[^\u0000-\u001f\u007f]{1,500}$/;

function validMarkup(value: unknown): number {
  requireThat(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_OFFICE_MARKUP_BASIS_POINTS, 'invalid_markup');
  return value as number;
}
/** A billable office: it exists and is not the internal cost account. */
function billableOffice(ledger: UsageLedger, companyId: unknown): string {
  id(companyId);
  const tenant = ledger.tenant(companyId);
  requireThat(tenant.billingMode !== 'internal_cost', 'internal_usage_not_billable', 403);
  return companyId;
}
const operator = (actor: OperatorPrincipal) => {
  requireThat(actor && actor.role === OPERATOR_ROLE && typeof actor.subject === 'string' && actor.subject.length > 0 && actor.subject.length <= 320, 'operator_unauthenticated', 401);
  return actor.subject;
};

/** Record an operator's proposed markup for one office. Takes effect only when
 * the office accepts terms that state it. Re-proposing the pending value is a no-op. */
export function proposeOfficeMarkup(ledger: UsageLedger, subject: string, companyId: string, markupBasisPoints: number, reason: string) {
  const office = billableOffice(ledger, companyId), markup = validMarkup(markupBasisPoints);
  requireThat(typeof reason === 'string' && TEXT.test(reason.trim()), 'invalid_markup_reason');
  return ledger.db.transaction(() => {
    const pending = proposedOfficeMarkup(ledger, office), accepted = latestResaleAcceptance(ledger, office)?.markupBasisPoints ?? null;
    if (pending?.markupBasisPoints === markup) return { companyId: office, markupBasisPoints: markup, acceptedBasisPoints: accepted, state: 'awaiting_office_acceptance' as const, duplicate: true };
    const proposal: MarkupProposal & { previousProposedBasisPoints: number | null; acceptedBasisPoints: number | null } = {
      markupBasisPoints: markup, subject, proposedAt: ledger.now(), reason: reason.trim(), previousProposedBasisPoints: pending?.markupBasisPoints ?? null, acceptedBasisPoints: accepted };
    ledger.db.append(office, MARKUP_PROPOSED, null, ledger.now(), proposal);
    return { companyId: office, markupBasisPoints: markup, acceptedBasisPoints: accepted, state: 'awaiting_office_acceptance' as const, duplicate: false };
  });
}

/** The office's invoice charge detail; `all_in` unless an operator chose otherwise. */
export function officeChargeDetail(ledger: UsageLedger, companyId: string): AiChargeDetail {
  const row = ledger.db.get<{ body: string }>('SELECT body FROM events WHERE tenant=? AND kind=? ORDER BY seq DESC LIMIT 1', companyId, CHARGE_DETAIL_SET);
  return row && (JSON.parse(row.body) as { chargeDetail: AiChargeDetail }).chargeDetail === 'itemized' ? 'itemized' : 'all_in';
}
/** Audited. Applies to invoices closed from now on; a closed invoice never changes. */
export function setOfficeChargeDetail(ledger: UsageLedger, subject: string, companyId: string, chargeDetail: unknown) {
  const office = billableOffice(ledger, companyId);
  requireThat(chargeDetail === 'all_in' || chargeDetail === 'itemized', 'invalid_charge_detail');
  return ledger.db.transaction(() => {
    const current = officeChargeDetail(ledger, office);
    if (current === chargeDetail) return { companyId: office, chargeDetail, duplicate: true };
    ledger.db.append(office, CHARGE_DETAIL_SET, null, ledger.now(), { subject, chargeDetail, previous: current });
    return { companyId: office, chargeDetail: chargeDetail as AiChargeDetail, duplicate: false };
  });
}

export interface OfficeMarkup {
  /** What the office accepted last and is billed at; null before any acceptance. */
  acceptedBasisPoints: number | null;
  /** An operator's proposal not yet accepted by the office. */
  proposedBasisPoints: number | null;
  /** What the office's next terms will state when a file leaves it out. */
  nextTermsBasisPoints: number | null;
  /** Whether Modelvia was last seen pricing at the accepted markup. */
  policy: 'synced' | 'sync_pending' | 'sync_failed' | 'not_synced' | null;
}
export function officeMarkup(ledger: UsageLedger, companyId: string, defaultBasisPoints?: number): OfficeMarkup {
  const accepted = latestResaleAcceptance(ledger, companyId), proposed = proposedOfficeMarkup(ledger, companyId);
  const customer = policyCustomer(ledger, companyId);
  return {
    acceptedBasisPoints: accepted?.markupBasisPoints ?? null,
    proposedBasisPoints: proposed?.markupBasisPoints ?? null,
    nextTermsBasisPoints: proposed?.markupBasisPoints ?? accepted?.markupBasisPoints ?? defaultBasisPoints ?? null,
    policy: !accepted ? null : resalePolicyState(ledger, companyId, accepted, customer),
  };
}

/** Latest attempt for this exact acceptance. A pending/failed retry cannot be
 * hidden by an older active receipt, nor can a different office/customer/rate
 * satisfy it. Legacy receipts without provider readback proof require a sync. */
function policyCustomer(ledger: UsageLedger, companyId: string): string | undefined {
  ledger.db.run('CREATE TABLE IF NOT EXISTS office_modelvia_customer (tenant TEXT PRIMARY KEY, customer TEXT NOT NULL UNIQUE)');
  return ledger.db.get<{ customer: string }>('SELECT customer FROM office_modelvia_customer WHERE tenant=?', companyId)?.customer;
}
function validSyncProof(result: ResaleSyncResult, accepted: ResaleAcceptance, customer: string): boolean {
  return (result.state === 'active' || result.state === 'pending') && typeof result.created === 'boolean'
    && typeof result.policyId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(result.policyId)
    && typeof result.clientId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(result.clientId)
    && result.customerId === customer && result.customerBilling === 'resale'
    && result.acceptanceReference === accepted.acceptanceReference && result.clientMarkupBasisPoints === accepted.markupBasisPoints
    && Number.isSafeInteger(result.effectiveAt) && Number.isSafeInteger(result.verifiedAt) && result.verifiedAt! > 0
    && (result.state === 'active' ? result.effectiveAt! <= result.verifiedAt! : result.effectiveAt! > result.verifiedAt!);
}
/** A receipt written before receipts carried provider readback (neither
 * `boundCustomerId` nor `verifiedAt`): the exact acceptance reference and
 * markup, reported active by the sync of its day. Its customer can only be the
 * office's bound one, since an office that accepted resale cannot be rebound
 * (provisioning.ts `bindOfficeCustomer`). It counts as synced so offices synced
 * before proof receipts keep closing; each invoice that relies on one records
 * `ai_policy_legacy_receipt_used`. A newer attempt for the same acceptance
 * still wins, and the operator's markup sync replaces it with a proof receipt. */
function legacyReceipt(receipt: Record<string, unknown>, accepted: ResaleAcceptance): boolean {
  return !Object.hasOwn(receipt, 'boundCustomerId') && !Object.hasOwn(receipt, 'verifiedAt') && receipt.state === 'active' && typeof receipt.policyId === 'string'
    && receipt.markupBasisPoints === accepted.markupBasisPoints && receipt.clientMarkupBasisPoints === accepted.markupBasisPoints && receipt.acceptanceReference === accepted.acceptanceReference;
}
function policyReceipt(ledger: UsageLedger, companyId: string, accepted: ResaleAcceptance, customer: string | undefined): { state: NonNullable<OfficeMarkup['policy']>; legacy?: true } {
  const row = ledger.db.all<{ kind: string; body: string }>('SELECT kind,body FROM events WHERE tenant=? AND kind IN (?,?) ORDER BY seq DESC', companyId, POLICY_SYNCED, POLICY_SYNC_FAILED)
    .find(row => (JSON.parse(row.body) as { acceptanceReference?: string }).acceptanceReference === accepted.acceptanceReference);
  if (!row) return { state: 'not_synced' };
  if (row.kind === POLICY_SYNC_FAILED) return { state: 'sync_failed' };
  const receipt = JSON.parse(row.body) as ResaleSyncResult & { markupBasisPoints?: number; boundCustomerId?: string };
  if (customer && legacyReceipt(receipt as unknown as Record<string, unknown>, accepted)) return { state: 'synced', legacy: true };
  if (!customer || receipt.boundCustomerId !== customer || receipt.markupBasisPoints !== accepted.markupBasisPoints || !validSyncProof(receipt, accepted, customer)) return { state: 'not_synced' };
  return { state: receipt.state === 'active' ? 'synced' : 'sync_pending' };
}
export function resalePolicyState(ledger: UsageLedger, companyId: string, accepted: ResaleAcceptance, customer = policyCustomer(ledger, companyId)): NonNullable<OfficeMarkup['policy']> {
  return policyReceipt(ledger, companyId, accepted, customer).state;
}
/** All accepted anchors whose historical requests can be included. A plan's
 * standing month resolves to its genuine owner anchor; a legacy month may have
 * several accepted revisions, whose already admitted request prices stay intact.
 * Returns the acceptance references admitted only by a legacy receipt. */
export function requireOfficeResalePolicies(terms: CommercialTermsStore, ledger: UsageLedger, companyId: string, periods: readonly string[], customer = policyCustomer(ledger, companyId)): string[] {
  const required = new Map<string, ResaleAcceptance>();
  const events = ledger.db.all<{ body: string }>("SELECT body FROM events WHERE tenant=? AND kind='ai_resale_terms_accepted' ORDER BY seq", companyId).map(row => JSON.parse(row.body) as ResaleAcceptance);
  for (const period of new Set(periods)) {
    for (const accepted of events.filter(event => event.period === period)) required.set(accepted.acceptanceReference, accepted);
    const latest = ledger.db.get<{ body: string }>('SELECT body FROM commercial_terms WHERE tenant=? AND period=? ORDER BY seq DESC LIMIT 1', companyId, period);
    const current = latest ? JSON.parse(latest.body) as CommercialTerms : undefined;
    if (current?.billingPlan?.aiBilling === 'resale') {
      const anchor = terms.planAcceptance(companyId, current.billingPlan.version);
      requireThat(anchor, 'ai_policy_acceptance_missing', 409);
      const reference = resaleAcceptanceReference(current.billingPlan.termsReference!, anchor!);
      const accepted = events.find(event => event.acceptanceReference === reference && event.markupBasisPoints === current.billingPlan!.markupBasisPoints);
      requireThat(accepted, 'ai_policy_acceptance_missing', 409);
      required.set(reference, accepted!);
    } else if (current?.aiUsage) requireThat(events.some(event => event.period === period && event.version === current.version), 'ai_policy_acceptance_missing', 409);
  }
  requireThat(customer, 'office_modelvia_customer_unbound', 409);
  const legacy: string[] = [];
  for (const accepted of required.values()) {
    const { state, legacy: onlyLegacy } = policyReceipt(ledger, companyId, accepted, customer);
    requireThat(state === 'synced', state === 'sync_pending' ? 'ai_policy_pending' : state === 'sync_failed' ? 'ai_policy_sync_failed' : 'ai_policy_not_synced', 409);
    if (onlyLegacy) legacy.push(accepted.acceptanceReference);
  }
  return legacy.sort();
}

export type CommercialPricingSync = 'not_required' | 'awaiting_acceptance' | NonNullable<OfficeMarkup['policy']>;
/** Fixed customer-safe state, separate from the signed commercial terms. */
export function commercialPricingSync(store: CommercialTermsStore, ledger: UsageLedger, terms: CommercialTerms, accepted: boolean): CommercialPricingSync {
  if (!terms.aiUsage && terms.billingPlan?.aiBilling !== 'resale') return 'not_required';
  if (!accepted) return 'awaiting_acceptance';
  try { requireOfficeResalePolicies(store, ledger, terms.companyId, [terms.period]); return 'synced'; }
  catch (error) { return error instanceof GatewayError && error.code === 'ai_policy_pending' ? 'sync_pending' : error instanceof GatewayError && error.code === 'ai_policy_sync_failed' ? 'sync_failed' : 'not_synced'; }
}

/** A reviewed terms file whose `aiUsage` omits the markup gets the office's next
 * markup (pending proposal, else accepted, else the deployment default). A file
 * that states one keeps it; `publish` refuses it when a proposal disagrees. */
export function withOfficeMarkup(ledger: UsageLedger, draft: CommercialTermsDraft, defaultBasisPoints?: number): CommercialTermsDraft {
  if (!draft || typeof draft !== 'object' || !draft.aiUsage || typeof draft.aiUsage !== 'object' || (draft.aiUsage as Partial<CommercialTermsDraft['aiUsage'] & object>).markupBasisPoints !== undefined) return draft;
  id(draft.companyId);
  const markup = officeMarkup(ledger, draft.companyId, defaultBasisPoints).nextTermsBasisPoints;
  requireThat(markup !== null, 'ai_markup_unconfigured', 409);
  return { ...draft, aiUsage: { ...draft.aiUsage, markupBasisPoints: markup! } };
}

export type OfficePolicySync = ResaleSyncResult | { state: 'acceptance_required' | 'customer_unbound' | 'client_funded' } | { state: 'failed'; error: string };
/** Bring Modelvia's resale policy for one office to its accepted markup. Never
 * throws: the outcome is returned and journalled (`ai_resale_policy_synced` or
 * `…_sync_failed`, with exact customer/reference and provider proof, never a secret). */
export function syncOfficeResalePolicy(options: { ledger: UsageLedger; modelvia?: Pick<ModelviaTermsClient, 'syncResaleTerms' | 'resalePolicyReceipt'>; clientFundedCompanies: ReadonlySet<string> }, companyId: string): Promise<OfficePolicySync> {
  return serialized(`office-ai-terms:${companyId}`, async () => {
    const { ledger } = options;
    if (options.clientFundedCompanies.has(companyId)) return { state: 'client_funded' };
    const accepted = latestResaleAcceptance(ledger, companyId);
    if (!accepted) return { state: 'acceptance_required' };
    ledger.db.run('CREATE TABLE IF NOT EXISTS office_modelvia_customer (tenant TEXT PRIMARY KEY, customer TEXT NOT NULL UNIQUE)');
    const customer = ledger.db.get<{ customer: string }>('SELECT customer FROM office_modelvia_customer WHERE tenant=?', companyId)?.customer;
    if (!customer) return { state: 'customer_unbound' };
    const markupBasisPoints = accepted.markupBasisPoints;
    let result: OfficePolicySync;
    try {
      requireThat(options.modelvia?.syncResaleTerms, 'modelvia_terms_unsupported', 503);
      result = await options.modelvia!.syncResaleTerms!(customer, { clientMarkupBasisPoints: markupBasisPoints, acceptanceReference: accepted.acceptanceReference });
      requireThat(result.state !== 'not_required' && validSyncProof(result, accepted, customer), 'modelvia_terms_scope_mismatch', 502);
    } catch (error) {
      result = { state: 'failed', error: error instanceof GatewayError ? error.code : 'modelvia_terms_failed' };
    }
    try {
      ledger.db.transaction(() => ledger.db.append(companyId, result.state === 'failed' ? POLICY_SYNC_FAILED : POLICY_SYNCED, null, ledger.now(),
        { ...result, markupBasisPoints, acceptanceReference: accepted.acceptanceReference, boundCustomerId: customer }));
    } catch { /* The Modelvia outcome stands; never lose the answer. */ }
    // Existing explicit sync also repairs proof for older accepted anchors.
    // Readback never appends old pricing or asserts it is the current policy.
    if (options.modelvia?.resalePolicyReceipt) {
      const prior = ledger.db.all<{ body: string }>("SELECT body FROM events WHERE tenant=? AND kind='ai_resale_terms_accepted' ORDER BY seq", companyId).map(row => JSON.parse(row.body) as ResaleAcceptance);
      for (const previous of prior.filter(previous => previous.acceptanceReference !== accepted.acceptanceReference && resalePolicyState(ledger, companyId, previous, customer) !== 'synced')) {
        let historical: OfficePolicySync;
        try {
          historical = await options.modelvia.resalePolicyReceipt(customer, { clientMarkupBasisPoints: previous.markupBasisPoints, acceptanceReference: previous.acceptanceReference });
          requireThat(historical.state !== 'not_required' && historical.historical === true && validSyncProof(historical, previous, customer), 'modelvia_terms_scope_mismatch', 502);
        } catch (error) { historical = { state: 'failed', error: error instanceof GatewayError ? error.code : 'modelvia_terms_failed' }; }
        try { ledger.db.transaction(() => ledger.db.append(companyId, historical.state === 'failed' ? POLICY_SYNC_FAILED : POLICY_SYNCED, null, ledger.now(),
          { ...historical, markupBasisPoints: previous.markupBasisPoints, acceptanceReference: previous.acceptanceReference, boundCustomerId: customer })); } catch { /* proof missing remains held */ }
      }
    }
    return result;
  });
}

/** The operator routes (http.ts). Every write names the operator subject. */
export interface OfficeAiTermsRoutes {
  proposeMarkup(actor: OperatorPrincipal, value: unknown): Promise<unknown>;
  setChargeDetail(actor: OperatorPrincipal, value: unknown): Promise<unknown>;
  /** Absent without the Modelvia operator configuration. */
  syncMarkup?(actor: OperatorPrincipal, value: unknown): Promise<OfficePolicySync>;
}
export function officeAiTermsRoutes(options: { ledger: UsageLedger; defaultMarkupBasisPoints?: number; clientFundedCompanies: ReadonlySet<string>; modelvia?: Pick<ModelviaTermsClient, 'syncResaleTerms' | 'resalePolicyReceipt'> }): OfficeAiTermsRoutes {
  const { ledger } = options;
  const routes: OfficeAiTermsRoutes = {
    async proposeMarkup(actor, value) {
      const subject = operator(actor);
      object(value); exact(value, ['companyId', 'markupBasisPoints', 'reason']);
      requireThat(!options.clientFundedCompanies.has(String(value.companyId)), 'client_funded_office_ai_not_billable', 409);
      const result = proposeOfficeMarkup(ledger, subject, value.companyId as string, value.markupBasisPoints as number, value.reason as string);
      return { ...result, ...officeMarkup(ledger, result.companyId, options.defaultMarkupBasisPoints) };
    },
    async setChargeDetail(actor, value) {
      const subject = operator(actor);
      object(value); exact(value, ['companyId', 'chargeDetail']);
      return setOfficeChargeDetail(ledger, subject, value.companyId as string, value.chargeDetail);
    },
  };
  if (options.modelvia?.syncResaleTerms) routes.syncMarkup = async (actor, value) => {
    operator(actor);
    object(value); exact(value, ['companyId']);
    return syncOfficeResalePolicy({ ledger, modelvia: options.modelvia, clientFundedCompanies: options.clientFundedCompanies }, billableOffice(ledger, value.companyId));
  };
  return routes;
}

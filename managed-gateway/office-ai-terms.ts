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
import { latestResaleAcceptance, MAX_OFFICE_MARKUP_BASIS_POINTS, proposedOfficeMarkup, type CommercialTermsDraft, type MarkupProposal } from './commercial-terms.ts';
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
  policy: 'synced' | 'sync_failed' | 'not_synced' | null;
}
export function officeMarkup(ledger: UsageLedger, companyId: string, defaultBasisPoints?: number): OfficeMarkup {
  const accepted = latestResaleAcceptance(ledger, companyId), proposed = proposedOfficeMarkup(ledger, companyId);
  const last = ledger.db.get<{ kind: string; body: string }>('SELECT kind,body FROM events WHERE tenant=? AND kind IN (?,?) ORDER BY seq DESC LIMIT 1', companyId, POLICY_SYNCED, POLICY_SYNC_FAILED);
  const lastMarkup = last ? (JSON.parse(last.body) as { markupBasisPoints: number }).markupBasisPoints : undefined;
  return {
    acceptedBasisPoints: accepted?.markupBasisPoints ?? null,
    proposedBasisPoints: proposed?.markupBasisPoints ?? null,
    nextTermsBasisPoints: proposed?.markupBasisPoints ?? accepted?.markupBasisPoints ?? defaultBasisPoints ?? null,
    policy: !accepted ? null : !last || lastMarkup !== accepted.markupBasisPoints ? 'not_synced' : last.kind === POLICY_SYNCED ? 'synced' : 'sync_failed',
  };
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
 * `…_sync_failed`, with the markup and a code; no customer id, no secret). */
export function syncOfficeResalePolicy(options: { ledger: UsageLedger; modelvia?: Pick<ModelviaTermsClient, 'syncResaleTerms'>; clientFundedCompanies: ReadonlySet<string> }, companyId: string): Promise<OfficePolicySync> {
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
    } catch (error) {
      result = { state: 'failed', error: error instanceof GatewayError ? error.code : 'modelvia_terms_failed' };
    }
    try {
      ledger.db.transaction(() => ledger.db.append(companyId, result.state === 'failed' ? POLICY_SYNC_FAILED : POLICY_SYNCED, null, ledger.now(),
        { markupBasisPoints, acceptanceReference: accepted.acceptanceReference, ...result }));
    } catch { /* The Modelvia outcome stands; never lose the answer. */ }
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
export function officeAiTermsRoutes(options: { ledger: UsageLedger; defaultMarkupBasisPoints?: number; clientFundedCompanies: ReadonlySet<string>; modelvia?: Pick<ModelviaTermsClient, 'syncResaleTerms'> }): OfficeAiTermsRoutes {
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

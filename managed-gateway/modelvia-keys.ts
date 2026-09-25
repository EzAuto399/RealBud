/**
 * Per-installation model project and key at Modelvia.
 *
 * Modelvia (a separate repository and a separate service) owns the model and
 * billing surface. Verified against `codex/neon-release`
 * (`managed-gateway/platform-admin.ts`, `accounts.ts`, `keys.ts`):
 *
 *   POST {MODELVIA}/v1/operator/projects
 *     { id, name, active, monthlyCapNanoAud, maxConcurrent, allowedModels,
 *       version, clientId, customerId, environments, requestCapNanoAud }
 *     → the saved project record. `version` is optimistic: 0 creates.
 *   POST {MODELVIA}/v1/operator/keys
 *     { projectId, environment, label?, expiresAt? }  → { key, record }
 *     `key` is `rbk_…`, returned once; `record.id` is 16 hex.
 *   POST {MODELVIA}/v1/operator/keys/{id}/revoke      → the key record
 *
 * Both routes reject unknown fields, so nothing extra is ever sent.
 *
 * Reads and repairs added on Modelvia `e41c186` (`platform-admin.ts:136-172`,
 * `keys.ts` `listForProject`/`rotate`, `accounts.ts` `put`):
 *
 *   GET  {MODELVIA}/v1/operator/projects               → { accounts: ProjectAccount[] }
 *     Every project; there is no read by id, so one is found in this list.
 *   POST {MODELVIA}/v1/operator/projects with the stored `version` updates that
 *     project (optimistic; a stale version is 409 `account_version_conflict`;
 *     `clientId`/`customerId` are immutable).
 *   GET  {MODELVIA}/v1/operator/keys?projectId=&environment=
 *     → { keys: [{ id, companyId, project, environment, label?, createdAt,
 *                  expiresAt?, revokedAt?, lastUsedAt? }] }   records only, no secret
 *   POST {MODELVIA}/v1/operator/keys/{id}/rotate  { label?, expiresAt? }
 *     → { key, record, replaced }  revokes `id` and mints a replacement with the
 *     same project, environment and label; `key` is returned once.
 *
 *   GET  {MODELVIA}/v1/operator/customers              → { accounts: CustomerAccount[] }
 *     Every customer (`accounts.ts` CustomerAccount: id, clientId, active,
 *     monthlyCapNanoAud, maxConcurrent, …); there is no read by id either.
 *   POST {MODELVIA}/v1/operator/customers
 *     { id, name, active, monthlyCapNanoAud, maxConcurrent, allowedModels,
 *       version, clientId, payer?, billingCompanyId? }  → the saved record.
 *     An upsert of the FULL record (`accounts.ts` `put`): `version` 0 creates, a
 *     stale one is 409 `account_version_conflict`; clientId, payer and
 *     billingCompanyId are immutable. The operator credential is global, so this
 *     client only ever reads or writes customers under its own `clientId`.
 *
 * Commercial terms, checked against Modelvia `main` 49327ba (`commercial.ts`,
 * `platform-admin.ts:396`, `ledger.ts:272`):
 *
 *   GET  {MODELVIA}/v1/operator/commercial-policies    → { policies: CommercialPolicy[] }
 *   POST {MODELVIA}/v1/operator/commercial-policies
 *     { id, clientId, customerId, state, effectiveAt, payer, invoiceIssuer,
 *       collection, management, platformFeeBasisPoints, clientMarkupBasisPoints,
 *       acceptanceReference, customerBilling? }  → the saved policy.
 *     Append-only: an id is one version (409 `policy_version_exists`), and a new
 *     active policy must start after the one in force (`policy_effective_order`).
 *     Without an active policy in force, every request of a customer its client
 *     pays for is refused with 409 `customer_terms_required`.
 *   GET  {MODELVIA}/v1/operator/clients                → { accounts: ClientAccount[] }
 *     read for `billingMode`, which decides who pays for a customer.
 *
 * Caps live on the PROJECT, not the key (`requestCapNanoAud`,
 * `monthlyCapNanoAud`, `maxConcurrent`). That is why one project is created per
 * installation, under the office's customer account: it is the only place this
 * gateway's ledger cap can actually be applied at Modelvia rather than merely
 * described.
 *
 * AUTH IS SHORT-LIVED, NOT A STATIC TOKEN. Modelvia's `operator-token.ts` verifies
 * an HMAC bearer whose window must be under five minutes, so a fixed string 401s
 * minutes after it is issued. This service holds the operator *secret*
 * (`REALBUD_MODELVIA_OPERATOR_SECRET`) and subject
 * (`REALBUD_MODELVIA_OPERATOR_SUBJECT`) and mints a fresh two-minute bearer per
 * request. The secret is a vendor credential: read from the environment of this
 * protected service, never stored beside customer data, never written into a
 * descriptor, and neither it nor a minted token is ever logged.
 *
 * No default transport, and nothing here is deployed.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { GatewayError, requireThat } from './contracts.ts';
import type { HttpTransport } from './composio-org.ts';

/** Modelvia's own `id()` shape, for values that only ever travel in a body. */
const ACCOUNT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/;
/** Project and customer ids also reach request paths and `id()` admits `/`, so
 * they are held to the narrower path-safe set with no separator at all. */
const PATH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const MINTED_KEY = /^rbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/;
const NANO = /^(0|[1-9][0-9]{0,20})$/;
const REQUEST_TIMEOUT_MS = 30_000;
/** Modelvia's `verifyOperatorToken` caps the window at 300_000 ms. Two minutes
 * leaves room for one slow request without handing out a long-lived credential. */
const OPERATOR_TOKEN_TTL_MS = 120_000;
const OPERATOR_AUDIENCE = 'managed-ai-operator';

/**
 * Mint the short-lived operator bearer Modelvia expects. Format copied from
 * `managed-gateway/operator-token.ts` + `platform-cli.ts` on `codex/neon-release`:
 * base64url claims `{aud, subject, iat, exp}` and an HMAC-SHA256 of that exact
 * payload string, joined with a dot. A static token is NOT accepted — the verifier
 * requires `exp > now` and `exp - iat <= 300_000`, so one is minted per request.
 * Exported for tests; the secret and the token are never logged.
 */
export function operatorToken(secret: string, subject: string, now: number, ttlMs = OPERATOR_TOKEN_TTL_MS): string {
  requireThat(secret.length >= 32, 'modelvia_operator_unconfigured', 503);
  requireThat(subject.length > 0 && subject.length <= 320, 'modelvia_operator_unconfigured', 503);
  requireThat(Number.isSafeInteger(now) && ttlMs > 0 && ttlMs <= 300_000, 'modelvia_operator_unconfigured', 503);
  const payload = Buffer.from(JSON.stringify({ aud: OPERATOR_AUDIENCE, subject, iat: now, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export interface ModelviaProjectInput {
  /** Project id to create, one per installation. */
  projectId: string;
  name: string;
  /** Modelvia customer account id for this company; the project's parent. */
  customerId: string;
  /** Caps taken straight from this gateway's ledger tenant. */
  monthlyCapNanoAud: string; requestCapNanoAud: string; maxConcurrent: number;
}
export interface ModelviaMintedKey { key: string; keyId: string; baseUrl: string }
export interface ModelviaCaps { monthlyCapNanoAud: string; requestCapNanoAud: string; maxConcurrent: number }
/** The office's customer account at Modelvia, read back only for what provisioning
 * needs: whether it may serve, and the caps an installation project copies. */
export interface ModelviaCustomer { active: boolean; monthlyCapNanoAud: string; maxConcurrent: number }
/** A project as Modelvia stores it, read back for adoption and cap updates. */
export interface ModelviaProjectRecord extends ModelviaCaps {
  projectId: string; clientId: string; customerId: string; environments: string[]; active: boolean; version: number;
}
/** A key record without its secret. `label` is how provisioning attributes a key
 * to one installation; Modelvia keeps it across a rotation. */
export interface ModelviaKeyRecord { keyId: string; projectId: string; environment: string; label?: string; expiresAt?: number; revokedAt?: number }
export interface ModelviaRotatedKey extends ModelviaMintedKey { projectId: string; replaced: string }
export interface ModelviaClient {
  readonly environment: string;
  /** Creates the installation's project under the customer, with the ledger cap.
   * `created` is false when Modelvia already holds that project id. */
  createProject(input: ModelviaProjectInput): Promise<{ projectId: string; created: boolean }>;
  /** The customer under this platform client, or null when Modelvia holds none
   * with that id under it. A customer of another client is never returned. */
  findCustomer(customerId: string): Promise<ModelviaCustomer | null>;
  /** The stored project, or undefined when Modelvia holds no project with that id. */
  findProject(projectId: string): Promise<ModelviaProjectRecord | undefined>;
  mint(input: { projectId: string; label: string }): Promise<ModelviaMintedKey>;
  /** Secret-free key records for one project and environment, revoked ones included. */
  listKeys(projectId: string, environment: string): Promise<ModelviaKeyRecord[]>;
  /** Revokes `keyId` and returns its replacement's secret, once. Never retried here. */
  rotate(keyId: string): Promise<ModelviaRotatedKey>;
  /** Marks the key for revocation. Idempotent there; never retried here. The
   * project is deliberately left in place — see `revoke` in provisioning.ts. */
  revoke(keyId: string): Promise<void>;
  /** Writes new caps onto an existing project at its stored version, re-reading
   * once after a version conflict. `updated` is false when it already had them. */
  updateProjectCaps(projectId: string, caps: ModelviaCaps): Promise<{ updated: boolean; version: number }>;
}

/** An office's default AI monthly cap: A$200 in nanoAUD (owner, 24 September 2026). */
export const DEFAULT_OFFICE_AI_CAP_NANO_AUD = '200000000000';
/** The largest custom cap this gateway will write: A$10,000 in nanoAUD. */
export const MAX_OFFICE_AI_CAP_NANO_AUD = '10000000000000';
/** Concurrency given to a customer this gateway creates. */
export const NEW_CUSTOMER_MAX_CONCURRENT = 2;
/** What a RealBud operator sets for one office. `disabled` leaves the cap as it is. */
export type OfficeAiAccess = { mode: 'default' } | { mode: 'custom'; monthlyCapNanoAud: string } | { mode: 'disabled' };
/** Exactly one of the three shapes, or `invalid_ai_access`. A custom cap is a
 * whole number of nanoAUD from 1 to A$10,000. */
export function parseOfficeAiAccess(value: unknown): OfficeAiAccess {
  requireThat(record(value) && typeof value.mode === 'string', 'invalid_ai_access');
  const v = value as Record<string, unknown>, keys = Object.keys(v).sort().join(',');
  if (v.mode === 'default' && keys === 'mode') return { mode: 'default' };
  if (v.mode === 'disabled' && keys === 'mode') return { mode: 'disabled' };
  // Whole cents only: Modelvia's billing-account monthly caps are refused unless
  // they are a multiple of 10,000,000 nanoAUD (`cap_requires_whole_cents`), and an
  // office cap is never written in a unit its billing account could not hold.
  requireThat(v.mode === 'custom' && keys === 'mode,monthlyCapNanoAud' && typeof v.monthlyCapNanoAud === 'string'
    && NANO.test(v.monthlyCapNanoAud) && BigInt(v.monthlyCapNanoAud) >= NANO_AUD_PER_CENT && BigInt(v.monthlyCapNanoAud) % NANO_AUD_PER_CENT === 0n
    && BigInt(v.monthlyCapNanoAud) <= BigInt(MAX_OFFICE_AI_CAP_NANO_AUD), 'invalid_ai_access');
  return { mode: 'custom', monthlyCapNanoAud: v.monthlyCapNanoAud as string };
}
/** One cent in nanoAUD. */
export const NANO_AUD_PER_CENT = 10_000_000n;

// ---------------------------------------------------------------------------
// Commercial terms (Modelvia commercial policies)
// ---------------------------------------------------------------------------

/**
 * How RealBud's client pays for one office's AI at Modelvia, written as that
 * customer's commercial policy. Modelvia refuses every request of a customer its
 * client pays for (`customer_terms_required`, 409, `ledger.ts`) until an ACTIVE
 * policy for that client and customer is in force.
 *
 *   client_funded  RealBud absorbs the usage (its own and internal offices). No
 *                  markup; receipts show `priceBasis: "withheld"`.
 *   resale         RealBud resells the usage on its own customer invoice at an
 *                  agreed markup. Never a default: the markup and the office's
 *                  acceptance reference come from explicit configuration.
 */
export type CustomerTerms =
  | { customerBilling: 'client_funded'; acceptanceReference: string }
  | { customerBilling: 'resale'; clientMarkupBasisPoints: number; acceptanceReference: string };
/** Which terms, if any, this deployment writes for an office. */
export interface CustomerTermsPolicy {
  /** RealBud companyIds whose AI RealBud absorbs (the owner's and internal offices). */
  clientFundedCompanies: ReadonlySet<string>;
  clientFundedReference: string;
  /** Present only when resale is explicitly configured. */
  resale?: { clientMarkupBasisPoints: number; acceptanceReference: string };
}
/** The owner's decision that RealBud's own AI use is a client-funded internal
 * cost (docs/decisions/2026-09-24-modelvia-sole-billing.md). */
export const DEFAULT_CLIENT_FUNDED_REFERENCE = 'realbud-owner-decision-2026-09-24-internal-ai';
const REFERENCE = /^[\x21-\x7e][\x20-\x7e]{0,198}[\x21-\x7e]$/;
/** The terms for one office: client-funded when listed, resale when resale is
 * configured, otherwise none (the operator has not decided how it is billed). */
export function termsForCompany(policy: CustomerTermsPolicy, companyId: string): CustomerTerms | undefined {
  if (policy.clientFundedCompanies.has(companyId)) return { customerBilling: 'client_funded', acceptanceReference: policy.clientFundedReference };
  return policy.resale ? { customerBilling: 'resale', ...policy.resale } : undefined;
}
/**
 * The terms policy from the environment. Every value is non-secret.
 *   REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES   comma-separated companyIds
 *   REALBUD_MODELVIA_CLIENT_FUNDED_REFERENCE   optional acceptance reference
 *   REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS  0..100000, resale only
 *   REALBUD_MODELVIA_RESALE_TERMS_REFERENCE      required with the markup
 * A malformed value is reported by name, never by value.
 */
export function customerTermsPolicy(env: NodeJS.ProcessEnv): CustomerTermsPolicy | { unavailable: string } {
  const value = (name: string) => (env[name] ?? '').trim();
  const companies = value('REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES').split(',').map(entry => entry.trim()).filter(Boolean);
  if (companies.some(entry => !ACCOUNT_ID.test(entry))) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES' };
  const clientFundedReference = value('REALBUD_MODELVIA_CLIENT_FUNDED_REFERENCE') || DEFAULT_CLIENT_FUNDED_REFERENCE;
  if (!REFERENCE.test(clientFundedReference)) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_CLIENT_FUNDED_REFERENCE' };
  const markup = value('REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS'), resaleReference = value('REALBUD_MODELVIA_RESALE_TERMS_REFERENCE');
  if (!markup && !resaleReference) return { clientFundedCompanies: new Set(companies), clientFundedReference };
  if (!/^(0|[1-9][0-9]{0,5})$/.test(markup) || Number(markup) > 100_000) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS' };
  if (!REFERENCE.test(resaleReference)) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_RESALE_TERMS_REFERENCE' };
  return { clientFundedCompanies: new Set(companies), clientFundedReference, resale: { clientMarkupBasisPoints: Number(markup), acceptanceReference: resaleReference } };
}
/** What `ensureCustomerTerms` found or wrote. `policyId` is Modelvia's policy id,
 * which this client never builds from a customer id. */
export interface CustomerTermsResult {
  /** `active`: a policy is in force. `pending`: an active policy starts later.
   * `not_required`: the customer pays Modelvia itself. */
  state: 'active' | 'pending' | 'not_required';
  created: boolean; policyId?: string; customerBilling?: 'client_funded' | 'resale';
}
/** Readiness for provisioning: may this customer's requests be admitted on terms? */
export type CustomerTermsReadiness = 'ready' | 'terms_required' | 'customer_missing';
/** The commercial-policy half of the operator client. Kept out of
 * `ModelviaOperatorClient` so existing fakes need not grow it; callers check for
 * it with `hasCustomerTerms`. */
export interface ModelviaTermsClient {
  /** Leaves an existing policy in force, whatever it says: changing how an
   * office is billed is a migration at Modelvia, never a side effect here.
   * Otherwise writes one ACTIVE policy for `terms`. */
  ensureCustomerTerms(customerId: string, terms: CustomerTerms): Promise<CustomerTermsResult>;
  /** Read only. */
  customerTermsReadiness(customerId: string): Promise<CustomerTermsReadiness>;
}
export function hasCustomerTerms(client: object): client is ModelviaTermsClient {
  return typeof (client as Partial<ModelviaTermsClient>).ensureCustomerTerms === 'function'
    && typeof (client as Partial<ModelviaTermsClient>).customerTermsReadiness === 'function';
}
/** How far before this service's clock a new policy is stamped. Modelvia admits
 * an activating `effectiveAt` down to five minutes before ITS clock and prices
 * nothing under a policy until `effectiveAt <= now`, so stamping a minute early
 * tolerates this clock running up to a minute ahead, or four minutes behind. */
export const TERMS_EFFECTIVE_LEAD_MS = 60_000;
/** A customer exactly as Modelvia's `accounts.put` admits it (id, name, active,
 * monthlyCapNanoAud, maxConcurrent, allowedModels, version, clientId, payer,
 * billingCompanyId). `payer` and `billingCompanyId` are immutable there, so an
 * update carries back whatever was read. */
export interface ModelviaCustomerRecord {
  id: string; name: string; active: boolean; monthlyCapNanoAud: string; maxConcurrent: number; allowedModels: string[];
  version: number; clientId: string; payer?: 'client' | 'customer'; billingCompanyId?: string;
}
/** The customer-record half of the operator client, used only by the operator
 * office AI access route. Kept apart from `ModelviaClient` so provisioning's
 * fakes need not grow it. */
export interface ModelviaCustomerAdmin {
  /** The full stored record, or null when Modelvia holds no customer with that
   * id. A customer under another platform client is `modelvia_customer_foreign`. */
  readCustomerRecord(customerId: string): Promise<ModelviaCustomerRecord | null>;
  /** Upserts the full record at its `version` (0 creates). Refuses, before any
   * request, a record under another client. A stale version is
   * `modelvia_customer_version_conflict` (409). */
  putCustomer(record: ModelviaCustomerRecord): Promise<ModelviaCustomerRecord>;
  /** Sets one office's AI access, creating its customer under this client when
   * Modelvia holds none. Re-reads once after a version conflict. */
  setCustomerAccess(customerId: string, input: { name: string; access: OfficeAiAccess }): Promise<{ active: boolean; monthlyCapNanoAud: string; created: boolean }>;
}
export type ModelviaOperatorClient = ModelviaClient & ModelviaCustomerAdmin;

function origin(raw: string): string {
  let url: URL; try { url = new URL(raw); } catch { throw new GatewayError('modelvia_base_invalid', 503); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  requireThat(!url.username && !url.password && !url.hash && !url.search && url.pathname === '/' && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)), 'modelvia_base_invalid', 503);
  return url.origin;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalTime = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
function validCaps(caps: ModelviaCaps): boolean {
  return NANO.test(caps.monthlyCapNanoAud) && NANO.test(caps.requestCapNanoAud)
    && BigInt(caps.requestCapNanoAud) <= BigInt(caps.monthlyCapNanoAud)
    && Number.isSafeInteger(caps.maxConcurrent) && caps.maxConcurrent > 0 && caps.maxConcurrent <= 100;
}
/** The fields `accounts.put` admits for a project, in the shape it stores them.
 * Anything else in a listed record is dropped, because a write that carries an
 * unknown field is refused. */
type StoredProject = { id: string; name: string; active: boolean; monthlyCapNanoAud: string; maxConcurrent: number; allowedModels: string[];
  version: number; clientId: string; customerId: string; environments: string[]; requestCapNanoAud: string };
function storedProject(value: unknown): StoredProject {
  const ids = (list: unknown) => Array.isArray(list) && list.length > 0 && list.length <= 64 && list.every(item => typeof item === 'string' && ACCOUNT_ID.test(item));
  requireThat(record(value) && typeof value.id === 'string' && PATH_ID.test(value.id) && typeof value.name === 'string' && typeof value.active === 'boolean'
    && typeof value.clientId === 'string' && ACCOUNT_ID.test(value.clientId) && typeof value.customerId === 'string' && ACCOUNT_ID.test(value.customerId)
    && ids(value.environments) && ids(value.allowedModels) && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 0
    && typeof value.monthlyCapNanoAud === 'string' && typeof value.requestCapNanoAud === 'string' && typeof value.maxConcurrent === 'number'
    && validCaps(value as unknown as ModelviaCaps), 'modelvia_unreadable', 502);
  const v = value as unknown as StoredProject;
  return { id: v.id, name: v.name, active: v.active, monthlyCapNanoAud: v.monthlyCapNanoAud, maxConcurrent: v.maxConcurrent, allowedModels: [...v.allowedModels],
    version: v.version, clientId: v.clientId, customerId: v.customerId, environments: [...v.environments], requestCapNanoAud: v.requestCapNanoAud };
}
/** A listed customer reduced to the fields `accounts.put` admits, or
 * `modelvia_unreadable`. Anything else is dropped: a write carrying an unknown
 * field is refused there. */
function storedCustomer(value: unknown): ModelviaCustomerRecord {
  requireThat(record(value) && typeof value.id === 'string' && PATH_ID.test(value.id) && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 200
    && typeof value.active === 'boolean' && typeof value.monthlyCapNanoAud === 'string' && NANO.test(value.monthlyCapNanoAud)
    && typeof value.maxConcurrent === 'number' && Number.isSafeInteger(value.maxConcurrent) && value.maxConcurrent > 0 && value.maxConcurrent <= 100
    && Array.isArray(value.allowedModels) && value.allowedModels.length > 0 && value.allowedModels.length <= 64 && value.allowedModels.every(item => typeof item === 'string' && ACCOUNT_ID.test(item))
    && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 0
    && typeof value.clientId === 'string' && ACCOUNT_ID.test(value.clientId)
    && (value.payer === undefined || value.payer === 'client' || value.payer === 'customer')
    && (value.billingCompanyId === undefined || (typeof value.billingCompanyId === 'string' && ACCOUNT_ID.test(value.billingCompanyId))), 'modelvia_unreadable', 502);
  const v = value as unknown as ModelviaCustomerRecord;
  return { id: v.id, name: v.name, active: v.active, monthlyCapNanoAud: v.monthlyCapNanoAud, maxConcurrent: v.maxConcurrent, allowedModels: [...v.allowedModels],
    version: v.version, clientId: v.clientId, ...(v.payer === undefined ? {} : { payer: v.payer }), ...(v.billingCompanyId === undefined ? {} : { billingCompanyId: v.billingCompanyId }) };
}
const sameCaps = (a: ModelviaCaps, b: ModelviaCaps) => a.monthlyCapNanoAud === b.monthlyCapNanoAud && a.requestCapNanoAud === b.requestCapNanoAud && a.maxConcurrent === b.maxConcurrent;

export function modelviaKeyClient(options: {
  /** Modelvia service origin, normally https://api.modelvia.dev. */
  serviceOrigin: string;
  environment: string;
  /** RealBud's platform client id at Modelvia; the customer's parent. */
  clientId: string;
  /** Models the installation's project may use. */
  allowedModels: readonly string[];
  /** Modelvia's operator HMAC secret (>=32 chars). Read per request, never stored. */
  operatorSecret: () => string | undefined;
  /** Operator subject recorded in Modelvia's audit trail. */
  operatorSubject: string;
  fetch: HttpTransport;
  /** Injected clock: the minted token's window must match Modelvia's. */
  now?: () => number;
}): ModelviaOperatorClient & ModelviaTermsClient {
  const base = origin(options.serviceOrigin);
  requireThat(ACCOUNT_ID.test(options.clientId), 'modelvia_client_id_invalid', 503);
  requireThat(options.operatorSubject.length > 0 && options.operatorSubject.length <= 320, 'modelvia_operator_subject_invalid', 503);
  requireThat(ACCOUNT_ID.test(options.environment), 'modelvia_environment_invalid', 503);
  requireThat(options.allowedModels.length > 0 && options.allowedModels.length <= 64
    && new Set(options.allowedModels).size === options.allowedModels.length
    && options.allowedModels.every(model => ACCOUNT_ID.test(model)), 'modelvia_models_invalid', 503);
  const clock = options.now ?? Date.now;
  // A fresh bearer per request. Modelvia rejects anything older than five
  // minutes, so nothing here may cache one.
  const token = () => {
    const secret = options.operatorSecret();
    requireThat(typeof secret === 'string' && secret.trim().length >= 32, 'modelvia_operator_unconfigured', 503);
    return operatorToken((secret as string).trim(), options.operatorSubject, clock());
  };
  /** `conflicts` names the Modelvia error codes this call treats as a conflict
   * rather than a failure. Only a strictly shaped `{error: "<code>"}` is read,
   * and only for control flow — an upstream body is never surfaced. */
  const callRaw = async (path: string, body: unknown, conflicts: readonly string[] = [], method: 'GET' | 'POST' = 'POST'): Promise<{ conflict?: string; body?: unknown }> => {
    const bearerToken = token();
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, method === 'GET'
        ? { method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { authorization: `Bearer ${bearerToken}`, accept: 'application/json' } }
        : { method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { authorization: `Bearer ${bearerToken}`, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body) });
    } catch { throw new GatewayError('modelvia_unreachable', 502); }
    if (response.redirected) { await response.body?.cancel().catch(() => {}); throw new GatewayError('modelvia_redirected', 502); }
    if (response.status === 409 && conflicts.length) {
      let code: unknown;
      try { code = ((await response.json()) as Record<string, unknown>).error; } catch { throw new GatewayError('modelvia_rejected', 502); }
      if (typeof code === 'string' && conflicts.includes(code)) return { conflict: code };
      throw new GatewayError('modelvia_rejected', 502);
    }
    // Modelvia's error bodies may quote the presented credential; only a code is reported.
    if (response.status !== 200 && response.status !== 201) { await response.body?.cancel().catch(() => {}); throw new GatewayError('modelvia_rejected', 502); }
    try { return { body: await response.json() }; } catch { throw new GatewayError('modelvia_unreadable', 502); }
  };
  const call = async (path: string, body: unknown): Promise<unknown> => (await callRaw(path, body)).body;
  const read = async (path: string): Promise<unknown> => (await callRaw(path, undefined, [], 'GET')).body;
  /** Modelvia has no project read by id; the operator list is the only source. */
  const readProject = async (projectId: string): Promise<StoredProject | undefined> => {
    const body = await read('/v1/operator/projects');
    requireThat(record(body) && Array.isArray(body.accounts), 'modelvia_unreadable', 502);
    const found = (body.accounts as unknown[]).filter(entry => record(entry) && entry.id === projectId);
    requireThat(found.length <= 1, 'modelvia_unreadable', 502);
    if (!found.length) return undefined;
    const project = storedProject(found[0]);
    // A project under another platform client is not one this service may touch.
    requireThat(project.clientId === options.clientId, 'modelvia_project_scope_mismatch', 502);
    return project;
  };
  /** Modelvia has no customer read by id either. A customer under another
   * platform client is refused outright: the operator credential is global, so
   * this check is the only thing keeping this service inside RealBud's client. */
  const readCustomer = async (customerId: string): Promise<ModelviaCustomerRecord | null> => {
    requireThat(PATH_ID.test(customerId), 'invalid_modelvia_account');
    const body = await read('/v1/operator/customers');
    requireThat(record(body) && Array.isArray(body.accounts), 'modelvia_unreadable', 502);
    const found = (body.accounts as unknown[]).filter(entry => record(entry) && entry.id === customerId);
    requireThat(found.length <= 1, 'modelvia_unreadable', 502);
    if (!found.length) return null;
    requireThat((found[0] as Record<string, unknown>).clientId === options.clientId, 'modelvia_customer_foreign', 409);
    return storedCustomer(found[0]);
  };
  const putCustomer = async (input: ModelviaCustomerRecord): Promise<ModelviaCustomerRecord> => {
    let next: ModelviaCustomerRecord;
    try { next = storedCustomer(input); } catch { throw new GatewayError('invalid_modelvia_customer_record'); }
    // Never write, or create, a customer under another platform client.
    requireThat(next.clientId === options.clientId, 'modelvia_customer_foreign', 409);
    const answer = await callRaw('/v1/operator/customers', next, ['account_version_conflict']);
    if (answer.conflict) throw new GatewayError('modelvia_customer_version_conflict', 409);
    const saved = storedCustomer(answer.body);
    requireThat(saved.id === next.id && saved.clientId === next.clientId && saved.active === next.active
      && saved.monthlyCapNanoAud === next.monthlyCapNanoAud && saved.version > next.version, 'modelvia_customer_scope_mismatch', 502);
    return saved;
  };
  /** Checks a returned key against the record Modelvia says it belongs to. */
  const issuedKey = (body: unknown, projectId?: string): { key: string; keyId: string; projectId: string } => {
    requireThat(record(body), 'modelvia_unreadable', 502);
    const b = body as Record<string, unknown>, minted = b.key, issued = b.record;
    requireThat(typeof minted === 'string' && MINTED_KEY.test(minted), 'modelvia_key_unusable', 502);
    requireThat(record(issued) && typeof issued.id === 'string' && KEY_ID.test(issued.id), 'modelvia_unreadable', 502);
    const keyId = (issued as Record<string, unknown>).id as string, project = (issued as Record<string, unknown>).project;
    // A record id that does not belong to the returned key would leave a live
    // credential revocation cannot reach.
    requireThat((minted as string).startsWith(`rbk_${keyId}_`), 'modelvia_key_unusable', 502);
    requireThat(typeof project === 'string' && (projectId === undefined || project === projectId), 'modelvia_key_scope_mismatch', 502);
    return { key: minted as string, keyId, projectId: project as string };
  };
  /** Who pays Modelvia for this customer (`accounts.ts`): the client's billing
   * mode, or the customer's own `payer` under a `mixed` client. */
  const effectivePayer = async (customer: ModelviaCustomerRecord): Promise<'client' | 'customer'> => {
    const body = await read('/v1/operator/clients');
    requireThat(record(body) && Array.isArray(body.accounts), 'modelvia_unreadable', 502);
    const found = (body.accounts as unknown[]).filter(entry => record(entry) && entry.id === options.clientId) as Record<string, unknown>[];
    requireThat(found.length === 1 && ['client', 'customer', 'mixed'].includes(String(found[0]!.billingMode)), 'modelvia_unreadable', 502);
    const payer = found[0]!.billingMode === 'mixed' ? customer.payer : found[0]!.billingMode;
    requireThat(payer === 'client' || payer === 'customer', 'modelvia_unreadable', 502);
    return payer as 'client' | 'customer';
  };
  /** This client's ACTIVE policies for one customer. The list is global to the
   * operator credential, so everything else is dropped unread. Drafts never price. */
  const readPolicies = async (customerId: string): Promise<HeldPolicy[]> => {
    const body = await read('/v1/operator/commercial-policies');
    requireThat(record(body) && Array.isArray(body.policies), 'modelvia_unreadable', 502);
    return (body.policies as unknown[]).filter(entry => record(entry) && entry.clientId === options.clientId && entry.customerId === customerId && entry.state === 'active')
      .map(entry => {
        const p = entry as Record<string, unknown>;
        requireThat(typeof p.id === 'string' && ACCOUNT_ID.test(p.id) && typeof p.effectiveAt === 'number' && Number.isSafeInteger(p.effectiveAt)
          && (p.customerBilling === undefined || p.customerBilling === 'resale' || p.customerBilling === 'client_funded'), 'modelvia_unreadable', 502);
        // Absent means resale: the only meaning a policy recorded before the field had.
        return { id: p.id as string, effectiveAt: p.effectiveAt as number, customerBilling: (p.customerBilling ?? 'resale') as HeldPolicy['customerBilling'] };
      });
  };
  return {
    environment: options.environment,
    async createProject(input) {
      requireThat(PATH_ID.test(input.projectId) && PATH_ID.test(input.customerId), 'invalid_modelvia_account');
      requireThat(input.name.trim().length > 0 && input.name.length <= 200, 'invalid_modelvia_project_name');
      requireThat(NANO.test(input.monthlyCapNanoAud) && NANO.test(input.requestCapNanoAud)
        && BigInt(input.requestCapNanoAud) <= BigInt(input.monthlyCapNanoAud), 'invalid_modelvia_caps');
      requireThat(Number.isSafeInteger(input.maxConcurrent) && input.maxConcurrent > 0 && input.maxConcurrent <= 100, 'invalid_modelvia_caps');
      // `version: 0` creates. A project id Modelvia already holds comes back as
      // `account_version_conflict`; it is reported, never re-capped or reparented
      // (clientId/customerId are immutable there after create).
      const answer = await callRaw('/v1/operator/projects', {
        id: input.projectId, name: input.name.trim(), active: true,
        monthlyCapNanoAud: input.monthlyCapNanoAud, requestCapNanoAud: input.requestCapNanoAud,
        maxConcurrent: input.maxConcurrent, allowedModels: [...options.allowedModels],
        version: 0, clientId: options.clientId, customerId: input.customerId,
        environments: [options.environment],
      }, ['account_version_conflict']);
      if (answer.conflict) return { projectId: input.projectId, created: false };
      const body = answer.body;
      requireThat(record(body) && body.id === input.projectId && body.customerId === input.customerId, 'modelvia_project_scope_mismatch', 502);
      return { projectId: input.projectId, created: true };
    },
    async mint(input) {
      requireThat(PATH_ID.test(input.projectId), 'invalid_modelvia_account');
      requireThat(input.label.length > 0 && input.label.length <= 200, 'invalid_key_label');
      // Exactly the four permitted fields, and only the ones we set.
      const body = await call('/v1/operator/keys', { projectId: input.projectId, environment: options.environment, label: input.label });
      const issued = issuedKey(body, input.projectId);
      // OpenAI-compatible serving base; Modelvia serves /v1/models and /v1/chat/completions.
      return { key: issued.key, keyId: issued.keyId, baseUrl: `${base}/v1` };
    },
    async findCustomer(customerId) {
      requireThat(PATH_ID.test(customerId), 'invalid_modelvia_account');
      const body = await read('/v1/operator/customers');
      requireThat(record(body) && Array.isArray(body.accounts), 'modelvia_unreadable', 502);
      const found = (body.accounts as unknown[]).filter(entry => record(entry) && entry.id === customerId);
      requireThat(found.length <= 1, 'modelvia_unreadable', 502);
      if (!found.length) return null;
      const c = found[0] as Record<string, unknown>;
      requireThat(typeof c.clientId === 'string' && typeof c.active === 'boolean' && typeof c.monthlyCapNanoAud === 'string' && NANO.test(c.monthlyCapNanoAud)
        && typeof c.maxConcurrent === 'number' && Number.isSafeInteger(c.maxConcurrent) && c.maxConcurrent >= 0 && c.maxConcurrent <= 100, 'modelvia_unreadable', 502);
      // A customer under another platform client is not this service's to provision into.
      if (c.clientId !== options.clientId) return null;
      return { active: c.active as boolean, monthlyCapNanoAud: c.monthlyCapNanoAud as string, maxConcurrent: c.maxConcurrent as number };
    },
    async findProject(projectId) {
      requireThat(PATH_ID.test(projectId), 'invalid_modelvia_account');
      const project = await readProject(projectId);
      if (!project) return undefined;
      return { projectId: project.id, clientId: project.clientId, customerId: project.customerId, environments: [...project.environments], active: project.active,
        version: project.version, monthlyCapNanoAud: project.monthlyCapNanoAud, requestCapNanoAud: project.requestCapNanoAud, maxConcurrent: project.maxConcurrent };
    },
    async listKeys(projectId, environment) {
      requireThat(PATH_ID.test(projectId), 'invalid_modelvia_account');
      requireThat(ACCOUNT_ID.test(environment), 'modelvia_environment_invalid');
      const body = await read(`/v1/operator/keys?${new URLSearchParams({ projectId, environment })}`);
      requireThat(record(body) && Array.isArray(body.keys) && body.keys.length <= 1000, 'modelvia_unreadable', 502);
      return (body.keys as unknown[]).map(entry => {
        requireThat(record(entry) && typeof entry.id === 'string' && KEY_ID.test(entry.id) && (entry.label === undefined || typeof entry.label === 'string')
          && optionalTime(entry.expiresAt) && optionalTime(entry.revokedAt), 'modelvia_unreadable', 502);
        const e = entry as Record<string, unknown>;
        // The listing is filtered there; a record for anything else is not ours to act on.
        requireThat(e.project === projectId && e.environment === environment, 'modelvia_key_scope_mismatch', 502);
        return { keyId: e.id as string, projectId, environment,
          ...(e.label === undefined ? {} : { label: e.label as string }),
          ...(e.expiresAt === undefined ? {} : { expiresAt: e.expiresAt as number }),
          ...(e.revokedAt === undefined ? {} : { revokedAt: e.revokedAt as number }) };
      });
    },
    async rotate(keyId) {
      requireThat(KEY_ID.test(keyId), 'invalid_key_id');
      // No label or expiry override: the replacement keeps the installation label,
      // which is what attributes it on a later listing.
      const body = await call(`/v1/operator/keys/${keyId}/rotate`, {});
      const issued = issuedKey(body);
      requireThat((body as Record<string, unknown>).replaced === keyId && issued.keyId !== keyId, 'modelvia_key_unusable', 502);
      return { key: issued.key, keyId: issued.keyId, baseUrl: `${base}/v1`, projectId: issued.projectId, replaced: keyId };
    },
    async revoke(keyId) {
      requireThat(KEY_ID.test(keyId), 'invalid_key_id');
      await call(`/v1/operator/keys/${keyId}/revoke`, {});
    },
    async updateProjectCaps(projectId, caps) {
      requireThat(PATH_ID.test(projectId), 'invalid_modelvia_account');
      requireThat(validCaps(caps), 'invalid_modelvia_caps');
      // Read, write back at the stored version, and re-read once if another
      // writer moved it in between. Only the caps change; every other field goes
      // back exactly as Modelvia stored it.
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await readProject(projectId);
        requireThat(current, 'modelvia_project_missing', 502);
        if (sameCaps(current!, caps)) return { updated: false, version: current!.version };
        const answer = await callRaw('/v1/operator/projects', { ...current!, monthlyCapNanoAud: caps.monthlyCapNanoAud,
          requestCapNanoAud: caps.requestCapNanoAud, maxConcurrent: caps.maxConcurrent }, ['account_version_conflict']);
        if (answer.conflict) continue;
        const saved = answer.body;
        requireThat(record(saved) && saved.id === projectId && typeof saved.version === 'number' && Number.isSafeInteger(saved.version), 'modelvia_unreadable', 502);
        requireThat(sameCaps(saved as unknown as ModelviaCaps, caps), 'modelvia_project_scope_mismatch', 502);
        return { updated: true, version: (saved as Record<string, unknown>).version as number };
      }
      throw new GatewayError('modelvia_project_version_conflict', 502);
    },
    readCustomerRecord: readCustomer,
    putCustomer,
    async setCustomerAccess(customerId, input) {
      requireThat(PATH_ID.test(customerId), 'invalid_modelvia_account');
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      requireThat(name.length > 0 && name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(name), 'invalid_ai_access');
      const access = parseOfficeAiAccess(input.access);
      const active = access.mode !== 'disabled';
      // Read, write the full record back at its stored version, and re-read once
      // if another writer moved it in between. Only `active` and the cap change;
      // an existing customer keeps its name, concurrency, models and bindings.
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await readCustomer(customerId);
        const monthlyCapNanoAud = access.mode === 'custom' ? access.monthlyCapNanoAud
          : access.mode === 'default' || !current ? DEFAULT_OFFICE_AI_CAP_NANO_AUD : current.monthlyCapNanoAud;
        if (current && current.active === active && current.monthlyCapNanoAud === monthlyCapNanoAud) return { active, monthlyCapNanoAud, created: false };
        const next: ModelviaCustomerRecord = current ? { ...current, active, monthlyCapNanoAud }
          : { id: customerId, name, active, monthlyCapNanoAud, maxConcurrent: NEW_CUSTOMER_MAX_CONCURRENT,
            allowedModels: [...options.allowedModels], version: 0, clientId: options.clientId };
        try {
          const saved = await putCustomer(next);
          return { active: saved.active, monthlyCapNanoAud: saved.monthlyCapNanoAud, created: !current };
        } catch (error) {
          if (error instanceof GatewayError && error.code === 'modelvia_customer_version_conflict') continue;
          throw error;
        }
      }
      throw new GatewayError('modelvia_customer_version_conflict', 409);
    },
    async ensureCustomerTerms(customerId, terms) {
      requireThat(PATH_ID.test(customerId), 'invalid_modelvia_account');
      const wanted = validTerms(terms);
      const customer = await readCustomer(customerId);
      // Terms follow the customer; AI access creates it first.
      requireThat(customer, 'modelvia_customer_not_ready', 409);
      if (await effectivePayer(customer!) === 'customer') return { state: 'not_required', created: false };
      // Re-read once when another writer (or a reply lost on the wire) moved the
      // policy list between the read and the write.
      for (let attempt = 0; attempt < 2; attempt++) {
        const at = clock();
        const held = inForce(await readPolicies(customerId), at);
        if (held) return { state: held.effectiveAt <= at ? 'active' : 'pending', created: false, policyId: held.id, customerBilling: held.customerBilling };
        const effectiveAt = at - TERMS_EFFECTIVE_LEAD_MS;
        // Modelvia's `CommercialPolicies.put` takes exactly these keys. The id is
        // globally unique there and deliberately carries no customer id.
        const body = {
          id: `realbud-${wanted.customerBilling}-${effectiveAt}-${randomBytes(4).toString('hex')}`,
          clientId: options.clientId, customerId, state: 'active', effectiveAt,
          payer: 'client', invoiceIssuer: 'client', collection: 'invoice', management: 'self_service',
          // RealBud's billing company is internal-cost (fee must be 0), and the
          // approved rate card already carries Modelvia's platform fee.
          platformFeeBasisPoints: 0,
          clientMarkupBasisPoints: wanted.customerBilling === 'resale' ? wanted.clientMarkupBasisPoints : 0,
          acceptanceReference: wanted.acceptanceReference, customerBilling: wanted.customerBilling,
        };
        const answer = await callRaw('/v1/operator/commercial-policies', body, TERMS_CONFLICTS);
        if (answer.conflict === 'policy_version_exists' || answer.conflict === 'policy_effective_order') continue;
        if (answer.conflict === 'payer_migration_required') throw new GatewayError('modelvia_terms_payer_mismatch', 409);
        if (answer.conflict === 'commercial_acceptance_required') throw new GatewayError('modelvia_terms_clock_skew', 409);
        if (answer.conflict) throw new GatewayError('modelvia_terms_refused', 409);
        const saved = answer.body;
        requireThat(record(saved) && saved.id === body.id && saved.customerId === customerId && saved.clientId === options.clientId
          && saved.state === 'active' && saved.effectiveAt === effectiveAt, 'modelvia_terms_scope_mismatch', 502);
        return { state: effectiveAt <= clock() ? 'active' : 'pending', created: true, policyId: body.id, customerBilling: wanted.customerBilling };
      }
      throw new GatewayError('modelvia_terms_conflict', 409);
    },
    async customerTermsReadiness(customerId) {
      requireThat(PATH_ID.test(customerId), 'invalid_modelvia_account');
      const body = await read('/v1/operator/customers');
      requireThat(record(body) && Array.isArray(body.accounts), 'modelvia_unreadable', 502);
      const found = (body.accounts as unknown[]).filter(entry => record(entry) && entry.id === customerId);
      requireThat(found.length <= 1, 'modelvia_unreadable', 502);
      // Missing or another client's: provisioning's customer check answers that.
      if (!found.length || (found[0] as Record<string, unknown>).clientId !== options.clientId) return 'customer_missing';
      if (await effectivePayer(storedCustomer(found[0])) === 'customer') return 'ready';
      const policy = inForce(await readPolicies(customerId), clock());
      return policy && policy.effectiveAt <= clock() ? 'ready' : 'terms_required';
    },
  };
}

/** The Modelvia refusals `ensureCustomerTerms` reads as a code (all 409). */
const TERMS_CONFLICTS = ['policy_version_exists', 'policy_effective_order', 'payer_migration_required', 'commercial_acceptance_required',
  'invalid_internal_commercial_policy', 'invalid_client_funded_policy', 'merchant_onboarding_required', 'hosted_collection_not_connected'] as const;
type HeldPolicy = { id: string; effectiveAt: number; customerBilling: 'client_funded' | 'resale' };
function validTerms(terms: CustomerTerms): CustomerTerms {
  requireThat(record(terms) && REFERENCE.test(String(terms.acceptanceReference)), 'invalid_customer_terms');
  if (terms.customerBilling === 'client_funded') return { customerBilling: 'client_funded', acceptanceReference: terms.acceptanceReference };
  requireThat(terms.customerBilling === 'resale' && Number.isSafeInteger(terms.clientMarkupBasisPoints)
    && terms.clientMarkupBasisPoints >= 0 && terms.clientMarkupBasisPoints <= 100_000, 'invalid_customer_terms');
  return { customerBilling: 'resale', clientMarkupBasisPoints: (terms as { clientMarkupBasisPoints: number }).clientMarkupBasisPoints, acceptanceReference: terms.acceptanceReference };
}
/** The policy Modelvia prices under now (latest active `effectiveAt <= at`), else
 * the earliest active one that starts later: while that one is pending a new
 * policy could only be refused (`policy_effective_order`). */
function inForce(policies: HeldPolicy[], at: number): HeldPolicy | undefined {
  const current = policies.filter(p => p.effectiveAt <= at).sort((a, b) => b.effectiveAt - a.effectiveAt)[0];
  return current ?? policies.filter(p => p.effectiveAt > at).sort((a, b) => a.effectiveAt - b.effectiveAt)[0];
}

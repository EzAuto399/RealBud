import type { AssistantMessage, ModelMessage, ToolDefinition } from './messages.ts';
/** Off-device contracts. Nothing in this directory is loaded by the desktop. */
export class GatewayError extends Error {
  readonly code:string; readonly status:number;
  constructor(code: string, status = 400) { super(code); this.code=code; this.status=status; }
}
export function requireThat(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new GatewayError(code, status);
}
export function object(value: unknown): asserts value is Record<string, unknown> {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid_object');
}
export function exact(value: Record<string, unknown>, fields: string[]) {
  requireThat(Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k)), 'invalid_fields');
}
export function id(value: unknown): asserts value is string {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value), 'invalid_id');
}
export function integer(value: unknown, max = 1_000_000_000): asserts value is number {
  requireThat(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max, 'invalid_integer');
}
export function nano(value: unknown): bigint {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,20})$/.test(value), 'invalid_money');
  return BigInt(value);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v])=>v!==undefined).sort(([a], [b]) => a<b?-1:a>b?1:0).map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  requireThat(value === null || ['string','number','boolean'].includes(typeof value), 'invalid_json');
  return JSON.stringify(value);
}

export const UNIT_NAMES = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'requests', 'image_units', 'audio_milliseconds', 'tool_calls'] as const;
export type Unit = typeof UNIT_NAMES[number];
/** Token buckets are disjoint. Reasoning tokens belong to output, never added twice. */
export type Units = Partial<Record<Unit, number>>;
export interface UnitRate { nanoAud: string; perUnits: number }
export interface ModelRate { model: string; label: string; units: Partial<Record<Unit, UnitRate>> }
export interface RateCard {
  version: string; currency: 'AUD'; gstInclusive: true; gstBasisPoints: 1000;
  publishedAt: number; effectiveAt: number; models: ModelRate[];
}
export interface ExecutionGrant {
  schema: 1 | 2; aud: 'realbud-managed-ai'; grantVersion: 1 | 2;
  companyId: string; memberId: string; hostInstallationId: string; deviceId: string;
  licenseId: string; jobId: string; attemptId: string; revision: string; authorityVersion: string;
  operation: 'model.stream'; model: string; account: string; resource: string;
  jti: string; iat: number; exp: number;
  rateVersion: string; maxSpendNanoAud: string; requestDigest: string;
  /** Mandatory in v2; immutable parent envelope is checked in the ledger. */
  modelCallId?: string; maxAttemptSpendNanoAud?: string; attemptExpiresAt?: number;
  provider?: string; allowedModels?: { provider: string; model: string; capabilities: ('text' | 'tools')[] }[];
}
export interface GrantEnvelope { kid: string; payload: string; signature: string }
export interface IssuerEnrollment {
  kid: string; companyId: string; hostInstallationId: string; publicKeyPem: string;
  revoked: boolean; expiresAt: number;
}
export interface Tenant {
  companyId: string; licenseId: string; active: boolean; serviceExpiresAt: number;
  customerName: string; customerAddress: string; customerAbn?: string;
  goLiveAt: number; goLiveEvidence: string; includedUntil: number;
  /** Monthly retail exposure, including GST, also contains included-period provider use. */
  monthlyCapNanoAud: string; requestCapNanoAud: string; maxConcurrent: number;
}
export interface PortalPrincipal { subject: string; companyId: string; role: 'billing_owner' | 'billing_reader' }
export interface ModelRequest {
  model: string; rateVersion: string; idempotencyKey: string;
  messages: ModelMessage[];
  protocol?: 'tools-v1'; tools?:ToolDefinition[]; thinking?:'enabled'|'disabled'; reasoningEffort?:'low'|'high'|'max';
  maxOutputTokens: number;
}
export interface UsageEvidence {
  evidenceId: string; providerRequestId: string; units: Units;
  outcome: 'succeeded' | 'failed' | 'cancelled'; source: 'final_usage' | 'provider_reconciliation';
}
export type ProviderEvent = { type: 'delta'; text: string } | { type: 'usage'; evidence: UsageEvidence } | { type:'continuation'; message:AssistantMessage };
export interface ProviderAdapter {
  /** No secrets, cost schedules or provider account identifiers in this identifier. */
  readonly id: string;
  /** Stable provider usage namespace across model-route versions; prevents cross-route rebilling. */
  readonly usageNamespace:string;
  readonly terms: { reviewReference: string; approvedUntil: number };
  /** A hard bound, never a best-effort token estimate. Reject unsupported inputs/units. */
  bound(request: ModelRequest): Units;
  stream(request: ModelRequest, context: { signal: AbortSignal; dispatchId: string }): AsyncIterable<ProviderEvent>;
}
export interface AuthorityLease {
  /** Must be current through dispatch; revocation/expiry aborts via signal. */
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}
export interface ExecutionAuthority {
  /** Required authenticated office connection: validates actor, enrolled device, job/attempt/revision,
   * account/resource permissions and revocation against the authoritative host.
   * assertCurrent may use a locally revocable lease backed by that outbound connection;
   * no remote roundtrip per stream delta is implied. No permissive default.
   * A signed grant or service-admin session alone is not sufficient. */
  acquire(grant: ExecutionGrant, signal: AbortSignal): Promise<AuthorityLease>;
}
export interface RequestRecord {
  id: string; companyId: string; memberId: string; jobId: string; attemptId: string;
  modelCallId?: string; authorizationDigest?: string;
  kid: string; jti: string; idempotencyKey: string; fingerprint: string;
  model: string; rateVersion: string; period: string; createdAt: number; deadline: number;
  state: 'reserved' | 'dispatched' | 'unknown' | 'settled' | 'released';
  included: boolean; bound: Units; reservedNanoAud: string; retailNanoAud: string;
  chargedNanoAud: string; units: Units; outcome?: UsageEvidence['outcome'];
  providerId?:string;
  providerNamespace?:string;
}

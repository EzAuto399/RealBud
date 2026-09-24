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
import { createHmac } from 'node:crypto';
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
}): ModelviaClient {
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
  };
}

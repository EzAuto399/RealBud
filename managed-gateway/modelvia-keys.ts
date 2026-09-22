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
export interface ModelviaClient {
  readonly environment: string;
  /** Creates the installation's project under the customer, with the ledger cap.
   * `created` is false when Modelvia already holds that project id. */
  createProject(input: ModelviaProjectInput): Promise<{ projectId: string; created: boolean }>;
  mint(input: { projectId: string; label: string }): Promise<ModelviaMintedKey>;
  /** Marks the key for revocation. Idempotent there; never retried here. The
   * project is deliberately left in place — see `revoke` in provisioning.ts. */
  revoke(keyId: string): Promise<void>;
}

function origin(raw: string): string {
  let url: URL; try { url = new URL(raw); } catch { throw new GatewayError('modelvia_base_invalid', 503); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  requireThat(!url.username && !url.password && !url.hash && !url.search && url.pathname === '/' && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)), 'modelvia_base_invalid', 503);
  return url.origin;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

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
  const callRaw = async (path: string, body: unknown, conflicts: readonly string[] = []): Promise<{ conflict?: string; body?: unknown }> => {
    const bearerToken = token();
    let response: Response;
    try {
      response = await options.fetch(`${base}${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${bearerToken}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
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
      requireThat(record(body), 'modelvia_unreadable', 502);
      const minted = body.key, issued = body.record;
      requireThat(typeof minted === 'string' && MINTED_KEY.test(minted), 'modelvia_key_unusable', 502);
      requireThat(record(issued) && typeof issued.id === 'string' && KEY_ID.test(issued.id), 'modelvia_unreadable', 502);
      const keyId = (issued as Record<string, unknown>).id as string;
      // A record id that does not belong to the returned key would leave a live
      // credential revocation cannot reach.
      requireThat((minted as string).startsWith(`rbk_${keyId}_`), 'modelvia_key_unusable', 502);
      requireThat((issued as Record<string, unknown>).project === input.projectId, 'modelvia_key_scope_mismatch', 502);
      // OpenAI-compatible serving base; Modelvia serves /v1/models and /v1/chat/completions.
      return { key: minted as string, keyId, baseUrl: `${base}/v1` };
    },
    async revoke(keyId) {
      requireThat(KEY_ID.test(keyId), 'invalid_key_id');
      await call(`/v1/operator/keys/${keyId}/revoke`, {});
    },
  };
}

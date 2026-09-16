import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { SERVICE_ADMIN_HEADER, type ServiceAdminGate, type ServiceAdminLogin, type ServiceAdminStatus } from "../shared/service-admin.ts";

export { SERVICE_ADMIN_HEADER } from "../shared/service-admin.ts";

/** Provider login codes are setup credentials, not staff connection status.
 * Reading them must not keep a five-minute administrator session alive.
 */
export function isPrivilegedServiceRead(path: string, method: string): boolean {
  return (method === "GET" || method === "HEAD") && path === "/api/hermes/oauth/status";
}

const SESSION_MS = 15 * 60_000;
const IDLE_MS = 5 * 60_000;
const ATTEMPT_WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SESSIONS = 8;
const MAX_PASSWORD_BYTES = 1024;
const VERIFIER = /^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
type RequestHeaders = Pick<IncomingMessage, "headers">;

export interface ServiceAdminPolicy {
  /** Selected by trusted server configuration, never a request or member role. */
  managed: boolean;
  passwordVerifier: string | null;
  configurationError?: boolean;
}

export class ServiceAdminError extends Error {
  readonly status: 400 | 401 | 403 | 429;
  readonly retryAfterSeconds?: number;
  constructor(message: string, status: 400 | 401 | 403 | 429, retryAfterSeconds?: number) {
    super(message);
    this.name = "ServiceAdminError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function passwordValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES && !/[\u0000-\u001f\u007f]/.test(value);
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

/** Trusted provisioning helper only; do not expose as an unauthenticated API. */
export async function createServiceAdminPasswordVerifier(password: string): Promise<string> {
  if (!passwordValid(password) || password.length < 12) {
    throw new ServiceAdminError("Use an administrator password of 12–512 characters within 1024 bytes.", 400);
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$32768$8$1$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Fixed KDF parameters prevent a malformed verifier from choosing resource use. */
export async function verifyServiceAdminPassword(password: string, verifier: string): Promise<boolean> {
  if (!passwordValid(password)) return false;
  const match = VERIFIER.exec(verifier);
  if (!match) return false;
  const key = await derive(password, Buffer.from(match[1]!, "hex"));
  return timingSafeEqual(key, Buffer.from(match[2]!, "hex"));
}

/** Reads only an explicitly supplied trusted provisioning file. No plaintext,
 * environment override, bundled password, or legacy-care fallback is accepted.
 * A deployment may migrate a legacy secret with the provisioning helper once.
 */
export function readServiceAdminPolicy(options: { path: string; managedDefault?: boolean }): ServiceAdminPolicy {
  try {
    if (statSync(options.path).size > 4096) throw new Error("oversized policy");
    const value: unknown = JSON.parse(readFileSync(options.path, "utf8"));
    if (!record(value) || Object.keys(value).some(key => !["version", "passwordVerifier"].includes(key)) ||
      value.version !== 1 || typeof value.passwordVerifier !== "string" || !VERIFIER.test(value.passwordVerifier)) {
      throw new Error("invalid policy");
    }
    return { managed: true, passwordVerifier: value.passwordVerifier };
  } catch (error) {
    const malformed = (error as NodeJS.ErrnoException).code !== "ENOENT";
    return { managed: malformed || (options.managedDefault ?? true), passwordVerifier: null,
      configurationError: malformed };
  }
}

/** Deliberately accepts neither query parameters nor the ordinary app token. */
export function serviceAdminToken(request?: RequestHeaders): string | null {
  const value = request?.headers[SERVICE_ADMIN_HEADER];
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");

interface ServiceAdminOptions {
  loadPolicy: () => ServiceAdminPolicy;
  now?: () => number;
  verifyPassword?: typeof verifyServiceAdminPassword;
}

export class ServiceAdminAuthority {
  private readonly options: ServiceAdminOptions;
  private readonly now: () => number;
  private readonly verify: typeof verifyServiceAdminPassword;
  private readonly sessions = new Map<string, { expiresAt: number; lastUsedAt: number }>();
  private attempts: number[] = [];
  private verifying = false;
  private policyFingerprint: string | null = null;
  private lastNow: number | null = null;

  constructor(options: ServiceAdminOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.verify = options.verifyPassword ?? verifyServiceAdminPassword;
  }

  private policy(): ServiceAdminPolicy {
    let policy: ServiceAdminPolicy;
    try {
      const value = this.options.loadPolicy();
      if (typeof value.managed !== "boolean" || (value.passwordVerifier !== null &&
        (typeof value.passwordVerifier !== "string" || !VERIFIER.test(value.passwordVerifier))) ||
        (value.configurationError !== undefined && typeof value.configurationError !== "boolean")) throw new Error();
      policy = { managed: value.managed, passwordVerifier: value.passwordVerifier, configurationError: value.configurationError === true };
    } catch { policy = { managed: true, passwordVerifier: null, configurationError: true }; }
    const next = fingerprint(JSON.stringify(policy));
    if (next !== this.policyFingerprint) {
      this.sessions.clear();
      this.policyFingerprint = next;
    }
    const now = this.now();
    if (this.lastNow !== null && now < this.lastNow) {
      this.sessions.clear();
      // Preserve the bounded throttle on clock rollback, without locking the
      // administrator out until an arbitrarily distant old timestamp returns.
      this.attempts = this.attempts.map(() => now);
    }
    this.lastNow = now;
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now || session.lastUsedAt + IDLE_MS <= now) this.sessions.delete(token);
    }
    return policy;
  }

  status(request?: RequestHeaders): ServiceAdminStatus {
    const policy = this.policy();
    const token = serviceAdminToken(request);
    const session = token ? this.sessions.get(fingerprint(token)) : null;
    const expiresAt = session ? Math.min(session.expiresAt, session.lastUsedAt + IDLE_MS) : null;
    return { managed: policy.managed, configured: Boolean(policy.passwordVerifier) && !policy.configurationError,
      authenticated: expiresAt !== null, expiresAt, configurationError: policy.configurationError === true };
  }

  authorize(request?: RequestHeaders): ServiceAdminGate {
    const status = this.status(request);
    if (!status.configured) return { ok: false, status: 403, error: "Service administrator access needs trusted provisioning." };
    if (!status.authenticated || status.expiresAt === null) return { ok: false, status: 401, error: "Service administrator sign-in is required." };
    const session = this.sessions.get(fingerprint(serviceAdminToken(request)!))!;
    session.lastUsedAt = this.now();
    return { ok: true, expiresAt: Math.min(session.expiresAt, session.lastUsedAt + IDLE_MS) };
  }

  async login(password: unknown): Promise<ServiceAdminLogin> {
    const policy = this.policy();
    if (!passwordValid(password)) throw new ServiceAdminError("Enter a valid administrator password.", 400);
    if (policy.configurationError || !policy.passwordVerifier) {
      throw new ServiceAdminError("Service administrator access needs trusted provisioning.", 403);
    }
    const now = this.now();
    this.attempts = this.attempts.filter(at => now - at < ATTEMPT_WINDOW_MS);
    if (this.attempts.length >= MAX_ATTEMPTS) {
      const seconds = Math.max(1, Math.ceil((this.attempts[0]! + ATTEMPT_WINDOW_MS - now) / 1000));
      throw new ServiceAdminError("Too many sign-in attempts. Try again later.", 429, seconds);
    }
    if (this.verifying) throw new ServiceAdminError("A sign-in check is in progress. Try again shortly.", 429, 1);
    this.attempts.push(now);
    this.verifying = true;
    const revision = this.policyFingerprint;
    try {
      let accepted = false;
      try { accepted = await this.verify(password, policy.passwordVerifier); } catch { /* deny without exposing verifier errors */ }
      this.policy();
      if (!accepted || revision !== this.policyFingerprint) throw new ServiceAdminError("Administrator sign-in did not match.", 401);
      const token = randomBytes(32).toString("hex");
      const expiresAt = this.now() + SESSION_MS;
      while (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
      this.sessions.set(fingerprint(token), { expiresAt, lastUsedAt: this.now() });
      const status = this.status({ headers: { [SERVICE_ADMIN_HEADER]: token } });
      return { token, expiresAt: status.expiresAt!, status };
    } finally { this.verifying = false; }
  }

  logout(request?: RequestHeaders): ServiceAdminStatus {
    const token = serviceAdminToken(request);
    if (token) this.sessions.delete(fingerprint(token));
    return this.status(request);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Classifies existing service-setting mutations, not business-source OAuth,
 * member preferences, human Stop, or ordinary paid operations. Entitlement
 * checks at actual provider/tool dispatch are a separate mandatory boundary.
 */
export function isPrivilegedServiceMutation(path: string, method: string, body?: unknown): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return false;
  if (/^\/api\/hermes(?:\/|$)/.test(path)) return true;
  if (/^\/api\/instances(?:\/|$)/.test(path)) return true;
  if (path === "/api/connected-apps/gmail-readonly/setup" || path === "/api/connected-apps/mode") return true;
  if (/^\/api\/channels\/(?:telegram|discord|slack)$/.test(path)) return true;
  if (/^\/api\/local-computer\/(?:pull|run|start|remove)$/.test(path)) return true;
  if (path === "/api/config") {
    if (!record(body)) return true;
    // Profile and voice choice remain normal preferences. No other section
    // can piggyback a credential or endpoint on that ordinary preference save.
    return Object.entries(body).some(([key, value]) => {
      if (key === "profile") return !record(value) || Object.keys(value).some(field => !["name", "email"].includes(field));
      if (key === "tts") return !record(value) || Object.keys(value).some(field => field !== "voice");
      return true;
    });
  }
  if (/^\/api\/bots\/[^/]+$/.test(path)) {
    return !record(body) || ["modelSelection", "model", "provider", "providerId", "apiKey", "baseUrl", "environment"].some(key => Object.hasOwn(body, key));
  }
  return false;
}

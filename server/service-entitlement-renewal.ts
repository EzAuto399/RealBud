/**
 * Automatic signed service grant for a linked computer.
 *
 * Authority: this computer's ACTIVE office link and service grant (the billing
 * owner approved it on realbud.app). With that, the app asks the managed
 * gateway it was provisioned against for its own signed desktop entitlement,
 * using its own connector credential, and installs it with the same verifier the
 * operator handoff uses (`installReceivedServiceBundle`). The trust anchor is
 * this build's pinned signer list (`shared/service-issuer-trust.ts`), never the
 * reply; signature, lifetime and the local company/host binding are checked as
 * well. A grant in force that lasts at least as long is never replaced.
 *
 * It asks only when the local grant is missing, expired or within 30 days of
 * expiry, and after a successful answer not again for 12 hours. A failure is a held state with fixed product copy and a delayed
 * retry, never a crash and never raw service text. No request, reply or grant
 * is logged; the log line names only the outcome.
 */
import { installReceivedServiceBundle } from "./service-entitlement-install.ts";
import { parseServiceGrantDelivery, SERVICE_GRANT_PATH, SERVICE_GRANT_REQUEST } from "../shared/office-link.ts";
import type { ServiceEntitlementStatus } from "../shared/service-entitlement.ts";
import type { PinnedServiceIssuer } from "../shared/service-issuer-trust.ts";

export const SERVICE_GRANT_RENEW_BEFORE_MS = 30 * 24 * 60 * 60_000;
/** After a failure the next ask waits this long (a refusal waits the longer one). */
export const SERVICE_GRANT_RETRY_MS = 5 * 60_000;
export const SERVICE_GRANT_REFUSED_RETRY_MS = 60 * 60_000;
/** After a successful answer that is not yet 30 days clear (the office's own
 * service ends sooner, or the grant was already current), ask again only this
 * much later: the gateway would return the same grant. */
export const SERVICE_GRANT_SETTLED_RETRY_MS = 12 * 60 * 60_000;
const TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 16_384;

export type ServiceGrantCode = "installed" | "current" | "held_unavailable" | "held_refused" | "held_invalid";
export interface ServiceGrantStatus { state: "idle" | "checking" | "ready" | "held"; code?: ServiceGrantCode; detail: string; nextAttemptAt?: number }

/** The only words a person sees. */
export const SERVICE_GRANT_COPY: Record<ServiceGrantCode, string> = {
  installed: "Service access is confirmed for this computer.",
  current: "Service access is confirmed for this computer.",
  held_unavailable: "RealBud couldn’t confirm this computer’s service access yet. It will try again automatically.",
  held_refused: "Your office’s RealBud service isn’t active for this computer. Contact RealBud support.",
  held_invalid: "RealBud received service access it couldn’t verify. Your files are kept; contact RealBud support.",
};

export interface ServiceGrantRenewalDeps {
  directory: string;
  /** Active provisioning on a linked, unrevoked office link. */
  active: () => Promise<boolean>;
  /** The managed connector this computer was provisioned with, or null. */
  connector: () => { endpoint: string; credential: string } | null;
  /** The local company/host binding written when the grant was applied. */
  binding: () => { companyId: string; hostInstallationId: string } | null;
  /** The local signed-grant state, as the app reads it. */
  entitlement: () => ServiceEntitlementStatus;
  fetch?: typeof fetch;
  now?: () => number;
  onInstalled?: () => void;
  log?: (message: string) => void;
  /** Tests only: the signer list to pin instead of this build's. */
  pinnedIssuers?: readonly PinnedServiceIssuer[];
}

class Held extends Error {
  readonly code: Extract<ServiceGrantCode, `held_${string}`>;
  readonly retryMs: number;
  constructor(code: Extract<ServiceGrantCode, `held_${string}`>, retryMs = SERVICE_GRANT_RETRY_MS) { super(code); this.code = code; this.retryMs = retryMs; }
}

/** An https origin, or plain http on loopback for local service rigs; the same
 * rule the connector endpoint was admitted under. */
function grantUrl(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Held("held_invalid"); }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Held("held_invalid");
  return `${url.origin}${SERVICE_GRANT_PATH}`;
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_REPLY_BYTES) throw new Held("held_invalid");
  try { return JSON.parse(text); } catch { throw new Held("held_invalid"); }
}

export function createServiceGrantRenewal(deps: ServiceGrantRenewalDeps) {
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetch ?? fetch;
  let current: ServiceGrantStatus = { state: "idle", detail: "" };
  let running: Promise<boolean> | null = null;
  let nextAttemptAt = 0;

  /** Whether the local grant already covers the next 30 days (or is not ours to fetch). */
  function covered(): boolean {
    const status = deps.entitlement();
    if (status.state === "unmanaged" || status.state === "not-required" || status.state === "not-yet-valid") return true;
    return status.state === "active" && status.expiresAt !== null && status.expiresAt - now() > SERVICE_GRANT_RENEW_BEFORE_MS;
  }

  async function run(force: boolean): Promise<boolean> {
    if (!(await deps.active())) { current = { state: "idle", detail: "" }; return false; }
    if (covered()) { current = { state: "ready", code: "current", detail: SERVICE_GRANT_COPY.current }; return false; }
    if (!force && now() < nextAttemptAt) return false;
    const connector = deps.connector(), binding = deps.binding();
    if (!connector || !binding) return false;
    current = { state: "checking", detail: "" };
    try {
      const url = grantUrl(connector.endpoint);
      let response: Response;
      try {
        response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { Authorization: `Bearer ${connector.credential}`, "Content-Type": "application/json" }, body: JSON.stringify(SERVICE_GRANT_REQUEST) });
      } catch { throw new Held("held_unavailable"); }
      if (response.status === 401 || response.status === 403 || response.status === 402) { await response.body?.cancel().catch(() => {}); throw new Held("held_refused", SERVICE_GRANT_REFUSED_RETRY_MS); }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Held("held_unavailable", response.status === 503 ? SERVICE_GRANT_REFUSED_RETRY_MS : SERVICE_GRANT_RETRY_MS); }
      let delivery;
      try { delivery = parseServiceGrantDelivery(await boundedJson(response), binding); } catch (error) { throw error instanceof Held ? error : new Held("held_invalid", SERVICE_GRANT_REFUSED_RETRY_MS); }
      // The link may have been released while the service answered.
      if (!(await deps.active())) { current = { state: "idle", detail: "" }; return false; }
      let installed;
      try {
        const input = { dataDirectory: deps.directory, bundle: delivery.bundle, expectedPublicKeySha256: delivery.publicKeySha256, now: now() };
        installed = await (deps.pinnedIssuers ? installReceivedServiceBundle(input, deps.pinnedIssuers) : installReceivedServiceBundle(input));
      }
      catch { throw new Held("held_invalid", SERVICE_GRANT_REFUSED_RETRY_MS); }
      // Settled: whatever the gateway had is installed or already here.
      nextAttemptAt = now() + SERVICE_GRANT_SETTLED_RETRY_MS;
      current = { state: "ready", code: installed.kept ? "current" : "installed", detail: SERVICE_GRANT_COPY[installed.kept ? "current" : "installed"] };
      deps.log?.(installed.kept ? "service grant already current" : "service grant installed");
      if (!installed.kept) { try { deps.onInstalled?.(); } catch { /* the grant is installed; readiness retries on its own */ } }
      return !installed.kept;
    } catch (error) {
      const held = error instanceof Held ? error : new Held("held_unavailable");
      nextAttemptAt = now() + held.retryMs;
      current = { state: "held", code: held.code, detail: SERVICE_GRANT_COPY[held.code], nextAttemptAt };
      deps.log?.(`service grant held (${held.code})`);
      return false;
    }
  }

  return {
    /** Serialized; a concurrent call joins the one in flight. `force` skips the
     * failure backoff (a fresh link). Resolves true when a new grant was installed. */
    ensure(options: { force?: boolean } = {}): Promise<boolean> {
      if (running) return running;
      running = run(options.force === true).finally(() => { running = null; });
      return running;
    },
    status(): ServiceGrantStatus { return { ...current }; },
  };
}

// Outbound installation reporting. No model credentials, work content or remote
// commands cross this boundary; a website link does not grant service access.
import { parseHermesVersion } from "./hermes-pin.ts";
import { oplog } from "./oplog.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileAtomic } from "./atomic.ts";
import { PREFLIGHT_STEPS, readServiceProvisioning, WORKER_MODEL_ENV_NAMES, type PreflightStep } from "./worker-model-access.ts";
import { workerModelAccessSnapshot } from "./hermes-runtime-env.ts";
import { windowsFilePrivacy } from "./windows-file-privacy.ts";
import { admitPrivateObject } from "./windows-private-admission.ts";
import { CONTACT_SUPPORT } from "../shared/support.ts";
import { currentUsagePeriod, isProvisioningSkipReasonText, isProvisioningSkipped, parseInstallationProvisioning, parseInstallationUsage, USAGE_PERIOD,
  type InstallationProvisioning, type InstallationUsageState } from "../shared/office-link.ts";
import { isLinkRequestInput, isLinkRequestIssued, isLinkStatus, type LinkCancelInput, type LinkRequestInput, type LinkStatus, type LinkStatusInput } from "../shared/installation-link.ts";
import { PrivateStorageError } from "./private-json.ts";
import { OFFICE_PACKS_MAX_BYTES, parseOfficePacks, type OfficePacksSource } from "../shared/customer-packs.ts";

/** The store a refused preflight step was admitting, in plain words. */
const PREFLIGHT_STORES: Record<PreflightStep, string> = {
  "prior record": "RealBud's saved service setup on this computer",
  vault: "RealBud's private key store on this computer",
  "profile folder": "Bud's private profile folder on this computer",
  "profile file": "a file in Bud's private profile on this computer",
  config: "Bud's profile settings on this computer",
  "data folder": "RealBud's data folder on this computer",
};
/** Why Windows refused a store, for the ACL refusals a person can act on. */
const WINDOWS_ACL_REASONS: Record<string, string> = {
  "grant-not-allowed": "another account on this computer can open it",
  "deny-rule-present": "a Windows rule blocks access to it",
  "owner-not-allowed": "it belongs to another account",
  "target-full-control-missing": "your Windows account can't fully control it",
  "inheritance-not-protected": "it takes its permissions from the folder above it",
  "target-reparse-point": "it is a shortcut to another location",
  "ancestor-reparse-point": "a folder above it is a shortcut to another location",
  "target-kind-mismatch": "it is not the kind of item RealBud expects there",
};
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const SAFE_CATEGORY = /^[a-z][a-z-]{0,39}$/;
/** The cause chain, outermost first, bounded so a cycle cannot loop. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let at = error; at !== undefined && at !== null && chain.length < 8 && !chain.includes(at); at = (at as { cause?: unknown }).cause) chain.push(at);
  return chain;
}
/**
 * A refused provisioning preflight as fixed product copy plus one log line.
 * Only a PrivateStorageError's message (plain and path-free by construction)
 * is ever repeated; a Windows ACL refusal is described from its category and
 * the step's store, never from its message; anything else keeps the generic
 * text. The log line holds the step, error names and the ACL token only.
 */
export function preflightRefusal(error: unknown): { message: string; log: { step: PreflightStep | "unknown"; errors: string; acl?: string } } {
  const chain = causeChain(error);
  const tagged = chain.map(item => (item as { preflightStep?: unknown }).preflightStep).find(value => value !== undefined);
  const step = PREFLIGHT_STEPS.find(value => value === tagged);
  const errors = chain.map(item => item instanceof Error && SAFE_NAME.test(item.name) ? item.name : "Error").join("<-");
  const windows = chain.find((item): item is Error & { category: unknown } => item instanceof Error && item.name === "WindowsFilePrivacyError");
  const category = typeof windows?.category === "string" && SAFE_CATEGORY.test(windows.category) ? windows.category : undefined;
  const log = { step: step ?? "unknown" as const, errors, ...(windows ? { acl: `[windows-acl:${category ?? "unknown"}]` } : {}) };
  const plain = chain.find((item): item is PrivateStorageError => item instanceof PrivateStorageError);
  if (plain) return { message: `${plain.message} Your work is kept.`, log };
  if (windows) {
    const store = step ? PREFLIGHT_STORES[step] : "RealBud's private storage on this computer";
    const reason = category ? WINDOWS_ACL_REASONS[category] : undefined;
    const said = reason ? `${store[0]!.toUpperCase()}${store.slice(1)} has Windows permissions RealBud can't use: ${reason}.`
      : `Windows couldn't check the permissions on ${store}.`;
    return { message: `${said} Your work is kept. ${CONTACT_SUPPORT} before trying office setup again.`, log };
  }
  return { message: "This computer's saved settings or private service storage need recovery. Your work is kept. Repair the local storage before retrying office setup.", log };
}

/** CLI diagnostics include local paths and update notices; only the product
 * version belongs in the website report. */
export function installationWorkerVersion(diagnostic: string | null | undefined): string | null {
  return parseHermesVersion(diagnostic ?? "").product ?? null;
}
const PRODUCTION_ORIGIN = "https://realbud.app";

/**
 * The website this installation reports to.
 *
 * A packaged production or managed build always talks to the real website: an
 * override there would move a customer's installation, subscription and model
 * access to somewhere the customer never chose. `REALBUD_WEBSITE_ORIGIN` is a
 * development/staging affordance only, and only for an https origin with no
 * path, query, fragment or embedded credentials. The local test lab
 * (`REALBUD_TEST_LAB=1`) may also use `http://127.0.0.1:<port>`.
 */
let originNoted = false;
const noteOnce = (detail: string): void => { if (originNoted) return; originNoted = true; oplog("boot", detail); };
export function websiteOrigin(env: NodeJS.ProcessEnv = process.env, note: (detail: string) => void = noteOnce): string {
  const raw = (env.REALBUD_WEBSITE_ORIGIN ?? "").trim();
  if (!raw) return PRODUCTION_ORIGIN;
  if (env.REALBUD_PRODUCTION === "1" || env.REALBUD_MANAGED_SERVICE === "1") {
    note("website origin override ignored on a production build");
    return PRODUCTION_ORIGIN;
  }
  let url: URL;
  try { url = new URL(raw); } catch { note("website origin override ignored: not a URL"); return PRODUCTION_ORIGIN; }
  // The local test lab runs the website fixture on loopback over plain http.
  // Only an explicit port on 127.0.0.1, only with the lab flag, and never on a
  // production or managed build (refused above).
  if (env.REALBUD_TEST_LAB === "1" && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") {
    note(`website origin override in use (test lab loopback): ${url.origin}`);
    return url.origin;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    note("website origin override ignored: not a plain https origin");
    return PRODUCTION_ORIGIN;
  }
  note(`website origin override in use: ${url.origin}`);
  return url.origin;
}

/** The website's own words for a refused link code, when they are one of the
 * sentences its redeem route sends (website app/api/installations/redeem).
 * Anything else is not shown, so arbitrary upstream text never reaches the screen. */
function websiteRedeemRefusal(body: unknown): { kind: "limit" | "refused"; message: string } | null {
  const message = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error.trim() : "";
  if (/^This office already has \d{1,3} computers\. Disconnect one to pair another\.$/.test(message)) return { kind: "limit", message };
  if (message === "The code is expired, already used, or unavailable. Ask your account owner for a new code.") return { kind: "refused", message };
  return null;
}

/** A saved pending approval has exactly the issued shape. Its own origin is
 * used here; which website it must match was checked when it was issued. */
function savedBrowserRequest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const saved = value as Record<string, unknown>;
  let origin: string;
  try { origin = new URL(String(saved.approvalUrl)).origin; } catch { return false; }
  return isLinkRequestIssued({ version: 1, purpose: "installation-link-issued", ...saved }, origin);
}

type Report = { appVersion: string; workerVersion: string | null; workerReady: boolean };
/** A browser approval this computer is waiting on. The approval URL is the
 * page the owner opens; the bearer token stays in `Saved.token` and never
 * leaves the server. */
export type BrowserLinkRequest = { approvalUrl: string; displayCode: string; expiresAt: string };
type Saved = { version: 1; id: string; token: string; label: string; code?: string; companyId?: string; agencyLabel?: string; revoked?: boolean; lastReportedAt?: string;
  /** When this computer learned the website no longer accepts it. */
  revokedAt?: string;
  /** Since when the website has said the office account is inactive. Nothing
   * is withdrawn; the next accepted report clears it. */
  officeInactiveAt?: string;
  /** A grant was applied for this link. Survives restart, so a repeated report
   * reply cannot re-apply provisioning that is already in force. */
  provisioned?: boolean;
  /** The website's stated reason for issuing no grant, from the latest reply
   * that said so. Cleared when a grant arrives. Absent in files written before
   * 25 September 2026, which read exactly as before. */
  provisioningSkipped?: string;
  /** Pending browser approval (no `code`, no `companyId`). One at a time. */
  browser?: BrowserLinkRequest };
/** What the renderer sees of a browser approval. Never carries the token. */
export type BrowserLinkView =
  | { state: "none" }
  | ({ state: "pending" } & BrowserLinkRequest)
  | { state: "linked"; agencyLabel: string }
  | { state: "expired" | "declined" };
export type OfficeLinkStatus = { state: "unlinked" | "pending" | "linked" | "revoked"; id?: string; label?: string; agencyLabel?: string; lastReportedAt?: string; revokedAt?: string; error?: string;
  /** Linked, but the website says the office account is inactive: check-ins
   * pause and resume by themselves. Nothing on this computer is removed. */
  officeInactive?: boolean;
  /** Present while a browser approval is pending, so the card resumes it. */
  browser?: BrowserLinkRequest;
  /** Linked only: a vendor grant (Bud's model access) is in force here. */
  provisioned?: boolean;
  /** Linked, no grant in force: the website's stated reason for issuing none
   * (`PROVISIONING_SKIP_REASONS` in shared/office-link.ts, or a newer one). */
  provisioningSkipped?: string;
  /** Vendor service access was withdrawn. Saved work records are unaffected. */
  serviceWithdrawn?: boolean;
  /** AI usage for the current month. In memory only; never saved to disk. */
  usage?: InstallationUsageState;
  /** Provisioned, but the model key is unusable: "missing" from the private
   * vault (redelivery is asked for), or "rejected" by the AI service. */
  modelKey?: "missing" | "rejected" };
/** Server-only capability. Never return this object through a renderer route. */
export type OfficeLinkCredentials = { installationId: string; token: string; companyId: string; agencyLabel: string };
/** Zero-touch provisioning sink. Supplied by the composition that owns the
 * protected private-state key; without it a provisioning reply is refused
 * rather than silently dropped. */
export interface OfficeLinkProvisioning {
  apply: (provisioning: InstallationProvisioning, installationId: string) => Promise<void>;
  withdraw: () => Promise<boolean>;
  /** A previous installation's withdrawal must not label a fresh office link.
   * With no link id, the retained marker still explains an unlinked computer. */
  withdrawn: (installationId?: string) => Promise<boolean>;
  /** Local configuration/storage admission before asking the website to issue
   * or rotate credentials. Throws a safe local-recovery explanation. */
  preflight?: (installationId: string) => Promise<void>;
  /** Notices a service administrator removing the installation binding, so the
   * grant is released on the ordinary status tick rather than at next use. */
  reconcile: () => Promise<boolean>;
  /** The model key env this grant resolves to, read from the private vault.
   * Absent, the running service's snapshot (what the relay sends) is used. */
  env?: () => Promise<Record<string, string>>;
  /** The person disconnected this computer: release without a withdrawn state. */
  clear: () => Promise<void>;
  /** Optional authority on whether a grant is already in force. Absent, the
   * link's own durable marker is used, and `apply` remains idempotent anyway. */
  active?: (installationId: string) => Promise<boolean>;
  /** A grant was applied and the link that carries it is now saved. Runs after
   * the durable save, never before, so a failed save changes nothing else. */
  onLinked?: () => void;
  /** Fetch and install this computer's signed service grant from the managed
   * gateway when it is missing or due for renewal
   * (`server/service-entitlement-renewal.ts`). Called after a successful link
   * and after every accepted report while a grant is in force, outside the link
   * lock; it throttles itself and never throws into the link. `force` skips its
   * failure backoff (a fresh link). */
  serviceGrant?: (options: { force?: boolean }) => Promise<unknown>;
}
/** Key id the AI service last refused (401/403) for this office, recorded by
 * the Ask model relay. In memory: the next refused request records it again
 * after a restart. Reported on check-in, never acted on locally: a key the
 * office revoked must stay revoked, so this never asks for a replacement. */
let rejectedModelKeyId: string | undefined;
export function noteModelKeyAnswer(keyId: string, accepted: boolean): void {
  if (!accepted) rejectedModelKeyId = keyId;
  else if (rejectedModelKeyId === keyId) rejectedModelKeyId = undefined;
}
/** The website's Retry-After on a 429 report, capped so a bad header cannot
 * silence check-ins for long; without one, wait a minute. */
const REPORT_RETRY_DEFAULT_MS = 60_000, REPORT_RETRY_CAP_MS = 60 * 60_000;
function retryAfterMs(header: string | null, now = Date.now()): number {
  const value = header?.trim() ?? "";
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - now : NaN;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), REPORT_RETRY_CAP_MS) : REPORT_RETRY_DEFAULT_MS;
}
/** A response body read up to `max` bytes; a longer one is cancelled and refused. */
async function boundedText(response: Response, max: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > max) { await response.body?.cancel().catch(() => {}); throw new Error("too large"); }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error("too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function createOfficeLink(options: { directory: string; appVersion: string; fetch?: typeof fetch; report: () => Promise<Report>; platform?: NodeJS.Platform; provisioning?: OfficeLinkProvisioning; origin?: string }) {
  const directory = join(options.directory, "office-link");
  const path = join(directory, "link.json");
  const fetcher = options.fetch ?? fetch;
  const ORIGIN = options.origin ?? websiteOrigin();
  let error: string | undefined;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reportRetryAt = 0;
  async function read(): Promise<Saved | null> {
    let st;
    try { st = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 4096 || (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))) throw new Error("The saved website link needs private-file recovery.");
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== "win32" && ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()))) throw new Error("The website link needs a private data directory.");
    await admitPrivateObject(directory, "directory", "RealBud's office link folder");
    await admitPrivateObject(path, "file", "RealBud's office link file");
    let saved: Saved;
    try { saved = JSON.parse(readFileSync(path, "utf8")) as Saved; }
    catch { throw new Error("The saved website link needs recovery."); }
    if (!saved || saved.version !== 1 || !/^[0-9a-f-]{36}$/i.test(saved.id) || !/^[a-f0-9]{64}$/.test(saved.token) || typeof saved.label !== "string" || saved.label.length > 80 || (saved.code !== undefined && !/^rb1_[a-f0-9]{64}$/.test(saved.code))) throw new Error("The saved website link needs recovery.");
    if (saved.browser !== undefined && (saved.code !== undefined || saved.companyId !== undefined || !savedBrowserRequest(saved.browser))) throw new Error("The saved website link needs recovery.");
    if (saved.provisioningSkipped !== undefined && !isProvisioningSkipReasonText(saved.provisioningSkipped)) throw new Error("The saved website link needs recovery.");
    return saved;
  }
  async function save(value: Saved) {
    const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()))) throw new Error("The website link needs a private data directory.");
    if (created) await windowsFilePrivacy(directory, "directory", true);
    else await admitPrivateObject(directory, "directory", "RealBud's office link folder");
    writeFileAtomic(path, JSON.stringify(value), 0o600);
    await windowsFilePrivacy(path, "file", true);
  }
  /**
   * AI usage for one month, at most one check per 30 seconds.
   *
   * Held in memory and never written to disk: it is a reporting convenience,
   * not a record, and the authoritative figures live in the account. A check
   * that still fails after its one retry is cached for the same interval, so a
   * portal outage cannot turn every status read into a wait.
   */
  const usageOwner = (saved: Saved) => `${saved.id}:${saved.token}:${saved.companyId ?? ""}`;
  let usageCache: { owner: string; period: string; at: number; value: InstallationUsageState } | undefined;
  const usagePending = new Map<string, Promise<InstallationUsageState>>();
  let lastUsageRefresh: { key: string; at: number } | undefined;
  const USAGE_TTL = 30_000;
  async function usage(period = currentUsagePeriod(), options?: { refresh?: boolean }): Promise<InstallationUsageState> {
    if (!USAGE_PERIOD.test(period)) throw Object.assign(new Error("Ask for a month as YYYY-MM."), { status: 400 });
    const saved = await read().catch(() => null);
    if (!saved?.companyId || saved.revoked) { usageCache = undefined; return { state: "not-linked" }; }
    const owner = usageOwner(saved), key = `${owner}:${period}`;
    const cached = usageCache?.owner === owner && usageCache.period === period ? usageCache : undefined;
    const pending = usagePending.get(key);
    if (pending) return pending;
    if (cached && Date.now() - cached.at < USAGE_TTL && (!options?.refresh ||
      (lastUsageRefresh?.key === key && Date.now() - lastUsageRefresh.at < 2_000))) return cached.value;
    if (options?.refresh) lastUsageRefresh = { key, at: Date.now() };
    // Keep the flight owned until its installation recheck and publication finish.
    // Manual checks join passive reads; neither can overwrite a newer office.
    const work = (async (): Promise<InstallationUsageState> => {
      let value: InstallationUsageState;
      try {
        const response = await readWithRetry(`usage?period=${period}`, { method: "GET", headers: { Authorization: `Bearer ${saved.token}` } });
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("usage unavailable"); }
        // Report owns revocation; a usage read must not tear down an install.
        value = { state: "ready", usage: parseInstallationUsage(await response.json(), period) };
      } catch { value = { state: "unavailable" }; }
      const current = await read().catch(() => null);
      if (!current?.companyId || current.revoked) return { state: "not-linked" };
      if (usageOwner(current) !== owner) return { state: "checking" };
      usageCache = { owner, period, at: Date.now(), value };
      return value;
    })();
    usagePending.set(key, work);
    try { return await work; }
    finally { if (usagePending.get(key) === work) usagePending.delete(key); }
  }

  /**
   * The packs this office uploaded on the website. Read-only and never saved:
   * the website is untrusted, so the envelope is checked here and every pack is
   * still admitted with a pinned signature before anyone can preview it.
   */
  async function officePacks(): Promise<OfficePacksSource> {
    const saved = await read().catch(() => null);
    if (!saved?.companyId || saved.revoked) return { state: "not-linked" };
    try {
      const response = await readWithRetry("packs", { method: "GET", headers: { Authorization: `Bearer ${saved.token}` } });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("packs unavailable"); }
      return { state: "ready", packs: parseOfficePacks(JSON.parse(await boundedText(response, OFFICE_PACKS_MAX_BYTES))) };
    } catch { return { state: "unavailable" }; }
  }

  async function refreshUsage(): Promise<OfficeLinkStatus> {
    await usage(currentUsagePeriod(), { refresh: true });
    return status();
  }

  async function status(): Promise<OfficeLinkStatus> {
    const saved = await read();
    // The withdrawn marker outlives the link record: a computer whose service
    // access was taken away must still say so after the link is discarded.
    const serviceWithdrawn = await options.provisioning?.withdrawn(saved?.id).catch(() => false);
    const withdrawn = serviceWithdrawn ? { serviceWithdrawn: true as const } : {};
    // Status stays a local read: a due refresh runs in the background and the
    // next status carries it, so the card never waits on the website.
    const period = currentUsagePeriod();
    let usageState: InstallationUsageState;
    if (!saved?.companyId || saved.revoked) { usageState = { state: "not-linked" }; usageCache = undefined; }
    else if (usageCache?.owner === usageOwner(saved) && usageCache.period === period && Date.now() - usageCache.at < USAGE_TTL) usageState = usageCache.value;
    else { usageState = usageCache?.owner === usageOwner(saved) && usageCache.period === period ? usageCache.value : { state: "checking" }; void usage(period).catch(() => {}); }
    const browser = saved?.browser && !saved.revoked ? { browser: saved.browser } : {};
    // The grant's own authority when there is one: a grant already in force is
    // not re-applied, so the link's marker alone can read false.
    const provisioned = saved?.companyId && !saved.revoked
      ? { provisioned: await provisioningActive(saved) } : {};
    // A stated reason is only news while no grant is in force.
    const skipped = provisioned.provisioned === false && saved?.provisioningSkipped ? { provisioningSkipped: saved.provisioningSkipped } : {};
    const issue = provisioned.provisioned ? (await modelKeyHealth(saved!.id)).issue : undefined;
    const modelKey = issue ? { modelKey: issue } : {};
    return saved ? { state: saved.revoked ? "revoked" : saved.companyId ? "linked" : "pending", id: saved.id, label: saved.label, agencyLabel: saved.agencyLabel, lastReportedAt: saved.lastReportedAt, ...(saved.revoked && saved.revokedAt ? { revokedAt: saved.revokedAt } : {}), ...(saved.companyId && !saved.revoked && saved.officeInactiveAt ? { officeInactive: true } : {}), usage: usageState, ...browser, ...provisioned, ...skipped, ...modelKey, ...withdrawn, ...(error ? { error } : {}) } : { state: "unlinked", usage: usageState, ...withdrawn };
  }
  /** Reads the website answers from its own records. */
  const REQUEST_TIMEOUT_MS = 10_000;
  /** Redeem and report may carry provisioning: behind them the website checks
   * the gateway's health and readiness and then has it mint at Modelvia and
   * Composio, each vendor call bounded at 30 s. A shorter wait here abandoned
   * a reply the website had already recorded as delivered. */
  const PROVISIONING_TIMEOUT_MS = 60_000;
  async function request(route: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    try { return await fetcher(`${ORIGIN}/api/installations/${route}`, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { "Content-Type": "application/json", ...init.headers } }); }
    catch { throw new Error("The website could not be reached. Check this computer’s internet connection, then try again."); }
  }
  /**
   * A read that is safe to repeat gets one more try, shortly after, when the
   * connection failed or the website answered 5xx. Only reads use this: GET
   * reads and the link-request status check (a POST that changes nothing).
   * Redeem, report and creating a link request are writes whose outcome a
   * blind repeat could double.
   */
  const READ_RETRY_DELAY_MS = 750;
  async function readWithRetry(route: string, init: RequestInit & { method: "GET" | "POST" }): Promise<Response> {
    try {
      const response = await request(route, init);
      if (response.status < 500) return response;
      await response.body?.cancel().catch(() => {});
    } catch { /* retried once below */ }
    await sleep(READ_RETRY_DELAY_MS);
    return request(route, init);
  }
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw Object.assign(new Error("A website link update is already running. Try again shortly."), { status: 409 });
    busy = true;
    try { const result = await work(); error = undefined; return result; }
    catch (e) { error = e instanceof Error ? e.message : "The website link could not be updated."; throw e; }
    finally { busy = false; }
  }
  /** One admission path for a grant, whichever reply carried it. */
  async function applyProvisioning(provisioning: InstallationProvisioning, saved: Saved, companyId: string) {
    if (provisioning.service.companyId !== companyId) throw new Error("The website returned service setup for a different office. Retry the same code.");
    if (!options.provisioning) throw new Error("This version of RealBud cannot finish automatic service setup. Update RealBud and retry the same code.");
    await options.provisioning.apply(provisioning, saved.id);
  }

  async function provisioningActive(saved: Saved): Promise<boolean> {
    return options.provisioning?.active
      ? options.provisioning.active(saved.id).catch(() => false)
      : saved.provisioned === true;
  }
  /** For a grant on record: the non-secret id of its model key, so the website
   * can flag a computer running on a key not issued for it (never the key
   * itself), or why it cannot be used. The record alone is not a usable key:
   * "missing" when the vault no longer yields it (deleted, profile restored). */
  async function modelKeyHealth(installationId: string): Promise<{ keyId?: string; issue?: "missing" | "rejected" }> {
    const record = await readServiceProvisioning(options.directory).catch(() => undefined);
    if (!options.provisioning || record?.state !== "active" || record.installationId !== installationId) return {};
    const env = options.provisioning.env ? await options.provisioning.env().catch(() => ({} as Record<string, string>)) : workerModelAccessSnapshot();
    if (!env[WORKER_MODEL_ENV_NAMES[0]]) return { issue: "missing" };
    return rejectedModelKeyId === record.keyId ? { keyId: record.keyId, issue: "rejected" } : { keyId: record.keyId };
  }
  let lastPreflightLog = "";
  async function preflightProvisioning(installationId: string) {
    try { await options.provisioning?.preflight?.(installationId); }
    catch (error) {
      // Local recovery errors may contain paths or credential-bearing parser
      // text, so the message and the log line are built by preflightRefusal.
      const { message, log } = preflightRefusal(error);
      // Reports retry on a timer: log a refusal when it changes, not each time.
      const signature = JSON.stringify(log);
      if (signature !== lastPreflightLog) { lastPreflightLog = signature; oplog("storage", "Office setup stopped at a local storage check.", log); }
      throw Object.assign(new Error(message), { status: 503, code: "service_provisioning_local_recovery" });
    }
    lastPreflightLog = "";
  }

  async function link(input: { code?: unknown; label?: unknown }) {
    await exclusive(async () => {
      input = input && typeof input === "object" ? input : {};
      const code = typeof input.code === "string" ? input.code.trim() : "";
      const label = typeof input.label === "string" ? input.label.trim() : "";
      if (!/^rb1_[a-f0-9]{64}$/.test(code) || !label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw Object.assign(new Error("This link code could not be used. Paste the whole code your office sent you into Link code, then choose Connect with this code."), { status: 400 });
      let saved = await read();
      if (saved?.companyId && !saved.revoked) throw Object.assign(new Error("Disconnect the current website link before linking another office."), { status: 409 });
      if (saved?.browser && !saved.revoked) throw Object.assign(new Error("Cancel the browser approval before using a link code."), { status: 409 });
      if (saved?.code && saved.code !== code && !saved.revoked) throw Object.assign(new Error("This computer is still finishing the first code you pasted. Paste that same code again to finish. If it has expired, you can then use a new one."), { status: 409 });
      // The revoked link is the durable cleanup signal. Keep it until the old
      // grant is released, including after a restart or a failed withdrawal.
      if (saved?.revoked) await options.provisioning?.withdraw();
      // Persist the token before making a request. Repeating this code after a
      // lost response redeems the identical id/token, never a second device.
      if (!saved || saved.revoked || saved.code !== code) {
        saved = { version: 1, id: randomUUID(), token: randomBytes(32).toString("hex"), label, code };
        await preflightProvisioning(saved.id);
        await save(saved);
      } else await preflightProvisioning(saved.id);
      const response = await request("redeem", { method: "POST", body: JSON.stringify({ code, id: saved.id, token: saved.token, label: saved.label, platform: options.platform ?? process.platform, appVersion: options.appVersion }) }, PROVISIONING_TIMEOUT_MS);
      if (response.status === 409) {
        const said = websiteRedeemRefusal(await response.json().catch(() => null));
        // The office is at its computer limit: nothing was created, so the code
        // and this computer's identity are kept for a retry once the owner
        // frees a place.
        if (said?.kind === "limit") throw Object.assign(new Error(`${said.message} Your code is kept: once your account owner disconnects a computer under Account → Computers on realbud.app, try this same code again.`), { status: 409, code: "installation_limit" });
        // Otherwise the website refused this code for good: expired, or used
        // (elsewhere, or here by a reply lost past its replay window). Revoke
        // the token in case that lost reply created an installation, then
        // forget the code so a fresh code or the browser link can start. Any
        // other failure keeps it.
        await revokeQuietly(saved.token);
        unlinkSync(path);
        throw Object.assign(new Error(said?.message ?? "This code is expired or already used. Get a new code from your account owner, then paste it here."), { status: 409, code: "link_code_refused" });
      }
      if (!response.ok) throw new Error("The website could not finish linking this computer. Try again shortly.");
      const result = await response.json().catch(() => null) as { companyId?: unknown; agencyLabel?: unknown; installationId?: unknown; provisioning?: unknown } | null;
      if (!result || result.installationId !== saved.id || typeof result.companyId !== "string" || !result.companyId || result.companyId.length > 200 || typeof result.agencyLabel !== "string" || result.agencyLabel.length > 200) throw new Error("The website returned an incomplete link. Retry the same code.");
      // Vendor provisioning, when present, is applied before the link is
      // recorded: a computer must never read as linked while still missing the
      // service access that reply carried. Retrying the code repeats it safely.
      // A stated skip is recorded with the link, so the card can say why.
      const outcome = parseInstallationProvisioning(result.provisioning);
      const provisioning = isProvisioningSkipped(outcome) ? undefined : outcome;
      if (provisioning) await applyProvisioning(provisioning, saved, result.companyId);
      delete saved.code;
      await save({ ...saved, companyId: result.companyId, agencyLabel: result.agencyLabel, ...(provisioning ? { provisioned: true } : {}),
        ...(isProvisioningSkipped(outcome) ? { provisioningSkipped: outcome.skipped } : {}) });
      if (provisioning) linked();
    });
    if (await grantInForce()) serviceGrant(true);
  }
  function linked() { try { options.provisioning?.onLinked?.(); } catch { /* the link is saved; the hook retries on its own schedule */ } }
  async function grantInForce(): Promise<boolean> {
    const saved = await read().catch(() => null);
    if (!saved?.companyId || saved.revoked) return false;
    return provisioningActive(saved);
  }
  function serviceGrant(force: boolean) {
    try { void options.provisioning?.serviceGrant?.({ force })?.catch(() => {}); } catch { /* held inside the hook */ }
  }

  // ── Linking through the browser (shared/installation-link.ts) ──────────
  const unreachable = () => Object.assign(new Error("The website could not be reached. Check this computer’s internet connection, then try again."), { status: 503, code: "website_unreachable" });
  const viewOf = (saved: Saved | null): BrowserLinkView =>
    saved?.companyId && !saved.revoked ? { state: "linked", agencyLabel: saved.agencyLabel ?? "" }
      : saved?.browser && !saved.revoked ? { state: "pending", ...saved.browser } : { state: "none" };
  /**
   * Revoke a token this computer is about to discard. If the owner approved it
   * just before it was cancelled or replaced, the website removes that
   * installation; otherwise it answers 401. Best effort: being offline must not
   * trap anyone in a request they are abandoning, and an unapproved request
   * expires on the website by itself.
   */
  async function revokeQuietly(token: string) {
    try { const response = await request("report", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }); await response.body?.cancel().catch(() => {}); }
    catch { /* offline */ }
  }
  /**
   * Ask the website for an approval page. The id and token are generated
   * exactly as redeem generates them; the website keeps only the token's hash.
   * The request is created once and never repeated blindly: a lost reply leaves
   * an unapproved request nobody can see, which expires by itself.
   */
  async function beginBrowserLink(input: { label?: unknown }): Promise<BrowserLinkRequest> {
    return exclusive(async () => {
      input = input && typeof input === "object" ? input : {};
      const label = typeof input.label === "string" ? input.label.trim() : "";
      if (!label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw Object.assign(new Error("Name this computer in 80 characters or fewer."), { status: 400 });
      const saved = await read();
      if (saved?.companyId && !saved.revoked) throw Object.assign(new Error("Disconnect the current website link before linking another office."), { status: 409 });
      if (saved?.code && !saved.revoked) throw Object.assign(new Error("This computer is still finishing a link code. Paste that same code in the Link code box to finish. If it has expired, you can then connect here."), { status: 409 });
      if (saved?.revoked) await options.provisioning?.withdraw();
      if (saved?.browser && !saved.revoked) {
        // One pending request at a time: an unexpired one is resumed, never duplicated.
        if (Date.parse(saved.browser.expiresAt) > Date.now()) return saved.browser;
        await revokeQuietly(saved.token);
      }
      const body: LinkRequestInput = { version: 1, purpose: "installation-link-request", id: randomUUID(), token: randomBytes(32).toString("hex"),
        label, platform: (options.platform ?? process.platform) as LinkRequestInput["platform"], appVersion: options.appVersion };
      if (!isLinkRequestInput(body)) throw Object.assign(new Error("This computer cannot be linked in the browser. Use a link code instead."), { status: 400 });
      await preflightProvisioning(body.id);
      const response = await request("link-requests", { method: "POST", body: JSON.stringify(body) }).catch(() => { throw unreachable(); });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status >= 500) throw unreachable();
        throw Object.assign(new Error("The website did not accept this link request. Try again, or use a link code instead."), { status: 502 });
      }
      const reply: unknown = await response.json().catch(() => null);
      if (!isLinkRequestIssued(reply, ORIGIN)) throw Object.assign(new Error("The website returned an approval page this computer will not open. Nothing was linked."), { status: 502 });
      const browser: BrowserLinkRequest = { approvalUrl: reply.approvalUrl, displayCode: reply.displayCode, expiresAt: reply.expiresAt };
      await save({ version: 1, id: body.id, token: body.token, label, browser });
      return browser;
    });
  }
  /**
   * Ask whether the owner has approved. On approval the link is stored exactly
   * as a successful redeem stores it, then the ordinary report starts once so
   * model access and the connector arrive through the report path; approval
   * itself carries no credential. The answer does not wait for that report:
   * status shows `provisioned`, `lastReportedAt` or `error` once it settles.
   * Expired and declined requests are cleared so a new one can start.
   */
  async function browserLinkStatus(): Promise<BrowserLinkView> {
    const current = await read();
    if (!current?.browser || current.companyId || current.revoked) return viewOf(current);
    // Another link update holds the record; answer from it and ask next poll.
    if (busy) return viewOf(current);
    let linked = false;
    const view = await exclusive(async (): Promise<BrowserLinkView> => {
      const saved = await read();
      if (!saved?.browser || saved.companyId || saved.revoked) return viewOf(saved);
      const input: LinkStatusInput = { version: 1, purpose: "installation-link-status", id: saved.id };
      const response = await readWithRetry("link-requests/status", { method: "POST", headers: { Authorization: `Bearer ${saved.token}` }, body: JSON.stringify(input) })
        .catch(() => { throw unreachable(); });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status >= 500) throw unreachable();
        throw Object.assign(new Error("The website could not check this approval. Try again, or cancel and start again."), { status: 502 });
      }
      const reply: unknown = await response.json().catch(() => null);
      if (!isLinkStatus(reply)) throw Object.assign(new Error("The website returned an answer this computer cannot use. Try again shortly."), { status: 502 });
      if (reply.state === "pending") return viewOf(saved);
      if (reply.state === "linked") {
        if (reply.installationId !== saved.id) throw Object.assign(new Error("The website answered for a different computer. Nothing was linked; cancel and start again."), { status: 502 });
        linked = true;
        return keepApproved(saved, reply);
      }
      unlinkSync(path);
      return { state: reply.state };
    });
    // A missed report must not hide the stored link; the periodic report retries it.
    if (linked) void report().catch(() => {});
    return view;
  }
  /** The owner approved: store the link exactly as a successful redeem stores it. */
  async function keepApproved(saved: Saved, reply: Extract<LinkStatus, { state: "linked" }>): Promise<BrowserLinkView> {
    const { browser: _approved, ...rest } = saved;
    await save({ ...rest, companyId: reply.companyId, agencyLabel: reply.agencyLabel });
    return { state: "linked", agencyLabel: reply.agencyLabel };
  }
  /**
   * Tell the website this computer is abandoning its request, so the owner can
   * no longer approve it. One attempt within the ordinary request timeout, never
   * repeated. The website's status answer, or `unreachable` when no request
   * reached it, or `null` when it answered without a usable status.
   */
  async function cancelOnWebsite(saved: Saved): Promise<LinkStatus | "unreachable" | null> {
    const input: LinkCancelInput = { version: 1, purpose: "installation-link-cancel", id: saved.id };
    let response: Response;
    try { response = await request("link-requests/cancel", { method: "POST", headers: { Authorization: `Bearer ${saved.token}` }, body: JSON.stringify(input) }); }
    catch { return "unreachable"; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
    const reply: unknown = await response.json().catch(() => null);
    return isLinkStatus(reply) ? reply : null;
  }
  /**
   * Cancel a waiting approval. The request is forgotten on this computer
   * whatever the website answers, so being offline never traps anyone in it.
   * If the owner approved before the cancel arrived, the website says linked
   * and the link is kept exactly as a status poll keeps it. If the website
   * answered without saying which (an older website, an error), the token is
   * revoked as before, in case an approval landed that this computer cannot see.
   */
  async function cancelBrowserLink(): Promise<BrowserLinkView> {
    let linked = false;
    const view = await exclusive(async (): Promise<BrowserLinkView> => {
      const saved = await read();
      if (!saved?.browser || saved.companyId || saved.revoked) return viewOf(saved);
      const reply = await cancelOnWebsite(saved);
      const approved = reply !== "unreachable" && reply?.state === "linked" ? reply : null;
      if (approved?.installationId === saved.id) { linked = true; return keepApproved(saved, approved); }
      // No usable answer, or a linked answer for another computer.
      if (reply === null || approved) await revokeQuietly(saved.token);
      unlinkSync(path);
      return { state: "none" };
    });
    if (linked) void report().catch(() => {});
    return view;
  }

  async function report() {
    if (busy) return;
    let accepted = false, fresh = false;
    await exclusive(async () => {
      const saved = await read();
      // A prior cleanup failure must retry before reconciliation can publish
      // active access again, including after a service restart.
      if (saved?.revoked) { await options.provisioning?.withdraw(); return; }
      await options.provisioning?.reconcile();
      if (!saved?.companyId) return;
      const report = await options.report();
      // Say so when this link holds no grant. If the website already recorded
      // one, its secret-bearing reply was lost on the way here; the website then
      // has this installation's own credentials replaced and sends them back.
      // Never asked while a grant is in force: that would rotate a working key.
      // A grant whose key the vault no longer holds (deleted, profile restored)
      // is asked for again like a missing grant. A key the AI service rejected
      // is only reported: the office may have revoked it on purpose.
      const active = await provisioningActive(saved);
      const key = active ? await modelKeyHealth(saved.id) : {};
      let needsProvisioning = options.provisioning !== undefined && !active;
      // A report for a never-provisioned row can mint credentials even without
      // needsProvisioning. Hold the whole request on a known local failure;
      // the ordinary timer retries this local check without rotating keys.
      // Already-active installations still report and observe revocation, so a
      // missing key is asked for only once local storage can take delivery.
      if (needsProvisioning) await preflightProvisioning(saved.id);
      const replaceKey = key.issue === "missing" && await preflightProvisioning(saved.id).then(() => true, () => false);
      if (replaceKey) needsProvisioning = true;
      const body = { ...report, ...(needsProvisioning ? { needsProvisioning: true } : {}), ...(key.keyId ? { modelKeyId: key.keyId } : {}),
        ...(key.issue === "rejected" ? { modelKeyRejected: true } : {}) };
      // The website asked this computer to slow down: no request until then.
      if (Date.now() < reportRetryAt) throw new Error("The website asked this computer to wait before reporting again. Your local work can continue.");
      const response = await request("report", { method: "POST", headers: { Authorization: `Bearer ${saved.token}` },
        body: JSON.stringify(body) }, PROVISIONING_TIMEOUT_MS);
      // 401/403 is the website saying this installation's access is gone. Stop
      // using the vendor grant immediately; every saved work record is kept.
      if (response.status === 401 || response.status === 403) {
        try { await save({ ...saved, revoked: true, revokedAt: new Date().toISOString() }); }
        finally { await options.provisioning?.withdraw(); }
        return;
      }
      // 423 office_inactive: this computer is still valid but the office account
      // is not active (owner or subscription). Pause, keep the grant and link,
      // and let the ordinary timer check in again. Spend is the gateway's call.
      if (response.status === 423) {
        const answer = await response.json().catch(() => null) as { error?: unknown } | null;
        if (answer?.error === "office_inactive") {
          if (!saved.officeInactiveAt) await save({ ...saved, officeInactiveAt: new Date().toISOString() });
          throw new Error("Your office’s RealBud account is inactive, so this computer can’t check in. Nothing was removed; it reconnects by itself once the account is active again.");
        }
      }
      if (response.status === 429) {
        reportRetryAt = Date.now() + retryAfterMs(response.headers.get("retry-after"));
        await response.body?.cancel().catch(() => {});
        throw new Error("The website asked this computer to wait before reporting again. Your local work can continue.");
      }
      if (!response.ok) throw new Error("The website did not accept the latest status. Your local work can continue.");
      // The portal retries provisioning here on every check-in until it has
      // minted once, so a computer skipped at redeem (setup unfinished on the
      // account) picks its grant up as soon as support finishes setup; after
      // that it redelivers only when asked above. A grant
      // already in force is left alone: re-applying would replace a live
      // revocable key with whatever this reply happened to carry.
      let provisioned = active && !replaceKey;
      let newlyApplied = false;
      // An accepted report also ends any "office inactive" pause.
      const { provisioningSkipped: previous, officeInactiveAt: _inactive, ...rest } = saved;
      let skipped = previous;
      if (!provisioned) {
        const body = await response.json().catch(() => null) as { provisioning?: unknown } | null;
        const outcome = parseInstallationProvisioning(body?.provisioning);
        if (isProvisioningSkipped(outcome)) skipped = outcome.skipped;
        else if (outcome) {
          // A grant has arrived: whatever the website said before no longer holds.
          skipped = undefined;
          const already = await provisioningActive(saved);
          if (!already || replaceKey) { await applyProvisioning(outcome, saved, saved.companyId!); provisioned = true; newlyApplied = true; }
        }
      }
      await save({ ...rest, lastReportedAt: new Date().toISOString(), provisioned, ...(skipped && !provisioned ? { provisioningSkipped: skipped } : {}) });
      if (newlyApplied) linked();
      accepted = true; fresh = newlyApplied;
    });
    // Outside the link lock: a slow service must never hold the next report.
    if (accepted && await grantInForce()) serviceGrant(fresh);
  }
  async function disconnect() {
    return exclusive(async () => {
      const saved = await read(); if (!saved) return;
      // Even a pending link might have been redeemed before its response was
      // lost; revoke the saved token before discarding it locally.
      if (!saved.revoked) {
        const response = await request("report", { method: "DELETE", headers: { Authorization: `Bearer ${saved.token}` } });
        if (!response.ok && response.status !== 401) throw new Error("The website link could not be revoked. Try again when connected.");
      }
      // Release the vendor grant with the link. The model key and broker
      // credential are useless to a disconnected computer; records stay.
      await options.provisioning?.clear();
      unlinkSync(path);
    });
  }
  return { status, link, report, disconnect, usage, refreshUsage, officePacks, beginBrowserLink, browserLinkStatus, cancelBrowserLink,
    /** Internal launch gate, including a grant applied during pending linking.
     * A stale async vault read cannot republish access after revoke/relink. */
    async modelAccessEnv(resolve: () => Promise<Record<string, string>>): Promise<Record<string, string>> {
      const saved = await read();
      if (!saved || saved.revoked) return {};
      if (options.provisioning?.active && !(await provisioningActive(saved))) return {};
      const access = await resolve();
      const current = await read();
      return current && !current.revoked && current.id === saved.id && current.token === saved.token &&
        (!options.provisioning?.active || await provisioningActive(current)) ? access : {};
    },
    async credentials(): Promise<OfficeLinkCredentials | null> {
      const saved = await read();
      return saved?.companyId && !saved.revoked ? { installationId: saved.id, token: saved.token, companyId: saved.companyId, agencyLabel: saved.agencyLabel ?? "" } : null;
    },
    start() { if (timer) return; const tick = () => { void report().catch(() => {}); }; tick(); timer = setInterval(tick, 5 * 60_000); timer.unref(); },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}

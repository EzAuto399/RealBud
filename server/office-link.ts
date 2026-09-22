// Outbound installation reporting. No model credentials, work content or remote
// commands cross this boundary; a website link does not grant service access.
import { parseHermesVersion } from "./hermes-pin.ts";
import { oplog } from "./oplog.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileAtomic } from "./atomic.ts";
import { windowsFilePrivacy } from "./windows-file-privacy.ts";
import { currentUsagePeriod, parseInstallationProvisioning, parseInstallationUsage, USAGE_PERIOD,
  type InstallationProvisioning, type InstallationUsageState } from "../shared/office-link.ts";
import { isLinkRequestInput, isLinkRequestIssued, isLinkStatus, type LinkCancelInput, type LinkRequestInput, type LinkStatus, type LinkStatusInput } from "../shared/installation-link.ts";

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
  /** A grant was applied for this link. Survives restart, so a repeated report
   * reply cannot re-apply provisioning that is already in force. */
  provisioned?: boolean;
  /** Pending browser approval (no `code`, no `companyId`). One at a time. */
  browser?: BrowserLinkRequest };
/** What the renderer sees of a browser approval. Never carries the token. */
export type BrowserLinkView =
  | { state: "none" }
  | ({ state: "pending" } & BrowserLinkRequest)
  | { state: "linked"; agencyLabel: string }
  | { state: "expired" | "declined" };
export type OfficeLinkStatus = { state: "unlinked" | "pending" | "linked" | "revoked"; id?: string; label?: string; agencyLabel?: string; lastReportedAt?: string; error?: string;
  /** Present while a browser approval is pending, so the card resumes it. */
  browser?: BrowserLinkRequest;
  /** Linked only: a vendor grant (Bud's model access) is in force here. */
  provisioned?: boolean;
  /** Vendor service access was withdrawn. Saved work records are unaffected. */
  serviceWithdrawn?: boolean;
  /** AI usage for the current month. In memory only; never saved to disk. */
  usage?: InstallationUsageState };
/** Server-only capability. Never return this object through a renderer route. */
export type OfficeLinkCredentials = { installationId: string; token: string; companyId: string; agencyLabel: string };
/** Zero-touch provisioning sink. Supplied by the composition that owns the
 * protected private-state key; without it a provisioning reply is refused
 * rather than silently dropped. */
export interface OfficeLinkProvisioning {
  apply: (provisioning: InstallationProvisioning, installationId: string) => Promise<void>;
  withdraw: () => Promise<boolean>;
  withdrawn: () => Promise<boolean>;
  /** Notices a service administrator removing the installation binding, so the
   * grant is released on the ordinary status tick rather than at next use. */
  reconcile: () => Promise<boolean>;
  /** The person disconnected this computer: release without a withdrawn state. */
  clear: () => Promise<void>;
  /** Optional authority on whether a grant is already in force. Absent, the
   * link's own durable marker is used, and `apply` remains idempotent anyway. */
  active?: () => Promise<boolean>;
}
export function createOfficeLink(options: { directory: string; appVersion: string; fetch?: typeof fetch; report: () => Promise<Report>; platform?: NodeJS.Platform; provisioning?: OfficeLinkProvisioning; origin?: string }) {
  const directory = join(options.directory, "office-link");
  const path = join(directory, "link.json");
  const fetcher = options.fetch ?? fetch;
  const ORIGIN = options.origin ?? websiteOrigin();
  let error: string | undefined;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  async function read(): Promise<Saved | null> {
    let st;
    try { st = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 4096 || (process.platform !== "win32" && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))) throw new Error("The saved website link needs private-file recovery.");
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== "win32" && ((parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()))) throw new Error("The website link needs a private data directory.");
    await windowsFilePrivacy(directory, "directory");
    await windowsFilePrivacy(path, "file");
    let saved: Saved;
    try { saved = JSON.parse(readFileSync(path, "utf8")) as Saved; }
    catch { throw new Error("The saved website link needs recovery."); }
    if (!saved || saved.version !== 1 || !/^[0-9a-f-]{36}$/i.test(saved.id) || !/^[a-f0-9]{64}$/.test(saved.token) || typeof saved.label !== "string" || saved.label.length > 80 || (saved.code !== undefined && !/^rb1_[a-f0-9]{64}$/.test(saved.code))) throw new Error("The saved website link needs recovery.");
    if (saved.browser !== undefined && (saved.code !== undefined || saved.companyId !== undefined || !savedBrowserRequest(saved.browser))) throw new Error("The saved website link needs recovery.");
    return saved;
  }
  async function save(value: Saved) {
    const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (process.platform !== "win32" && ((dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()))) throw new Error("The website link needs a private data directory.");
    await windowsFilePrivacy(directory, "directory", !!created);
    writeFileAtomic(path, JSON.stringify(value), 0o600);
    await windowsFilePrivacy(path, "file", true);
  }
  /**
   * AI usage for one month, at most one check per three minutes.
   *
   * Held in memory and never written to disk: it is a reporting convenience,
   * not a record, and the authoritative figures live in the account. A check
   * that still fails after its one retry is cached for the same interval, so a
   * portal outage cannot turn every status read into a wait.
   */
  let usageCache: { period: string; at: number; value: InstallationUsageState } | undefined;
  let usageBusy = false;
  const USAGE_TTL = 3 * 60_000;
  async function usage(period = currentUsagePeriod()): Promise<InstallationUsageState> {
    if (!USAGE_PERIOD.test(period)) throw Object.assign(new Error("Ask for a month as YYYY-MM."), { status: 400 });
    const saved = await read().catch(() => null);
    if (!saved?.companyId || saved.revoked) { usageCache = undefined; return { state: "not-linked" }; }
    if (usageCache && usageCache.period === period && Date.now() - usageCache.at < USAGE_TTL) return usageCache.value;
    if (usageBusy) return usageCache?.period === period ? usageCache.value : { state: "checking" };
    usageBusy = true;
    let value: InstallationUsageState;
    try {
      const response = await readWithRetry(`usage?period=${period}`, { method: "GET", headers: { Authorization: `Bearer ${saved.token}` } });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("usage unavailable"); }
      // 401/403 is not treated as revocation here: the report loop is the
      // authority for that, and a usage read must not tear down an install.
      value = { state: "ready", usage: parseInstallationUsage(await response.json(), period) };
    } catch { value = { state: "unavailable" }; }
    finally { usageBusy = false; }
    usageCache = { period, at: Date.now(), value };
    return value;
  }

  async function status(): Promise<OfficeLinkStatus> {
    const saved = await read();
    // The withdrawn marker outlives the link record: a computer whose service
    // access was taken away must still say so after the link is discarded.
    const serviceWithdrawn = await options.provisioning?.withdrawn().catch(() => false);
    const withdrawn = serviceWithdrawn ? { serviceWithdrawn: true as const } : {};
    // Status stays a local read: a due refresh runs in the background and the
    // next status carries it, so the card never waits on the website.
    const period = currentUsagePeriod();
    let usageState: InstallationUsageState;
    if (!saved?.companyId || saved.revoked) { usageState = { state: "not-linked" }; usageCache = undefined; }
    else if (usageCache && usageCache.period === period && Date.now() - usageCache.at < USAGE_TTL) usageState = usageCache.value;
    else { usageState = usageCache?.period === period ? usageCache.value : { state: "checking" }; void usage(period).catch(() => {}); }
    const browser = saved?.browser && !saved.revoked ? { browser: saved.browser } : {};
    // The grant's own authority when there is one: a grant already in force is
    // not re-applied, so the link's marker alone can read false.
    const provisioned = saved?.companyId && !saved.revoked
      ? { provisioned: saved.provisioned === true || ((await options.provisioning?.active?.().catch(() => false)) ?? false) } : {};
    return saved ? { state: saved.revoked ? "revoked" : saved.companyId ? "linked" : "pending", id: saved.id, label: saved.label, agencyLabel: saved.agencyLabel, lastReportedAt: saved.lastReportedAt, usage: usageState, ...browser, ...provisioned, ...withdrawn, ...(error ? { error } : {}) } : { state: "unlinked", usage: usageState, ...withdrawn };
  }
  async function request(route: string, init: RequestInit): Promise<Response> {
    try { return await fetcher(`${ORIGIN}/api/installations/${route}`, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json", ...init.headers } }); }
    catch { throw new Error("The website could not be reached. Your link is saved; try again when connected."); }
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

  async function link(input: { code?: unknown; label?: unknown }) {
    return exclusive(async () => {
      input = input && typeof input === "object" ? input : {};
      const code = typeof input.code === "string" ? input.code.trim() : "";
      const label = typeof input.label === "string" ? input.label.trim() : "";
      if (!/^rb1_[a-f0-9]{64}$/.test(code) || !label || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) throw Object.assign(new Error("Paste the link code and name this computer."), { status: 400 });
      let saved = await read();
      if (saved?.companyId && !saved.revoked) throw Object.assign(new Error("Disconnect the current website link before linking another office."), { status: 409 });
      if (saved?.browser && !saved.revoked) throw Object.assign(new Error("Cancel the browser approval before using a link code."), { status: 409 });
      if (saved?.code && saved.code !== code && !saved.revoked) throw Object.assign(new Error("Retry the original code, or cancel the pending link before using a new code."), { status: 409 });
      // Persist the token before making a request. Repeating this code after a
      // lost response redeems the identical id/token, never a second device.
      if (!saved || saved.revoked || saved.code !== code) {
        saved = { version: 1, id: randomUUID(), token: randomBytes(32).toString("hex"), label, code };
        await save(saved);
      }
      const response = await request("redeem", { method: "POST", body: JSON.stringify({ code, id: saved.id, token: saved.token, label: saved.label, platform: options.platform ?? process.platform, appVersion: options.appVersion }) });
      if (!response.ok) throw new Error(response.status === 409 ? "This code is expired or already used. Get a new code from your account owner." : "The website could not finish linking this computer. Try again shortly.");
      const result = await response.json().catch(() => null) as { companyId?: unknown; agencyLabel?: unknown; installationId?: unknown; provisioning?: unknown } | null;
      if (!result || result.installationId !== saved.id || typeof result.companyId !== "string" || !result.companyId || result.companyId.length > 200 || typeof result.agencyLabel !== "string" || result.agencyLabel.length > 200) throw new Error("The website returned an incomplete link. Retry the same code.");
      // Vendor provisioning, when present, is applied before the link is
      // recorded: a computer must never read as linked while still missing the
      // service access that reply carried. Retrying the code repeats it safely.
      const provisioning = parseInstallationProvisioning(result.provisioning);
      if (provisioning) await applyProvisioning(provisioning, saved, result.companyId);
      delete saved.code;
      await save({ ...saved, companyId: result.companyId, agencyLabel: result.agencyLabel, ...(provisioning ? { provisioned: true } : {}) });
    });
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
      if (saved?.code && !saved.revoked) throw Object.assign(new Error("Retry the pending link code, or cancel it before linking in the browser."), { status: 409 });
      if (saved?.browser && !saved.revoked) {
        // One pending request at a time: an unexpired one is resumed, never duplicated.
        if (Date.parse(saved.browser.expiresAt) > Date.now()) return saved.browser;
        await revokeQuietly(saved.token);
      }
      const body: LinkRequestInput = { version: 1, purpose: "installation-link-request", id: randomUUID(), token: randomBytes(32).toString("hex"),
        label, platform: (options.platform ?? process.platform) as LinkRequestInput["platform"], appVersion: options.appVersion };
      if (!isLinkRequestInput(body)) throw Object.assign(new Error("This computer cannot be linked in the browser. Use a link code instead."), { status: 400 });
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
    await exclusive(async () => {
      await options.provisioning?.reconcile();
      const saved = await read(); if (!saved?.companyId || saved.revoked) return;
      const report = await options.report();
      const response = await request("report", { method: "POST", headers: { Authorization: `Bearer ${saved.token}` }, body: JSON.stringify(report) });
      // 401/403 is the website saying this installation's access is gone. Stop
      // using the vendor grant immediately; every saved work record is kept.
      if (response.status === 401 || response.status === 403) {
        await save({ ...saved, revoked: true });
        await options.provisioning?.withdraw();
        return;
      }
      if (!response.ok) throw new Error("The website did not accept the latest status. Your local work can continue.");
      // The portal retries a redeem-time provisioning failure here, once. A
      // grant already in force is left alone: re-applying would replace a live
      // revocable key with whatever this reply happened to carry.
      let provisioned = saved.provisioned === true;
      if (!provisioned) {
        const body = await response.json().catch(() => null) as { provisioning?: unknown } | null;
        const provisioning = parseInstallationProvisioning(body?.provisioning);
        if (provisioning) {
          const already = (await options.provisioning?.active?.().catch(() => false)) ?? false;
          if (!already) { await applyProvisioning(provisioning, saved, saved.companyId!); provisioned = true; }
        }
      }
      await save({ ...saved, lastReportedAt: new Date().toISOString(), ...(provisioned ? { provisioned: true } : {}) });
    });
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
  return { status, link, report, disconnect, usage, beginBrowserLink, browserLinkStatus, cancelBrowserLink,
    async credentials(): Promise<OfficeLinkCredentials | null> {
      const saved = await read();
      return saved?.companyId && !saved.revoked ? { installationId: saved.id, token: saved.token, companyId: saved.companyId, agencyLabel: saved.agencyLabel ?? "" } : null;
    },
    start() { if (timer) return; const tick = () => { void report().catch(() => {}); }; tick(); timer = setInterval(tick, 5 * 60_000); timer.unref(); },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}

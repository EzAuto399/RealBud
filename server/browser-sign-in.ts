// Sign-in handover: Bud opens RealBud's work browser on a site's sign-in page,
// hands the page to the person, and carries on once they are signed in.
// Credentials and verification codes stay with the person: Bud takes no action
// in that tab (the browser broker refuses steps on a site being handed over)
// and detects sign-in from the tab's address only, or the person's Done. The
// one exception: a long (scheduled) wait reloads the sign-in page in place
// when it has sat unchanged for 10 minutes, so it is never stale.
// The address comes from a known site (an installed pack's site map or the
// office's approved sites) or one the person typed in this conversation; never
// from a page, an email or a tool result.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserRuntime } from "./browser-runtime.ts";
import { normalizePageUrl, startLoopbackToolServer, toolError, type LoopbackToolServer } from "./web-research-broker.ts";
import type { BrowserActionClass } from "../shared/browser-task.ts";

export const SIGN_IN_SERVER = "sign-in";
/** The tool is a navigate-class step: it opens a page and reads nothing. */
export const SIGN_IN_TOOL_CLASS: BrowserActionClass = "navigate";
export const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
/** How long the tool call itself waits: under the worker's 300 s tool-call limit. */
export const SIGN_IN_TURN_WAIT_MS = 240_000;
const POLL_MS = 2000;
/** A long wait (until a deadline) reads the address every 20 s; Done and Stop still answer at once. */
const LONG_POLL_MS = 20_000;
/** A long wait reloads a sign-in page whose address has not changed for this long: REI's sign-in journey failed
 * after about 15 idle minutes on one page (docs/REI-LOGIN-TEST.md). */
export const SIGN_IN_REFRESH_MS = 10 * 60_000;
export const WRONG_ACCOUNT = "This is signed in to a different account than this task allows. Switch account, then press Done.";

export const SIGN_IN_TOOL = {
  name: "open_for_sign_in",
  description: "Open RealBud's work browser on a website's sign-in page and hand it to the person, then wait until they are signed in. Use it whenever browser work needs a session the person has not signed in to. site: a known site's name or address; url: only an HTTPS address the person typed in this conversation. The person types passwords and codes; you never do.",
  inputSchema: { type: "object", additionalProperties: false, required: ["reason"], properties: {
    site: { type: "string", maxLength: 200 }, url: { type: "string", maxLength: 2048 }, reason: { type: "string", maxLength: 300 },
  } },
};

export interface SignInSite { key: string; name: string; origin: string; loginUrl: string; signInHosts: string[]; postLogin: string[]; accountParam: string | null }
export type SignInOutcome = "signed_in" | "stopped" | "timed_out" | "wrong_account";
export interface SignInRuntime {
  openSignInTab(url: string): Promise<string>; signInTabUrl(targetId: string): Promise<string | null>;
  /** Loads `url` again in the same tab: never a second tab. Absent: a long wait does not refresh. */
  reloadSignInTab?(targetId: string, url: string): Promise<void>;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Installed packs' website maps. A fixed list, never a request. */
export const SIGN_IN_SITE_MAPS: Readonly<Record<string, string>> = {
  "rei-cloud": "pack/workflows/austin-accounts/support/rei-cloud-navigation/site-map.json",
};
const SITE_NAMES: Readonly<Record<string, string>> = { "rei-cloud": "REI Cloud" };
const httpsOrigin = (value: string): string | null => {
  try { const url = new URL(value.includes("://") ? value : `https://${value}`); return url.protocol === "https:" && !url.username && !url.password ? url.origin : null; } catch { return null; }
};

/** The site map's sign-in facts: origin, sign-in host, optional post-login paths and account parameter. */
export function siteFromMap(key: string, raw: unknown): SignInSite | null {
  const map = raw as { origin?: unknown; signIn?: { host?: unknown; hosts?: unknown; postLogin?: unknown }; scope?: { urlParam?: unknown } } | null;
  const origin = typeof map?.origin === "string" ? httpsOrigin(map.origin) : null;
  if (!origin) return null;
  const hosts = [map!.signIn?.host, ...(Array.isArray(map!.signIn?.hosts) ? map!.signIn!.hosts : [])].filter((host): host is string => typeof host === "string" && /^[a-z0-9.-]{1,253}$/i.test(host));
  const postLogin = Array.isArray(map!.signIn?.postLogin) ? map!.signIn!.postLogin.filter((path): path is string => typeof path === "string" && path.startsWith("/")) : [];
  const accountParam = typeof map!.scope?.urlParam === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(map!.scope.urlParam) ? map!.scope.urlParam : null;
  return { key, name: SITE_NAMES[key] ?? new URL(origin).hostname, origin, loginUrl: `${origin}/`, signInHosts: hosts.map(host => host.toLowerCase()), postLogin, accountParam };
}

/** Known sites: installed packs' site maps, then the office's approved HTTPS sites. */
export async function knownSignInSites(approved: readonly string[] = [], read = (path: string) => readFile(join(ROOT, path), "utf8")): Promise<SignInSite[]> {
  const sites: SignInSite[] = [];
  for (const [key, path] of Object.entries(SIGN_IN_SITE_MAPS)) {
    try { const site = siteFromMap(key, JSON.parse(await read(path))); if (site) sites.push(site); } catch { /* a missing pack offers no site */ }
  }
  for (const value of approved) {
    const origin = httpsOrigin(value);
    if (origin && !sites.some(site => site.origin === origin)) sites.push({ key: origin, name: new URL(origin).hostname, origin, loginUrl: `${origin}/`, signInHosts: [], postLogin: [], accountParam: null });
  }
  return sites;
}

/** Where Bud may open a sign-in page: a known site, or an HTTPS address the person typed in this thread. */
export function signInTarget(input: { site?: unknown; url?: unknown }, sites: readonly SignInSite[], typed: readonly string[]): { site: SignInSite; url: string } | { error: string } {
  const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : null;
  if (typeof input.site === "string" && input.site.trim()) {
    // A known site opens only its pinned sign-in address; a different url alongside it is refused.
    const wanted = input.site.trim().toLowerCase();
    if (/^http:\/\//i.test(wanted)) return { error: "Bud opens only HTTPS sign-in pages." };
    const origin = httpsOrigin(wanted);
    const known = sites.find(site => site.key.toLowerCase() === wanted || site.name.toLowerCase() === wanted || site.origin === origin);
    if (!known) return { error: "That site is not one Bud knows. Type the site's HTTPS address in this conversation and ask again." };
    if (url && normalizePageUrl(url) !== normalizePageUrl(known.loginUrl)) return { error: "Name the site or give the address you typed, not both." };
    return { site: known, url: known.loginUrl };
  }
  if (url) {
    // Exactly an address the person typed (read_page's normalisation), never a path or query from a page, email or tool result.
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { error: "That is not a web address Bud can open." }; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return { error: "Bud opens only HTTPS sign-in pages." };
    const normalized = normalizePageUrl(parsed.href);
    if (!normalized || !typed.some(value => normalizePageUrl(value) === normalized)) {
      return { error: "Bud can open only a known site or an address you typed in this conversation. Type the site's address and ask again." };
    }
    const known = sites.find(site => site.origin === parsed.origin);
    return { site: known ?? { key: parsed.origin, name: parsed.hostname, origin: parsed.origin, loginUrl: normalized, signInHosts: [], postLogin: [], accountParam: null }, url: normalized };
  }
  return { error: "Name the site or give its HTTPS address." };
}

const LOGIN_PATH = /(?:^|[/_-])(?:log[-_]?in|sign[-_]?in|sign[-_]?on|auth|oauth2?|sso|b2c)(?:$|[/_.-])/i;
/** A login word inside a path segment too: REI's failed sign-in lands on /Account/NewLoginMFA. */
const LOGIN_WORD = /log[-_]?[io]n|sign[-_]?[io]n/i;
/** Signed in, judged from the address alone: back on the site, off its sign-in host and login paths, and on a post-login path when the map names any. */
export function signedInAt(site: SignInSite, value: string | null): boolean {
  if (!value) return false;
  let url: URL; try { url = new URL(value); } catch { return false; }
  if (url.origin !== site.origin || site.signInHosts.includes(url.hostname.toLowerCase())) return false;
  // ponytail: login-path heuristic for sites without a map; a site map's postLogin paths are exact.
  if (site.postLogin.length) return site.postLogin.some(path => url.pathname.startsWith(path));
  return !LOGIN_PATH.test(url.pathname) && !LOGIN_WORD.test(url.pathname) && (site.signInHosts.length > 0 || url.href !== new URL(site.loginUrl).href);
}

/** Still on the site's sign-in page, judged from the address alone: its sign-in host (REI's "Member Login" on
 * b2clogin), or a login path on the site, such as REI's failed sign-in page. */
export function onSignInPage(site: SignInSite, value: string | null): boolean {
  if (!value) return false;
  let url: URL; try { url = new URL(value); } catch { return false; }
  return site.signInHosts.includes(url.hostname.toLowerCase()) || url.origin === site.origin && (LOGIN_PATH.test(url.pathname) || LOGIN_WORD.test(url.pathname));
}

export interface SignInHandoverView { id: string; site: string; origin: string; state: "waiting" | "wrong_account" | "signed_in" | "stopped" | "timed_out"; message: string }
interface Handover {
  id: string; threadId: string | null; site: SignInSite; reason: string; account: string | null;
  state: SignInHandoverView["state"]; done: boolean; stopped: boolean; inTurn: boolean; stop(): void;
  settled: Promise<SignInOutcome>;
  /** A scheduled wait's deadline (epoch ms), or null for the attended 15-minute handover. */
  until: number | null;
  /** Ends the current poll's sleep (Done). */
  nudge(): void;
}
const handovers = new Map<string, Handover>();
const settledListeners = new Set<(event: { threadId: string | null; id: string; outcome: SignInOutcome; origin: string; site: string; inTurn: boolean }) => void>();
/** The host starts the continue turn when a sign-in finishes after the tool call stopped waiting. */
export function onSignInSettled(listener: Parameters<typeof settledListeners.add>[0]): () => void {
  settledListeners.add(listener); return () => { settledListeners.delete(listener); };
}

/** True while the person is signing in on this address's site: Bud takes no action there. */
export function signInHandoverBlocks(value: string): boolean {
  let url: URL; try { url = new URL(value); } catch { return false; }
  return [...handovers.values()].some(item => (item.state === "waiting" || item.state === "wrong_account") &&
    (item.site.origin === url.origin || item.site.signInHosts.includes(url.hostname.toLowerCase())));
}

const messageFor = (item: Handover): string => item.state === "wrong_account" ? WRONG_ACCOUNT
  : item.state === "signed_in" ? `Signed in to ${item.site.name}. Bud carries on.`
    : item.state === "stopped" ? `Sign-in to ${item.site.name} stopped. Nothing was done there.`
      : item.state === "timed_out" ? (item.until !== null ? `Sign-in to ${item.site.name} was not finished today, so Bud paused. The next scheduled run tries again.`
        : `Sign-in to ${item.site.name} was not finished within 15 minutes, so Bud paused. Ask again when you are ready.`)
        : `Sign in to ${item.site.name} here. Bud carries on when you're signed in.`;
export function signInHandovers(threadId: string | null): SignInHandoverView[] {
  return [...handovers.values()].filter(item => item.threadId === threadId)
    .map(item => ({ id: item.id, site: item.site.name, origin: item.site.origin, state: item.state, message: messageFor(item) }));
}
/** The person pressed Done: signed in unless the address shows another account. */
export function signInDone(id: string): boolean { const item = handovers.get(id); if (!item || item.state !== "waiting" && item.state !== "wrong_account") return false; item.done = true; item.nudge(); return true; }
export function signInStop(id: string): boolean { const item = handovers.get(id); if (!item || item.state !== "waiting" && item.state !== "wrong_account") return false; item.stopped = true; item.stop(); return true; }

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(done, ms); timer.unref?.();
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

export interface SignInDependencies { runtime?: SignInRuntime; sites?: readonly SignInSite[]; now?: () => number; pollMs?: number; timeoutMs?: number }

/** Opens the tab and starts watching it. Re-attaches to a thread's open handover for the same site.
 * `until` (epoch ms) makes it a scheduled wait that lasts until then instead of 15 minutes. */
async function begin(site: SignInSite, url: string, input: { reason: string; account?: string | null; threadId?: string | null; signal?: AbortSignal; until?: number }, deps: SignInDependencies): Promise<Handover> {
  const threadId = input.threadId ?? null;
  const open = [...handovers.values()].find(item => item.threadId === threadId && item.site.origin === site.origin && (item.state === "waiting" || item.state === "wrong_account"));
  if (open) return open;
  const runtime = deps.runtime ?? browserRuntime;
  const now = deps.now ?? Date.now;
  const targetId = await runtime.openSignInTab(url);
  const long = input.until !== undefined;
  const item: Handover = { id: randomUUID(), threadId, site, reason: input.reason.slice(0, 300), account: input.account ?? null, state: "waiting", done: false, stopped: false, inTurn: true, stop: () => {}, settled: Promise.resolve("stopped"),
    until: input.until ?? null, nudge: () => {} };
  handovers.set(item.id, item);
  const started = now(); const limit = long ? input.until! - started : deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS; const signal = input.signal;
  // The first terminal outcome wins and is final: Stop, an aborted signal or
  // the time limit settle at once, and a poll still in flight can never turn
  // that into signed_in afterwards (nor tell the host to continue).
  let final: SignInOutcome | null = null;
  let resolve!: (outcome: SignInOutcome) => void;
  item.settled = new Promise<SignInOutcome>(done => { resolve = done; });
  const settle = (outcome: SignInOutcome) => {
    if (final) return; final = outcome;
    signal?.removeEventListener("abort", aborted);
    item.state = outcome === "wrong_account" ? "timed_out" : outcome;
    const event = { threadId, id: item.id, outcome, origin: site.origin, site: site.name, inTurn: item.inTurn };
    for (const listener of settledListeners) { try { listener(event); } catch { /* display only */ } }
    // Keep the ended strip briefly so the person sees how it ended.
    setTimeout(() => handovers.delete(item.id), 60_000).unref?.();
    resolve(outcome);
  };
  const aborted = () => settle("stopped");
  item.stop = () => settle("stopped");
  /** Stop, abort or time limit; true once the handover has ended. */
  const ended = () => {
    if (!final && (item.stopped || signal?.aborted)) settle("stopped");
    else if (!final && now() - started >= limit) settle(item.state === "wrong_account" ? "wrong_account" : "timed_out");
    return final !== null;
  };
  signal?.addEventListener("abort", aborted, { once: true });
  void (async () => {
    let last: string | null = null, since = started;
    while (!ended()) {
      // The address only: no page read and no action in the person's tab.
      const current = await runtime.signInTabUrl(targetId).catch(() => null);
      if (ended()) return;
      // Twice the same address so a redirect still in flight is not taken as signed in.
      const steady = current !== null && current === last; last = current;
      if (!steady) since = now();
      if (item.done || steady && signedInAt(site, current)) {
        const shown = current && site.accountParam && new URL(current).origin === site.origin ? new URL(current).searchParams.get(site.accountParam) : null;
        if (item.account && shown !== null && shown !== item.account) { item.state = "wrong_account"; item.done = false; }
        else if (!ended()) { settle("signed_in"); return; }
      } else if (long && runtime.reloadSignInTab && onSignInPage(site, current) && now() - since >= SIGN_IN_REFRESH_MS) {
        // A fresh sign-in page in the same tab, from the address first opened (a new sign-in journey). Focus and typing
        // are not visible from the address, so only a page unchanged for 10 minutes reloads.
        since = now(); last = null;
        await runtime.reloadSignInTab(targetId, url).catch(() => {});
        if (ended()) return;
      }
      await new Promise<void>(resolve => { item.nudge = resolve; void sleep(deps.pollMs ?? (long ? LONG_POLL_MS : POLL_MS), signal).then(resolve); });
    }
  })().catch(() => settle("stopped"));
  return item;
}

/** Host function (W1 and other host workflows): open the site's sign-in page, hand it over, and resolve when it ends. */
export async function openForSignIn(input: { site: string; url?: string; reason: string; signal?: AbortSignal; account?: string; threadId?: string | null; personUrls?: readonly string[]; approvedSites?: readonly string[]; until?: number },
  deps: SignInDependencies = {}): Promise<{ outcome: SignInOutcome; origin: string }> {
  const target = signInTarget(input, deps.sites ?? await knownSignInSites(input.approvedSites), input.personUrls ?? []);
  if ("error" in target) throw Object.assign(new Error(target.error), { status: 409 });
  const item = await begin(target.site, target.url, input, deps);
  return { outcome: await item.settled, origin: target.site.origin };
}

/** Ask's `open_for_sign_in`: waits within the tool call; past that, the handover keeps going and the host continues the conversation. */
export async function startSignInBroker(options: { threadId: string; personUrls(): readonly string[]; approvedSites(): readonly string[]; isActive(): boolean; turnWaitMs?: number } & SignInDependencies): Promise<LoopbackToolServer> {
  return startLoopbackToolServer({
    name: SIGN_IN_SERVER, serverName: "RealBud sign-in", tools: [SIGN_IN_TOOL], isActive: options.isActive, maxConcurrent: 1,
    call: async (_name, args, signal) => {
      if (typeof args.reason !== "string" || !args.reason.trim()) return toolError("Say briefly why Bud needs the person signed in.");
      const target = signInTarget(args, options.sites ?? await knownSignInSites(options.approvedSites()), options.personUrls());
      if ("error" in target) return toolError(target.error);
      let item: Handover;
      try { item = await begin(target.site, target.url, { reason: args.reason, threadId: options.threadId, signal }, options); }
      catch (error) { return toolError(`The work browser could not open ${target.site.name}: ${error instanceof Error ? error.message : "unknown error"}`); }
      item.inTurn = true;
      const outcome = await Promise.race([item.settled, sleep(options.turnWaitMs ?? SIGN_IN_TURN_WAIT_MS, signal).then(() => null)]);
      if (outcome === null) {
        if (signal.aborted) { item.stopped = true; item.stop(); return toolError("Sign-in stopped. Nothing was done on the site."); }
        item.inTurn = false;
        return { content: [{ type: "text", text: `Still waiting for the person to sign in to ${target.site.name}. End this reply with one short line saying so; RealBud continues this conversation once they are signed in.` }] };
      }
      const text: Record<SignInOutcome, string> = {
        signed_in: `Signed in to ${target.site.name}. The work browser keeps this sign-in; carry on with the request.`,
        stopped: `The person stopped the sign-in to ${target.site.name}. Do not open it again unless they ask.`,
        timed_out: `Sign-in to ${target.site.name} was not finished within 15 minutes. Say the task is paused until they ask again.`,
        wrong_account: `${target.site.name} is signed in to a different account than this task allows. Say so and stop.`,
      };
      return { content: [{ type: "text", text: text[outcome] }], ...(outcome === "signed_in" ? {} : { isError: true }) };
    },
  });
}

/** GET /api/browser/sign-in?threadId=…, POST /api/browser/sign-in/:id/(done|stop). Null for any other path. */
export function browserSignInRoute(path: string, method: string, query: URLSearchParams): { status: number; body: unknown } | null {
  if (path === "/api/browser/sign-in" && method === "GET") return { status: 200, body: { handovers: signInHandovers(query.get("threadId")) } };
  const match = path.match(/^\/api\/browser\/sign-in\/([0-9a-f-]{36})\/(done|stop)$/);
  if (!match || method !== "POST") return null;
  const ok = match[2] === "done" ? signInDone(match[1]) : signInStop(match[1]);
  return ok ? { status: 200, body: { ok: true } } : { status: 409, body: { error: "This sign-in has already ended." } };
}

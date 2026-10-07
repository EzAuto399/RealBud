// The day's REI Cloud sign-in on Desk (owner, 8 Oct 2026). REI's session ends most nights, so a
// day often starts signed out. Desk and the status bar read one line from facts RealBud already
// has: a sign-in handover waiting on REI, how the last one ended, the REI morning refresh finding
// REI signed in or out (all in browser-sign-in.ts), and the REI loops' own runs. "Sign in to REI"
// opens REI's own sign-in page in the work browser through the ordinary handover, or brings the
// page already waiting there forward; the person types their password on REI's page and Bud never
// sees it. Once signed in, runs waiting at REI sign-in carry on by themselves (their handover) and
// a REI morning refresh that missed for sign-in today runs again once the browser is free (resumeReiWhenFree).
import { noteSiteSignIn, siteSignInState, signInShow } from "./browser-sign-in.ts";
import { reiWaitNotice } from "../shared/rei-sign-in-wait.ts";
import type { LoopRun } from "../shared/contracts.ts";

export const REI_SITE = "REI Cloud";
/** The installed pack's site key (browser-sign-in.ts SIGN_IN_SITE_MAPS; the lab maps the same key). */
export const REI_SITE_KEY = "rei-cloud";
/** Desk's own handover thread: no conversation, so no Bud turn starts from it. */
export const REI_DESK_THREAD = "desk-rei-sign-in";
const REI_LOOPS: readonly string[] = ["bank-references", "rei-supplier-check", "rei-morning-refresh"];
/** server/rei-morning-refresh.ts REI_SIGN_IN_MISSED at the start of a missed run's line. */
const REFRESH_MISSED = /^Missed: sign in to REI\b/;
/** "Signed in" older than this reads as not checked: REI's session rarely lasts the night. */
export const REI_SIGNED_IN_FRESH_MS = 12 * 60 * 60_000;

export interface ReiSignInView {
  state: "needed" | "signed_in" | "unknown";
  /** When RealBud last saw REI signed in or out; null while a sign-in waits or nothing was seen. */
  at: number | null;
  /** REI work waiting for the sign-in, by loop name. */
  waiting: Array<{ loopId: string; name: string }>;
  /** This office uses REI on this PC: a REI loop is on, or REI's sign-in was seen. */
  used: boolean;
  /** REI's sign-in page is open in the work browser now, waiting for the person. */
  signingIn: boolean;
}

type SignState = ReturnType<typeof siteSignInState>;
const latestRuns = (runs: readonly LoopRun[]) => {
  const latest = new Map<string, LoopRun>();
  for (const run of [...runs].sort((a, b) => b.scheduledFor - a.scheduledFor)) if (!latest.has(run.loopId)) latest.set(run.loopId, run);
  return [...latest.values()];
};
const refreshMissed = (run: LoopRun) => run.loopId === "rei-morning-refresh" && run.status === "missed" && REFRESH_MISSED.test(run.detail ?? "");
const endedAt = (run: LoopRun) => run.finishedAt ?? run.startedAt ?? run.scheduledFor;

/** Pure: Desk's REI line. A run waiting at REI sign-in, or a refresh that missed it since REI was last seen signed in
 * (within 12 hours), keeps "needed"; a sign-in seen after it wins. */
export function reiSignInView(sign: SignState, loops: readonly { id: string; enabled: boolean }[], runs: readonly LoopRun[], now: number): ReiSignInView {
  const signedAt = sign.state === "signed_in" ? sign.at ?? 0 : 0;
  const waiting = latestRuns(runs).filter(run => REI_LOOPS.includes(run.loopId) && (
    (reiWaitNotice(run) === "waiting" && sign.state !== "signed_in") ||
    (refreshMissed(run) && endedAt(run) > signedAt && now - endedAt(run) < REI_SIGNED_IN_FRESH_MS))).map(run => ({ loopId: run.loopId, name: run.loopName }));
  let state = sign.state, at = sign.at;
  if (state === "signed_in" && (at === null || now - at >= REI_SIGNED_IN_FRESH_MS)) { state = "unknown"; at = null; }
  if (waiting.length && state !== "signed_in") state = "needed";
  const used = state !== "unknown" || loops.some(loop => REI_LOOPS.includes(loop.id) && loop.enabled);
  return { state, at, waiting, used, signingIn: sign.waiting !== null };
}

/** The REI morning refresh read REI whole (signed in) or missed for sign-in, part-way or at the start (signed out).
 * Any other ending (a second REI tab, another business, a timeout) says nothing about the sign-in. */
export function noteReiRefresh(result: { status?: string; detail?: string }, at = Date.now()): void {
  if (result.status === "completed") noteSiteSignIn(REI_SITE, true, at);
  else if (/\bMissed: sign in to REI\b/.test(result.detail ?? "")) noteSiteSignIn(REI_SITE, false, at);
}

/** After a REI sign-in: the REI morning refresh runs again when it is on and its latest run missed for sign-in today.
 * Runs waiting at sign-in carry on through their own handover, so they are not started twice. */
export function reiLoopsToResume(loops: readonly { id: string; enabled: boolean; available: boolean }[], runs: readonly LoopRun[], now: number): string[] {
  return latestRuns(runs).filter(run => refreshMissed(run) && now - endedAt(run) < REI_SIGNED_IN_FRESH_MS &&
    loops.some(loop => loop.id === run.loopId && loop.enabled && loop.available)).map(run => run.loopId);
}

/** After a REI sign-in, a refresh that missed it runs again once the work browser is free: work that waited at the same
 * sign-in (a bank import) carries on first, and a second browser session at the same time would be refused. Checks
 * every minute for up to four hours and stops once nothing is left to run. */
export function resumeReiWhenFree(deps: { due(): string[]; busy(): Promise<boolean>; run(id: string): void; firstMs?: number; everyMs?: number; tries?: number }): void {
  let left = deps.tries ?? 240;
  const check = async () => {
    if (!deps.due().length || left-- <= 0) return;
    if (await deps.busy().catch(() => true)) { setTimeout(() => void check(), deps.everyMs ?? 60_000).unref?.(); return; }
    // Read again after the await, in the same turn as the dispatch: a loop switched off or already rerun meanwhile is not run.
    for (const id of deps.due()) { try { deps.run(id); } catch { /* already running */ } }
  };
  // A moment first, so the work that waited at the sign-in takes the browser before this looks.
  setTimeout(() => void check(), deps.firstMs ?? 15_000).unref?.();
}

type Open = (input: { site: string; reason: string; threadId: string }) => Promise<unknown>;
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

/** Desk's "Sign in to REI": brings a waiting sign-in page forward, or opens REI's own sign-in page through the
 * ordinary 15-minute handover. Answers once the page is open (bounded), or with the plain reason it could not open. */
export async function startReiSignIn(open: Open | undefined, waitMs = 10_000): Promise<{ opened: "existing" | "new" }> {
  const now = siteSignInState(REI_SITE);
  if (now.waiting && await signInShow(now.waiting)) return { opened: "existing" };
  if (!open) throw Object.assign(new Error("REI sign-in isn't available on this computer yet."), { status: 409 });
  let failure: unknown = null, ended = false;
  void open({ site: REI_SITE_KEY, reason: "Sign in to REI Cloud so Bud can carry on with today's REI work.", threadId: REI_DESK_THREAD })
    .then(() => { ended = true; }, error => { ended = true; failure = error; });
  for (let waited = 0; waited < waitMs && !ended && !siteSignInState(REI_SITE).waiting; waited += 100) await sleep(100);
  if (failure) throw Object.assign(new Error("The work browser couldn't open REI's sign-in page. Open Workspace → Work browser, then try again."), { status: 409 });
  return { opened: "new" };
}

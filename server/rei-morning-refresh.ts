// REI morning refresh (loop rei-morning-refresh, off until an office turns it on in Schedule).
// REI Cloud is Desk's source of truth (docs/decisions/2026-10-06-rei-source-of-truth-and-client-packs.md):
// each morning the clock reads REI's tenants, arrears, owners and tasks due in the person's
// ALREADY signed-in REI session and applies the rows to Desk through server/rei-desk-sync.ts.
//   - Read only. The host issues a loop-read grant (shared/browser-task.ts): no uploads, downloads
//     or submits, and the broker refuses every step that is not plainly a read
//     (server/browser-authority.ts). The recipes are checked against the site map first
//     (loopReadRefusal in server/portal-recipe-task.ts). Nobody is asked anything.
//   - Never signs in and never opens a browser. Signed out, expired or no REI tab: the run records
//     "Missed: sign in to REI" and Desk keeps its freshness stamps as they were, so nothing reads as
//     fresh that was not read this time. A session that expires part-way applies the parts read
//     completely and leaves the rest stale.
//   - One apply, after the read: a restart, Stop or timeout before then changes nothing on Desk.
//   - One refresh at a time in this process; the clock itself never runs one loop twice (server/routines.ts).
// A loop is never a bot turn or a prompt: no model is called.
import { createHash, randomUUID } from "node:crypto";
import type { BrowserSessionRuntime } from "./browser-session.ts";
import type { Desk } from "./desk.ts";
import { loadPortalRecipePack, loadPortalSiteMap, runPortalReadLoop, type PackLoader, type PortalSiteMap } from "./portal-recipe-task.ts";
import { portalRecipeGrantNeeds, type PortalRunRequest, type PortalRunResult } from "./portal-recipe-runner.ts";
import { redactSecretsInText } from "./redact.ts";
import { REI_PARTS, reiDeskSyncLine, syncReiReadIntoDesk } from "./rei-desk-sync.ts";
import type { LoopExecuteResult } from "./routines.ts";
import { reiPartsFreshness } from "./source-gate.ts";
import { parseBrowserTaskGrant } from "../shared/browser-task.ts";

const PORTAL = "rei-cloud";
export const REI_SIGN_IN_MISSED = "Missed: sign in to REI.";
const SIGN_IN_HOW = "Bud never signs in for you: sign in to REI Cloud in the work browser, then run the refresh again from Schedule.";
const SIGNED_OUT = new Set(["sign-in", "choose-tab", "account-url-unavailable"]);
/** Long enough for a large book; a slower REI ends as a miss and the next run starts clean. */
export const REI_REFRESH_TIMEOUT_MS = 10 * 60_000;

/** The morning's reads, in order. Tenants, arrears and owners are Desk parts; tasks due are counted only. */
export function reiMorningRuns(today: string): PortalRunRequest[] {
  return [
    { recipe: "open-session" },
    { recipe: "find-record", inputs: { list: "Tenants", query: "" } },
    { recipe: "arrears-review", inputs: { min_days: "1" } },
    { recipe: "find-record", inputs: { list: "Owners", query: "" } },
    { recipe: "tasks-due", inputs: { date_from: today, date_to: today } },
  ];
}

export interface ReiMorningRefreshDeps {
  desk: Desk;
  runtime: BrowserSessionRuntime;
  /** The selected work browser when it is already open and ready, else null. The refresh never opens one. */
  browserId: () => Promise<string | null>;
  /** The office's REI account: the top-bar business code, and a reicid only when one was saved. */
  account: () => Promise<{ marker: string; urlValue?: string } | null>;
  /** Today in the office's timezone (YYYY-MM-DD), for tasks due. */
  today: () => Promise<string>;
  load?: PackLoader;
  map?: (portal: string) => Promise<PortalSiteMap>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
  workroom?: string;
}

const notFresh = (stale: readonly string[]) => stale.length ? `Not fresh from REI: ${stale.join(", ")}.` : "";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
let inFlight = false;

export function createReiMorningRefresh(deps: ReiMorningRefreshDeps) {
  const now = deps.now ?? Date.now;
  const staleNow = () => REI_PARTS.filter(part => !reiPartsFreshness(REI_PARTS, deps.desk.snapshot().sources, now())[part]);
  const missed = (why: string): LoopExecuteResult => ({ ok: false, status: "missed", detail: `${REI_SIGN_IN_MISSED} ${why} ${notFresh(staleNow())}`.trim() });

  async function refresh(): Promise<LoopExecuteResult> {
    const account = await deps.account();
    if (!account) return { ok: false, status: "failed", detail: `Save the REI business code (Schedule → Bank reference review → Set up bank imports) before the REI morning refresh can read REI. ${notFresh(staleNow())}`.trim() };
    const browserId = await deps.browserId();
    if (!browserId) return missed(`The work browser isn't open and ready (open it and sign in to REI, or release an earlier browser task that needs recovery), so REI wasn't read. ${SIGN_IN_HOW}`);
    const [pack, map, today] = await Promise.all([(deps.load ?? loadPortalRecipePack)(PORTAL), (deps.map ?? loadPortalSiteMap)(PORTAL), deps.today()]);
    const runs = reiMorningRuns(today);
    const needs = portalRecipeGrantNeeds(pack, runs);
    const id = randomUUID(), text = `Read REI Cloud for ${account.marker} this morning: tenants, arrears, owners and tasks due. Read only; nothing in REI changes and nobody is asked.`;
    const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id, runId: `rei-refresh-${id}`, route: "loop-read",
      request: { text, sha256: sha256(text) }, sites: needs.sites, browser: { id: browserId, accountMarker: account.marker },
      actions: needs.actions, consequential: "ask-each", uploads: [], expiresAt: Date.now() + (deps.timeoutMs ?? REI_REFRESH_TIMEOUT_MS), budget: null });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REI_REFRESH_TIMEOUT_MS); timer.unref?.();
    let result: PortalRunResult;
    try {
      result = await runPortalReadLoop({ pack, map, runs, account, grant, runtime: deps.runtime, threadId: `rei-refresh-${id}`, signal: controller.signal,
        ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}), ...(deps.workroom ? { workroom: deps.workroom } : {}) });
    } finally { clearTimeout(timer); }
    const timedOut = controller.signal.aborted;
    // One apply, after the read: rows of parts read completely are fresh, partial rows still count as REI's but stay stale.
    const sync = syncReiReadIntoDesk(deps.desk, { runs, results: result.results, observedAt: now() })!;
    const tasks = result.results[runs.findIndex(run => run.recipe === "tasks-due")];
    const tasksLine = tasks?.outcome === "completed" ? ` REI shows ${tasks.rows.length} task${tasks.rows.length === 1 ? "" : "s"} due today.` : "";
    // Say what THIS run applied and read whole, never that an earlier read is fresh from this one.
    const unread = REI_PARTS.filter(part => !sync.fresh.includes(part));
    const applied = sync.updated || sync.differs || sync.proposed || sync.held ? reiDeskSyncLine(sync, false) : "Nothing from REI was applied.";
    if (result.outcome === "completed") return unread.length
      ? { ok: false, status: "partial", detail: [applied, `Not read whole this run (a page came back cut short or a list ran past one page): ${unread.join(", ")}.`, notFresh(staleNow())].filter(Boolean).join(" ") + tasksLine }
      : { ok: true, status: "completed", detail: `${reiDeskSyncLine(sync)}${tasksLine}` };
    const freshness = `${sync.fresh.length ? `Fresh from REI this run: ${sync.fresh.join(", ")}.` : "Nothing was fresh from REI this run; Desk keeps its earlier REI facts."} ${notFresh(staleNow())}`.trim();
    if (result.outcome === "handover" && SIGNED_OUT.has(result.reason ?? "")) return sync.fresh.length
      ? { ok: false, status: "partial", detail: `REI signed out part-way. ${applied} ${freshness} ${REI_SIGN_IN_MISSED} ${SIGN_IN_HOW}` }
      : missed(`REI isn't signed in, so nothing was read. ${SIGN_IN_HOW}`);
    const why = timedOut ? "REI didn't answer in time, so the refresh stopped. The next run starts clean."
      : result.outcome === "handover" && result.reason?.startsWith("account-") ? `REI is open in a different business than ${account.marker}. Switch business in REI; nothing from the other business was used.`
        : `REI couldn't be read (${result.reason ?? result.outcome}).${result.detail ? ` ${result.detail}` : ""}`;
    return { ok: false, status: sync.fresh.length ? "partial" : timedOut ? "missed" : "failed", detail: redactSecretsInText(`${why} ${applied} ${freshness}`).slice(0, 500) };
  }

  /** One refresh at a time in this process; a second start while one runs does nothing. */
  async function run(): Promise<LoopExecuteResult> {
    if (inFlight) return { ok: false, status: "missed", detail: "Another REI refresh was already running, so this one did not start. Desk changed only once." };
    inFlight = true;
    try { return await refresh(); }
    catch (error) { return { ok: false, status: "failed", detail: `${redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 300)} ${notFresh(staleNow())}`.trim() }; }
    finally { inFlight = false; }
  }
  return { run };
}
export type ReiMorningRefresh = ReturnType<typeof createReiMorningRefresh>;

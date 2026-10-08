// A one-off browser task from Ask, as one decision: the site, the browser,
// what Bud may do there, what always asks first, and how long it lasts.
// Start saves the grant on the server and opens the work browser when it is
// not open yet (one press); Stop ends it for good. The server is the
// authority: this card only shows what the saved task allows.
// With no site named, the person may instead give the task one open app
// window on this computer; the server fences every step to that window.
import { AppWindow, Globe, Square } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BrowserActionClass, BrowserConsequentialKind } from "@shared/browser-task";
import { parseDesktopTarget, type DesktopTarget } from "@shared/desktop-task";
import { api, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { desktopStartBody, desktopWindowLabel, loadDesktopWindows, type DesktopWindowsState } from "@/lib/desktop-windows";

/** The Ask reply that carries a task card contains this button name. */
export const BROWSER_TASK_OFFER_MARK = "**Start this task**";

export type BrowserTaskStatus = "proposed" | "declined" | "saved-as-job" | "active" | "paused" | "finished" | "stopped" | "expired" | "budget" | "interrupted";
export interface BrowserTaskCardView {
  id: string;
  messageId: string;
  status: BrowserTaskStatus;
  request: string;
  sites: string[];
  siteSource: "request" | "saved-job" | "person" | "none";
  savedJob: string | null;
  actions: BrowserActionClass[];
  consequential: BrowserConsequentialKind[];
  minutes: number;
  budget: number;
  offerExpiresAt: number;
  startedAt: number | null;
  expiresAt: number | null;
  endNote: string | null;
  /** What the task has done so far ("Signed in to REI Cloud", "Opened Reports"), oldest first. */
  progress: string[];
  /** Present only on a task given one app window instead of a site. */
  desktop?: DesktopTarget;
  /** Asked for an app on this computer: the card asks for a window, not a site. */
  appTask?: true;
}
export interface BrowserTaskBrowser { ready: boolean; name: string | null }
export interface BrowserTaskList { tasks: BrowserTaskCardView[]; browser: BrowserTaskBrowser }
export type BrowserTaskAction = "start" | "decline" | "save-job" | "stop";
const NO_BROWSER: BrowserTaskBrowser = { ready: false, name: null };

const STATUSES: readonly BrowserTaskStatus[] = ["proposed", "declined", "saved-as-job", "active", "paused", "finished", "stopped", "expired", "budget", "interrupted"];
const ACTIONS: readonly BrowserActionClass[] = ["read", "navigate", "fill", "click", "download", "upload", "keys", "submit"];
const KINDS: readonly BrowserConsequentialKind[] = ["pay", "sign", "send", "notice", "delete", "account-change"];
const INVALID = "Bud sent task details this app cannot read. Nothing was started.";
function invalid(): never { throw new Error(INVALID); }
const str = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullable = <T,>(value: unknown, check: (value: unknown) => value is T): value is T | null => value === null || check(value);
const list = <T extends string>(value: unknown, allowed: readonly T[]): T[] =>
  Array.isArray(value) && value.every(item => (allowed as readonly unknown[]).includes(item)) ? [...value as T[]] : invalid();

/** A malformed reply is an error, never a card. */
export function parseBrowserTaskList(value: unknown): BrowserTaskList {
  if (!value || typeof value !== "object") invalid();
  const body = value as Record<string, unknown>;
  const browser = body.browser as Record<string, unknown> | undefined;
  if (!Array.isArray(body.tasks) || !browser || typeof browser.ready !== "boolean" || !nullable(browser.name, (v): v is string => str(v, 60))) invalid();
  const tasks = (body.tasks as unknown[]).map((raw): BrowserTaskCardView => {
    const row = (raw && typeof raw === "object" ? raw : invalid()) as Record<string, unknown>;
    if (!str(row.id, 64) || !str(row.messageId, 200) || !STATUSES.includes(row.status as BrowserTaskStatus) || !str(row.request, 4000) ||
      !Array.isArray(row.sites) || !row.sites.every(site => str(site, 260)) || !["request", "saved-job", "person", "none"].includes(row.siteSource as string) ||
      !nullable(row.savedJob, (v): v is string => str(v, 200)) || !num(row.minutes) || !num(row.budget) || !num(row.offerExpiresAt) ||
      !nullable(row.startedAt, num) || !nullable(row.expiresAt, num) || !nullable(row.endNote, (v): v is string => str(v, 500)) ||
      !Array.isArray(row.progress) || row.progress.length > 10 || !row.progress.every(line => str(line, 200))) invalid();
    let desktop: DesktopTarget | undefined;
    if (row.desktop !== undefined && row.desktop !== null) try { desktop = parseDesktopTarget(row.desktop); } catch { invalid(); }
    if (row.appTask !== undefined && row.appTask !== true) invalid();
    return {
      id: row.id as string, messageId: row.messageId as string, status: row.status as BrowserTaskStatus, request: row.request as string,
      sites: [...row.sites as string[]], siteSource: row.siteSource as BrowserTaskCardView["siteSource"], savedJob: row.savedJob as string | null,
      actions: list(row.actions, ACTIONS), consequential: list(row.consequential, KINDS), minutes: row.minutes as number, budget: row.budget as number,
      offerExpiresAt: row.offerExpiresAt as number, startedAt: row.startedAt as number | null, expiresAt: row.expiresAt as number | null, endNote: row.endNote as string | null,
      progress: [...row.progress as string[]], ...(desktop ? { desktop } : {}), ...(row.appTask ? { appTask: true as const } : {}),
    };
  });
  return { tasks, browser: { ready: browser.ready as boolean, name: browser.name as string | null } };
}

const STEP_WORDS: Array<[BrowserActionClass, string]> = [
  ["click", "Click links and ordinary buttons"],
  ["fill", "Fill in forms"],
  ["download", "Download files"],
  ["upload", "Upload files you give it (none given yet)"],
  ["keys", "Press keys such as Enter to search"],
  ["submit", "Submit this request"],
];
// In an app window Bud reads, presses, types and uses keys only (server/desktop-fence.ts).
const APP_STEP_WORDS: Array<[BrowserActionClass, string]> = [
  ["click", "Press ordinary buttons, tabs and menu items"],
  ["fill", "Type into fields"],
  ["keys", "Press Tab, Return, Escape and the arrow keys"],
];
/** Plain phrases for what the task may do, in the order a person reads them. */
export function browserTaskSteps(actions: readonly BrowserActionClass[], app = false): string[] {
  const [first, words] = app ? ["Read the window and scroll it", APP_STEP_WORDS] : ["Open pages and read them", STEP_WORDS];
  return [first, ...words.filter(([action]) => actions.includes(action)).map(([, phrase]) => phrase)];
}

const DESKTOP_TASK_LIMITS = "It asks you before pressing anything that pays, sends, signs or deletes, and shows you the app's own words for that button. Signing in and passwords stay with you. If the window closes or another app takes it over, the task ends.";
/** What a task given an app window may and may not do there, in plain words. */
export const DESKTOP_TASK_SCOPE = `Bud works only in this window. ${DESKTOP_TASK_LIMITS}`;
/** The same, before the person has chosen the window. */
export const DESKTOP_TASK_CHOOSE = `Bud works only in the window you choose. ${DESKTOP_TASK_LIMITS}`;
/** The card's title for a task in an app window, chosen or still to choose. */
export const APP_TASK_TITLE = "Task in an app on this computer";

const ASK_WORDS: Record<BrowserConsequentialKind, string> = {
  pay: "payments", sign: "signatures", send: "messages", notice: "notices", delete: "deletions", "account-change": "account changes",
};
/** The line saying which steps always ask first, from the task's own list. Null when it has none. */
export function browserTaskAsksFirst(kinds: readonly BrowserConsequentialKind[]): string | null {
  const words = KINDS.filter(kind => kinds.includes(kind)).map(kind => ASK_WORDS[kind]);
  if (!words.length) return null;
  const listed = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : words[0];
  return `${listed.charAt(0).toUpperCase()}${listed.slice(1)} each ask you separately, with the exact details from the page.`;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** For a task that cannot submit or upload (typing in a search box is still looking): what Bud does, in one plain line. Null otherwise. */
export function browserTaskLooksOnly(task: Pick<BrowserTaskCardView, "actions" | "sites">): string | null {
  if (task.actions.includes("submit") || task.actions.includes("upload")) return null;
  return `Bud only looks: it opens ${task.sites[0] ?? "the site"}, reads pages and follows links. It changes nothing there without asking you first.`;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const ENDED: Partial<Record<BrowserTaskStatus, string>> = {
  declined: "Not started. Nothing was done in your browser.",
  "saved-as-job": "Saved as a job instead. Bud's reply below has the plan.",
};
/** The status line under the card's title. */
export function browserTaskStatusLine(task: BrowserTaskCardView, now: number): string {
  if (task.status === "proposed") return now > task.offerExpiresAt ? "This request is from more than an hour ago. Ask again to start it." : "Needs your go-ahead";
  if (task.status === "paused") return "Paused for you to sign in · sign in on the page, then continue from the handover";
  const where = task.desktop ? task.desktop.appName : "your browser";
  if (task.status === "active") return task.expiresAt ? `Running in ${where} · ends by ${clock(task.expiresAt)} or after ${task.budget} steps` : `Running in ${where}`;
  return ENDED[task.status] ?? task.endNote ?? "This task has ended.";
}

/** The open app windows, read only while the person is choosing what the task works in. The list re-reads
 * quietly (keeping what is shown) when the picker opens or RealBud regains focus, so a window opened after the
 * card appeared is offered without a new card. */
function useDesktopWindows(enabled: boolean): [DesktopWindowsState, () => void, () => void] {
  const [state, setState] = useState<DesktopWindowsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setState({ status: "loading" });
    void loadDesktopWindows(api).then(next => { if (current) setState(next); });
    return () => { current = false; };
  }, [enabled, attempt]);
  const reading = useRef(false);
  const reread = useCallback(() => {
    if (reading.current) return; // a click fires both focus and mousedown: one read
    reading.current = true;
    void loadDesktopWindows(api).then(next => { if (next.status === "ready") setState(next); }).finally(() => { reading.current = false; });
  }, []);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [enabled, reread]);
  return [state, useCallback(() => setAttempt(n => n + 1), []), reread];
}

/** "or an app on this computer": a native list of open windows, or why there is none. */
export function DesktopWindowPicker({ state, value, disabled = false, onChange, onRetry, onOpen, heading = "or an app on this computer" }: {
  state: DesktopWindowsState;
  value: string;
  disabled?: boolean;
  onChange: (windowId: string) => void;
  onRetry: () => void;
  /** The person is opening the list: re-read the open windows. */
  onOpen?: () => void;
  heading?: string;
}) {
  const id = useId();
  if (state.status === "unavailable") return <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">Apps on this computer aren't available here.</p>;
  if (state.status === "ready" && state.windows.length) return (
    <div className="mt-2">
      <label htmlFor={id} className="block text-[12px] text-ink-muted">{heading}</label>
      <select id={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} onFocus={onOpen} onMouseDown={onOpen}
        className="pm-control mt-0.5 w-full rounded border border-line bg-paper px-3 text-[14px] text-ink disabled:opacity-50">
        <option value="">Choose an open app window</option>
        {state.windows.map(window => <option key={window.windowId} value={String(window.windowId)}>{desktopWindowLabel(window)}</option>)}
      </select>
    </div>
  );
  const note = state.status === "loading" ? "Looking for open apps…"
    : state.status === "error" ? "RealBud couldn't list the open apps." : "No app windows are open. Open the app, then check again.";
  return (
    <div className="mt-2">
      <p className="text-[12px] text-ink-muted">{heading}</p>
      <p role="status" className="flex flex-wrap items-center gap-x-2 text-[13px] leading-relaxed text-ink-secondary">
        {note}
        {state.status === "loading" ? null : (
          <button type="button" disabled={disabled} onClick={onRetry} className="pm-control rounded px-2 text-[13px] text-agency underline-offset-2 hover:underline disabled:opacity-50">Check again</button>
        )}
      </p>
    </div>
  );
}

export function BrowserTaskCard({ task, browser, now = Date.now(), busy = false, error, onStart, onStartWindow, onDecline, onSaveJob, onStop }: {
  task: BrowserTaskCardView;
  browser: BrowserTaskBrowser;
  now?: number;
  busy?: boolean;
  error?: string | null;
  onStart: (site?: string) => void;
  /** Starts the task in one app window instead of a site. Without it the card offers sites only. */
  onStartWindow?: (window: DesktopTarget) => void;
  onDecline: () => void;
  onSaveJob: () => void;
  onStop: () => void;
}) {
  const reasonId = useId();
  const siteId = useId();
  const [site, setSite] = useState("");
  const [windowId, setWindowId] = useState("");
  const app = task.desktop;
  const offered = task.status === "proposed" && now <= task.offerExpiresAt;
  const needsSite = offered && task.sites.length === 0 && !app;
  const [windows, recheckWindows, rereadWindows] = useDesktopWindows(needsSite && Boolean(onStartWindow));
  const choices = windows.status === "ready" ? windows.windows : [];
  const chosen = choices.find(window => String(window.windowId) === windowId) ?? null;
  // Asked for an app ("… in the Notepad app"): the card asks only for the window, never a site.
  const pickApp = needsSite && Boolean(task.appTask && onStartWindow);
  const blocked = !needsSite || chosen ? null
    : pickApp ? "Choose the app window to start."
      : site.trim() ? null
        : choices.length && onStartWindow ? "Enter the site's web address or choose an app window to start." : "Enter the site's web address to start.";
  const inApp = Boolean(app || chosen || task.appTask);
  const kind = inApp ? APP_TASK_TITLE : "Browser task";
  const title = task.status === "active" ? `${kind} · running` : kind;
  const where = app ? app.appName : inApp ? "the app" : "your browser";
  const asksFirst = inApp ? "Anything that pays, sends, signs or deletes asks you first, with the app's own words for that button." : browserTaskAsksFirst(task.consequential);
  // What Bud will do, before and while it runs; once it ends the progress line says what it did.
  const live = offered || task.status === "active" || task.status === "paused";
  const looksOnly = live && !inApp ? browserTaskLooksOnly(task) : null;
  const appScope = !live || !inApp ? null : app ? DESKTOP_TASK_SCOPE : DESKTOP_TASK_CHOOSE;
  const start = () => chosen && onStartWindow ? onStartWindow(chosen) : onStart(needsSite ? site.trim() : undefined);
  const Icon = app ? AppWindow : Globe;
  return (
    <section aria-label={kind} className={cn("w-full max-w-[48rem] rounded-lg border bg-sheet", task.status === "active" ? "border-portal/40" : "border-line")}>
      <div className="px-4 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted"><Icon size={13} aria-hidden="true" />{title}</span>
          <span role="status" className={cn("text-[12px]", task.status === "active" ? "text-portal" : "text-ink-muted")}>{browserTaskStatusLine(task, now)}</span>
        </div>
        <h3 className="mt-1 break-words text-[15px] font-semibold leading-snug text-ink">{sentence(task.request)}</h3>
        {looksOnly ? <p className="mt-1 text-[14px] leading-relaxed text-ink-secondary">{looksOnly}</p> : null}
        {appScope ? <p className="mt-1 text-[14px] leading-relaxed text-ink-secondary">{appScope}</p> : null}
        {task.progress.length ? <p aria-label="Progress" className="mt-1 break-words text-[13px] leading-relaxed text-ink-muted">{task.progress.join(" · ")}</p> : null}
        <dl aria-label="What this task covers" className="mt-2 divide-y divide-line border-y border-line text-[14px]">
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[12px] text-ink-muted">{app || pickApp ? "App window" : "Site"}</dt>
            <dd className="min-w-0 break-words text-ink">
              {app ? desktopWindowLabel(app) : task.sites.length ? task.sites.join(", ") : pickApp ? (
                <DesktopWindowPicker state={windows} value={windowId} disabled={busy} onRetry={recheckWindows} onOpen={rereadWindows}
                  heading="Choose the window Bud works in" onChange={setWindowId} />
              ) : needsSite ? (
                <>
                  <label htmlFor={siteId} className="sr-only">Site web address</label>
                  <input id={siteId} type="text" inputMode="url" autoComplete="off" spellCheck={false} value={site}
                    onChange={event => { setSite(event.target.value); if (event.target.value.trim()) setWindowId(""); }}
                    placeholder="for example vantagestrata.com.au" className="pm-control w-full rounded border border-line bg-paper px-3 text-[14px] text-ink" />
                  {onStartWindow ? (
                    <DesktopWindowPicker state={windows} value={windowId} disabled={busy} onRetry={recheckWindows} onOpen={rereadWindows}
                      onChange={next => { setWindowId(next); if (next) setSite(""); }} />
                  ) : null}
                </>
              ) : "No site"}
              {task.savedJob && task.sites.length ? <span className="block text-[12px] text-ink-muted">From your saved job “{task.savedJob}”</span> : null}
            </dd>
          </div>
          {inApp ? null : (
            <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="text-[12px] text-ink-muted">Browser</dt>
              <dd className="min-w-0 text-ink">{browser.ready ? `${browser.name ?? "Your selected browser"} on this computer` : "Work browser on this computer · opens when you start"}</dd>
            </div>
          )}
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[12px] text-ink-muted">Bud can</dt>
            <dd className="min-w-0 text-ink"><ul className="list-disc pl-4">{browserTaskSteps(task.actions, inApp).map(step => <li key={step}>{step}</li>)}</ul></dd>
          </div>
          {asksFirst ? (
            <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="text-[12px] text-ink-muted">Asks you first</dt>
              <dd className="min-w-0 text-ink">{asksFirst}</dd>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[12px] text-ink-muted">Time and step limit</dt>
            <dd className="min-w-0 text-ink tabular-nums">{`${task.minutes} minutes or ${task.budget} steps in ${chosen ? chosen.appName : where}, whichever comes first. Stop ends it at any time.`}</dd>
          </div>
        </dl>
      </div>
      <div className="flex w-full flex-col gap-2 px-4 py-3">
        {error ? <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p> : null}
        {offered ? (
          <>
            {blocked ? <p id={reasonId} className="text-[13px] leading-relaxed text-hold">{blocked}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={busy || blocked !== null} aria-describedby={blocked ? reasonId : undefined} aria-busy={busy || undefined}
                onClick={start}
                className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white transition-colors hover:bg-agency-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-agency">
                {busy ? "Starting…" : "Start this task"}
              </button>
              <button type="button" disabled={busy} onClick={onDecline} className="pm-control rounded border border-line px-3.5 text-[14px] text-ink transition-colors hover:bg-selected disabled:opacity-50">
                Not now
              </button>
              <button type="button" disabled={busy} onClick={onSaveJob} className="pm-control rounded px-3 text-[14px] text-agency underline-offset-2 hover:underline disabled:opacity-50">
                Save as a job instead
              </button>
            </div>
          </>
        ) : task.status === "active" ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={onStop} title={app ? `Ends this task and its access to ${app.appName}. Nothing more is pressed.` : "Ends this task and its browser access. Nothing more is pressed."}
              className="pm-control inline-flex items-center gap-1.5 rounded border border-line px-3.5 text-[14px] text-ink transition-colors hover:bg-selected disabled:opacity-50">
              <Square size={12} className="fill-current" aria-hidden="true" />
              Stop the task
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The thread's task cards, keyed by the Ask reply each belongs to, and the
 * person's answers to them. Loaded only for threads that offered one. */
export function useBrowserTasks({ threadId, messages, busy, enabled, onInterrupt }: {
  threadId: string;
  messages: Message[];
  busy: boolean;
  enabled: boolean;
  onInterrupt: () => void;
}) {
  const offered = enabled && messages.some(message => message.role === "bot" && message.kind === "text" && Boolean(message.text?.includes(BROWSER_TASK_OFFER_MARK)));
  const [state, setState] = useState<BrowserTaskList | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    try {
      const next = parseBrowserTaskList(await api(`/api/browser/tasks?threadId=${encodeURIComponent(threadId)}`, undefined, { timeoutMs: 10_000 }));
      if (request === epoch.current) setState(next);
    } catch {
      if (request === epoch.current) setState(null);
    }
  }, [threadId]);
  useEffect(() => {
    if (offered) void refresh();
    else setState(null);
  }, [offered, refresh, messages.length, busy]);
  /** `target` is the site the person typed, or the app window they chose. */
  const act = useCallback(async (id: string, action: BrowserTaskAction, target?: string | DesktopTarget) => {
    if (acting) return;
    setActing(id); setError(null);
    try {
      await api(`/api/browser/tasks/${id}/${action}`, { method: "POST", body: JSON.stringify({ threadId, ...(!target ? {} : typeof target === "string" ? { site: target } : desktopStartBody(target)) }) }, { timeoutMs: 90_000 });
      // Stop takes the grant away first; the Ask Stop then ends the turn.
      if (action === "stop") onInterrupt();
    } catch (cause) {
      const known = typeof (cause as { status?: unknown })?.status === "number";
      if (action === "stop") onInterrupt();
      setError({ id, text: known ? (cause as Error).message
        : action === "start" ? "RealBud could not confirm whether this task started. Check the conversation before pressing Start again."
          : "RealBud could not confirm this change. Check the task again before retrying." });
    } finally {
      setActing(null);
      void refresh();
    }
  }, [acting, onInterrupt, refresh, threadId]);
  const byMessage = useMemo(() => Object.fromEntries((state?.tasks ?? []).map(task => [task.messageId, task])), [state]);
  return { byMessage, browser: state?.browser ?? NO_BROWSER, acting, error, act, refresh };
}

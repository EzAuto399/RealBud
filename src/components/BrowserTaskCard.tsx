// A one-off browser task from Ask, as one decision: the site, the browser,
// what Bud may do there, what always asks first, and how long it lasts.
// Start saves the grant on the server; Stop ends it for good. The server is
// the authority: this card only shows what the saved task allows.
import { Globe, Square } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BrowserActionClass, BrowserConsequentialKind } from "@shared/browser-task";
import { api, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

/** The Ask reply that carries a task card contains this button name. */
export const BROWSER_TASK_OFFER_MARK = "**Start this task**";

export type BrowserTaskStatus = "proposed" | "declined" | "saved-as-job" | "active" | "finished" | "stopped" | "expired" | "budget" | "interrupted";
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
}
export interface BrowserTaskBrowser { ready: boolean; name: string | null }
export interface BrowserTaskList { tasks: BrowserTaskCardView[]; browser: BrowserTaskBrowser }
export type BrowserTaskAction = "start" | "decline" | "save-job" | "stop";
const NO_BROWSER: BrowserTaskBrowser = { ready: false, name: null };

const STATUSES: readonly BrowserTaskStatus[] = ["proposed", "declined", "saved-as-job", "active", "finished", "stopped", "expired", "budget", "interrupted"];
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
      !nullable(row.startedAt, num) || !nullable(row.expiresAt, num) || !nullable(row.endNote, (v): v is string => str(v, 500))) invalid();
    return {
      id: row.id as string, messageId: row.messageId as string, status: row.status as BrowserTaskStatus, request: row.request as string,
      sites: [...row.sites as string[]], siteSource: row.siteSource as BrowserTaskCardView["siteSource"], savedJob: row.savedJob as string | null,
      actions: list(row.actions, ACTIONS), consequential: list(row.consequential, KINDS), minutes: row.minutes as number, budget: row.budget as number,
      offerExpiresAt: row.offerExpiresAt as number, startedAt: row.startedAt as number | null, expiresAt: row.expiresAt as number | null, endNote: row.endNote as string | null,
    };
  });
  return { tasks, browser: { ready: browser.ready as boolean, name: browser.name as string | null } };
}

const STEP_WORDS: Array<[BrowserActionClass, string]> = [
  ["fill", "Type into ordinary fields and choose options"],
  ["download", "Download files into this task's private folder"],
  ["upload", "Upload files you give this task (none given yet)"],
  ["keys", "Press keys such as Enter in a search box"],
  ["submit", "Press Submit on the form you asked about"],
];
/** Plain phrases for what the task may do, in the order a person reads them. */
export function browserTaskSteps(actions: readonly BrowserActionClass[]): string[] {
  const steps = ["Open and read pages on the site", ...(actions.includes("click") ? ["Follow links and press ordinary buttons"] : [])];
  return [...steps, ...STEP_WORDS.filter(([action]) => actions.includes(action)).map(([, words]) => words)];
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const ENDED: Partial<Record<BrowserTaskStatus, string>> = {
  declined: "Not started. Nothing was done in your browser.",
  "saved-as-job": "Saved as a job instead. Bud's reply below has the plan.",
};
/** The status line under the card's title. */
export function browserTaskStatusLine(task: BrowserTaskCardView, now: number): string {
  if (task.status === "proposed") return now > task.offerExpiresAt ? "This request is from more than an hour ago. Ask again to start it." : "Needs your go-ahead";
  if (task.status === "active") return task.expiresAt ? `Running in your browser · ends by ${clock(task.expiresAt)} or after ${task.budget} browser steps` : "Running in your browser";
  return ENDED[task.status] ?? task.endNote ?? "This task has ended.";
}

export function BrowserTaskCard({ task, browser, now = Date.now(), busy = false, error, onStart, onDecline, onSaveJob, onStop, onConnect }: {
  task: BrowserTaskCardView;
  browser: BrowserTaskBrowser;
  now?: number;
  busy?: boolean;
  error?: string | null;
  onStart: (site?: string) => void;
  onDecline: () => void;
  onSaveJob: () => void;
  onStop: () => void;
  onConnect: () => void;
}) {
  const reasonId = useId();
  const siteId = useId();
  const [site, setSite] = useState("");
  const offered = task.status === "proposed" && now <= task.offerExpiresAt;
  const needsSite = offered && task.sites.length === 0;
  const blocked = !browser.ready ? "Connect your browser before starting. Bud works in the browser you choose on this computer, where you are already signed in."
    : needsSite && !site.trim() ? "Enter the site's web address to start." : null;
  const title = task.status === "active" ? "Browser task · running" : "Browser task";
  return (
    <section aria-label="Browser task" className={cn("w-full max-w-[48rem] rounded-lg border bg-sheet", task.status === "active" ? "border-portal/40" : "border-line")}>
      <div className="px-4 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted"><Globe size={13} aria-hidden="true" />{title}</span>
          <span role="status" className={cn("text-[12px]", task.status === "active" ? "text-portal" : "text-ink-muted")}>{browserTaskStatusLine(task, now)}</span>
        </div>
        <h3 className="mt-1 break-words text-[15px] font-semibold leading-snug text-ink">{task.request}</h3>
        <dl aria-label="What this task covers" className="mt-2 divide-y divide-line border-y border-line text-[14px]">
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[12px] text-ink-muted">Site</dt>
            <dd className="min-w-0 break-words text-ink">
              {task.sites.length ? task.sites.join(", ") : needsSite ? (
                <>
                  <label htmlFor={siteId} className="sr-only">Site web address</label>
                  <input id={siteId} type="text" inputMode="url" autoComplete="off" spellCheck={false} value={site} onChange={event => setSite(event.target.value)}
                    placeholder="for example vantagestrata.com.au" className="pm-control w-full rounded border border-line bg-paper px-3 text-[14px] text-ink" />
                </>
              ) : "No site"}
              {task.savedJob && task.sites.length ? <span className="block text-[12px] text-ink-muted">From your saved job “{task.savedJob}”</span> : null}
            </dd>
          </div>
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[12px] text-ink-muted">Browser</dt>
            <dd className={cn("min-w-0", browser.ready ? "text-ink" : "text-hold")}>{browser.ready ? `${browser.name ?? "Your selected browser"} on this computer` : "Not connected"}</dd>
          </div>
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[12px] text-ink-muted">Bud may</dt>
            <dd className="min-w-0 text-ink"><ul className="list-disc pl-4">{browserTaskSteps(task.actions).map(step => <li key={step}>{step}</li>)}</ul></dd>
          </div>
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[12px] text-ink-muted">Always asks you</dt>
            <dd className="min-w-0 text-ink">Each payment, signature, message, notice, deletion or account change, separately, with the exact details from the page.</dd>
          </div>
          <div className="grid grid-cols-1 gap-x-3 gap-y-0.5 py-2 min-[720px]:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-[12px] text-ink-muted">Ends</dt>
            <dd className="min-w-0 text-ink tabular-nums">{`${task.minutes} minutes after you start it, or after ${task.budget} browser steps. Stop ends it at any time.`}</dd>
          </div>
        </dl>
      </div>
      <div className="flex w-full flex-col gap-2 px-4 py-3">
        {error ? <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p> : null}
        {offered ? (
          <>
            {blocked ? <p id={reasonId} className="text-[13px] leading-relaxed text-hold">{blocked}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              {browser.ready ? (
                <button type="button" disabled={busy || blocked !== null} aria-describedby={blocked ? reasonId : undefined} aria-busy={busy || undefined}
                  onClick={() => onStart(needsSite ? site.trim() : undefined)}
                  className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white transition-colors hover:bg-agency-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-agency">
                  {busy ? "Starting…" : "Start this task"}
                </button>
              ) : (
                <button type="button" onClick={onConnect} aria-describedby={reasonId}
                  className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white transition-colors hover:bg-agency-hover">
                  Connect your browser
                </button>
              )}
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
            <button type="button" disabled={busy} onClick={onStop} title="Ends this task and its browser access. Nothing more is pressed."
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
  const act = useCallback(async (id: string, action: BrowserTaskAction, site?: string) => {
    if (acting) return;
    setActing(id); setError(null);
    try {
      await api(`/api/browser/tasks/${id}/${action}`, { method: "POST", body: JSON.stringify({ threadId, ...(site ? { site } : {}) }) }, { timeoutMs: 90_000 });
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
  return { byMessage, browser: state?.browser ?? NO_BROWSER, acting, error, act };
}

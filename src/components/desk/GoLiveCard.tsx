import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, Circle, CircleDashed, CircleHelp, LoaderCircle } from "lucide-react";

import { parseAustinPackView } from "@shared/austin-pack";
import { budAutoSetupView } from "@/lib/bud-setup";
import {
  SETUP_STEP_COUNT,
  officeAppsToConnect,
  readAgencySetupFacts,
  readWebsiteLinkState,
  setupSequence,
  setupSequenceComplete,
  sharedGmailNotAllowed,
  type AgencySetupRead,
  type AustinPackRead,
  type ScheduleRead,
  type SetupStep,
  type WebsiteLinkRead,
} from "@/lib/setup-sequence";
import { useOfficeSources } from "@/lib/connected-apps-refresh";
import { SET_UP_DISMISSED, firstDayContext, firstDayItems, readGetStartedLocal, saveGetStartedLocal, type FirstDayItem, type GetStartedLocal } from "@/lib/first-day";
import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { api, useStore } from "@/state/store";
import { OwnerRequestButton } from "../OwnerRequestButton";

const STATE_LABEL: Record<SetupStep["state"], string> = {
  done: "Done",
  current: "Now",
  working: "Working",
  later: "Later",
  unknown: "Not checked yet",
  skipped: "Skipped",
};

type Read<T> = T | "unavailable" | undefined;
const READ_TIMEOUT_MS = 15_000;
/** A busy PC can miss one 15 s window (Windows issues #15), so a failed read tries again a few times. */
export const READ_RETRY_DELAYS_MS = [3_000, 10_000, 30_000];

/**
 * Bounded reads of one path: a hung or failed read becomes "unavailable",
 * never a permanent "Reading…"; a failed read tries again a few times.
 */
export function boundedRead<T>(path: string, parse: (body: unknown) => T, set: (update: (previous: Read<T>) => Read<T>) => void) {
  let alive = true;
  let controller: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const load = (attempt: number) => {
    controller?.abort();
    clearTimeout(retry);
    const current = new AbortController();
    controller = current;
    const timer = setTimeout(() => current.abort(), READ_TIMEOUT_MS);
    void api(path, { signal: current.signal })
      .then((body: unknown) => {
        if (!alive || controller !== current) return;
        const next = parse(body);
        set(() => next);
      })
      .catch(() => {
        if (!alive || controller !== current) return;
        // Absent evidence is never evidence: a failed read is unknown, never the last good value.
        set(() => "unavailable");
        if (attempt < READ_RETRY_DELAYS_MS.length) retry = setTimeout(() => load(attempt + 1), READ_RETRY_DELAYS_MS[attempt]);
      })
      .finally(() => clearTimeout(timer));
  };
  return {
    refresh: () => load(0),
    stop: () => {
      alive = false;
      controller?.abort();
      clearTimeout(retry);
    },
  };
}

function useBoundedRead<T>(path: string, parse: (body: unknown) => T, skip: boolean, refreshEvent?: string): Read<T> {
  const [value, setValue] = useState<Read<T>>(undefined);
  useEffect(() => {
    if (skip) return;
    const read = boundedRead(path, parse, setValue);
    read.refresh();
    if (refreshEvent) window.addEventListener(refreshEvent, read.refresh);
    return () => {
      read.stop();
      if (refreshEvent) window.removeEventListener(refreshEvent, read.refresh);
    };
    // `parse` is a module-level function at every call site.
  }, [path, skip, refreshEvent]);
  return value;
}

function setUpDismissed(): boolean {
  try { return localStorage.getItem(SET_UP_DISMISSED) === "1"; } catch { return false; }
}
/** Remembers on this computer that the person has seen the set-up line. */
export function dismissSetUp() {
  try { localStorage.setItem(SET_UP_DISMISSED, "1"); } catch { /* hidden for this session only */ }
}

/**
 * "Get started": the one setup checklist, on Desk. Five steps that tick from
 * the host's own facts; once every step is done it folds to one line the
 * person can dismiss on this computer.
 */
export function GoLiveCard({
  agencyName,
  compact = false,
  agencySetup,
  websiteLink,
  austinPack,
  menu,
  inert,
  quiet = false,
}: {
  agencyName: string;
  /** Another card holds Desk's one primary action (REI sign-in): this card's action is not filled. */
  quiet?: boolean;
  /** Desk's per-card menu, placed beside the card (and gone with it). */
  menu?: ReactNode;
  /** True while a Desk drawer covers the card. */
  inert?: boolean;
  /** Desk shows a Hide control that folds the card to one line. */
  compact?: boolean;
  /** Supply the host facts to skip this card's own bounded reads of them. */
  agencySetup?: AgencySetupRead;
  websiteLink?: WebsiteLinkRead;
  austinPack?: AustinPackRead;
}) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(true);
  const [doneDismissed, setDoneDismissed] = useState(setUpDismissed);
  // Skipped steps, tried workflows and the dismissed guide: this computer's own choices.
  const [local, setLocal] = useState<GetStartedLocal>(readGetStartedLocal);
  const [guideOpen, setGuideOpen] = useState<boolean | null>(null);
  const keep = (next: GetStartedLocal) => { setLocal(next); saveGetStartedLocal(next); };
  // Unknown setup state stays unknown: a failed or slow read may never read as
  // finished setup, so the step carries its own honest wording instead.
  const agencyRead = useBoundedRead("/api/agency-setup", readAgencySetupFacts, agencySetup !== undefined);
  const packRead = useBoundedRead("/api/austin-pack", parseAustinPackView, austinPack !== undefined);
  // Step 1 re-reads whenever the link card in Workspace changes the link, so it
  // ticks without a reload.
  const linkRead = useBoundedRead("/api/office-link", readWebsiteLinkState, websiteLink !== undefined, "realbud-website-link-changed");
  // The store already hydrates the loops once per session, so the workflow step
  // reuses that slice. Anything short of a finished read stays "not checked yet".
  const routines = state?.activityLoad?.routines;
  const schedule: ScheduleRead =
    routines === "ready"
      ? {
          read: "ready",
          loops: (state.loops ?? []).map((loop) => ({
            id: loop.id,
            name: loop.name,
            available: loop.available,
            enabled: loop.enabled,
            nextRunAt: loop.nextRunAt,
          })),
        }
      : { read: routines === "error" ? "error" : "loading" };
  // Bud ticks only on the server's own readiness verdict.
  const hermes = state?.hermes ?? null;
  const auto = budAutoSetupView(hermes);
  // The app-wide office-source watch already keeps this snapshot fresh.
  const { snapshot: officeSnapshot } = useOfficeSources();
  const steps = setupSequence({
    officeAgencyName: agencyName,
    agencySetup: agencySetup ?? agencyRead,
    austinPack: austinPack ?? packRead,
    websiteLink: websiteLink ?? linkRead,
    bud: hermes ? { ready: hermes.ready, working: Boolean(auto?.working), detail: auto && !auto.working ? auto.detail : null } : undefined,
    schedule,
    appsToConnect: officeAppsToConnect(officeSnapshot, state?.config?.composio?.managed === true),
    sharedGmailBlocked: sharedGmailNotAllowed(officeSnapshot, state?.config?.composio?.managed === true),
    skipped: local.skipped as SetupStep["id"][],
  });
  const firstDay = local.guideDismissed ? [] : firstDayItems(austinPack ?? packRead);
  const tryItem = (item: FirstDayItem) => {
    if (!local.tried.includes(item.loopId)) keep({ ...local, tried: [...local.tried, item.loopId] });
    dispatch({ type: "stageAskContext", context: firstDayContext(item, crypto.randomUUID()) });
  };

  const openStep = (step: SetupStep) => {
    if (step.target === "bud-setup") {
      openWorkspaceSetup("bud");
      return;
    }
    if (typeof location !== "undefined") location.hash = step.target;
    if (step.target.startsWith("you-")) {
      dispatch({ type: "showYou" });
      return;
    }
    // Schedule's own section scroll runs off the hash once its screen mounts;
    // the direct call covers the case where that section is already on screen.
    dispatch({ type: "showRoutines" });
    if (typeof document !== "undefined") document.getElementById(step.target)?.scrollIntoView({ block: "start" });
  };

  const frame = (card: ReactNode) => (
    <div className="mb-3 flex items-start gap-2" inert={inert}>
      <div className="min-w-0 flex-1">{card}</div>
      {menu}
    </div>
  );

  const complete = setupSequenceComplete(steps);
  const guide = firstDay.length ? (
    <FirstDayGuide
      items={firstDay}
      tried={local.tried}
      open={guideOpen ?? complete}
      onToggle={() => setGuideOpen(!(guideOpen ?? complete))}
      onTry={tryItem}
      onDismiss={() => keep({ ...local, guideDismissed: true })}
    />
  ) : null;

  // Every step done: one calm line until dismissed, and the first-day guide while it stays. Setup never claims workflow readiness.
  if (complete) {
    if (doneDismissed && !guide) return null;
    return frame(
      <section className="rounded-lg border border-line bg-sheet px-3.5 py-2" aria-label="Get started">
        {doneDismissed ? null : (
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-[13px] text-ink">
              <CheckCircle2 size={16} className="shrink-0 text-agency" aria-hidden />
              You’re set up. Ask Bud whenever you need a hand.
            </p>
            <button
              type="button"
              onClick={() => {
                dismissSetUp();
                setDoneDismissed(true);
              }}
              className="pm-control shrink-0 px-2 text-[12px] text-ink-muted hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        )}
        {guide}
      </section>
    );
  }

  const doneCount = steps.filter((step) => step.state === "done").length;
  const skippedCount = steps.filter((step) => step.state === "skipped").length;
  const summary = `${doneCount} of ${SETUP_STEP_COUNT} done${skippedCount ? ` · ${skippedCount} skipped` : ""}`;
  const skip = (step: SetupStep) => keep({ ...local, skipped: [...local.skipped, step.id] });
  const unskip = (step: SetupStep) => keep({ ...local, skipped: local.skipped.filter((id) => id !== step.id) });

  if (compact && !open) {
    return frame(
      <section className="rounded-lg border border-line bg-sheet px-3.5 py-2" aria-label="Get started">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-h-8 w-full items-center justify-between gap-2 text-left text-[13px] text-ink"
        >
          <span>Get started · {summary}</span>
          <span className="text-[12px] text-agency">Open</span>
        </button>
      </section>
    );
  }

  return frame(
    <section className="rounded-lg border border-line bg-sheet px-3.5 py-3" aria-label="Get started">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-medium text-ink">Get started</h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">{summary}</p>
          <div
            role="progressbar"
            aria-label="Get started progress"
            aria-valuemin={0}
            aria-valuemax={SETUP_STEP_COUNT}
            aria-valuenow={doneCount}
            aria-valuetext={summary}
            className="mt-1.5 h-1 max-w-[16rem] overflow-hidden rounded-full bg-line"
          >
            <div className="h-full origin-left rounded-full bg-agency transition-transform duration-300 motion-reduce:transition-none" style={{ transform: `scaleX(${doneCount / SETUP_STEP_COUNT})` }} />
          </div>
        </div>
        {compact ? (
          <button type="button" onClick={() => setOpen(false)} className="min-h-8 px-1 text-[12px] text-ink-muted hover:text-ink">
            Hide
          </button>
        ) : null}
      </div>
      <ol aria-label="Get started steps" className="mt-2 divide-y divide-line">
        {steps.map((step) => {
          // Bud's step always offers its progress; any other step acts only on its turn.
          const action = step.state === "current" || (step.id === "bud" && step.state !== "done");
          // Any step but Bud's own can be put aside for now, and brought back.
          const canSkip = step.state === "current" && step.id !== "bud";
          return (
            <li key={step.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2">
              <StepIcon state={step.state} />
              <div className="min-w-0 flex-1 basis-[12rem]">
                <div className={`text-[13px] ${step.state === "current" ? "font-medium text-ink" : "text-ink-secondary"}`}>
                  {step.number}. {step.title}
                  {/* An unread step's own sentence already starts "Not checked yet." */}
                  {step.state === "unknown" ? null : <span className="text-[12px] text-ink-muted">{` · ${STATE_LABEL[step.state]}`}</span>}
                </div>
                {step.state !== "done" ? (
                  <p className={`mt-0.5 text-[12.5px] ${step.state === "unknown" ? "text-hold" : "text-ink-muted"}`}>{step.status}</p>
                ) : null}
              </div>
              {action || canSkip || step.state === "skipped" ? (
                <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
                  {canSkip ? (
                    <button type="button" onClick={() => skip(step)} aria-label={`Skip for now: ${step.title}`} className="pm-control rounded px-2 text-[13px] text-ink-secondary hover:bg-selected hover:text-ink">
                      Skip for now
                    </button>
                  ) : null}
                  {step.state === "skipped" ? (
                    <button type="button" onClick={() => unskip(step)} aria-label={`Back to this step: ${step.title}`} className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected">
                      Back to this step
                    </button>
                  ) : null}
                  {action && step.ownerRequest ? <OwnerRequestButton request={step.ownerRequest} /> : null}
                  {action && !step.ownerOnly ? (
                    <button
                      type="button"
                      onClick={() => openStep(step)}
                      aria-label={step.actionLabel}
                      className={`pm-control rounded border px-3 text-[13px] ${step.state === "current" && !quiet ? "border-agency bg-agency text-white hover:bg-agency-hover" : "border-line bg-sheet text-ink hover:bg-selected"}`}
                    >
                      {step.actionLabel}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {guide ? <div className="mt-1 border-t border-line pt-1">{guide}</div> : null}
    </section>
  );
}

/** Each role's workflows on a first day: what Bud will do, what it reads and what needs the person's OK, one line
 * each, and one "Try it with Bud" that puts the request in Work for the person to send. */
function FirstDayGuide({ items, tried, open, onToggle, onTry, onDismiss }: {
  items: readonly FirstDayItem[]; tried: readonly string[]; open: boolean; onToggle: () => void; onTry: (item: FirstDayItem) => void; onDismiss: () => void;
}) {
  const count = items.filter((item) => tried.includes(item.loopId)).length;
  return (
    <div role="group" aria-label="Your first day with Bud">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onToggle} aria-expanded={open} className="pm-control flex min-w-0 items-center gap-1.5 rounded text-left text-[13px] font-medium text-ink">
          <ChevronDown size={15} className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`} aria-hidden />
          <span>Your first day with Bud</span>
          <span className="font-normal text-ink-muted">· {count} of {items.length} tried</span>
        </button>
        <button type="button" onClick={onDismiss} aria-label="Dismiss the first-day guide" className="pm-control shrink-0 px-2 text-[12px] text-ink-muted hover:text-ink">
          Dismiss
        </button>
      </div>
      {open ? (
        <ol className="divide-y divide-line">
          {items.map((item) => {
            const done = tried.includes(item.loopId);
            return (
              <li key={item.loopId} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2">
                {done ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-agency" aria-label="Tried" /> : <Circle size={16} className="mt-0.5 shrink-0 text-ink-muted" aria-hidden />}
                <div className="min-w-0 flex-1 basis-[14rem] text-[12.5px] text-ink-secondary">
                  <p className="text-[13px] font-medium text-ink">{item.name}</p>
                  <p><span className="text-ink">Bud will:</span> {item.does}</p>
                  <p><span className="text-ink">Reads:</span> {item.reads}</p>
                  <p><span className="text-ink">Needs your OK:</span> {item.asks}</p>
                </div>
                <button type="button" onClick={() => onTry(item)} aria-label={`Try it with Bud: ${item.name}`} className="pm-control flex shrink-0 items-center gap-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected">
                  Try it with Bud
                  <ArrowRight size={14} aria-hidden />
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}

function StepIcon({ state }: { state: SetupStep["state"] }) {
  const className = "mt-0.5 shrink-0";
  if (state === "done") return <CheckCircle2 size={16} className={`${className} text-agency`} aria-hidden />;
  if (state === "working") return <LoaderCircle size={16} className={`${className} animate-spin text-agency motion-reduce:animate-none`} aria-hidden />;
  if (state === "unknown") return <CircleHelp size={16} className={`${className} text-hold`} aria-hidden />;
  if (state === "skipped") return <CircleDashed size={16} className={`${className} text-ink-muted`} aria-hidden />;
  return <Circle size={16} className={`${className} ${state === "current" ? "text-ink" : "text-ink-muted"}`} aria-hidden />;
}

import { useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Circle, CircleHelp, LoaderCircle } from "lucide-react";

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
import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { api, useStore } from "@/state/store";

const STATE_LABEL: Record<SetupStep["state"], string> = {
  done: "Done",
  current: "Now",
  working: "Working",
  later: "Later",
  unknown: "Not checked yet",
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

const SET_UP_DISMISSED = "realbud.get-started-done-dismissed.v1";
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
}: {
  agencyName: string;
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
  });

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

  // Every step done: one calm line until dismissed. Setup never claims workflow readiness.
  if (setupSequenceComplete(steps)) {
    if (doneDismissed) return null;
    return frame(
      <section className="flex items-center justify-between gap-2 rounded-lg border border-line bg-sheet px-3.5 py-2" aria-label="Get started">
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
      </section>
    );
  }

  const doneCount = steps.filter((step) => step.state === "done").length;
  const summary = `${doneCount} of ${SETUP_STEP_COUNT} done`;

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
        <div>
          <h2 className="text-[14px] font-medium text-ink">Get started</h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">{summary}</p>
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
              {action ? (
                <button
                  type="button"
                  onClick={() => openStep(step)}
                  aria-label={step.actionLabel}
                  className={`pm-control shrink-0 rounded border px-3 text-[13px] ${step.state === "current" ? "border-agency bg-agency text-white hover:bg-agency-hover" : "border-line bg-sheet text-ink hover:bg-selected"}`}
                >
                  {step.actionLabel}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StepIcon({ state }: { state: SetupStep["state"] }) {
  const className = "mt-0.5 shrink-0";
  if (state === "done") return <CheckCircle2 size={16} className={`${className} text-agency`} aria-hidden />;
  if (state === "working") return <LoaderCircle size={16} className={`${className} animate-spin text-agency motion-reduce:animate-none`} aria-hidden />;
  if (state === "unknown") return <CircleHelp size={16} className={`${className} text-hold`} aria-hidden />;
  return <Circle size={16} className={`${className} ${state === "current" ? "text-ink" : "text-ink-muted"}`} aria-hidden />;
}

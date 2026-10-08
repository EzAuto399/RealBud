// The one setup reading for the app (`setupState`): the office link, the pack
// or agency setup, Bud's status, the loops, office sources, REI sign-in and the
// updater, each read once and shared by every surface that asks.
import { useEffect, useState, useSyncExternalStore } from "react";
import { parseAustinPackView } from "@shared/austin-pack";
import { officeSourceState } from "@shared/office-sources";
import { modelAccessMessage } from "@/components/you/browser-link";
import { api, useStore, type HermesStatus } from "@/state/store";
import type { UpdaterState } from "@/types/ogb";
import type { OfficeLinkStatus } from "../../server/office-link";
import { budAutoSetupRetryable, budAutoSetupView } from "./bud-setup";
import { useOfficeSources } from "./connected-apps-refresh";
import { useReiSignIn } from "./rei-sign-in";
import {
  gmailReadyHere,
  officeAppsToConnect,
  readAgencySetupFacts,
  setupState,
  sharedGmailNotAllowed,
  type AgencySetupRead,
  type AustinPackRead,
  type BudRead,
  type LinkAttempt,
  type ScheduleRead,
  type SetupState,
  type SetupStepId,
  type WebsiteLinkRead,
} from "./setup-sequence";
import { useOfficeLinkView } from "./use-office-link";

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

/** One bounded read shared by every subscriber; it starts fresh ("not read yet") once nobody was watching. */
function sharedRead<T>(path: string, parse: (body: unknown) => T) {
  let value: Read<T>;
  let read: ReturnType<typeof boundedRead<T>> | null = null;
  const listeners = new Set<() => void>();
  const set = (update: (previous: Read<T>) => Read<T>) => {
    value = update(value);
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!read) {
        value = undefined;
        read = boundedRead(path, parse, set);
        read.refresh();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        read?.stop();
        read = null;
      };
    },
    snapshot: () => value,
    /** Read again now, for the surfaces already watching. */
    refresh: () => read?.refresh(),
  };
}

const agencyRead = sharedRead("/api/agency-setup", readAgencySetupFacts);
const packRead = sharedRead("/api/austin-pack", parseAustinPackView);
/** A pack import or agency save changed what setup reads: every watching surface reads it again. */
export function refreshSetupReads() {
  agencyRead.refresh();
  packRead.refresh();
}
const idle = () => () => {};
const unread = () => undefined;

function useShared<T>(read: ReturnType<typeof sharedRead<T>>, skip: boolean): Read<T> {
  return useSyncExternalStore(skip ? idle : read.subscribe, skip ? unread : read.snapshot, skip ? unread : read.snapshot);
}

// The last link attempt's outcome, reported by the surface that made it.
let attempt: LinkAttempt | null = null;
const attemptListeners = new Set<() => void>();
/** The link surface reports a refused code or a finished browser approval here; `null` clears it. */
export function noteLinkAttempt(next: LinkAttempt | null) {
  attempt = next;
  for (const listener of attemptListeners) listener();
}
const subscribeAttempt = (listener: () => void) => {
  attemptListeners.add(listener);
  return () => { attemptListeners.delete(listener); };
};

export interface SetupStateOptions {
  /** The agency name recorded on Desk's book, which counts for the pack step. */
  officeAgencyName?: string;
  /** Steps the person skipped for now on this computer. */
  skipped?: readonly SetupStepId[];
  /** Supply a host fact to skip its shared read (tests and previews). */
  agencySetup?: AgencySetupRead;
  austinPack?: AustinPackRead;
  websiteLink?: WebsiteLinkRead;
}

/** Bud's server status as setup reads it; `undefined` until it answers. */
function budRead(hermes: HermesStatus | null): BudRead {
  if (!hermes) return undefined;
  const view = budAutoSetupView(hermes);
  const auto = hermes.autoSetup;
  const stopped = auto?.state === "held" && (auto.code === "held_failed" || auto.code === "held_exhausted");
  return {
    ready: hermes.ready,
    working: Boolean(view?.working),
    detail: view && !view.working ? view.detail : null,
    ...(auto ? { step: auto.step, total: auto.total } : {}),
    ...(stopped ? { heldAt: auto.step } : {}),
    retryable: budAutoSetupRetryable(hermes),
    restartRequired: Boolean(hermes.restartRequired || auto?.code === "held_restart"),
    withdrawn: Boolean(hermes.modelAccess?.withdrawn),
  };
}

/** The app's one setup reading, plus the pack and agency reads it was built from. */
export function useSetupState(options: SetupStateOptions = {}): SetupState & { austinPack: AustinPackRead; agencySetup: AgencySetupRead } {
  const { state } = useStore();
  const office = useOfficeLinkView(Boolean(state?.connected) && options.websiteLink === undefined);
  const agencySetup = useShared(agencyRead, options.agencySetup !== undefined);
  const austinPack = useShared(packRead, options.austinPack !== undefined);
  const linkAttempt = useSyncExternalStore(subscribeAttempt, () => attempt, () => attempt);
  const { view: rei } = useReiSignIn();
  const { snapshot } = useOfficeSources();
  // The preload's updater bridge; absent in the browser and in tests.
  const [updater, setUpdater] = useState<UpdaterState | null>(null);
  useEffect(() => (typeof window === "undefined" ? undefined : window.ogb?.updater?.onState(setUpdater)), []);

  // The store hydrates the loops once per session. Anything short of a finished read stays "not checked yet".
  const routines = state?.activityLoad?.routines;
  const schedule: ScheduleRead = routines === "ready"
    ? { read: "ready", loops: (state.loops ?? []).map((loop) => ({ id: loop.id, name: loop.name, available: loop.available, enabled: loop.enabled, nextRunAt: loop.nextRunAt })) }
    : { read: routines === "error" ? "error" : "loading" };
  const managed = state?.config?.composio?.managed === true;
  const websiteLink = options.websiteLink ?? office.link;
  const linkedStatus = { state: "linked", provisioningSkipped: office.provisioningSkipped } as OfficeLinkStatus;
  const result = setupState({
    officeAgencyName: options.officeAgencyName,
    agencySetup: options.agencySetup ?? agencySetup,
    austinPack: options.austinPack ?? austinPack,
    websiteLink,
    bud: budRead(state?.hermes ?? null),
    schedule,
    appsToConnect: officeAppsToConnect(snapshot, managed),
    sharedGmailBlocked: sharedGmailNotAllowed(snapshot, managed),
    gmailReady: gmailReadyHere(snapshot, managed),
    skipped: options.skipped,
    office: { ...office, link: websiteLink ?? "unavailable" },
    linkAttempt: websiteLink === "linked" ? null : linkAttempt,
    // The website's own sentence for why it issued no model grant.
    modelAccessReason: office.provisioningSkipped ? modelAccessMessage(linkedStatus, { passive: true }) : null,
    rei,
    gmailDegraded: managed && Boolean(snapshot?.services?.gmail) && officeSourceState(snapshot, "gmail") === "degraded",
    updatePending: updater?.status === "downloaded",
  });
  return { ...result, austinPack: options.austinPack ?? austinPack, agencySetup: options.agencySetup ?? agencySetup };
}

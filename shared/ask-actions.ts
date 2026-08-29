import type { LoopId, NotifyChannel, RentSource, WorkRoutingPlan } from "./contracts.ts";
import { prettyOfficeName } from "./ask-connections.ts";

export const WORKER_ASK_ACTION_PROTOCOL = "realbud.propose-action.v1" as const;

export type AskActionStatus = "pending" | "allowed" | "denied" | "stale";
export type AskSetupTarget = "worker" | "desktop-reminders" | "connections" | "computer-use" | "composio-account";

export type AskConnectionChoice = {
  id: string;
  label: string;
  detail: string;
  target: AskSetupTarget;
  service: string;
};

export interface AskPropertyOptionPatch {
  rentSource?: RentSource;
  graceDays?: number;
  courtesyUntilDay?: number;
  notifyChannel?: NotifyChannel;
}

export interface AskPropertySummary {
  address: string;
  tenantName: string;
  tenantPhone: string;
  weeklyRentCents: number;
}

const WORK_ROUTING_PREFERENCES = new Set(["auto", "local-standard", "local-accelerated", "cloud-accelerated"]);
const WORK_ROUTING_MODES = new Set(["local-standard", "local-accelerated", "cloud-accelerated"]);
const WORK_ROUTE_KINDS = new Set([
  "structured-batch",
  "local-analysis",
  "remote-analysis",
  "scripted-browser",
  "isolated-browser",
  "remote-browser",
  "desktop-cua",
]);
const WORK_ROUTE_STATES = new Set(["ready", "gated"]);
const WORK_ROUTE_ISOLATIONS = new Set([
  "realbud-process",
  "realbud-workspace",
  "realbud-browser-profile",
  "remote-isolated",
  "visible-desktop",
]);

function boundedPlanInteger(value: unknown, maximum = 10_000): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function boundedPlanText(value: unknown, maximum = 500): value is string {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Ask messages are durable and may outlive the release that created them.
 * Validate the small, content-free route projection before either rendering
 * it or treating it as pre-execution truth. Unknown versions fail closed. */
export function readAskWorkRoutingPlan(value: unknown): WorkRoutingPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== "realbud.work-routing.v1" || raw.schemaVersion !== 1 ||
    (raw.preferenceConfigured !== undefined && typeof raw.preferenceConfigured !== "boolean") ||
    (raw.preferenceRevision !== undefined && !boundedPlanInteger(raw.preferenceRevision, Number.MAX_SAFE_INTEGER)) ||
    typeof raw.requestedMode !== "string" || !WORK_ROUTING_PREFERENCES.has(raw.requestedMode) ||
    typeof raw.selectedMode !== "string" || !WORK_ROUTING_MODES.has(raw.selectedMode) ||
    !boundedPlanInteger(raw.propertyCount) || !Array.isArray(raw.lanes) || raw.lanes.length > 7 ||
    !Array.isArray(raw.fallbackReasons) || raw.fallbackReasons.length > 10 ||
    !raw.estimate || typeof raw.estimate !== "object" || Array.isArray(raw.estimate) ||
    !raw.boundaries || typeof raw.boundaries !== "object" || Array.isArray(raw.boundaries)
  ) return null;

  const lanes = raw.lanes as unknown[];
  if (!lanes.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const lane = value as Record<string, unknown>;
    return typeof lane.kind === "string" && WORK_ROUTE_KINDS.has(lane.kind)
      && typeof lane.state === "string" && WORK_ROUTE_STATES.has(lane.state)
      && boundedPlanInteger(lane.itemCount)
      && boundedPlanInteger(lane.batchCount)
      && boundedPlanInteger(lane.concurrency, 32)
      && typeof lane.isolation === "string" && WORK_ROUTE_ISOLATIONS.has(lane.isolation)
      && boundedPlanText(lane.detail);
  })) return null;
  if (!(raw.fallbackReasons as unknown[]).every((reason) => boundedPlanText(reason))) return null;

  const estimate = raw.estimate as Record<string, unknown>;
  if (estimate.basis !== "measured" && estimate.basis !== "unavailable") return null;
  if (!boundedPlanText(estimate.detail)) return null;
  if (estimate.basis === "measured") {
    if (
      typeof estimate.minimumSeconds !== "number" || !Number.isFinite(estimate.minimumSeconds) || estimate.minimumSeconds < 0 ||
      typeof estimate.maximumSeconds !== "number" || !Number.isFinite(estimate.maximumSeconds) || estimate.maximumSeconds < estimate.minimumSeconds
    ) return null;
  } else if (estimate.minimumSeconds !== null || estimate.maximumSeconds !== null) return null;

  const boundaries = raw.boundaries as Record<string, unknown>;
  if (
    boundaries.cloudRequired !== false || boundaries.maxIsolatedBrowsers !== 2 || boundaries.maxDesktopCua !== 1 ||
    boundaries.workerOwnership !== "external-pinned-runtime" || boundaries.browserOwnership !== "realbud-only" ||
    boundaries.personalBrowserAccess !== false || boundaries.personalHermesAccess !== false
  ) return null;

  return value as WorkRoutingPlan;
}

/** Only a wholly ready, non-empty plan may be attached to an admitted task.
 * Gated route projections belong in readiness UI, not in executable cards. */
export function readAdmittedAskWorkRoutingPlan(value: unknown): WorkRoutingPlan | null {
  const plan = readAskWorkRoutingPlan(value);
  if (!plan) return null;
  const active = plan.lanes.filter((lane) => lane.itemCount > 0);
  return active.length > 0 && active.every((lane) => lane.state === "ready" && lane.concurrency > 0)
    ? plan
    : null;
}

interface AskActionBase {
  schemaVersion: 1;
  /** Server generated. Used as the idempotency key at the owning command. */
  id: string;
  status: AskActionStatus;
  title: string;
  detail: string;
  createdAt: number;
  decidedAt?: number;
  failure?: string;
}

export type AskActionProposal =
  | (AskActionBase & {
      kind: "run-routine";
      loopId: LoopId;
      loopName: string;
      expectedLoopRevision: number;
      /** Present only for admitted multi-property execution. Older durable
       * cards remain valid without it. */
      executionPlan?: WorkRoutingPlan;
    })
  | (AskActionBase & {
      kind: "change-routine";
      loopId: LoopId;
      loopName: string;
      expectedLoopRevision: number;
      before: { enabled: boolean; time: string; weekdays: number[] };
      after: { enabled: boolean; time: string; weekdays: number[] };
    })
  | (AskActionBase & {
      kind: "add-property";
      expectedDeskRevision: number;
      bookProposalIds: string[];
      properties: AskPropertySummary[];
    })
  | (AskActionBase & {
      kind: "configure-property";
      expectedDeskRevision: number;
      propertyId: string;
      address: string;
      before: Required<Pick<AskPropertyOptionPatch, "rentSource" | "graceDays" | "courtesyUntilDay" | "notifyChannel">>;
      changes: AskPropertyOptionPatch;
    })
  | (AskActionBase & {
      kind: "set-agency-name";
      expectedDeskRevision: number;
      beforeName: string;
      afterName: string;
    })
  | (AskActionBase & {
      kind: "open-setup";
      target: AskSetupTarget;
      service?: string;
    })
  | (AskActionBase & {
      kind: "choose-connection";
      options: AskConnectionChoice[];
      selectedId?: string;
    })
  | (AskActionBase & {
      kind: "prepare-handoff";
      expectedDeskRevision: number;
      draftId: string;
      workItemId: string;
      capabilityId: string;
      proposalHash: string;
      propertyId: string;
      address: string;
      draftKind: "courtesy-rent" | "levy-from-rent" | "owner-letter";
      mode: "practice" | "pilot";
    });

export interface AskActionApprovalCopy {
  permission: string;
  boundary: string;
  completed: string;
}

const HONORED_SETUP_WINDOW_MS = 12_000;

export type AskConnectRequest = {
  target: AskSetupTarget;
  service?: string;
};

/** Navigation-only setup the PM already asked for. Fresh allowed cards open
 * the Ask connect sheet; older receipts stay in the transcript. */
export function isCompletedToolConnect(action: AskActionProposal | undefined): boolean {
  return action?.kind === "open-setup" && /(?: connected| on this device)$/i.test(action.title ?? "");
}

export function honoredSetupRequest(
  action: AskActionProposal | undefined,
  now = Date.now(),
): AskConnectRequest | null {
  if (!action || action.status !== "allowed") return null;
  if (isCompletedToolConnect(action)) return null;
  const at = action.decidedAt ?? action.createdAt;
  if (!Number.isFinite(at) || now - at > HONORED_SETUP_WINDOW_MS) return null;
  if (action.kind === "open-setup") {
    return { target: action.target, ...(action.service ? { service: action.service } : {}) };
  }
  if (action.kind === "choose-connection" && action.selectedId) {
    const option = action.options.find((item) => item.id === action.selectedId);
    return {
      target: option?.target ?? "connections",
      ...(option?.service ? { service: option.service } : {}),
    };
  }
  return null;
}

export function honoredSetupNavigation(
  action: AskActionProposal | undefined,
  now = Date.now(),
): AskSetupTarget | null {
  return honoredSetupRequest(action, now)?.target ?? null;
}

export function isConnectSetupAction(
  action: AskActionProposal | undefined,
): action is Extract<AskActionProposal, { kind: "open-setup" | "choose-connection" }> {
  return action?.kind === "open-setup" || action?.kind === "choose-connection";
}

/** Settled connect cards are receipts, not the current job. */
export function isSpentConnectReceipt(action: AskActionProposal | undefined): boolean {
  return isConnectSetupAction(action) && action.status !== "pending";
}

/** Historic refusal receipts only. New named-app cards are ordinary connects. */
export function isUnsupportedOfficeConnect(action: AskActionProposal | undefined): boolean {
  if (!isConnectSetupAction(action)) return false;
  return /isn't a named office source/i.test(action.title ?? "");
}

export function askConnectReceiptCopy(action: AskActionProposal): { status: string; open: string } {
  if (action.status === "denied") return { status: "Not run", open: "Open card" };
  if (action.status === "stale") return { status: "Stopped safely", open: "Open card" };
  if (isUnsupportedOfficeConnect(action)) return { status: "Not a source", open: "Pick a source" };
  if (isCompletedToolConnect(action)) return { status: "Connected", open: "Open card" };
  return { status: "Card ready", open: "Open card" };
}

export function askSetupUserTurnCopy(action: AskActionProposal): { label: string; detail: string } {
  if (isCompletedToolConnect(action)) {
    return {
      label: "Connected",
      detail: action.detail || "This key is on this device. Ask still cannot send.",
    };
  }
  if (isUnsupportedOfficeConnect(action)) {
    const service = action.kind === "open-setup"
      ? action.service
      : action.options.find((option) => option.id === action.selectedId)?.service;
    const name = prettyOfficeName(service ?? "This name");
    return {
      label: "Not a source",
      detail: `${name} isn't a named office source. Nothing connected.`,
    };
  }
  return {
    label: "Card opened",
    detail: "Opened the requested setup in Ask. Nothing connected automatically.",
  };
}

/**
 * Keep the approval contract identical wherever a proposal is presented.
 * This is presentation only: the server-side action broker remains the
 * authority for freshness, scope, idempotency and execution.
 */
export function askActionApprovalCopy(action: AskActionProposal): AskActionApprovalCopy {
  switch (action.kind) {
    case "run-routine":
      return {
        permission: `Run ${action.loopName} one time now.`,
        boundary: "Results return to Desk. No message, payment, notice or portal Submit.",
        completed: "The routine ran once and its results are available on Desk.",
      };
    case "change-routine":
      return {
        permission: "Apply only the schedule difference shown below.",
        boundary: "RealBud's clock only. No backfill, message or legal deadline is created.",
        completed: "RealBud's schedule now reflects the approved change.",
      };
    case "add-property":
      return {
        permission: `Add ${action.properties.length === 1 ? "this property" : `these ${action.properties.length} properties`} to the local book.`,
        boundary: "Local book data only. PMS balances remain unverified until a current structured export is matched.",
        completed: `${action.properties.length === 1 ? "The property was" : "The properties were"} added to the local book.`,
      };
    case "configure-property":
      return {
        permission: `Apply the shown shop options to ${action.address}.`,
        boundary: "Agency workflow settings only. This cannot create law, a statutory clock or an external action.",
        completed: "The approved shop options are now on the property.",
      };
    case "set-agency-name":
      return {
        permission: "Change the agency label shown inside RealBud.",
        boundary: "Display and local-book label only. No external account or service is changed.",
        completed: "The agency label was updated across RealBud.",
      };
    case "open-setup":
      return isUnsupportedOfficeConnect(action)
        ? {
          permission: "Show why this name is not a RealBud source.",
          boundary: "Social and unnamed tools stay out. Nothing is connected.",
          completed: "Nothing connected. Pick a named office source if that is what you meant.",
        }
        : {
          permission: "Open the named connection card in Ask.",
          boundary: "Setup only. No credential is saved until you use the card. Nothing connects automatically.",
          completed: "The connection card is ready in Ask. Nothing connected automatically.",
        };
    case "choose-connection":
      return {
        permission: "Pick one office source to open in Ask.",
        boundary: "Selection only. Keys stay on this device. Ask cannot claim a connection succeeded.",
        completed: action.selectedId
          ? "The connection card you picked is ready in Ask. Nothing connected automatically."
          : "Nothing connected automatically.",
      };
    case "prepare-handoff":
      return {
        permission: "Run one case-bound browser preparation using the already allowed wording.",
        boundary: "Bud may prefill only this case. You perform Submit; Bud cannot send, pay or leave the bounded portal route.",
        completed: "The approved handoff is ready for your final review and Submit in the PMS.",
      };
  }
}

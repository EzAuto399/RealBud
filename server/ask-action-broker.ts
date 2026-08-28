import { randomUUID } from "node:crypto";

import {
  WORKER_ASK_ACTION_PROTOCOL,
  readAdmittedAskWorkRoutingPlan,
  type AskActionProposal,
  type AskPropertyOptionPatch,
  type AskPropertySummary,
  type AskSetupTarget,
} from "../shared/ask-actions.ts";
import {
  ASK_CONNECTION_OPTIONS,
  isKnownOfficeService,
  matchAskConnectionSpeech,
  namedOfficeService,
  prettyOfficeName,
} from "../shared/ask-connections.ts";
import type { DeskSnapshot, Draft, Loop, LoopId, NotifyChannel, Property, RentSource, WorkRoutingPlan } from "../shared/contracts.ts";
import { normalizeAddress } from "./csv-ledger.ts";
import type { Desk } from "./desk.ts";
import { applyOptions } from "./desk-evaluate.ts";
import { INTAKE_FIELD_LIMITS, intakeItemError } from "./intake.ts";
import { redactSecretsInText } from "./redact.ts";
import { parseClockTime, parseWeekdays, type LoopManager } from "./routines.ts";
import { currentBookWorkRoutingPlan } from "./work-routing.ts";

const RENT_SOURCES = new Set<RentSource>(["mepay", "bank", "pms-export", "fixture", "csv"]);
const NOTIFY_CHANNELS = new Set<NotifyChannel>(["sms", "email", "portal", "desk"]);
const LOOP_IDS = new Set<LoopId>(["morning-arrears", "owner-letter", "inbound-triage"]);
const SETUP_TARGETS = new Set<AskSetupTarget>(["worker", "desktop-reminders", "connections", "computer-use", "composio-account"]);

type WorkerProposal =
  | { kind: "run-routine"; routineId: LoopId }
  | { kind: "change-routine"; routineId: LoopId; time?: string; weekdays?: number[]; enabled?: boolean }
  | ({ kind: "add-property" } & AskPropertySummary)
  | { kind: "configure-property"; propertyRef: string; changes: AskPropertyOptionPatch }
  | { kind: "set-agency-name"; name: string }
  | { kind: "open-setup"; target: AskSetupTarget; service?: string }
  | { kind: "prepare-handoff"; draftRef: string };

interface WorkerActionEnvelope {
  action: typeof WORKER_ASK_ACTION_PROTOCOL;
  proposal: WorkerProposal;
}

export type StageWorkerActionResult =
  | { matched: false }
  | { matched: true; error: string; status: number; code: string }
  | { matched: true; proposal: AskActionProposal; deskChanged: boolean; navigation?: AskSetupTarget };

export interface AskActionDecisionResult {
  proposal: AskActionProposal;
  snapshot?: DeskSnapshot;
  loop?: Loop;
  run?: ReturnType<LoopManager["runNow"]>;
  navigation?: AskSetupTarget;
}

export interface AskActionBrokerContext {
  desk: Desk;
  loops: LoopManager;
  now?: () => number;
  portalMode?: "practice" | "pilot";
  prepareHandoff?: (draftId: string) => Promise<DeskSnapshot>;
  /** Server-owned route projection. Tests and older callers safely fall back
   * to the automatic local-first planner. */
  workRoutingPlan?: (snapshot: DeskSnapshot) => WorkRoutingPlan;
  /** Required when Allowing a choose-connection card. */
  selection?: string;
}

function boundedString(value: unknown, max: number, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if ((!clean && !allowEmpty) || clean.length > max) return null;
  if (redactSecretsInText(clean) !== clean) return null;
  return clean;
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function jsonBody(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fence?.[1]?.trim() ?? trimmed;
}

function parseWorkerProposal(value: unknown): WorkerProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind;

  if (kind === "run-routine") {
    if (!allowedKeys(record, ["kind", "routineId"], ["kind", "routineId"])) return null;
    return typeof record.routineId === "string" && LOOP_IDS.has(record.routineId as LoopId)
      ? { kind, routineId: record.routineId as LoopId }
      : null;
  }

  if (kind === "change-routine") {
    if (!allowedKeys(record, ["kind", "routineId", "time", "weekdays", "enabled"], ["kind", "routineId"])) return null;
    if (typeof record.routineId !== "string" || !LOOP_IDS.has(record.routineId as LoopId)) return null;
    const hasChange = record.time !== undefined || record.weekdays !== undefined || record.enabled !== undefined;
    if (!hasChange) return null;
    const time = record.time === undefined ? undefined : parseClockTime(record.time);
    const weekdays = record.weekdays === undefined ? undefined : parseWeekdays(record.weekdays);
    if (record.time !== undefined && !time) return null;
    if (record.weekdays !== undefined && !weekdays) return null;
    if (record.enabled !== undefined && typeof record.enabled !== "boolean") return null;
    return {
      kind,
      routineId: record.routineId as LoopId,
      ...(time ? { time } : {}),
      ...(weekdays ? { weekdays } : {}),
      ...(record.enabled !== undefined ? { enabled: record.enabled } : {}),
    };
  }

  if (kind === "add-property") {
    if (!allowedKeys(
      record,
      ["kind", "address", "tenantName", "tenantPhone", "weeklyRentCents"],
      ["kind", "address", "tenantName", "tenantPhone", "weeklyRentCents"],
    )) return null;
    const address = boundedString(record.address, INTAKE_FIELD_LIMITS.address);
    const tenantName = boundedString(record.tenantName, INTAKE_FIELD_LIMITS.tenantName);
    const tenantPhone = boundedString(record.tenantPhone, INTAKE_FIELD_LIMITS.tenantPhone);
    const weeklyRentCents = record.weeklyRentCents;
    const property = { address: address ?? "", tenantName: tenantName ?? "", tenantPhone: tenantPhone ?? "", weeklyRentCents };
    if (
      !address || !tenantName || !tenantPhone || typeof weeklyRentCents !== "number" ||
      !Number.isInteger(weeklyRentCents) || weeklyRentCents <= 0 ||
      weeklyRentCents > INTAKE_FIELD_LIMITS.weeklyRentCents || intakeItemError(property as AskPropertySummary)
    ) return null;
    return { kind, address, tenantName, tenantPhone, weeklyRentCents };
  }

  if (kind === "configure-property") {
    if (!allowedKeys(record, ["kind", "propertyRef", "changes"], ["kind", "propertyRef", "changes"])) return null;
    const propertyRef = boundedString(record.propertyRef, 240);
    if (!propertyRef || !record.changes || typeof record.changes !== "object" || Array.isArray(record.changes)) return null;
    const raw = record.changes as Record<string, unknown>;
    if (!allowedKeys(raw, ["rentSource", "graceDays", "courtesyUntilDay", "notifyChannel"], [])) return null;
    if (Object.keys(raw).length === 0) return null;
    const changes: AskPropertyOptionPatch = {};
    if (raw.rentSource !== undefined) {
      if (typeof raw.rentSource !== "string" || !RENT_SOURCES.has(raw.rentSource as RentSource)) return null;
      changes.rentSource = raw.rentSource as RentSource;
    }
    if (raw.notifyChannel !== undefined) {
      if (typeof raw.notifyChannel !== "string" || !NOTIFY_CHANNELS.has(raw.notifyChannel as NotifyChannel)) return null;
      changes.notifyChannel = raw.notifyChannel as NotifyChannel;
    }
    if (raw.graceDays !== undefined) {
      if (!Number.isInteger(raw.graceDays) || Number(raw.graceDays) < 0 || Number(raw.graceDays) > 28) return null;
      changes.graceDays = Number(raw.graceDays);
    }
    if (raw.courtesyUntilDay !== undefined) {
      if (!Number.isInteger(raw.courtesyUntilDay) || Number(raw.courtesyUntilDay) < 1 || Number(raw.courtesyUntilDay) > 60) return null;
      changes.courtesyUntilDay = Number(raw.courtesyUntilDay);
    }
    return { kind, propertyRef, changes };
  }

  if (kind === "set-agency-name") {
    if (!allowedKeys(record, ["kind", "name"], ["kind", "name"])) return null;
    const name = boundedString(record.name, 120, true);
    return name == null ? null : { kind, name };
  }

  if (kind === "open-setup") {
    if (!allowedKeys(record, ["kind", "target", "service"], ["kind", "target"])) return null;
    if (typeof record.target !== "string" || !SETUP_TARGETS.has(record.target as AskSetupTarget)) return null;
    const service = record.service === undefined ? undefined : boundedString(record.service, 80);
    if (record.service !== undefined && (!service || /:\/\//.test(service))) return null;
    return { kind, target: record.target as AskSetupTarget, ...(service ? { service } : {}) };
  }

  if (kind === "prepare-handoff") {
    if (!allowedKeys(record, ["kind", "draftRef"], ["kind", "draftRef"])) return null;
    const draftRef = boundedString(record.draftRef, 240);
    return draftRef ? { kind, draftRef } : null;
  }

  return null;
}

export function parseWorkerAskAction(text: string): { matched: boolean; value?: WorkerActionEnvelope; error?: string } {
  let value: unknown;
  try {
    value = JSON.parse(jsonBody(text));
  } catch {
    return text.includes(WORKER_ASK_ACTION_PROTOCOL)
      ? { matched: true, error: "Bud returned an incomplete RealBud change. Nothing was applied." }
      : { matched: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { matched: false };
  const record = value as Record<string, unknown>;
  if (record.action !== WORKER_ASK_ACTION_PROTOCOL) return { matched: false };
  if (!allowedKeys(record, ["action", "proposal"], ["action", "proposal"])) {
    return { matched: true, error: "Bud returned an unsupported RealBud change. Nothing was applied." };
  }
  const proposal = parseWorkerProposal(record.proposal);
  if (!proposal) return { matched: true, error: "Bud returned an invalid RealBud change. Nothing was applied." };
  return { matched: true, value: { action: WORKER_ASK_ACTION_PROTOCOL, proposal } };
}

function actionError(message: string, status = 400, code = "INVALID_ACTION"): Error {
  return Object.assign(new Error(message), { status, code });
}

function uniqueProperty(properties: Property[], ref: string): Property {
  const clean = ref.toLowerCase().trim();
  const normalized = normalizeAddress(ref);
  const exact = properties.filter((property) =>
    property.id.toLowerCase() === clean || (normalized && normalizeAddress(property.address) === normalized),
  );
  if (exact.length === 1) return exact[0]!;
  const fuzzy = properties.filter((property) =>
    property.address.toLowerCase().includes(clean) || property.tenantName.toLowerCase().includes(clean),
  );
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (exact.length > 1 || fuzzy.length > 1) throw actionError("That property reference matches more than one property. Use the full address.", 409, "AMBIGUOUS_PROPERTY");
  throw actionError("I could not find that property in the current book.", 404, "PROPERTY_NOT_FOUND");
}

function uniquePreparableDraft(
  snapshot: DeskSnapshot,
  desk: Desk,
  ref: string,
  now: number,
): { draft: Draft; property: Property; capability: NonNullable<ReturnType<Desk["capabilityFor"]>>; workItemId: string; proposalHash: string } {
  const exactDraft = snapshot.drafts.find((draft) => draft.id.toLowerCase() === ref.toLowerCase().trim());
  const property = exactDraft
    ? snapshot.properties.find((item) => item.id === exactDraft.propertyId)
    : uniqueProperty(snapshot.properties, ref);
  if (!property) throw actionError("That draft no longer belongs to an active property.", 409, "REVISION_CONFLICT");

  const candidates = snapshot.drafts.flatMap((draft) => {
    if (draft.propertyId !== property.id || draft.status !== "allowed") return [];
    if (exactDraft && draft.id !== exactDraft.id) return [];
    const work = snapshot.workItems.find((item) => item.id === draft.workItemId || item.draftId === draft.id);
    const capability = desk.capabilityFor(draft.id);
    if (
      !work || work.state !== "approved" || !capability ||
      capability.expiresAt <= now || capability.revision !== snapshot.revision ||
      capability.proposalHash !== work.proposalHash
    ) return [];
    return [{ draft, property, capability, workItemId: work.id, proposalHash: work.proposalHash }];
  });

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw actionError("More than one approved handoff is ready for that property. Name the draft id shown on Desk.", 409, "AMBIGUOUS_HANDOFF");
  }

  const alreadyPrepared = snapshot.workItems.some((work) =>
    work.propertyId === property.id && ["preparing", "handoff-ready", "confirmed", "effect-unknown"].includes(work.state),
  );
  if (alreadyPrepared) {
    throw actionError("That property's approved handoff is already being prepared or is waiting for your final PMS step.", 409, "NO_CHANGE");
  }
  throw actionError("There is no current approved portal handoff for that property. Allow the wording on Desk first.", 409, "HANDOFF_NOT_READY");
}

function newBase(title: string, detail: string, now: number) {
  return {
    schemaVersion: 1 as const,
    id: randomUUID(),
    status: "pending" as const,
    title,
    detail,
    createdAt: now,
  };
}

function admittedStructuredBulkPlan(snapshot: DeskSnapshot, context?: AskActionBrokerContext) {
  if (snapshot.properties.length < 2) return undefined;
  const plan = context?.workRoutingPlan?.(snapshot) ?? currentBookWorkRoutingPlan(snapshot);
  const admitted = readAdmittedAskWorkRoutingPlan(plan);
  if (!admitted) return undefined;
  const active = admitted.lanes.filter((lane) => lane.itemCount > 0);
  return active.length === 1 && active[0]?.kind === "structured-batch" ? admitted : undefined;
}

function routePlanFingerprint(plan: ReturnType<typeof readAdmittedAskWorkRoutingPlan>): string | null {
  if (!plan) return null;
  return JSON.stringify({
    selectedMode: plan.selectedMode,
    propertyCount: plan.propertyCount,
    lanes: plan.lanes.filter((lane) => lane.itemCount > 0).map((lane) => ({
      kind: lane.kind,
      state: lane.state,
      itemCount: lane.itemCount,
      batchCount: lane.batchCount,
      concurrency: lane.concurrency,
      isolation: lane.isolation,
    })),
    cloudRequired: plan.boundaries.cloudRequired,
  });
}

export function stageWorkerAskAction(
  text: string,
  context: AskActionBrokerContext,
): StageWorkerActionResult {
  const parsed = parseWorkerAskAction(text);
  if (!parsed.matched) return { matched: false };
  if (!parsed.value) return { matched: true, error: parsed.error ?? "Bud returned an invalid RealBud change. Nothing was applied.", status: 400, code: "INVALID_ACTION" };

  try {
    const input = parsed.value.proposal;
    const now = context.now?.() ?? Date.now();
    const snapshot = context.desk.snapshot();

    if (input.kind === "run-routine") {
      const loop = context.loops.listLoops().find((item) => item.id === input.routineId);
      if (!loop) throw actionError("That routine does not exist.", 404, "ROUTINE_NOT_FOUND");
      if (!loop.available) throw actionError(`${loop.name} is planned but not built yet.`, 409, "ROUTINE_UNAVAILABLE");
      if (!loop.enabled) throw actionError(`${loop.name} is paused. Ask to turn it on before running it.`, 409, "ROUTINE_PAUSED");
      const executionPlan = loop.id === "morning-arrears" ? admittedStructuredBulkPlan(snapshot, context) : undefined;
      return {
        matched: true,
        deskChanged: false,
        proposal: {
          ...newBase(`Run ${loop.name}`, "Run it once now. Its results will land on Desk; nothing will be sent.", now),
          kind: "run-routine",
          loopId: loop.id,
          loopName: loop.name,
          expectedLoopRevision: loop.revision,
          ...(executionPlan ? { executionPlan } : {}),
        },
      };
    }

    if (input.kind === "change-routine") {
      const loop = context.loops.listLoops().find((item) => item.id === input.routineId);
      if (!loop) throw actionError("That routine does not exist.", 404, "ROUTINE_NOT_FOUND");
      if (input.enabled === true && !loop.available) throw actionError(`${loop.name} is planned but not built yet.`, 409, "ROUTINE_UNAVAILABLE");
      const before = { enabled: loop.enabled, time: loop.schedule.time, weekdays: [...loop.schedule.weekdays] };
      const after = {
        enabled: input.enabled ?? before.enabled,
        time: input.time ?? before.time,
        weekdays: input.weekdays ? [...input.weekdays] : [...before.weekdays],
      };
      if (before.enabled === after.enabled && before.time === after.time && before.weekdays.join(",") === after.weekdays.join(",")) {
        throw actionError(`${loop.name} already has that schedule.`, 409, "NO_CHANGE");
      }
      return {
        matched: true,
        deskChanged: false,
        proposal: {
          ...newBase(`Change ${loop.name}`, "Review the before and after schedule, then Allow to update RealBud's clock.", now),
          kind: "change-routine",
          loopId: loop.id,
          loopName: loop.name,
          expectedLoopRevision: loop.revision,
          before,
          after,
        },
      };
    }

    if (input.kind === "add-property") {
      const beforeIds = new Set(snapshot.book?.bookProposals.map((proposal) => proposal.id) ?? []);
      const staged = context.desk.proposeBook({ items: [input] }, "ask");
      const next = context.desk.snapshot();
      const created = (next.book?.bookProposals ?? []).filter((proposal) => !beforeIds.has(proposal.id));
      if (staged.created !== 1 || created.length !== 1) {
        throw actionError("That property is already in the book or is already waiting for review. Nothing new was staged.", 409, "BOOK_DUPLICATE");
      }
      return {
        matched: true,
        deskChanged: true,
        proposal: {
          ...newBase("Add property to the book", `${input.address} will be added only after Allow.`, now),
          kind: "add-property",
          expectedDeskRevision: next.revision,
          bookProposalIds: [created[0]!.id],
          properties: [{
            address: input.address,
            tenantName: input.tenantName,
            tenantPhone: input.tenantPhone,
            weeklyRentCents: input.weeklyRentCents,
          }],
        },
      };
    }

    if (input.kind === "configure-property") {
      const property = uniqueProperty(snapshot.properties, input.propertyRef);
      const candidateOptions = structuredClone(property.options);
      applyOptions(candidateOptions, input.changes);
      const before = {
        rentSource: property.options.rentSource,
        graceDays: property.options.graceDays,
        courtesyUntilDay: property.options.courtesyUntilDay,
        notifyChannel: property.options.notifyChannel,
      };
      const changed = Object.entries(input.changes).some(([key, value]) => before[key as keyof typeof before] !== value);
      if (!changed) throw actionError(`${property.address} already has those options.`, 409, "NO_CHANGE");
      return {
        matched: true,
        deskChanged: false,
        proposal: {
          ...newBase(`Configure ${property.address}`, "These are agency shop options, not a legal clock. Allow applies them to the property card.", now),
          kind: "configure-property",
          expectedDeskRevision: snapshot.revision,
          propertyId: property.id,
          address: property.address,
          before,
          changes: input.changes,
        },
      };
    }

    if (input.kind === "set-agency-name") {
      const beforeName = snapshot.book?.agency.name ?? "";
      if (beforeName === input.name) throw actionError("The agency name is already set to that value.", 409, "NO_CHANGE");
      return {
        matched: true,
        deskChanged: false,
        proposal: {
          ...newBase("Update agency name", "This changes the agency label shown across Desk, Ask and You.", now),
          kind: "set-agency-name",
          expectedDeskRevision: snapshot.revision,
          beforeName,
          afterName: input.name,
        },
      };
    }

    if (input.kind === "prepare-handoff") {
      if (snapshot.recovery.active) throw actionError("Desk is in recovery, so browser preparation is paused.", 409, "RECOVERY_ACTIVE");
      const resolved = uniquePreparableDraft(snapshot, context.desk, input.draftRef, now);
      if (resolved.draft.kind === "inbound-reply") {
        throw actionError("Inbound replies are copied to the agency mailbox or PMS; they cannot mint a portal handoff.", 409, "HANDOFF_NOT_READY");
      }
      const mode = context.portalMode ?? "practice";
      return {
        matched: true,
        deskChanged: false,
        proposal: {
          ...newBase(
            mode === "practice" ? `Prepare ${resolved.property.address} in the practice portal` : `Prepare ${resolved.property.address} in the PMS`,
            mode === "practice"
              ? "Allow runs the bounded training handoff. Bud may prefill the approved wording; you still perform the final Submit."
              : "Allow starts one case-bound, expiring handoff. Bud may prefill the approved wording; you still perform the final Submit.",
            now,
          ),
          kind: "prepare-handoff",
          expectedDeskRevision: snapshot.revision,
          draftId: resolved.draft.id,
          workItemId: resolved.workItemId,
          capabilityId: resolved.capability.id,
          proposalHash: resolved.proposalHash,
          propertyId: resolved.property.id,
          address: resolved.property.address,
          draftKind: resolved.draft.kind,
          mode,
        },
      };
    }

    const setupCopy = {
      connections: input.service && !isKnownOfficeService(input.service)
        ? {
          title: `${prettyOfficeName(input.service)} isn't a named office source`,
          detail: `RealBud does not connect ${prettyOfficeName(input.service)}. Pick the book, inbox, calendar or a PM channel this office already uses.`,
        }
        : {
          title: input.service ? `Connect ${prettyOfficeName(input.service)}` : "Connect a source",
          detail: input.service
            ? `Connect ${prettyOfficeName(input.service)} here in Ask. Keys stay on this device. Nothing connects automatically.`
            : "Name the source this office already uses. Keys stay on this device. Nothing connects automatically.",
        },
      worker: {
        title: "Connect Bud",
        detail: "Prepare Bud's private worker and model. Keys stay on this device.",
      },
      "desktop-reminders": {
        title: "Desktop reminders",
        detail: "Local alerts when a routine fails or leaves held work. Never messages anyone.",
      },
      "computer-use": {
        title: "Connect computer use",
        detail: "Set up case-scoped browser handoffs on this Mac. You keep Submit.",
      },
      "composio-account": {
        title: "Link Composio",
        detail: "Link your own Composio account. The key stays on this device. Ask never sees it.",
      },
    }[input.target];
    return honorOpenSetup({
      matched: true,
      deskChanged: false,
      proposal: {
        ...newBase(setupCopy.title, setupCopy.detail, now),
        kind: "open-setup",
        target: input.target,
        ...(input.service ? { service: input.service } : {}),
      },
    }, now);
  } catch (error) {
    return {
      matched: true,
      error: error instanceof Error ? error.message : String(error),
      status: (error as { status?: number }).status ?? 400,
      code: (error as { code?: string }).code ?? "INVALID_ACTION",
    };
  }
}

/**
 * Resolve an explicit PM-owned Pocket setup request without spending a model
 * call. This is deliberately narrower than general intent parsing: it can
 * only stage the same navigation-only `open-setup` proposal the worker may
 * request, and potentially external/tenant-facing requests stay with Bud so
 * the normal refusal boundary can explain them.
 */
const ROUTINE_NEGATION = /\b(?:do\s+not|don't|dont|never)\b/i;
const ROUTINE_FORBIDDEN = /\b(?:send|pay|notice|sms|text them)\b/i;
const OWNER_LETTER = /\b(?:owner\s+letter|friday\s+(?:owner\s+)?letter|friday\s+letters)\b/i;
const MORNING_MONEY = /\b(?:morning\s+(?:money|arrears|check|rent)|(?:rent|money|arrears)\s+check)\b/i;
const RUN_IT = /\brun\s+it\b/i;
const RUN_NOW = /\b(?:run(?:\s+it)?\s+now|check\s+now|do\s+(?:it|the\s+check)\s+now)\b/i;
const PAUSE = /\b(?:pause|turn\s+off)\b/i;
const RESUME = /\b(?:resume|turn\s+on|unpause)\b/i;

function parseSpokenClock(text: string): string | null {
  const match = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridian = match[3]?.toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59 || hour < 0 || hour > 23) return null;
  if (meridian === "pm" && hour > 0 && hour < 12) hour += 12;
  if (meridian === "am" && hour === 12) hour = 0;
  if (meridian && hour > 23) return null;
  return parseClockTime(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
}

/**
 * Honour the named-routine wall line without a model or prompt-runner.
 * Only run / retune / pause / resume of Morning money and Friday letters.
 * Send, pay, notices and inbound stay unmatched so the normal refusal path
 * can explain them.
 */
export function stageDirectAskRoutineIntent(
  text: string,
  context: AskActionBrokerContext,
): StageWorkerActionResult {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 500 || ROUTINE_NEGATION.test(clean) || ROUTINE_FORBIDDEN.test(clean)) {
    return { matched: false };
  }
  const owner = OWNER_LETTER.test(clean);
  const morning = MORNING_MONEY.test(clean) || (/\b(?:morning|rent|arrears)\b/i.test(clean) && /\b(?:check|run)\b/i.test(clean) && !owner);
  const unnamed = RUN_IT.test(clean) && !owner && !morning;
  if (!owner && !morning && !unnamed) return { matched: false };

  const loopId: LoopId = owner ? "owner-letter" : "morning-arrears";
  const time = parseSpokenClock(clean);
  const pause = PAUSE.test(clean);
  const resume = RESUME.test(clean);
  const runNow = RUN_NOW.test(clean) || (/\brun\b/i.test(clean) && !time && !pause && !resume) || (/\bnow\b/i.test(clean) && (morning || owner) && !time);

  if (time) {
    return stageWorkerAskAction(JSON.stringify({
      action: WORKER_ASK_ACTION_PROTOCOL,
      proposal: { kind: "change-routine", routineId: loopId, time },
    }), context);
  }
  if (pause && !resume) {
    return stageWorkerAskAction(JSON.stringify({
      action: WORKER_ASK_ACTION_PROTOCOL,
      proposal: { kind: "change-routine", routineId: loopId, enabled: false },
    }), context);
  }
  if (resume && !pause) {
    return stageWorkerAskAction(JSON.stringify({
      action: WORKER_ASK_ACTION_PROTOCOL,
      proposal: { kind: "change-routine", routineId: loopId, enabled: true },
    }), context);
  }
  if (runNow) {
    const loop = context.loops.listLoops().find((item) => item.id === loopId);
    if (loop && !loop.enabled) {
      return stageWorkerAskAction(JSON.stringify({
        action: WORKER_ASK_ACTION_PROTOCOL,
        proposal: { kind: "change-routine", routineId: loopId, enabled: true },
      }), context);
    }
    return stageWorkerAskAction(JSON.stringify({
      action: WORKER_ASK_ACTION_PROTOCOL,
      proposal: { kind: "run-routine", routineId: loopId },
    }), context);
  }
  return { matched: false };
}

export function stageDirectAskSetupIntent(
  text: string,
  context: AskActionBrokerContext,
): StageWorkerActionResult {
  const match = matchAskConnectionSpeech(text);
  if (match.kind === "none") return { matched: false };
  const now = context.now?.() ?? Date.now();
  if (match.kind === "unsupported") {
    const stagedUnknown = stageWorkerAskAction(JSON.stringify({
      action: WORKER_ASK_ACTION_PROTOCOL,
      proposal: { kind: "open-setup", target: "connections", service: match.name },
    }), context);
    if (!stagedUnknown.matched || "error" in stagedUnknown) return stagedUnknown;
    return honorOpenSetup(stagedUnknown, now);
  }
  if (match.kind === "chooser") {
    return {
      matched: true,
      deskChanged: false,
      proposal: {
        ...newBase(
          "Choose a connection",
          "Pick the PMS, inbox or portal this office already uses. Keys stay on this device. Ask cannot claim a connection succeeded.",
          now,
        ),
        kind: "choose-connection",
        options: ASK_CONNECTION_OPTIONS.map(({ id, label, detail, target, service }) => ({
          id, label, detail, target, service,
        })),
      },
    };
  }
  const staged = stageWorkerAskAction(JSON.stringify({
    action: WORKER_ASK_ACTION_PROTOCOL,
    proposal: { kind: "open-setup", target: match.option.target, service: namedOfficeService(match.option, text) },
  }), context);
  if (!staged.matched || "error" in staged) return staged;
  return honorOpenSetup(staged, now);
}

function honorOpenSetup(
  result: Extract<StageWorkerActionResult, { proposal: AskActionProposal }>,
  now: number,
): Extract<StageWorkerActionResult, { proposal: AskActionProposal }> {
  if (result.proposal.kind !== "open-setup" || result.proposal.status === "allowed") return result;
  return {
    ...result,
    proposal: { ...result.proposal, status: "allowed", decidedAt: now },
    navigation: result.proposal.target,
  };
}

function loopMatches(loop: Loop, target: { enabled: boolean; time: string; weekdays: number[] }): boolean {
  return loop.enabled === target.enabled && loop.schedule.time === target.time && loop.schedule.weekdays.join(",") === target.weekdays.join(",");
}

function propertyMatchesSummary(property: Property, summary: AskPropertySummary): boolean {
  return normalizeAddress(property.address) === normalizeAddress(summary.address)
    && property.tenantName === summary.tenantName
    && property.tenantPhone === summary.tenantPhone
    && property.weeklyRentCents === summary.weeklyRentCents;
}

function propertyOptionsMatch(property: Property, changes: AskPropertyOptionPatch): boolean {
  return Object.entries(changes).every(([key, value]) => property.options[key as keyof AskPropertyOptionPatch] === value);
}

function propertyOptionsStillBefore(
  property: Property,
  before: Extract<AskActionProposal, { kind: "configure-property" }>["before"],
  changes: AskPropertyOptionPatch,
): boolean {
  return Object.keys(changes).every((key) => {
    const option = key as keyof AskPropertyOptionPatch;
    return property.options[option] === before[option];
  });
}

function openBookProposalMatches(
  snapshot: DeskSnapshot,
  id: string,
  summary: AskPropertySummary | undefined,
): boolean {
  if (!summary) return false;
  const proposal = snapshot.book?.bookProposals.find((item) => item.id === id);
  return Boolean(proposal)
    && normalizeAddress(proposal!.address) === normalizeAddress(summary.address)
    && proposal!.tenantName === summary.tenantName
    && proposal!.tenantPhone === summary.tenantPhone
    && proposal!.weeklyRentCents === summary.weeklyRentCents;
}

export async function decideAskAction(
  proposal: AskActionProposal,
  decision: "allow" | "deny",
  context: AskActionBrokerContext,
): Promise<AskActionDecisionResult> {
  const decidedAt = context.now?.() ?? Date.now();
  if (proposal.status !== "pending") {
    if ((decision === "allow" && proposal.status === "allowed") || (decision === "deny" && proposal.status === "denied")) {
      return { proposal };
    }
    throw actionError(`This change is already ${proposal.status}.`, 409, "ACTION_SETTLED");
  }

  if (decision === "deny") {
    let snapshot: DeskSnapshot | undefined;
    if (proposal.kind === "add-property") {
      const current = context.desk.snapshot();
      const open = new Set(current.book?.bookProposals.map((item) => item.id) ?? []);
      const allOpen = proposal.bookProposalIds.every((id) => open.has(id));
      const allUnchanged = proposal.bookProposalIds.every((id, index) => openBookProposalMatches(current, id, proposal.properties[index]!));
      if (allOpen && allUnchanged) snapshot = context.desk.denyBookProposals(proposal.bookProposalIds, current.revision);
      else if (allOpen) {
        throw actionError("This property proposal changed after Bud prepared it. Review it on Desk.", 409, "REVISION_CONFLICT");
      }
      else if (proposal.properties.some((summary) => current.properties.some((property) => propertyMatchesSummary(property, summary)))) {
        throw actionError("This property proposal was already applied and cannot be denied.", 409, "ACTION_SETTLED");
      } else if (proposal.bookProposalIds.some((id) => open.has(id))) {
        throw actionError("Only part of this property proposal is still open. Review it on Desk.", 409, "REVISION_CONFLICT");
      }
    }
    return { proposal: { ...proposal, status: "denied", decidedAt }, ...(snapshot ? { snapshot } : {}) };
  }

  if (proposal.kind === "run-routine") {
    const loop = context.loops.listLoops().find((item) => item.id === proposal.loopId);
    if (!loop) throw actionError("That routine no longer exists.", 404, "ROUTINE_NOT_FOUND");
    const existing = context.loops.listRuns().find((run) => run.requestId === proposal.id);
    if (existing) return { proposal: { ...proposal, status: "allowed", decidedAt }, run: existing };
    if (loop.revision !== proposal.expectedLoopRevision) throw actionError("That routine changed after Bud prepared this card. Ask again to use the current clock.", 409, "REVISION_CONFLICT");
    if (proposal.executionPlan !== undefined) {
      const planned = readAdmittedAskWorkRoutingPlan(proposal.executionPlan);
      if (!planned) throw actionError("This work card has an unknown or unavailable execution route. Ask again to build a current plan.", 409, "ROUTE_PLAN_INVALID");
      const current = admittedStructuredBulkPlan(context.desk.snapshot(), context);
      if (routePlanFingerprint(planned) !== routePlanFingerprint(current ?? null)) {
        throw actionError("The property book changed after Bud prepared this route. Ask again to review the current batch.", 409, "ROUTE_PLAN_STALE");
      }
    }
    const run = context.loops.runNow(proposal.loopId, proposal.id);
    if (!run) throw actionError("Enable this routine before running it.", 409, "ROUTINE_PAUSED");
    return { proposal: { ...proposal, status: "allowed", decidedAt }, run };
  }

  if (proposal.kind === "change-routine") {
    const current = context.loops.listLoops().find((item) => item.id === proposal.loopId);
    if (!current) throw actionError("That routine no longer exists.", 404, "ROUTINE_NOT_FOUND");
    if (current.revision !== proposal.expectedLoopRevision) {
      if (loopMatches(current, proposal.after)) return { proposal: { ...proposal, status: "allowed", decidedAt }, loop: current };
      throw actionError("That routine changed after Bud prepared this card. Ask again to review the current clock.", 409, "REVISION_CONFLICT");
    }
    const loop = context.loops.patchClock(proposal.loopId, {
      enabled: proposal.after.enabled,
      time: proposal.after.time,
      weekdays: proposal.after.weekdays,
      expectedRevision: proposal.expectedLoopRevision,
    });
    return { proposal: { ...proposal, status: "allowed", decidedAt }, loop };
  }

  if (proposal.kind === "add-property") {
    const current = context.desk.snapshot();
    const open = new Set(current.book?.bookProposals.map((item) => item.id) ?? []);
    const alreadyAdded = proposal.properties.every((summary) => current.properties.some((property) => propertyMatchesSummary(property, summary)));
    if (alreadyAdded) {
      const remaining = proposal.bookProposalIds.filter((id) => open.has(id));
      const unchanged = remaining.every((id) => {
        const index = proposal.bookProposalIds.indexOf(id);
        return openBookProposalMatches(current, id, proposal.properties[index]!);
      });
      if (!unchanged) throw actionError("The staged property changed after Bud prepared it. Review the book on Desk.", 409, "REVISION_CONFLICT");
      const snapshot = remaining.length > 0
        ? context.desk.denyBookProposals(remaining, current.revision)
        : current;
      return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot };
    }
    const allOpen = proposal.bookProposalIds.every((id) => open.has(id));
    const allUnchanged = proposal.bookProposalIds.every((id, index) => openBookProposalMatches(current, id, proposal.properties[index]!));
    if (allOpen && allUnchanged) {
      const snapshot = context.desk.allowBookProposals(proposal.bookProposalIds, current.revision);
      return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot };
    }
    throw actionError("The book changed after Bud prepared this card. Review the current intake cards on Desk.", 409, "REVISION_CONFLICT");
  }

  if (proposal.kind === "configure-property") {
    const current = context.desk.snapshot();
    const property = current.properties.find((item) => item.id === proposal.propertyId);
    if (!property) throw actionError("That property is no longer active in the book.", 409, "REVISION_CONFLICT");
    if (propertyOptionsMatch(property, proposal.changes)) {
      return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot: current };
    }
    if (current.revision !== proposal.expectedDeskRevision && !propertyOptionsStillBefore(property, proposal.before, proposal.changes)) {
      throw actionError("The book changed after Bud prepared this card. Ask again to review current options.", 409, "REVISION_CONFLICT");
    }
    context.desk.patchProperty(proposal.propertyId, proposal.changes);
    return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot: context.desk.snapshot() };
  }

  if (proposal.kind === "set-agency-name") {
    const current = context.desk.snapshot();
    if (current.book?.agency.name === proposal.afterName) {
      return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot: current };
    }
    if (current.revision !== proposal.expectedDeskRevision && current.book?.agency.name !== proposal.beforeName) {
      throw actionError("The agency name changed after Bud prepared this card. Ask again to review the current name.", 409, "REVISION_CONFLICT");
    }
    const snapshot = context.desk.updateAgencyName(proposal.afterName, current.revision);
    return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot };
  }

  if (proposal.kind === "prepare-handoff") {
    const current = context.desk.snapshot();
    const draft = current.drafts.find((item) => item.id === proposal.draftId);
    const work = current.workItems.find((item) => item.id === proposal.workItemId && item.draftId === proposal.draftId);
    if (!draft || !work || draft.propertyId !== proposal.propertyId || work.propertyId !== proposal.propertyId) {
      throw actionError("That handoff no longer matches the current Desk case.", 409, "REVISION_CONFLICT");
    }
    if (work.proposalHash !== proposal.proposalHash) {
      throw actionError("The approved wording changed after Bud prepared this card. Ask again from the current Desk case.", 409, "REVISION_CONFLICT");
    }
    if (["handoff-ready", "confirmed", "effect-unknown"].includes(work.state)) {
      return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot: current };
    }
    if (work.state === "preparing" || work.state === "failed") {
      throw actionError("The prior preparation did not reach a safely retryable state. Review the handoff on Desk before trying again.", 409, "HANDOFF_FAILED");
    }
    if (current.recovery.active) throw actionError("Desk is in recovery, so browser preparation is paused.", 409, "REVISION_CONFLICT");
    if (current.revision !== proposal.expectedDeskRevision || draft.status !== "allowed" || work.state !== "approved") {
      throw actionError("That Desk case changed after Bud prepared this card. Ask again from the current approved wording.", 409, "REVISION_CONFLICT");
    }
    const capability = context.desk.capabilityFor(draft.id);
    if (
      !capability || capability.id !== proposal.capabilityId ||
      capability.proposalHash !== proposal.proposalHash || capability.revision !== current.revision ||
      capability.expiresAt <= decidedAt
    ) {
      throw actionError("That browser authorization expired or changed. Re-open the approved Desk wording before preparing it.", 409, "REVISION_CONFLICT");
    }
    if (!context.prepareHandoff) throw actionError("Browser preparation is not available in this RealBud runtime.", 409, "HANDOFF_UNAVAILABLE");
    let snapshot: DeskSnapshot;
    try {
      snapshot = await context.prepareHandoff(draft.id);
    } catch (error) {
      const detail = redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 200);
      throw actionError(
        `Preparation did not complete safely${detail ? `: ${detail}` : "."}`,
        (error as { status?: number }).status ?? 502,
        "HANDOFF_FAILED",
      );
    }
    const prepared = snapshot.workItems.find((item) => item.id === proposal.workItemId);
    if (!prepared || prepared.state !== "handoff-ready") {
      throw actionError("Preparation ended without a verified handoff-ready state. Review Desk before trying again.", 502, "HANDOFF_FAILED");
    }
    return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot };
  }

  if (proposal.kind === "choose-connection") {
    const selected = proposal.options.find((option) => option.id === context.selection);
    if (!selected) throw actionError("Pick one connection to open.", 400, "SELECTION_REQUIRED");
    return {
      proposal: { ...proposal, status: "allowed", selectedId: selected.id, decidedAt },
      navigation: selected.target,
    };
  }

  return {
    proposal: { ...proposal, status: "allowed", decidedAt },
    navigation: proposal.target,
  };
}

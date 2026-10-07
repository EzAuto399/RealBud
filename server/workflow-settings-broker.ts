// Bud's working-rules tools: the person changes the office's workflow settings by
// asking Bud. `workflow_settings_read` is a read with no card. Every change and
// every restore shows RealBud's one-time review card with each field's before →
// after and Bud's reason, then saves through the setting's own store with its
// revision check, so an edit made elsewhere while the card was open is a
// conflict, never overwritten. The stores keep replaced versions so a change can
// be undone. A workflow's clock (loop_schedule) goes the same way through the
// clock's own compare-and-set; it never switches a workflow on or off, and
// earlier clocks are not kept. Mounted per ACP session as a loopback MCP server.
import { defaultAgencySettings, validateAgencySettings } from "./agency-setup.ts";
import { validateInspectionRules, type InspectionRulesStore } from "./inspection-rules.ts";
import { isMaintenanceWindowRule, MAINTENANCE_RULE_MESSAGE, type MaintenanceReviewStore } from "./maintenance-review.ts";
import { redactSecretsInText } from "./redact.ts";
import { parseClockTime, parseWeekdays } from "./routines.ts";
import { startLoopbackToolServer, toolError, type LoopbackToolResult, type LoopbackToolServer } from "./web-research-broker.ts";
import type { AgencySetupSettings } from "../shared/agency-setup.ts";
import type { Loop, LoopId, LoopSchedule } from "../shared/contracts.ts";
import { validCalendarCadence } from "../shared/routine-clock.ts";
import { evaluatorForLoop } from "../shared/workflow-catalog.ts";

export const WORKFLOW_SETTINGS_SERVER = "workflow-settings";
export const SETTINGS_CONFLICT = "These settings changed since Bud read them — ask again";
export const LOOP_SCHEDULE_CONFLICT = "This schedule changed. Ask Bud again.";
export const WORKFLOW_SETTINGS_TARGETS = ["maintenance_month_rule", "inspection_rules", "morning_priorities", "loop_schedule"] as const;
export type WorkflowSettingsTarget = typeof WORKFLOW_SETTINGS_TARGETS[number];
type RuleTarget = Exclude<WorkflowSettingsTarget, "loop_schedule">;
type Values = Record<string, unknown>;
/** A workflow's clock as Bud reads and proposes it: no timezone, no on/off. */
export interface LoopClock { time: string; weekdays: number[]; intervalDays?: number; anchorDate?: string; monthly?: "first-weekday" }
export interface LoopScheduleSnapshot { loopId: string; name: string; enabled: boolean; revision: number; schedule: LoopClock; waitingForPlan: boolean; agencyTimed: boolean }
export interface WorkflowSettingsSnapshot {
  revision: number; values: Values;
  /** Replaced versions, newest first; null when this setting keeps none. */
  previous: Array<{ values: Values; replacedAt: number }> | null;
}
/** One turn's settings, bound by the host. `check` returns clean values or throws
 * a plain sentence; `save` is compare-and-set and throws `code: "settings_changed"`
 * on a stale revision. */
export interface BudWorkflowSettings {
  read(target: RuleTarget): Promise<WorkflowSettingsSnapshot>;
  check(target: RuleTarget, values: Values): Values;
  save(target: RuleTarget, values: Values, expectedRevision: number): Promise<void>;
  /** Every built-in and recipe-* workflow's clock. */
  loops(): LoopScheduleSnapshot[];
  /** The workflow's next clock from Bud's partial schedule, or throws a plain sentence. */
  checkLoop(loopId: unknown, schedule: unknown): { loop: LoopScheduleSnapshot; next: LoopClock };
  /** Compare-and-set on the workflow's revision; throws `code: "settings_changed"` when stale. */
  saveLoop(loopId: string, next: LoopClock, expectedRevision: number): Promise<void>;
}
export interface WorkflowSettingsReceipt { tool: string; target?: WorkflowSettingsTarget; outcome: "succeeded" | "failed" | "refused" | "declined" | "conflict" }

const TARGETS: Record<RuleTarget, { label: string; fields: Record<string, string>; notice?: string }> = {
  maintenance_month_rule: { label: "maintenance month rule", fields: { span: "Comparison window", basis: "Compare invoices by" } },
  inspection_rules: { label: "inspection rules", fields: { cycleMonths: "Inspect every (months)", cycleBasis: "Cycle counts from", horizonMonths: "Plan ahead (months)",
    workingDays: "Working days", closedDates: "Closed days", inspectors: "Inspectors", dayStart: "Start time", appointmentMinutes: "Visit length (minutes)",
    travelMinutes: "Travel time (minutes)", dailyCapacity: "Visits per day" } },
  morning_priorities: { label: "Morning priorities preferences", fields: { localTime: "Time", weekdays: "Days", followUpAfterDays: "Follow up after (days)" },
    notice: "Saving changes the agency setup, so Morning priorities and Weekly bills turn off until their setup is reviewed again." },
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WORDS: Record<string, string> = { invoiceDate: "invoice date", receivedDate: "date received", calendarMonth: "calendar month", rolling30: "rolling 30 days", completed: "completed date", planned: "planned date" };
/** Compact values for Bud's read: raw dates and times so a proposal can build on them. */
const show = (field: string, value: unknown): string => {
  if (Array.isArray(value)) return value.length ? value.map(item => field === "weekdays" || field === "workingDays" ? DAYS[item as number] ?? String(item) : String(item)).join(" ") : "none";
  return typeof value === "string" ? WORDS[value] ?? value : String(value);
};
const DAY_MS = 86_400_000;
const isoDay = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
const dayLabel = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
/** "2026-12-24".."2027-01-02" → "24 Dec 2026 – 2 Jan 2027"; runs of consecutive days collapse. */
export function dateRanges(values: readonly unknown[]): string {
  const days = values.map(isoDay);
  if (days.some(Number.isNaN)) return values.map(String).join(", ");
  const sorted = [...new Set(days)].sort((a, b) => a - b), runs: Array<[number, number]> = [];
  for (const day of sorted) { const last = runs.at(-1); if (last && day - last[1] === DAY_MS) last[1] = day; else runs.push([day, day]); }
  return runs.map(([from, to]) => from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`).join(", ");
}
/** "09:30" → "9:30 am"; anything else is shown as given. */
export function clockLabel(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "am" : "pm"}`;
}
/** Values as an office worker reads them on the review card. */
export function friendly(field: string, value: unknown): string {
  if (Array.isArray(value)) {
    if (!value.length) return "none";
    if (field === "closedDates") return dateRanges(value);
    return value.map(item => field === "weekdays" || field === "workingDays" ? DAYS[item as number] ?? String(item) : String(item)).join(", ");
  }
  if (typeof value === "string" && (field === "dayStart" || field === "localTime")) return clockLabel(value);
  return show(field, value);
}
const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const andList = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");
/** A workflow clock as an office worker reads it: "Mondays and Thursdays 8:00 am". */
export function scheduleWords(clock: LoopClock): string {
  const days = clock.weekdays.length === 7 ? "Every day" : clock.weekdays.join() === "1,2,3,4,5" ? "Weekdays" : andList(clock.weekdays.map(day => DAY_NAMES[day] ?? String(day)));
  const only = clock.weekdays.length === 7 ? "" : ` (${days} only)`, time = clockLabel(clock.time);
  if (clock.monthly) return `First weekday of each month${days === "Weekdays" ? "" : only}, ${time}`;
  if (clock.intervalDays === undefined) return `${days} ${time}`;
  const from = isoDay(clock.anchorDate);
  return `Every ${clock.intervalDays === 1 ? "day" : `${clock.intervalDays} days`} from ${Number.isNaN(from) ? String(clock.anchorDate) : dayLabel(from)}${only}, ${time}`;
}
const clockOf = (schedule: LoopSchedule | LoopClock): LoopClock => ({ time: schedule.time, weekdays: [...schedule.weekdays],
  ...(schedule.intervalDays !== undefined ? { intervalDays: schedule.intervalDays } : {}), ...(schedule.anchorDate !== undefined ? { anchorDate: schedule.anchorDate } : {}),
  ...(schedule.monthly ? { monthly: schedule.monthly } : {}) });
const loopSnapshot = (loop: Loop): LoopScheduleSnapshot => ({ loopId: loop.id, name: loop.name, enabled: loop.enabled, revision: loop.revision,
  schedule: clockOf(loop.schedule), waitingForPlan: loop.waitingForPlan === true, agencyTimed: evaluatorForLoop(loop.id)?.agencyTimed === true });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const TARGET = { type: "string", enum: [...WORKFLOW_SETTINGS_TARGETS] };
const REASON = { type: "string", minLength: 1, maxLength: 300, description: "One plain sentence the person will see on the card: why this change." };
const TOOLS = [
  { name: "workflow_settings_read", description: "Read the office's current working rules, their revision and kept earlier versions, and (loop_schedule) each workflow's loopId, revision, on/off and clock. target is optional (all when omitted). Read only, no card.",
    inputSchema: { type: "object", additionalProperties: false, properties: { target: TARGET } } },
  { name: "workflow_settings_propose", description: "Propose new values for one working rule. values holds only the fields to change: maintenance_month_rule {span: calendarMonth|rolling30, basis: invoiceDate|receivedDate}; inspection_rules {cycleMonths, cycleBasis: completed|planned, horizonMonths, workingDays (0=Sun..6=Sat), closedDates (YYYY-MM-DD), inspectors, dayStart (HH:MM), appointmentMinutes, travelMinutes, dailyCapacity}; morning_priorities {localTime (HH:MM), weekdays (0=Sun..6=Sat), followUpAfterDays}; loop_schedule {loopId, schedule: {time (HH:MM), weekdays (0=Sun..6=Sat), and for workflows that repeat every N days intervalDays (1-31) and anchorDate (YYYY-MM-DD)}} for one existing workflow, which never switches it on or off. The person approves the before → after once on a card; the replaced version is kept (not for loop_schedule).",
    inputSchema: { type: "object", additionalProperties: false, required: ["target", "values", "reason"], properties: { target: TARGET, values: { type: "object" }, reason: REASON } } },
  { name: "workflow_settings_restore", description: "Propose putting back an earlier version of one working rule. previous is 1 for the version just before the current one (default), up to 10. The person approves it once on a card.",
    inputSchema: { type: "object", additionalProperties: false, required: ["target", "reason"], properties: { target: TARGET, previous: { type: "integer", minimum: 1, maximum: 10 }, reason: REASON } } },
];
const ARGS: Record<string, { required: string[]; optional: string[] }> = {
  workflow_settings_read: { required: [], optional: ["target"] },
  workflow_settings_propose: { required: ["target", "values", "reason"], optional: [] },
  workflow_settings_restore: { required: ["target", "reason"], optional: ["previous"] },
};
const text = (value: string, structuredContent?: Record<string, unknown>): LoopbackToolResult => ({ content: [{ type: "text", text: value }], ...(structuredContent ? { structuredContent } : {}) });
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const isTarget = (value: unknown): value is WorkflowSettingsTarget => (WORKFLOW_SETTINGS_TARGETS as readonly unknown[]).includes(value);
const object = (value: unknown): value is Values => !!value && typeof value === "object" && !Array.isArray(value);
/** Model text shown on a card: one plain line, no controls or direction overrides, no secrets. */
const plainReason = (value: unknown) => typeof value === "string" ? redactSecretsInText(value.replace(/[\x00-\x1f\x7f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 300) : "";

/** Binds the three stores and the workflow clock for one turn. `writable` returns a refusal sentence when
 * the book is in recovery or the member changed; it is checked again after the card. */
export function bindWorkflowSettings(host: {
  maintenance: MaintenanceReviewStore;
  inspection: InspectionRulesStore;
  agency: { read(): Promise<{ revision: number; settings: AgencySetupSettings }>; save(body: { expectedRevision: number; settings: AgencySetupSettings }): Promise<unknown> };
  /** The clock's one door (LoopManager.patchClock) with the checks PATCH /api/loops/:id adds. */
  loops: { listLoops(): Loop[]; patchClock(id: LoopId, patch: { time: string; weekdays: number[]; intervalDays?: number; anchorDate?: string; expectedRevision: number }): unknown };
  writable(): string | null;
}): BudWorkflowSettings {
  const changed = () => Object.assign(new Error(SETTINGS_CONFLICT), { code: "settings_changed" });
  const guard = () => { const refusal = host.writable(); if (refusal) throw Object.assign(new Error(refusal), { status: 503 }); };
  return {
    async read(target) {
      if (target === "maintenance_month_rule") {
        const state = await host.maintenance.read();
        return { revision: state.ruleRevision ?? 0, values: { ...state.rule }, previous: (state.ruleHistory ?? []).map(h => ({ values: { ...h.rule }, replacedAt: h.replacedAt })) };
      }
      if (target === "inspection_rules") {
        const state = await host.inspection.read();
        return { revision: state.revision, values: { ...state.rules }, previous: state.history.map(h => ({ values: { ...h.rules }, replacedAt: h.replacedAt })) };
      }
      const state = await host.agency.read();
      // ponytail: agency setup keeps no earlier versions (its saved shape lives in shared/agency-setup.ts); add history there to make this restorable.
      return { revision: state.revision, values: { ...state.settings.morningReview }, previous: null };
    },
    check(target, values) {
      if (target === "maintenance_month_rule") { if (!isMaintenanceWindowRule(values)) throw new Error(MAINTENANCE_RULE_MESSAGE); return { span: values.span, basis: values.basis }; }
      if (target === "inspection_rules") return validateInspectionRules(values) as unknown as Values;
      return validateAgencySettings({ ...defaultAgencySettings(), morningReview: values }).morningReview as unknown as Values;
    },
    async save(target, values, expectedRevision) {
      guard();
      try {
        if (target === "maintenance_month_rule") { await host.maintenance.setRule({ rule: values, expectedRevision }); return; }
        if (target === "inspection_rules") { await host.inspection.save({ rules: values, expectedRevision }); return; }
        const state = await host.agency.read();
        if (state.revision !== expectedRevision) throw changed();
        await host.agency.save({ expectedRevision, settings: { ...state.settings, morningReview: values as unknown as AgencySetupSettings["morningReview"] } });
      } catch (error) {
        const failure = error as { status?: unknown; code?: unknown };
        if (failure.code === "settings_changed" || failure.code === "agency_setup_stale" || (target !== "morning_priorities" && failure.status === 409)) throw changed();
        throw error;
      }
    },
    loops: () => host.loops.listLoops().map(loopSnapshot),
    checkLoop(loopId, schedule) {
      const loop = typeof loopId === "string" ? host.loops.listLoops().find(row => row.id === loopId) : undefined, spec = loop && evaluatorForLoop(loop.id);
      if (!loop || !spec) throw new Error("Choose a workflow by its loopId from workflow_settings_read.");
      // Its clock comes from the reviewed agency setup, as PATCH /api/loops/inbound-triage says.
      if (spec.agencyTimed) throw new Error(`${loop.name} runs at the time saved in agency setup; propose a morning_priorities change instead.`);
      const fields = spec.cadenceEditable ? ["time", "weekdays", "intervalDays", "anchorDate"] : ["time", "weekdays"];
      if (!object(schedule) || !Object.keys(schedule).length || Object.keys(schedule).some(key => !fields.includes(key))) throw new Error(`For ${loop.name}, schedule takes ${fields.join(", ")}.`);
      const merged = { ...clockOf(loop.schedule), ...schedule } as LoopClock, time = parseClockTime(merged.time), weekdays = parseWeekdays(merged.weekdays);
      if (!time) throw new Error("time must be HH:MM (00:00–23:59).");
      if (!weekdays) throw new Error("weekdays must be a non-empty list of numbers 0–6.");
      const next = clockOf({ ...merged, time, weekdays });
      if (!validCalendarCadence(next)) throw new Error("Choose an interval of 1–31 calendar days and a valid first date.");
      return { loop: loopSnapshot(loop), next };
    },
    async saveLoop(loopId, next, expectedRevision) {
      guard();
      if (evaluatorForLoop(loopId)?.agencyTimed) throw Object.assign(new Error("This workflow runs at the time saved in agency setup. Nothing was changed."), { status: 409 });
      try {
        // The clock only, never `enabled`: an off, opt-in or waiting workflow stays as it was.
        await host.loops.patchClock(loopId as LoopId, { time: next.time, weekdays: next.weekdays, intervalDays: next.intervalDays, anchorDate: next.anchorDate, expectedRevision });
      } catch (error) {
        if ((error as { code?: unknown }).code === "schedule_changed") throw Object.assign(new Error(LOOP_SCHEDULE_CONFLICT), { code: "settings_changed" });
        throw error;
      }
    },
  };
}

export async function startWorkflowSettingsBroker(options: {
  /** The current turn's id while it may still act, else null. */
  turnId(): string | null;
  /** The current turn's settings binding, else undefined. */
  settings(): BudWorkflowSettings | undefined;
  /** RealBud's one-time review card; true only for an explicit allow. */
  approve(summary: string, signal: AbortSignal): Promise<boolean>;
  receipt?: (receipt: WorkflowSettingsReceipt) => void;
}): Promise<LoopbackToolServer> {
  const note = (receipt: WorkflowSettingsReceipt) => { try { options.receipt?.(receipt); } catch { /* receipts never change the outcome */ } };
  return startLoopbackToolServer({
    name: WORKFLOW_SETTINGS_SERVER,
    serverName: "Bud working rules",
    tools: TOOLS,
    maxConcurrent: 1,
    isActive: () => options.turnId() !== null && options.settings() !== undefined,
    async call(name, args, signal) {
      const turn = options.turnId(), settings = options.settings();
      if (!turn || !settings) return toolError("Bud is no longer working on this request. Nothing was changed.");
      const shape = ARGS[name]!;
      if (Object.keys(args).some(key => !shape.required.includes(key) && !shape.optional.includes(key)) || shape.required.some(key => args[key] === undefined)) {
        return toolError(`${name} takes ${[...shape.required, ...shape.optional.map(key => `optional ${key}`)].join(", ")}.`);
      }
      if (args.target !== undefined && !isTarget(args.target)) return toolError(`Choose a target: ${WORKFLOW_SETTINGS_TARGETS.join(", ")}. Nothing was changed.`);
      if (name === "workflow_settings_read") {
        const targets = args.target ? [args.target as WorkflowSettingsTarget] : [...WORKFLOW_SETTINGS_TARGETS];
        const rows: Record<string, WorkflowSettingsSnapshot> = {}, lines: string[] = [];
        let loops: LoopScheduleSnapshot[] | undefined;
        for (const target of targets) {
          if (target === "loop_schedule") {
            try { loops = settings.loops(); } catch (error) { return toolError(message(error, "The workflow schedules could not be read.")); }
            lines.push(...loops.map(loop => `- loop_schedule ${loop.loopId} ${JSON.stringify(loop.name)} (revision ${loop.revision}, ${loop.enabled ? "on" : "off"}` +
              `${loop.waitingForPlan ? ", waiting for plan approval" : ""}${loop.agencyTimed ? ", time set by agency setup" : ""}): ${scheduleWords(loop.schedule)} ${JSON.stringify(loop.schedule)}`));
            continue;
          }
          let row: WorkflowSettingsSnapshot;
          try { row = rows[target] = await settings.read(target); } catch (error) { return toolError(message(error, `The ${TARGETS[target].label} could not be read.`)); }
          lines.push(`- ${target} (revision ${row.revision}): ${Object.keys(TARGETS[target].fields).map(field => `${field} ${show(field, row.values[field])}`).join("; ")}. ` +
            (row.previous === null ? "Earlier versions are not kept." : `${row.previous.length} earlier version(s) kept.`));
        }
        return text(`Working rules:\n${lines.join("\n")}`, { settings: rows, ...(loops ? { loops } : {}) });
      }
      const target = args.target as WorkflowSettingsTarget;
      const reason = plainReason(args.reason);
      if (!reason) return toolError("Give one plain sentence saying why. Nothing was changed.");
      /** RealBud's one-time card, then the compare-and-set save on the revision read before it was shown. */
      const review = async (card: string, save: () => Promise<void>, saved: string, result: Record<string, unknown>, label: string) => {
        if (!await options.approve(card, signal)) {
          note({ tool: name, target, outcome: "declined" });
          return toolError("The person did not approve this change. Nothing was changed. Do not retry without a new request.");
        }
        if (signal.aborted || options.turnId() !== turn || options.settings() !== settings) return toolError("Bud is no longer working on this request. Nothing was changed.");
        try {
          await save();
          note({ tool: name, target, outcome: "succeeded" });
          return text(saved, result);
        } catch (error) {
          if ((error as { code?: unknown }).code === "settings_changed") { note({ tool: name, target, outcome: "conflict" }); return toolError(message(error, SETTINGS_CONFLICT)); }
          note({ tool: name, target, outcome: "failed" });
          // Stores throw plain sentences with a status; anything else stays generic.
          return toolError(typeof (error as { status?: unknown }).status === "number" ? message(error, "") || "Nothing was changed." : `The ${label} could not be saved. Ask again to check whether it was kept.`);
        }
      };
      if (target === "loop_schedule") {
        if (name === "workflow_settings_restore") return toolError("Earlier workflow schedules are not kept, so there is nothing to restore. Propose the schedule you want instead. Nothing was changed.");
        const values = args.values;
        if (!object(values) || Object.keys(values).some(key => key !== "loopId" && key !== "schedule") || values.loopId === undefined || values.schedule === undefined) {
          return toolError("For loop_schedule, values holds loopId and schedule. Nothing was changed.");
        }
        let checked: ReturnType<BudWorkflowSettings["checkLoop"]>;
        try { checked = settings.checkLoop(values.loopId, values.schedule); } catch (error) { note({ tool: name, target, outcome: "refused" }); return toolError(`${message(error, "Check the schedule.")} Nothing was changed.`); }
        const { loop, next } = checked, workflow = plainReason(loop.name) || loop.loopId;
        if (same(loop.schedule, next)) { note({ tool: name, target, outcome: "refused" }); return toolError(`${workflow} already runs ${scheduleWords(next)}. Nothing was changed.`); }
        // Before → after in plain words, what stays as it was, then Bud's reason (already one plain line).
        const card = ["Change workflow schedule", `${workflow}: ${scheduleWords(loop.schedule)} → ${scheduleWords(next)}`,
          // Approving a plan adopts the plan's own time (LoopManager.adoptRecipePlan), so the card says so.
          ...(loop.waitingForPlan ? ["It still waits for its plan to be approved, and approving the plan uses the plan's own time."]
            : loop.enabled ? [] : ["It stays off until someone switches it on in Schedule."]),
          `Why: ${reason}`].join("\n");
        return review(card, () => settings.saveLoop(loop.loopId, next, loop.revision),
          `Saved the schedule for ${workflow}: ${scheduleWords(next)}. Earlier schedules are not kept; it was: ${scheduleWords(loop.schedule)}.`,
          { target, loopId: loop.loopId, schedule: next }, "workflow schedule");
      }
      const spec = TARGETS[target];
      let current: WorkflowSettingsSnapshot;
      try { current = await settings.read(target); } catch (error) { return toolError(message(error, `The ${spec.label} could not be checked. Nothing was changed.`)); }
      let proposed: Values;
      if (name === "workflow_settings_propose") {
        const values = args.values;
        if (!values || typeof values !== "object" || Array.isArray(values)) return toolError("values must be an object of the fields to change. Nothing was changed.");
        const unknown = Object.keys(values).filter(key => !Object.hasOwn(spec.fields, key));
        if (unknown.length || !Object.keys(values).length) return toolError(`The ${spec.label} has the fields ${Object.keys(spec.fields).join(", ")}. Nothing was changed.`);
        proposed = { ...current.values, ...values };
      } else {
        if (current.previous === null) return toolError(`Earlier versions of the ${spec.label} are not kept, so there is nothing to restore. Nothing was changed.`);
        const back = args.previous ?? 1;
        if (!Number.isInteger(back) || (back as number) < 1 || (back as number) > current.previous.length) {
          return toolError(current.previous.length ? `Choose previous from 1 to ${current.previous.length}. Nothing was changed.` : `There is no earlier version of the ${spec.label} yet. Nothing was changed.`);
        }
        proposed = current.previous[(back as number) - 1]!.values;
      }
      let clean: Values;
      try { clean = settings.check(target, proposed); } catch (error) { note({ tool: name, target, outcome: "refused" }); return toolError(`${message(error, `Check the ${spec.label}.`)} Nothing was changed.`); }
      const diff = Object.keys(spec.fields).filter(field => !same(current.values[field], clean[field]));
      if (!diff.length) { note({ tool: name, target, outcome: "refused" }); return toolError(`The ${spec.label} already has those values. Nothing was changed.`); }
      const verb = name === "workflow_settings_restore" ? "Restore earlier" : "Change";
      // One line per changed field, then the notice and Bud's reason (already one plain line).
      const card = [`${verb} ${spec.label}`, ...diff.map(field => `${spec.fields[field]}: ${friendly(field, current.values[field])} → ${friendly(field, clean[field])}`),
        ...(spec.notice ? [spec.notice] : []), `Why: ${reason}`].join("\n");
      const before = diff.map(field => `${spec.fields[field]}: ${friendly(field, current.values[field])}`).join("; ");
      return review(card, () => settings.save(target, clean, current.revision),
        `Saved the ${spec.label}. ${current.previous === null ? `Earlier versions are not kept; it was: ${before}.` : "The version it replaced is kept and can be restored."}`,
        { target, values: clean }, spec.label);
    },
  });
}

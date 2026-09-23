import { WorkflowDatabase, workflowConflict, type WorkflowRecord } from "./workflow-database.ts";
import type { AttendedFenceContext } from "./attended-run.ts";
import { parseBrowserTaskGrant } from "../shared/browser-task.ts";

export interface LoginBinding {
  version: 1; pid?: number; windowId?: number; origin: string; accountMarker: string; readyMarker: string;
  browser?: { browserId: string; tabId: number };
}
/** What a paused attended task keeps while the person signs in: the attended
 * context that authorised it (restored as-is, with its grant: a saved job's own
 * or an Ask task's), its grant's remaining budget and the actions it already
 * completed. Never credentials, page contents or typed values. */
export interface HandoffTask {
  version: 1;
  context: AttendedFenceContext;
  grant: { grantId: string; runId: string; expiresAt: number | null; budget: number | null; used: number } | null;
  completed: string[];
}
export interface HumanHandoff {
  version: 1; runId: string; threadId: string; botId: string; jobRevision: number;
  reason: "login" | "mfa"; state: "releasing" | "awaiting_login" | "checking" | "verified" | "resuming" | "recovery_required" | "stopped" | "closed";
  createdAt: number; expiresAt: number; updatedAt: number; detail: string;
  binding?: LoginBinding;
  steps?: string[]; resumedRunId?: string; resumeStep?: number;
  /** Present when the run was kept, not ended: Continue carries on with this task. */
  task?: HandoffTask;
  /** Bud is waiting inside its browser step while the person signs in on the page. */
  inPage?: boolean;
}
const invalidTask = () => Object.assign(new Error("The saved task needs review. Start it again."), { status: 400 });
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;
const time = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) > 0;
export function validateHandoffTask(task: HandoffTask, runId: string): HandoffTask {
  const context = task?.context, grant = task?.grant;
  if (!task || task.version !== 1 || !context || typeof context !== "object" || context.runId !== runId || !/^[\w-]{1,120}$/.test(context.botId)
    || !Array.isArray(context.allowedOrigins) || context.allowedOrigins.length > 50 || !context.allowedOrigins.every(origin => text(origin, 300))
    || !Array.isArray(context.capabilities) || context.capabilities.length > 20 || !context.capabilities.every(capability => text(capability, 60))
    || JSON.stringify(context).length > 20_000
    || !(grant === null || grant && typeof grant === "object" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(grant.grantId) && grant.runId === runId
      && time(grant.expiresAt) && (grant.budget === null || Number.isSafeInteger(grant.budget) && grant.budget >= 0) && Number.isSafeInteger(grant.used) && grant.used >= 0)
    || !Array.isArray(task.completed) || task.completed.length > 20 || !task.completed.every(line => text(line, 500))) throw invalidTask();
  // The grant that continues is exactly the one that paused: for this run, and the one whose budget is kept.
  if (context.grant !== undefined) {
    let saved;
    try { saved = parseBrowserTaskGrant(context.grant); } catch { throw invalidTask(); }
    if (saved.runId !== runId || grant && grant.grantId !== saved.id) throw invalidTask();
  }
  return structuredClone(task);
}
const TASK_EXPIRED = "This task's permission ended while you were signing in, so Bud cannot continue it. Start the task again from your request.";
const TASK_SPENT = "This task used all its browser steps before you signed in, so Bud cannot continue it. Start the task again from your request.";
const CHECKPOINT_EXPIRED = "This sign-in checkpoint expired, so Bud cannot continue the task. Start it again from your request.";
const WAITING_ON_PAGE = "Bud is waiting on the page in your browser. Finish signing in there and press Done, or press Stop.";
export function validateLoginBinding(binding: LoginBinding): LoginBinding {
  if (!binding || binding.version !== 1 || (binding.browser
    ? typeof binding.browser.browserId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(binding.browser.browserId) || !Number.isSafeInteger(binding.browser.tabId) || binding.browser.tabId < 1 || binding.pid !== undefined || binding.windowId !== undefined
    : !Number.isSafeInteger(binding.pid) || Number(binding.pid) < 1 || !Number.isSafeInteger(binding.windowId) || Number(binding.windowId) < 1)) throw Object.assign(new Error("Choose the exact browser window for this sign-in check."), { status: 400 });
  let url: URL;
  try { url = new URL(binding.origin); } catch { throw Object.assign(new Error("Choose a valid HTTPS site."), { status: 400 }); }
  if (url.protocol !== "https:" || url.origin !== binding.origin || url.username || url.password) throw Object.assign(new Error("Sign-in checks need an exact HTTPS origin."), { status: 400 });
  for (const marker of [binding.accountMarker, binding.readyMarker]) if (typeof marker !== "string" || marker.trim().length < 4 || marker.length > 120 || /[\r\n\x00]/.test(marker) || /^[\d\s-]+$/.test(marker)) throw Object.assign(new Error("Use visible account and signed-in page labels, never an account number, password or code."), { status: 400 });
  return { ...structuredClone(binding), accountMarker: binding.accountMarker.trim(), readyMarker: binding.readyMarker.trim() };
}
const active = (state: HumanHandoff["state"]) => state !== "closed";
export interface HandoffHost {
  release(threadId: string): Promise<void>;
  verify(binding: LoginBinding, requestId: string): Promise<boolean>;
  restore?(): Promise<void>;
  resume?(handoff: WorkflowRecord<HumanHandoff>, step: number): Promise<string>;
  /** Carries on with the saved task after a confirmed sign-in; returns the run it continues in. */
  continueTask?(handoff: WorkflowRecord<HumanHandoff>): Promise<string>;
  /** Ends the kept run with a plain reason when the task cannot continue. */
  endTask?(handoff: WorkflowRecord<HumanHandoff>, detail: string): void;
}

/** Persist intent before touching the worker/desktop. A Continue click is a
 * single, fresh, read-only check, never evidence of authentication by itself. */
export class HumanHandoffs {
  private db: WorkflowDatabase;
  private host: HandoffHost;
  private now: () => number;
  constructor(db: WorkflowDatabase, host: HandoffHost, now = Date.now) { this.db = db; this.host = host; this.now = now; }
  list() { return this.db.list<HumanHandoff>("handoff"); }
  get(id: string) {
    const record = this.db.get<HumanHandoff>("handoff", id);
    if (!record || record.value.version !== 1) throw Object.assign(new Error("This sign-in request is no longer available."), { status: 404 });
    return record;
  }
  isHolding() { return this.list().some(r => active(r.value.state)); }
  private change(record: WorkflowRecord<HumanHandoff>, patch: Partial<HumanHandoff>) {
    return this.db.update<HumanHandoff>("handoff", record.id, record.revision, value => ({ ...value, ...patch, updatedAt: this.now() }));
  }
  private checked(input: Pick<HumanHandoff, "runId" | "threadId" | "botId" | "jobRevision" | "reason" | "steps" | "task">) {
    if (![input.runId, input.threadId, input.botId].every(v => typeof v === "string" && /^[\w-]{1,120}$/.test(v)) || !Number.isSafeInteger(input.jobRevision) || input.jobRevision < 1 || !["login", "mfa"].includes(input.reason)) throw Object.assign(new Error("Invalid sign-in checkpoint."), { status: 400 });
    if (input.steps && (!Array.isArray(input.steps) || input.steps.length > 100 || input.steps.some(step => typeof step !== "string" || step.length > 4000))) throw Object.assign(new Error("The saved job steps need review."), { status: 400 });
    return { ...input, ...(input.task ? { task: validateHandoffTask(input.task, input.runId) } : {}) };
  }
  /** A kept run can pause for sign-in more than once; each pause is its own record. This is the one still open. */
  activeFor(runId: string) { return this.list().find(record => record.value.runId === runId && active(record.value.state)); }
  private nextId(runId: string) {
    const first = `handover:${runId}`;
    if (!this.db.get("handoff", first)) return first;
    for (let n = 2; ; n++) if (!this.db.get("handoff", `${first}-${n}`)) return `${first}-${n}`;
  }
  async open(input: Pick<HumanHandoff, "runId" | "threadId" | "botId" | "jobRevision" | "reason" | "steps" | "task">) {
    const checked = this.checked(input);
    const existing = this.activeFor(input.runId);
    // Bud waiting on the page must stop too once the card takes over.
    if (existing) return existing.value.inPage ? this.toCard(existing.id, existing.revision, checked.task) : existing;
    const record = this.db.create<HumanHandoff>("handoff", this.nextId(input.runId), { ...checked, version: 1, state: "releasing", createdAt: this.now(), updatedAt: this.now(), expiresAt: this.now() + 24 * 60 * 60_000, detail: "Stopping Bud's worker and desktop connection before you sign in." }, 500);
    return this.release(record);
  }
  /** In-page sign-in: saved before the person is asked, so a restart still
   * finds the task paused. Bud stays inside its browser step; nothing is released. */
  hold(input: Pick<HumanHandoff, "runId" | "threadId" | "botId" | "jobRevision" | "reason" | "steps"> & { task: HandoffTask }) {
    const checked = this.checked(input);
    if (!checked.task || this.isHolding()) return null;
    return this.db.create<HumanHandoff>("handoff", this.nextId(input.runId), { ...checked, version: 1, state: "awaiting_login", inPage: true, createdAt: this.now(), updatedAt: this.now(), expiresAt: this.now() + 24 * 60 * 60_000,
      detail: "Sign in on the page in your browser, then press Done there. Bud is waiting and continues this task afterwards. Bud does not see or keep what you type." }, 500);
  }
  /** The active in-page wait for a run, if any. */
  waitingOnPage(runId: string) {
    const record = this.activeFor(runId);
    return record?.value.inPage && record.value.state === "awaiting_login" ? record : undefined;
  }
  /** A fresh read confirmed the in-page sign-in; the task already carried on in the same step. */
  signedInOnPage(id: string, revision: number) {
    const record = this.get(id);
    if (record.revision !== revision || !record.value.inPage || record.value.state !== "awaiting_login") throw workflowConflict();
    return this.change(record, { inPage: false, state: "closed", detail: "You finished signing in on the page. Bud continued the same task; earlier actions were not repeated." });
  }
  /** The in-page sign-in was not confirmed: keep the task and hand over to the card. */
  async toCard(id: string, revision: number, task?: HandoffTask) {
    const record = this.get(id);
    if (record.revision !== revision || !record.value.inPage || record.value.state !== "awaiting_login") throw workflowConflict();
    const saved = task ? validateHandoffTask(task, record.value.runId) : record.value.task;
    return this.release(this.change(record, { inPage: false, state: "releasing", ...(saved ? { task: saved } : {}), detail: "Stopping Bud's worker and browser connection before you sign in. The task stays paused." }));
  }
  async release(record: WorkflowRecord<HumanHandoff>) {
    try {
      await this.host.release(record.value.threadId);
      return this.change(record, { state: "awaiting_login", detail: record.value.task
        ? "Bud's computer connection is stopped and this task is paused with its remaining permission. Sign in directly in your browser, choose the signed-in page, then press Continue: Bud carries on with the same task. Keep passwords and codes out of chat."
        : "Bud's computer connection is stopped. Sign in directly in the application, then choose the page to check. Keep passwords and codes out of chat." });
    } catch {
      const current = this.get(record.id);
      if (current.revision !== record.revision) return current;
      return this.change(current, { state: "recovery_required", detail: "Computer release could not be confirmed. Do not enter credentials yet. Retry release or close RealBud before signing in." });
    }
  }
  async retryRelease(id: string, revision: number) {
    const record = this.get(id);
    if (record.revision !== revision || !["releasing", "recovery_required"].includes(record.value.state)) throw workflowConflict();
    return this.release(this.change(record, { state: "releasing" }));
  }
  bind(id: string, revision: number, binding: LoginBinding) {
    const record = this.get(id);
    if (record.revision !== revision || record.value.state !== "awaiting_login") throw workflowConflict();
    return this.change(record, { binding: validateLoginBinding(binding) });
  }
  async continue(id: string, revision: number) {
    let record = this.get(id);
    if (record.revision !== revision || record.value.state !== "awaiting_login") throw workflowConflict();
    if (record.value.inPage) throw Object.assign(new Error(WAITING_ON_PAGE), { status: 409 });
    if (record.value.task && this.taskEnded(record)) return this.endTask(record, this.taskEnded(record)!);
    if (record.value.expiresAt <= this.now()) return record.value.task ? this.endTask(record, CHECKPOINT_EXPIRED)
      : this.change(record, { state: "recovery_required", detail: "This checkpoint expired. Review the saved job and establish a fresh sign-in checkpoint." });
    if (!record.value.binding) throw Object.assign(new Error("Choose the signed-in page and save its visible labels before continuing."), { status: 409 });
    record = this.change(record, { state: "checking", detail: "Checking the saved site, account and signed-in page once. No typing or submissions are allowed." });
    let verified = false;
    try { verified = await this.host.verify(record.value.binding!, `${id}:${record.revision}`); }
    catch { /* A failed check is a held login, never an authenticated session. */ }
    // Quiesce again even after a successful read: only this checkpoint's
    // explicit continuation (or a reviewed step) may start more work.
    let released = false;
    try { await this.host.release(record.value.threadId); released = true; } catch { /* stay held */ }
    const current = this.get(id);
    if (current.revision !== record.revision || current.value.state !== "checking") return current;
    if (released && verified && current.value.task) return this.continueTask(current);
    return this.change(current, !released
      ? { state: "recovery_required", detail: "The check ended, but computer release could not be confirmed. Close RealBud or retry release before entering credentials." }
      : verified
        ? { state: "verified", detail: "The saved site, account and signed-in page were confirmed. The earlier run remains interrupted: review its last completed action before starting the next step. No earlier actions were replayed." }
        : { state: "awaiting_login", detail: "The expected account and signed-in page could not both be confirmed. Bud is stopped again. Finish signing in or change the page check, then try Continue." });
  }
  /** Why a paused task can no longer continue: its grant's time ran out or its steps are spent. */
  private taskEnded(record: WorkflowRecord<HumanHandoff>): string | null {
    const task = record.value.task;
    const until = task?.grant?.expiresAt ?? task?.context.grant?.expiresAt;
    if (until !== null && until !== undefined && until <= this.now()) return TASK_EXPIRED;
    const budget = task?.grant?.budget;
    return budget !== null && budget !== undefined && task!.grant!.used >= budget ? TASK_SPENT : null;
  }
  /** The task cannot continue: say so plainly, end its kept run, hold until closed. */
  private endTask(record: WorkflowRecord<HumanHandoff>, detail: string) {
    const stopped = this.change(record, { state: "stopped", inPage: false, detail });
    try { this.host.endTask?.(stopped, detail); } catch { /* the run keeps its own restart recovery */ }
    return stopped;
  }
  /** Carries on with the same task (its grant, remaining budget and completed
   * steps) once a fresh check confirmed the sign-in. Claimed before dispatch;
   * an uncertain start is held for review, never retried automatically. */
  private async continueTask(record: WorkflowRecord<HumanHandoff>) {
    if (!this.host.continueTask || !this.host.restore) return this.change(record, { state: "verified", detail: "The saved site, account and signed-in page were confirmed. This host cannot continue the task itself: choose the next reviewed step. No earlier actions were replayed." });
    if (this.taskEnded(record)) return this.endTask(record, this.taskEnded(record)!);
    if (this.list().some(other => other.id !== record.id && active(other.value.state))) return this.change(record, { state: "awaiting_login", detail: "Another sign-in checkpoint still holds this computer. Finish it, then press Continue again." });
    const claimed = this.change(record, { state: "resuming", detail: "You are signed in. Bud is continuing the same task with its remaining permission; earlier actions are not repeated." });
    try {
      await this.host.restore();
      if (!this.canResume(record.id) || this.get(record.id).revision !== claimed.revision) throw workflowConflict();
      const resumedRunId = await this.host.continueTask(claimed);
      return this.change(claimed, { state: "closed", resumedRunId, detail: "You are signed in. Bud continued the same task from where it stopped; earlier actions were not repeated. Check Work activity for its result." });
    } catch {
      await this.host.release(record.value.threadId).catch(() => {});
      const current = this.get(record.id);
      if (current.revision !== claimed.revision) return current;
      return this.change(current, { state: "recovery_required", detail: "Bud could not confirm that the task continued. Review Work activity before retrying; it may already have started. Nothing is repeated automatically." });
    }
  }
  async stop(id: string, revision: number) {
    const record = this.get(id);
    if (record.revision !== revision || record.value.state === "stopped") throw workflowConflict();
    const stopped = this.change(record, { state: "stopped", inPage: false, detail: record.value.task ? "Stopped. The paused task ended; nothing further was done and old Continue buttons cannot resume it." : "Stopped. Old Continue buttons cannot resume this request." });
    if (record.value.task && record.value.state !== "closed") { try { this.host.endTask?.(stopped, "Stopped by you while waiting for sign-in. Nothing further was done."); } catch { /* restart recovery ends it */ } }
    try { await this.host.release(record.value.threadId); }
    catch { return this.change(stopped, { state: "recovery_required", detail: "Stop was saved, but desktop release still needs confirmation. Close RealBud or retry release." }); }
    return this.get(id);
  }
  async close(id: string, revision: number) {
    const record = this.get(id);
    if (record.revision !== revision || !["verified", "stopped"].includes(record.value.state)) throw workflowConflict();
    if (this.list().some(other => other.id !== id && active(other.value.state))) throw Object.assign(new Error("Another sign-in checkpoint still holds this computer."), { status: 409 });
    if (!this.host.restore) throw Object.assign(new Error("The desktop host cannot restore computer access."), { status: 503 });
    // Claim before async restore. A crash remains a held recovery, never an
    // automatic continuation of the original model turn.
    const claimed = this.change(record, { state: "releasing", detail: "Restoring computer availability. The earlier job stays interrupted." });
    try { await this.host.restore(); return this.change(claimed, { state: "closed", detail: "Handover closed. Computer access is available for a new reviewed step. The earlier run was not replayed." }); }
    catch { return this.change(claimed, { state: "recovery_required", detail: "Computer availability could not be restored. Retry release before continuing." }); }
  }
  canResume(id?: string) {
    return Boolean(id && this.get(id).value.state === "resuming" && !this.list().some(other => other.id !== id && active(other.value.state)));
  }
  async resumeStep(id: string, revision: number, step: number) {
    const record = this.get(id);
    if (record.revision !== revision || record.value.state !== "verified") throw workflowConflict();
    if (this.now() - record.value.updatedAt > 60_000) return this.change(record, { state: "awaiting_login", detail: "The sign-in check is over a minute old. Press Continue for a fresh check before selecting the next step." });
    if (!Number.isSafeInteger(step) || step < 0 || step >= (record.value.steps?.length ?? 0)) throw Object.assign(new Error("Choose the next reviewed step from the saved job."), { status: 400 });
    if (!this.host.resume || !this.host.restore) throw Object.assign(new Error("Step recovery is unavailable on this host."), { status: 503 });
    if (this.list().some(other => other.id !== id && active(other.value.state))) throw workflowConflict();
    const claimed = this.change(record, { state: "resuming", resumeStep: step, detail: `Starting only reviewed step ${step + 1}. Earlier steps will not be replayed.` });
    // A kept run ends before its reviewed step starts as a separate attempt.
    if (record.value.task) { try { this.host.endTask?.(claimed, "Replaced by a reviewed recovery step after sign-in. Earlier actions were not repeated."); } catch { /* restart recovery ends it */ } }
    try {
      await this.host.restore();
      if (!this.canResume(id) || this.get(id).revision !== claimed.revision) throw workflowConflict();
      const resumedRunId = await this.host.resume(claimed, step);
      return this.change(claimed, { state: "closed", resumedRunId, detail: `Step ${step + 1} has its own saved attempt. Check Work activity for its outcome; starting it does not mean it completed.` });
    } catch {
      await this.host.release(record.value.threadId).catch(() => {});
      const current = this.get(id);
      if (current.revision !== claimed.revision) return current;
      return this.change(current, { state: "recovery_required", detail: "The next step could not be confirmed. Review Work activity before retrying; it may already have started. No automatic replay is allowed." });
    }
  }
  /** Interrupted release/check transitions cannot become successful on boot.
   * A paused task stays paused: an in-page wait ended with the restart, so its
   * old browser session is released and the card takes over with the task kept. */
  recover() {
    for (const record of this.list()) {
      if (["checking", "releasing", "resuming"].includes(record.value.state)) this.change(record, { state: "recovery_required", detail: "RealBud restarted during a sign-in check or step dispatch. Review Work activity and retry computer release before continuing; no work has been replayed." });
      else if (record.value.state === "awaiting_login" && record.value.inPage) {
        const releasing = this.change(record, { inPage: false, state: "releasing", detail: "RealBud restarted while you were signing in. The task is still paused; stopping the earlier browser session first." });
        void this.release(releasing).catch(() => { /* stays releasing: the next restart holds it for review */ });
      }
    }
  }
}

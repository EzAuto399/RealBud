import { WorkflowDatabase, workflowConflict, type WorkflowRecord } from "./workflow-database.ts";

export interface LoginBinding {
  version: 1; pid: number; windowId: number; origin: string; accountMarker: string; readyMarker: string;
}
export interface HumanHandoff {
  version: 1; runId: string; threadId: string; jobRevision: number;
  reason: "login" | "mfa"; state: "releasing" | "awaiting_login" | "checking" | "verified" | "recovery_required" | "stopped" | "closed";
  createdAt: number; expiresAt: number; updatedAt: number; detail: string;
  binding?: LoginBinding;
}
export function validateLoginBinding(binding: LoginBinding): LoginBinding {
  if (!binding || binding.version !== 1 || !Number.isSafeInteger(binding.pid) || binding.pid < 1 || !Number.isSafeInteger(binding.windowId) || binding.windowId < 1) throw Object.assign(new Error("Choose the exact browser window for this sign-in check."), { status: 400 });
  let url: URL;
  try { url = new URL(binding.origin); } catch { throw Object.assign(new Error("Choose a valid HTTPS site."), { status: 400 }); }
  if (url.protocol !== "https:" || url.origin !== binding.origin || url.username || url.password) throw Object.assign(new Error("Sign-in checks need an exact HTTPS origin."), { status: 400 });
  for (const marker of [binding.accountMarker, binding.readyMarker]) if (typeof marker !== "string" || marker.trim().length < 4 || marker.length > 120 || /[\r\n\x00]/.test(marker)) throw Object.assign(new Error("Use visible account and signed-in page labels, never a password or code."), { status: 400 });
  return structuredClone(binding);
}
const active = (state: HumanHandoff["state"]) => state !== "closed";
export interface HandoffHost {
  release(threadId: string): Promise<void>;
  verify(binding: LoginBinding, requestId: string): Promise<boolean>;
  restore?(): Promise<void>;
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
  async open(input: Pick<HumanHandoff, "runId" | "threadId" | "jobRevision" | "reason">) {
    if (![input.runId, input.threadId].every(v => typeof v === "string" && /^[\w-]{1,120}$/.test(v)) || !Number.isSafeInteger(input.jobRevision) || input.jobRevision < 1 || !["login", "mfa"].includes(input.reason)) throw Object.assign(new Error("Invalid sign-in checkpoint."), { status: 400 });
    const id = `handover:${input.runId}`;
    const existing = this.db.get<HumanHandoff>("handoff", id);
    if (existing) return existing;
    const record = this.db.create<HumanHandoff>("handoff", id, { ...input, version: 1, state: "releasing", createdAt: this.now(), updatedAt: this.now(), expiresAt: this.now() + 24 * 60 * 60_000, detail: "Stopping Bud's worker and desktop connection before you sign in." }, 500);
    return this.release(record);
  }
  async release(record: WorkflowRecord<HumanHandoff>) {
    try {
      await this.host.release(record.value.threadId);
      return this.change(record, { state: "awaiting_login", detail: "Bud's computer connection is stopped. Sign in directly in the application, then press Continue. Keep passwords and codes out of chat." });
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
    if (record.value.expiresAt <= this.now()) return this.change(record, { state: "recovery_required", detail: "This checkpoint expired. Review the saved job and establish a fresh sign-in checkpoint." });
    if (!record.value.binding) throw Object.assign(new Error("This site's account and signed-in page check has not been calibrated. Your setup person must connect that check before Continue can resume work."), { status: 409 });
    record = this.change(record, { state: "checking", detail: "Checking the saved site, account and signed-in page once. No typing or submissions are allowed." });
    let verified = false;
    try { verified = await this.host.verify(record.value.binding!, `${id}:${record.revision}`); }
    catch { /* A failed check is a held login, never an authenticated session. */ }
    // Quiesce again even after a successful read: no worker has authority to
    // run another step until its explicit checkpoint is selected separately.
    let released = false;
    try { await this.host.release(record.value.threadId); released = true; } catch { /* stay held */ }
    const current = this.get(id);
    if (current.revision !== record.revision || current.value.state !== "checking") return current;
    return this.change(current, !released
      ? { state: "recovery_required", detail: "The check ended, but computer release could not be confirmed. Close RealBud or retry release before entering credentials." }
      : verified
        ? { state: "verified", detail: "The saved site, account and signed-in page were confirmed. The earlier run remains interrupted: review its last completed action before starting the next step. No earlier actions were replayed." }
        : { state: "awaiting_login", detail: "The expected account and signed-in page could not both be confirmed. Bud is stopped again. Finish signing in or ask your setup person to check the saved window, then try Continue." });
  }
  async stop(id: string, revision: number) {
    const record = this.get(id);
    if (record.revision !== revision || record.value.state === "stopped") throw workflowConflict();
    const stopped = this.change(record, { state: "stopped", detail: "Stopped. Old Continue buttons cannot resume this request." });
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
  /** Interrupted release/check transitions cannot become successful on boot. */
  recover() {
    for (const record of this.list()) if (["checking", "releasing"].includes(record.value.state)) this.change(record, { state: "recovery_required", detail: "RealBud restarted during a sign-in check. Retry computer release before continuing; no work has been replayed." });
  }
}

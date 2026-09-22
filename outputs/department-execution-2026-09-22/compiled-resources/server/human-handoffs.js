import { workflowConflict } from "./workflow-database.js";
export function validateLoginBinding(binding) {
    if (!binding || binding.version !== 1 || (binding.browser
        ? typeof binding.browser.browserId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(binding.browser.browserId) || !Number.isSafeInteger(binding.browser.tabId) || binding.browser.tabId < 1 || binding.pid !== undefined || binding.windowId !== undefined
        : !Number.isSafeInteger(binding.pid) || Number(binding.pid) < 1 || !Number.isSafeInteger(binding.windowId) || Number(binding.windowId) < 1))
        throw Object.assign(new Error("Choose the exact browser window for this sign-in check."), { status: 400 });
    let url;
    try {
        url = new URL(binding.origin);
    }
    catch {
        throw Object.assign(new Error("Choose a valid HTTPS site."), { status: 400 });
    }
    if (url.protocol !== "https:" || url.origin !== binding.origin || url.username || url.password)
        throw Object.assign(new Error("Sign-in checks need an exact HTTPS origin."), { status: 400 });
    for (const marker of [binding.accountMarker, binding.readyMarker])
        if (typeof marker !== "string" || marker.trim().length < 4 || marker.length > 120 || /[\r\n\x00]/.test(marker) || /^[\d\s-]+$/.test(marker))
            throw Object.assign(new Error("Use visible account and signed-in page labels, never an account number, password or code."), { status: 400 });
    return { ...structuredClone(binding), accountMarker: binding.accountMarker.trim(), readyMarker: binding.readyMarker.trim() };
}
const active = (state) => state !== "closed";
/** Persist intent before touching the worker/desktop. A Continue click is a
 * single, fresh, read-only check, never evidence of authentication by itself. */
export class HumanHandoffs {
    db;
    host;
    now;
    constructor(db, host, now = Date.now) { this.db = db; this.host = host; this.now = now; }
    list() { return this.db.list("handoff"); }
    get(id) {
        const record = this.db.get("handoff", id);
        if (!record || record.value.version !== 1)
            throw Object.assign(new Error("This sign-in request is no longer available."), { status: 404 });
        return record;
    }
    isHolding() { return this.list().some(r => active(r.value.state)); }
    change(record, patch) {
        return this.db.update("handoff", record.id, record.revision, value => ({ ...value, ...patch, updatedAt: this.now() }));
    }
    async open(input) {
        if (![input.runId, input.threadId, input.botId].every(v => typeof v === "string" && /^[\w-]{1,120}$/.test(v)) || !Number.isSafeInteger(input.jobRevision) || input.jobRevision < 1 || !["login", "mfa"].includes(input.reason))
            throw Object.assign(new Error("Invalid sign-in checkpoint."), { status: 400 });
        const id = `handover:${input.runId}`;
        if (input.steps && (!Array.isArray(input.steps) || input.steps.length > 100 || input.steps.some(step => typeof step !== "string" || step.length > 4000)))
            throw Object.assign(new Error("The saved job steps need review."), { status: 400 });
        const existing = this.db.get("handoff", id);
        if (existing)
            return existing;
        const record = this.db.create("handoff", id, { ...input, version: 1, state: "releasing", createdAt: this.now(), updatedAt: this.now(), expiresAt: this.now() + 24 * 60 * 60_000, detail: "Stopping Bud's worker and desktop connection before you sign in." }, 500);
        return this.release(record);
    }
    async release(record) {
        try {
            await this.host.release(record.value.threadId);
            return this.change(record, { state: "awaiting_login", detail: "Bud's computer connection is stopped. Sign in directly in the application, then choose the page to check. Keep passwords and codes out of chat." });
        }
        catch {
            const current = this.get(record.id);
            if (current.revision !== record.revision)
                return current;
            return this.change(current, { state: "recovery_required", detail: "Computer release could not be confirmed. Do not enter credentials yet. Retry release or close RealBud before signing in." });
        }
    }
    async retryRelease(id, revision) {
        const record = this.get(id);
        if (record.revision !== revision || !["releasing", "recovery_required"].includes(record.value.state))
            throw workflowConflict();
        return this.release(this.change(record, { state: "releasing" }));
    }
    bind(id, revision, binding) {
        const record = this.get(id);
        if (record.revision !== revision || record.value.state !== "awaiting_login")
            throw workflowConflict();
        return this.change(record, { binding: validateLoginBinding(binding) });
    }
    async continue(id, revision) {
        let record = this.get(id);
        if (record.revision !== revision || record.value.state !== "awaiting_login")
            throw workflowConflict();
        if (record.value.expiresAt <= this.now())
            return this.change(record, { state: "recovery_required", detail: "This checkpoint expired. Review the saved job and establish a fresh sign-in checkpoint." });
        if (!record.value.binding)
            throw Object.assign(new Error("Choose the signed-in page and save its visible labels before continuing."), { status: 409 });
        record = this.change(record, { state: "checking", detail: "Checking the saved site, account and signed-in page once. No typing or submissions are allowed." });
        let verified = false;
        try {
            verified = await this.host.verify(record.value.binding, `${id}:${record.revision}`);
        }
        catch { /* A failed check is a held login, never an authenticated session. */ }
        // Quiesce again even after a successful read: no worker has authority to
        // run another step until its explicit checkpoint is selected separately.
        let released = false;
        try {
            await this.host.release(record.value.threadId);
            released = true;
        }
        catch { /* stay held */ }
        const current = this.get(id);
        if (current.revision !== record.revision || current.value.state !== "checking")
            return current;
        return this.change(current, !released
            ? { state: "recovery_required", detail: "The check ended, but computer release could not be confirmed. Close RealBud or retry release before entering credentials." }
            : verified
                ? { state: "verified", detail: "The saved site, account and signed-in page were confirmed. The earlier run remains interrupted: review its last completed action before starting the next step. No earlier actions were replayed." }
                : { state: "awaiting_login", detail: "The expected account and signed-in page could not both be confirmed. Bud is stopped again. Finish signing in or change the page check, then try Continue." });
    }
    async stop(id, revision) {
        const record = this.get(id);
        if (record.revision !== revision || record.value.state === "stopped")
            throw workflowConflict();
        const stopped = this.change(record, { state: "stopped", detail: "Stopped. Old Continue buttons cannot resume this request." });
        try {
            await this.host.release(record.value.threadId);
        }
        catch {
            return this.change(stopped, { state: "recovery_required", detail: "Stop was saved, but desktop release still needs confirmation. Close RealBud or retry release." });
        }
        return this.get(id);
    }
    async close(id, revision) {
        const record = this.get(id);
        if (record.revision !== revision || !["verified", "stopped"].includes(record.value.state))
            throw workflowConflict();
        if (this.list().some(other => other.id !== id && active(other.value.state)))
            throw Object.assign(new Error("Another sign-in checkpoint still holds this computer."), { status: 409 });
        if (!this.host.restore)
            throw Object.assign(new Error("The desktop host cannot restore computer access."), { status: 503 });
        // Claim before async restore. A crash remains a held recovery, never an
        // automatic continuation of the original model turn.
        const claimed = this.change(record, { state: "releasing", detail: "Restoring computer availability. The earlier job stays interrupted." });
        try {
            await this.host.restore();
            return this.change(claimed, { state: "closed", detail: "Handover closed. Computer access is available for a new reviewed step. The earlier run was not replayed." });
        }
        catch {
            return this.change(claimed, { state: "recovery_required", detail: "Computer availability could not be restored. Retry release before continuing." });
        }
    }
    canResume(id) {
        return Boolean(id && this.get(id).value.state === "resuming" && !this.list().some(other => other.id !== id && active(other.value.state)));
    }
    async resumeStep(id, revision, step) {
        const record = this.get(id);
        if (record.revision !== revision || record.value.state !== "verified")
            throw workflowConflict();
        if (this.now() - record.value.updatedAt > 60_000)
            return this.change(record, { state: "awaiting_login", detail: "The sign-in check is over a minute old. Press Continue for a fresh check before selecting the next step." });
        if (!Number.isSafeInteger(step) || step < 0 || step >= (record.value.steps?.length ?? 0))
            throw Object.assign(new Error("Choose the next reviewed step from the saved job."), { status: 400 });
        if (!this.host.resume || !this.host.restore)
            throw Object.assign(new Error("Step recovery is unavailable on this host."), { status: 503 });
        if (this.list().some(other => other.id !== id && active(other.value.state)))
            throw workflowConflict();
        const claimed = this.change(record, { state: "resuming", resumeStep: step, detail: `Starting only reviewed step ${step + 1}. Earlier steps will not be replayed.` });
        try {
            await this.host.restore();
            if (!this.canResume(id) || this.get(id).revision !== claimed.revision)
                throw workflowConflict();
            const resumedRunId = await this.host.resume(claimed, step);
            return this.change(claimed, { state: "closed", resumedRunId, detail: `Step ${step + 1} has its own saved attempt. Check Work activity for its outcome; starting it does not mean it completed.` });
        }
        catch {
            await this.host.release(record.value.threadId).catch(() => { });
            const current = this.get(id);
            if (current.revision !== claimed.revision)
                return current;
            return this.change(current, { state: "recovery_required", detail: "The next step could not be confirmed. Review Work activity before retrying; it may already have started. No automatic replay is allowed." });
        }
    }
    /** Interrupted release/check transitions cannot become successful on boot. */
    recover() {
        for (const record of this.list())
            if (["checking", "releasing", "resuming"].includes(record.value.state))
                this.change(record, { state: "recovery_required", detail: "RealBud restarted during a sign-in check or step dispatch. Review Work activity and retry computer release before continuing; no work has been replayed." });
    }
}

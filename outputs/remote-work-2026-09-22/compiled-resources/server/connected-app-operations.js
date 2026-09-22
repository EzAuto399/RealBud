// RealBud's dispatch receipts contain identifiers and fixed status text only.
// Tool arguments, provider results, account details and credentials stay out.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
const MAX_OPERATIONS = 1_000;
const MAX_BYTES = 2 * 1024 * 1024;
const DETAILS = {
    started: "The app operation was recorded before dispatch. Its outcome is not yet confirmed.",
    succeeded: "The app service returned a successful operation result.",
    failed: "The app service reported an operation failure. Review its result before retrying.",
    unknown: "The app outcome is unknown. Check the app before trying this action again; RealBud has not replayed it.",
    denied: "The app operation was not approved or was stopped before dispatch.",
    partial: "Some app operations failed; others may have succeeded. Check the app before retrying.",
};
const RECOVERY = "Connected-app history needs recovery. App actions are paused. Check disk space and file access, then restore the saved history if needed and restart RealBud.";
const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
export const validAppToolName = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,149}$/.test(value);
export const validAppToolSlug = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,149}$/.test(value);
const validThread = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const timestamp = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const clone = (row) => ({ ...row, toolSlugs: [...row.toolSlugs] });
const failure = () => Object.assign(new Error(RECOVERY), { status: 503 });
export class ConnectedAppOperationStore {
    rows = [];
    held = false;
    file;
    now;
    constructor(options = {}) {
        this.file = options.file ?? join(DATA_DIR, "connected-app-operations.json");
        this.now = options.now ?? Date.now;
        try {
            if (statSync(this.file).size > MAX_BYTES)
                throw failure();
            const saved = JSON.parse(readFileSync(this.file, "utf8"));
            if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.operations) || saved.operations.length > MAX_OPERATIONS)
                throw failure();
            const ids = new Set();
            this.rows = saved.operations.map((row) => {
                if (!record(row) || typeof row.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) || ids.has(row.id) ||
                    !validThread(row.threadId) || !validAppToolName(row.toolName) || !Array.isArray(row.toolSlugs) ||
                    row.toolSlugs.length > 50 || !row.toolSlugs.every(validAppToolSlug) || !timestamp(row.startedAt) ||
                    typeof row.status !== "string" || !["started", "succeeded", "failed", "unknown", "denied"].includes(row.status) ||
                    (row.status === "started" ? row.finishedAt !== undefined : !timestamp(row.finishedAt)) ||
                    (row.finishedAt !== undefined && Number(row.finishedAt) < row.startedAt) ||
                    (row.detail !== DETAILS[row.status] && !(row.status === "failed" && row.detail === DETAILS.partial)) ||
                    Object.keys(row).some(key => !["id", "threadId", "toolName", "toolSlugs", "status", "startedAt", "finishedAt", "detail"].includes(key)))
                    throw failure();
                ids.add(row.id);
                return clone(row);
            });
            if (this.rows.some(row => row.status === "started")) {
                this.commit(this.rows.map(row => row.status === "started"
                    ? { ...row, status: "unknown", finishedAt: Math.max(row.startedAt, this.now()), detail: DETAILS.unknown } : row));
            }
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                this.held = true;
        }
    }
    list(threadId) {
        this.assertAvailable();
        return this.rows.filter(row => threadId === undefined || row.threadId === threadId)
            .sort((a, b) => b.startedAt - a.startedAt).map(clone);
    }
    start(input) { return this.add(input, "started"); }
    deny(input) { return this.add(input, "denied"); }
    finish(id, status, partial = false) {
        this.assertAvailable();
        const existing = this.rows.find(row => row.id === id);
        if (!existing)
            throw Object.assign(new Error("No such app operation."), { status: 404 });
        if (existing.status !== "started")
            return clone(existing);
        const next = { ...existing, status, finishedAt: Math.max(existing.startedAt, this.now()), detail: partial && status === "failed" ? DETAILS.partial : DETAILS[status] };
        this.commit(this.rows.map(row => row.id === id ? next : row));
        return clone(next);
    }
    add(input, status) {
        this.assertAvailable();
        if (!validThread(input.threadId) || !validAppToolName(input.toolName) || !Array.isArray(input.toolSlugs) ||
            input.toolSlugs.length > 50 || !input.toolSlugs.every(validAppToolSlug))
            throw Object.assign(new Error("Invalid app operation identifiers."), { status: 400 });
        const now = this.now();
        const row = { id: randomUUID(), threadId: input.threadId, toolName: input.toolName,
            toolSlugs: [...new Set(input.toolSlugs)], status, startedAt: now,
            ...(status === "denied" ? { finishedAt: now } : {}), detail: DETAILS[status] };
        // Unresolved outcomes cannot disappear when routine successful reads churn.
        const next = [...this.rows];
        if (next.length >= MAX_OPERATIONS) {
            const evict = next.findIndex(item => item.status !== "started" && item.status !== "unknown");
            if (evict < 0)
                throw Object.assign(new Error("Connected-app history is full of unresolved operations. Review their outcomes before starting more app work."), { status: 503 });
            next.splice(evict, 1);
        }
        this.commit([...next, row]);
        return clone(row);
    }
    assertAvailable() { if (this.held)
        throw failure(); }
    commit(next) {
        const body = JSON.stringify({ version: 1, operations: next });
        try {
            if (Buffer.byteLength(body) > MAX_BYTES)
                throw failure();
            mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
            writeFileAtomic(this.file, body, 0o600);
            this.rows = next;
        }
        catch {
            // A rename may have succeeded before fsync failed. Either way no new
            // dispatch is authorized; disk is authoritative again only on restart.
            this.held = true;
            throw failure();
        }
    }
}
export const connectedAppOperations = new ConnectedAppOperationStore();
export const listConnectedAppOperations = (threadId) => connectedAppOperations.list(threadId);

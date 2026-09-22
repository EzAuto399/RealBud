import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
const VERSION = 1;
const ROLLING_DAYS = 7;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_RECORDS = 2_000;
const MAX_TOKENS_PER_TURN = 1_000_000_000;
const MAX_COST_PER_TURN_USD = 1_000_000;
function boundedCount(value, max) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return null;
    return Math.min(max, Math.floor(value));
}
function boundedCost(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return null;
    return Math.min(MAX_COST_PER_TURN_USD, value);
}
function highestReported(current, incoming) {
    if (incoming == null)
        return current ?? null;
    if (current == null)
        return incoming;
    return Math.max(current, incoming);
}
function boundedLabel(value, max) {
    if (typeof value !== "string")
        return "";
    return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function recordKey(threadId, turnId) {
    return createHash("sha256").update(`${threadId}:${turnId}`).digest("hex").slice(0, 24);
}
function normalizeRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const record = value;
    if (typeof record.key !== "string" || !/^[a-f0-9]{24}$/.test(record.key))
        return null;
    if (typeof record.at !== "number" || !Number.isFinite(record.at) || record.at <= 0)
        return null;
    if (typeof record.completed !== "boolean")
        return null;
    const inputTokens = record.inputTokens == null ? null : boundedCount(record.inputTokens, MAX_TOKENS_PER_TURN);
    const outputTokens = record.outputTokens == null ? null : boundedCount(record.outputTokens, MAX_TOKENS_PER_TURN);
    const costUsd = record.costUsd == null ? null : boundedCost(record.costUsd);
    if (record.inputTokens != null && inputTokens == null)
        return null;
    if (record.outputTokens != null && outputTokens == null)
        return null;
    if (record.costUsd != null && costUsd == null)
        return null;
    if (record.ok != null && typeof record.ok !== "boolean")
        return null;
    return {
        key: record.key,
        at: Math.floor(record.at),
        provider: boundedLabel(record.provider, 80),
        model: boundedLabel(record.model, 160),
        inputTokens,
        outputTokens,
        costUsd,
        completed: record.completed,
        ok: record.ok ?? null,
    };
}
/** A bounded, private observability ledger. It stores no prompts, messages,
 * property references, attachments or credentials. A write failure never
 * blocks Bud; the UI names that recent usage may be incomplete instead. */
export class UsageLedger {
    file;
    now;
    writer;
    records = [];
    recovered = false;
    writeIssue = "";
    constructor(options = {}) {
        this.file = options.file ?? join(DATA_DIR, "usage.json");
        this.now = options.now ?? Date.now;
        this.writer = options.writer ?? writeFileAtomic;
        this.load();
    }
    load() {
        if (!existsSync(this.file))
            return;
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8"));
            if (parsed.version !== VERSION || !Array.isArray(parsed.records))
                throw new Error("unsupported usage ledger");
            const normalized = parsed.records.flatMap((record) => {
                const next = normalizeRecord(record);
                return next ? [next] : [];
            });
            this.records = this.trim(normalized);
            this.recovered = normalized.length !== parsed.records.length;
        }
        catch {
            try {
                renameSync(this.file, `${this.file}.corrupt-${this.now()}-${process.pid}`);
                this.records = [];
                this.recovered = true;
            }
            catch {
                this.records = [];
                this.writeIssue = "Local usage history could not be read or preserved. Usage reporting is paused.";
            }
        }
    }
    trim(records) {
        const oldest = this.now() - RETENTION_MS;
        return records
            .filter((record) => record.at >= oldest)
            .sort((a, b) => a.at - b.at)
            .slice(-MAX_RECORDS);
    }
    record(observation) {
        const threadId = boundedLabel(observation.threadId, 240);
        const turnId = boundedLabel(observation.turnId, 240);
        if (!threadId || !turnId)
            return this.summary();
        const key = recordKey(threadId, turnId);
        const current = this.records.find((record) => record.key === key);
        const at = boundedCount(observation.at ?? this.now(), Number.MAX_SAFE_INTEGER) ?? this.now();
        const input = observation.inputTokens === undefined
            ? undefined
            : boundedCount(observation.inputTokens, MAX_TOKENS_PER_TURN);
        const output = observation.outputTokens === undefined
            ? undefined
            : boundedCount(observation.outputTokens, MAX_TOKENS_PER_TURN);
        const cost = observation.costUsd === undefined ? undefined : boundedCost(observation.costUsd);
        const next = {
            key,
            at: Math.max(current?.at ?? 0, at),
            provider: boundedLabel(observation.provider, 80) || current?.provider || "",
            model: boundedLabel(observation.model, 160) || current?.model || "",
            // Token events may be retried or arrive out of order. Providers report
            // cumulative turn totals, so a stale observation must never move the
            // private meter backwards or double-count the turn.
            inputTokens: highestReported(current?.inputTokens, input),
            outputTokens: highestReported(current?.outputTokens, output),
            costUsd: highestReported(current?.costUsd, cost),
            completed: Boolean(observation.completed || current?.completed),
            ok: observation.ok === undefined ? current?.ok ?? null : observation.ok,
        };
        const candidate = this.trim([...this.records.filter((record) => record.key !== key), next]);
        try {
            this.writer(this.file, JSON.stringify({ version: VERSION, records: candidate }, null, 2));
            this.records = candidate;
            this.writeIssue = "";
        }
        catch {
            this.writeIssue = "Recent usage could not be saved. Bud can keep working, but the local usage total may be incomplete.";
        }
        return this.summary();
    }
    summary() {
        const endsAt = this.now();
        const startsAt = endsAt - ROLLING_DAYS * 24 * 60 * 60 * 1_000;
        const completed = this.records.filter((record) => record.completed && record.at >= startsAt && record.at <= endsAt);
        const withTokens = completed.filter((record) => record.inputTokens != null || record.outputTokens != null);
        const withCost = completed.filter((record) => record.costUsd != null);
        const latest = completed.at(-1) ?? null;
        const metering = completed.length === 0
            ? "empty"
            : withTokens.length === 0
                ? "unavailable"
                : withTokens.length === completed.length ? "reported" : "partial";
        const storage = this.writeIssue ? "attention" : this.recovered ? "recovered" : "ok";
        const detail = this.writeIssue || (this.recovered
            ? "Unreadable usage history was preserved separately and a new private ledger was started."
            : "This private meter stores counts, timestamps, provider and model only—never prompts, files or property data.");
        return {
            period: { kind: "rolling", days: ROLLING_DAYS, startsAt, endsAt },
            completedTurns: completed.length,
            successfulTurns: completed.filter((record) => record.ok === true).length,
            failedTurns: completed.filter((record) => record.ok === false).length,
            tokenReportedTurns: withTokens.length,
            inputTokens: withTokens.reduce((total, record) => total + (record.inputTokens ?? 0), 0),
            outputTokens: withTokens.reduce((total, record) => total + (record.outputTokens ?? 0), 0),
            costReportedTurns: withCost.length,
            costUsd: withCost.length
                ? Number(withCost.reduce((total, record) => total + (record.costUsd ?? 0), 0).toFixed(6))
                : null,
            lastUsedAt: latest?.at ?? null,
            lastProvider: latest?.provider || null,
            lastModel: latest?.model || null,
            metering,
            storage,
            detail,
        };
    }
}

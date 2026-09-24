import { JOB_CAPABILITIES } from "../shared/contracts.js";
import { redactSecretsInText } from "./redact.js";
import { JOB_OUTPUT_MAX_CHARS, JOB_OUTPUT_TOTAL_CHARS, JOB_OUTPUT_TOO_LARGE } from "../shared/job-output.js";
const MAX_DETAIL = 2_000, MAX_NOTE = 500, MAX_EVIDENCE = 50, MAX_APPROVALS = 20;
function isStatus(value) {
    return (value === "queued" ||
        value === "running" ||
        value === "awaiting-approval" ||
        value === "completed" ||
        value === "partial" ||
        value === "failed" ||
        value === "interrupted" ||
        value === "cancelled" ||
        value === "missed");
}
function isMode(value) {
    return value === "shadow" || value === "prepare" || value === "attended";
}
function isTrigger(value) {
    return value === "manual" || value === "schedule";
}
function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
}
export function cleanText(value, max) {
    return redactSecretsInText(typeof value === "string" ? value : "").trim().slice(0, max);
}
export function cleanEvidence(items, now, requireComplete = false) {
    if (!items)
        return [];
    const out = [];
    let outputChars = 0;
    for (const item of items.slice(0, MAX_EVIDENCE)) {
        if (!item || !["observation", "output", "approval", "action", "denied", "asked", "note"].includes(item.kind))
            continue;
        const limit = item.kind === "output" ? Math.min(JOB_OUTPUT_MAX_CHARS, JOB_OUTPUT_TOTAL_CHARS - outputChars) : MAX_NOTE;
        const cleaned = redactSecretsInText(typeof item.note === "string" ? item.note : "").trim();
        if (requireComplete && item.kind === "output" && cleaned.length > limit)
            throw new Error(JOB_OUTPUT_TOO_LARGE);
        const note = cleaned.length > limit && item.kind === "output"
            ? "[Saved output exceeds the supported size. Review the original receipt before using it.]"
            : cleaned.slice(0, limit);
        if (!note)
            continue;
        if (item.kind === "output")
            outputChars += note.length;
        out.push({ at: finite(item.at) ? item.at : now, note, kind: item.kind });
    }
    return out;
}
export function cleanApprovals(items) {
    if (!items)
        return [];
    return items
        .slice(0, MAX_APPROVALS)
        .map((item) => cleanText(item, MAX_NOTE))
        .filter(Boolean);
}
function asSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    if (typeof row.title !== "string" || typeof row.description !== "string" || typeof row.evidence !== "string")
        return null;
    if (!Array.isArray(row.steps) || !row.steps.every((item) => typeof item === "string"))
        return null;
    if (!Array.isArray(row.allowedOrigins) || !row.allowedOrigins.every((item) => typeof item === "string"))
        return null;
    if (!Array.isArray(row.capabilities) ||
        row.capabilities.length < 1 ||
        row.capabilities.length > JOB_CAPABILITIES.length ||
        !row.capabilities.every((item) => typeof item === "string" && JOB_CAPABILITIES.includes(item)))
        return null;
    if (!row.limits || typeof row.limits !== "object" || Array.isArray(row.limits))
        return null;
    const limits = row.limits;
    if (!Number.isInteger(limits.maxRuntimeMinutes) ||
        Number(limits.maxRuntimeMinutes) < 1 ||
        Number(limits.maxRuntimeMinutes) > 5 ||
        !Number.isInteger(limits.maxTurns) ||
        Number(limits.maxTurns) < 1 ||
        Number(limits.maxTurns) > 12)
        return null;
    return {
        title: row.title,
        description: row.description,
        steps: [...row.steps],
        allowedOrigins: [...row.allowedOrigins],
        evidence: row.evidence,
        capabilities: [...row.capabilities],
        limits: { maxRuntimeMinutes: Number(limits.maxRuntimeMinutes), maxTurns: Number(limits.maxTurns) },
    };
}
export function parseJobRun(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const row = value;
    const spec = asSnapshot(row.spec);
    if (!spec)
        return null;
    if (typeof row.id !== "string" ||
        typeof row.jobId !== "string" ||
        typeof row.jobTitle !== "string" ||
        !finite(row.jobRevision) ||
        !isMode(row.mode) ||
        !isStatus(row.status) ||
        !isTrigger(row.trigger) ||
        !finite(row.scheduledFor) ||
        typeof row.idempotencyKey !== "string" ||
        !finite(row.attempt) ||
        typeof row.detail !== "string" ||
        !finite(row.createdAt) ||
        !Array.isArray(row.evidence) ||
        !Array.isArray(row.approvalRequests)) {
        return null;
    }
    const evidence = cleanEvidence(row.evidence, row.createdAt);
    const approvalRequests = cleanApprovals(row.approvalRequests.filter((item) => typeof item === "string"));
    return {
        id: row.id,
        jobId: row.jobId,
        jobTitle: row.jobTitle,
        jobRevision: row.jobRevision,
        mode: row.mode,
        status: row.status,
        trigger: row.trigger,
        scheduledFor: row.scheduledFor,
        ...(typeof row.loopRunId === "string" ? { loopRunId: row.loopRunId } : {}),
        idempotencyKey: row.idempotencyKey,
        attempt: row.attempt,
        spec,
        evidence,
        approvalRequests,
        detail: cleanText(row.detail, MAX_DETAIL),
        createdAt: row.createdAt,
        ...(finite(row.startedAt) ? { startedAt: row.startedAt } : {}),
        ...(finite(row.finishedAt) ? { finishedAt: row.finishedAt } : {}),
        ...(finite(row.seenAt) ? { seenAt: row.seenAt } : {}),
        ...(typeof row.legacySessionId === "string" ? { legacySessionId: row.legacySessionId } : {}),
        ...(typeof row.threadId === "string" && row.threadId ? { threadId: row.threadId } : {}),
    };
}

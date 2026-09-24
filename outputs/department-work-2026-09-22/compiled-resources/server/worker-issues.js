// Durable, PM-language record of worker / Ask / channel failures. Desk and
// You read the same file so random Telegram misses show up in RealBud.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { redactSecretsInText } from "./redact.js";
const MAX_ENTRIES = 40;
const MAX_SUMMARY = 80;
const MAX_DETAIL = 280;
const DEDUP_MS = 120_000;
let issueListener = null;
export function setWorkerIssueListener(listener) {
    issueListener = listener;
}
function issuesPath() {
    return join(DATA_DIR, "worker-issues.json");
}
function clip(text, max) {
    const trimmed = text.trim();
    return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
function asIssue(value) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    const source = row.source;
    if (source !== "ask" && source !== "runtime" && source !== "channel" && source !== "hands" && source !== "install") {
        return null;
    }
    if (typeof row.id !== "string" || !row.id.trim())
        return null;
    if (typeof row.at !== "number" || !Number.isFinite(row.at))
        return null;
    if (typeof row.summary !== "string" || typeof row.detail !== "string")
        return null;
    return {
        id: row.id,
        at: row.at,
        source,
        summary: row.summary,
        detail: row.detail,
    };
}
function persist(entries) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(issuesPath(), `${JSON.stringify({ issues: entries }, null, 2)}\n`, 0o600);
}
export function loadWorkerIssues() {
    try {
        const parsed = JSON.parse(readFileSync(issuesPath(), "utf8"));
        const list = parsed && typeof parsed === "object" && Array.isArray(parsed.issues)
            ? parsed.issues
            : null;
        if (!list)
            return [];
        const out = [];
        for (const row of list) {
            const issue = asIssue(row);
            if (issue)
                out.push(issue);
        }
        return out.slice(-MAX_ENTRIES);
    }
    catch {
        return [];
    }
}
/** Latest first. */
export function listWorkerIssues(limit = 20) {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
    return loadWorkerIssues()
        .slice(-cap)
        .reverse();
}
export function noteWorkerIssue(input) {
    const summary = clip(redactSecretsInText(input.summary), MAX_SUMMARY);
    const detail = clip(redactSecretsInText(input.detail), MAX_DETAIL);
    if (!summary || !detail)
        return null;
    const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : Date.now();
    const prev = loadWorkerIssues().at(-1);
    if (prev &&
        prev.source === input.source &&
        prev.summary === summary &&
        prev.detail === detail &&
        at - prev.at < DEDUP_MS) {
        return null;
    }
    const issue = {
        id: randomUUID(),
        at,
        source: input.source,
        summary,
        detail,
    };
    const next = [...loadWorkerIssues(), issue].slice(-MAX_ENTRIES);
    persist(next);
    issueListener?.(issue);
    return issue;
}
/** Drop issues of one source after the worker proves it recovered. */
export function resolveWorkerIssues(source) {
    const prev = loadWorkerIssues();
    const next = prev.filter((issue) => issue.source !== source);
    const removed = prev.length - next.length;
    if (removed)
        persist(next);
    return removed;
}

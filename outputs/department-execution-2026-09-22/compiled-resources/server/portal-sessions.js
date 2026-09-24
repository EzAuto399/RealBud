// Portal runs. This wave is shadow-only: Bud narrates, nothing is browsed.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { narrateShadowRun } from "./recipe-draft.js";
import { normalizeOrigin } from "./recipes.js";
const MAX_SESSIONS = 50;
const LEASE_MS = 10 * 60_000;
const STATES = [
    "prepared",
    "running",
    "awaiting-review",
    "done",
    "unknown",
    "failed",
];
const NEXT = {
    prepared: ["running"],
    running: ["awaiting-review", "done", "unknown", "failed"],
    "awaiting-review": ["done", "unknown", "failed"],
    done: [],
    unknown: [],
    failed: [],
};
function sessionsPath() {
    return join(DATA_DIR, "portal-sessions.json");
}
function isState(value) {
    return typeof value === "string" && STATES.includes(value);
}
function asEvidence(value) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    if (typeof row.at !== "number" || !Number.isFinite(row.at))
        return null;
    if (typeof row.note !== "string")
        return null;
    return { at: row.at, note: row.note };
}
function asLease(value) {
    if (value == null)
        return null;
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    if (typeof row.origin !== "string" || !row.origin.trim())
        return null;
    if (typeof row.expiresAt !== "number" || !Number.isFinite(row.expiresAt))
        return null;
    return { origin: row.origin, expiresAt: row.expiresAt };
}
function liveLease(session) {
    const lease = session.submitLease;
    if (lease && lease.expiresAt <= Date.now())
        return { ...session, submitLease: null };
    return session;
}
function asSession(value) {
    if (!value || typeof value !== "object")
        return null;
    const row = value;
    if (typeof row.id !== "string" || !row.id.trim())
        return null;
    if (typeof row.recipeId !== "string" || !row.recipeId.trim())
        return null;
    if (!isState(row.state))
        return null;
    if (typeof row.shadow !== "boolean")
        return null;
    if (!Array.isArray(row.allowedOrigins) || !row.allowedOrigins.every((origin) => typeof origin === "string")) {
        return null;
    }
    if (!Array.isArray(row.evidence))
        return null;
    const evidence = [];
    for (const item of row.evidence) {
        const note = asEvidence(item);
        if (note)
            evidence.push(note);
    }
    if (typeof row.detail !== "string")
        return null;
    if (typeof row.startedAt !== "number" || !Number.isFinite(row.startedAt))
        return null;
    const endedAt = typeof row.endedAt === "number" && Number.isFinite(row.endedAt) ? row.endedAt : undefined;
    return liveLease({
        id: row.id,
        recipeId: row.recipeId,
        state: row.state,
        shadow: row.shadow,
        allowedOrigins: row.allowedOrigins,
        submitLease: asLease(row.submitLease),
        evidence,
        detail: row.detail,
        startedAt: row.startedAt,
        ...(endedAt !== undefined ? { endedAt } : {}),
    });
}
function persist(sessions) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(sessionsPath(), `${JSON.stringify({ sessions }, null, 2)}\n`, 0o600);
}
export function loadSessions() {
    try {
        const parsed = JSON.parse(readFileSync(sessionsPath(), "utf8"));
        const list = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === "object" && Array.isArray(parsed.sessions)
                ? parsed.sessions
                : null;
        if (!list)
            return [];
        const out = [];
        for (const row of list) {
            const session = asSession(row);
            if (session)
                out.push(session);
        }
        return out.slice(0, MAX_SESSIONS);
    }
    catch {
        return [];
    }
}
function writeSession(session) {
    const next = [liveLease(session), ...loadSessions().filter((item) => item.id !== session.id)].slice(0, MAX_SESSIONS);
    persist(next);
    return liveLease(session);
}
export function listSessions() {
    return loadSessions().map(liveLease);
}
export function getSession(id) {
    const session = loadSessions().find((item) => item.id === id);
    return session ? liveLease(session) : undefined;
}
export function createSession(input) {
    return writeSession({
        id: randomUUID(),
        recipeId: input.recipeId,
        state: input.state ?? "prepared",
        shadow: input.shadow ?? false,
        allowedOrigins: [...input.allowedOrigins],
        submitLease: null,
        evidence: [],
        detail: "",
        startedAt: Date.now(),
    });
}
export function transitionSession(session, state, detail) {
    if (!NEXT[session.state].includes(state)) {
        throw Object.assign(new Error("This run cannot move to that state."), { status: 409 });
    }
    const next = {
        ...session,
        state,
        detail: detail ?? session.detail,
    };
    if (state === "done" || state === "unknown" || state === "failed")
        next.endedAt = Date.now();
    return writeSession(next);
}
export function grantLease(session, origin) {
    if (session.state !== "awaiting-review") {
        throw Object.assign(new Error("This run is not waiting for a submit review."), { status: 409 });
    }
    const host = normalizeOrigin(origin);
    if (!host || !session.allowedOrigins.includes(host)) {
        throw Object.assign(new Error("That site is not on this job."), { status: 400 });
    }
    return writeSession({
        ...session,
        submitLease: { origin: host, expiresAt: Date.now() + LEASE_MS },
    });
}
export function revokeLease(session) {
    return writeSession({ ...session, submitLease: null });
}
export function appendEvidence(session, note) {
    const trimmed = note.trim();
    if (!trimmed)
        return liveLease(session);
    return writeSession({
        ...session,
        evidence: [...session.evidence, { at: Date.now(), note: trimmed }],
    });
}
export async function startShadowRun(recipe, opts) {
    let session = createSession({
        recipeId: recipe.id,
        allowedOrigins: recipe.allowedOrigins,
        shadow: true,
        state: "running",
    });
    const result = await narrateShadowRun(recipe, opts);
    if (!result.ok)
        return transitionSession(session, "unknown", result.detail);
    session = writeSession({
        ...session,
        evidence: result.lines.map((note) => ({ at: Date.now(), note })),
    });
    return transitionSession(session, "done", "Shadow run — nothing was browsed or clicked.");
}

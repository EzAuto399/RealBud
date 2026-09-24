import { currentWorkerProfile, withWorkerProfile } from "./hermes-profile.js";
// Drive Hermes device-code OAuth for the property profile from RealBud.
// Spawns `hermes -p property auth add <provider> --type oauth --no-browser`,
// parses the printed user code + verification URL, and watches auth.json.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_OAUTH_LOGINS } from "../shared/worker-providers.js";
import { augmentedPath } from "./env-path.js";
import { hermesHome, propertyProfileDir } from "./hermes-pack.js";
import { hermesCli } from "./hermes-pin.js";
import { killCliTree, spawnCli } from "./procs.js";
export const HERMES_OAUTH_PROVIDERS = ["openai-codex", "xai-oauth"];
const sessions = new Map();
let activeSessionId = null;
const OAUTH_IDS = new Set(HERMES_OAUTH_PROVIDERS);
export function isHermesOAuthProvider(providerId) {
    return OAUTH_IDS.has(providerId);
}
/** Resolve a picker provider id (or oauth alias) to a startable Hermes oauth id. */
export function resolveOAuthProviderId(providerId) {
    if (isHermesOAuthProvider(providerId))
        return providerId;
    const mapped = WORKER_OAUTH_LOGINS[providerId]?.oauthId;
    return mapped && isHermesOAuthProvider(mapped) ? mapped : null;
}
function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
}
/** Parse Hermes CLI device-code instructions (codex + shared xAI/Nous block). */
export function parseDeviceCodeOutput(text) {
    const clean = stripAnsi(text);
    const url = /Open this URL in your browser:\s*\n?\s*(https?:\/\/\S+)/i.exec(clean)?.[1]
        ?? /Open:\s*(https?:\/\/\S+)/i.exec(clean)?.[1]
        ?? /(https:\/\/auth\.openai\.com\/codex\/device)\b/i.exec(clean)?.[1]
        ?? /(https:\/\/accounts\.x\.ai\/(?:oauth2\/)?device\S*)/i.exec(clean)?.[1]
        ?? null;
    const userCode = /Enter this code:\s*\n?\s*([A-Za-z0-9][A-Za-z0-9-]{3,31})/i.exec(clean)?.[1]
        ?? /If prompted, enter code:\s*([A-Za-z0-9][A-Za-z0-9-]{3,31})/i.exec(clean)?.[1]
        ?? /enter code:\s*([A-Za-z0-9][A-Za-z0-9-]{3,31})/i.exec(clean)?.[1]
        ?? /user_code=([A-Za-z0-9][A-Za-z0-9-]{3,31})/i.exec(clean)?.[1]
        ?? null;
    if (!url || !userCode)
        return null;
    return { userCode, verificationUrl: url.replace(/[)\].,;]+$/g, "") };
}
export function authHasProvider(providerId, root) {
    // Bud's hands only — never inherit the user's personal Hermes Desktop
    // root auth (~/.hermes/auth.json) or sibling profiles.
    const authPaths = [join(propertyProfileDir(root), "auth.json")];
    for (const authPath of authPaths) {
        try {
            if (!existsSync(authPath))
                continue;
            const auth = JSON.parse(readFileSync(authPath, "utf8"));
            const hasExactProvider = (collection) => {
                if (Array.isArray(collection)) {
                    return collection.some((entry) => {
                        if (entry === providerId)
                            return true;
                        if (!entry || typeof entry !== "object")
                            return false;
                        const item = entry;
                        return item.id === providerId || item.provider === providerId || item.provider_id === providerId;
                    });
                }
                return Boolean(collection
                    && typeof collection === "object"
                    && Object.prototype.hasOwnProperty.call(collection, providerId));
            };
            if (hasExactProvider(auth.providers) || hasExactProvider(auth.credential_pool))
                return true;
        }
        catch {
            /* try next path */
        }
    }
    return false;
}
function publicSession(session) {
    return {
        sessionId: session.sessionId,
        providerId: session.providerId,
        state: session.state,
        userCode: session.userCode,
        verificationUrl: session.verificationUrl,
        error: session.error,
        startedAt: session.startedAt,
    };
}
function finishError(session, message) {
    if (session.state === "approved" || session.state === "cancelled")
        return;
    session.state = "error";
    session.error = message.slice(0, 500);
    if (session.child) {
        killCliTree(session.child);
        session.child = null;
    }
    if (activeSessionId === session.sessionId)
        activeSessionId = null;
}
function markApproved(session) {
    if (session.state === "cancelled" || session.state === "error")
        return;
    session.state = "approved";
    session.error = null;
    if (session.child) {
        killCliTree(session.child);
        session.child = null;
    }
    if (activeSessionId === session.sessionId)
        activeSessionId = null;
}
function ingestOutput(session, chunk) {
    session.buffer += chunk;
    if (session.buffer.length > 32_000)
        session.buffer = session.buffer.slice(-24_000);
    if (session.userCode && session.verificationUrl)
        return;
    const parsed = parseDeviceCodeOutput(session.buffer);
    if (!parsed)
        return;
    session.userCode = parsed.userCode;
    session.verificationUrl = parsed.verificationUrl;
    if (session.state === "starting")
        session.state = "waiting";
}
function evaluateApproval(session) {
    if (session.state === "cancelled" || session.state === "error" || session.state === "approved")
        return;
    const present = withWorkerProfile(session.memberKey, () => authHasProvider(session.providerId, session.root));
    if (!present)
        return;
    // A credential that already existed at start is not proof this attempt
    // succeeded — wait for a clean CLI exit in that case.
    if (!session.sawAuthAtStart)
        markApproved(session);
}
export function startOAuth(providerId, opts) {
    const oauthId = resolveOAuthProviderId(providerId);
    if (!oauthId) {
        throw Object.assign(new Error("OAuth login is only available for OpenAI ChatGPT and xAI"), { status: 400 });
    }
    const profileDir = propertyProfileDir(opts?.root);
    if (!existsSync(join(profileDir, "SOUL.md"))) {
        throw Object.assign(new Error("the worker pack is not installed — apply the pack first"), { status: 409 });
    }
    if (activeSessionId) {
        const prior = sessions.get(activeSessionId);
        if (prior && (prior.state === "starting" || prior.state === "waiting")) {
            cancelOAuth(activeSessionId);
        }
    }
    const sessionId = randomUUID();
    const session = {
        sessionId,
        providerId: oauthId,
        state: "starting",
        userCode: null,
        verificationUrl: null,
        error: null,
        startedAt: Date.now(),
        child: null,
        memberKey: currentWorkerProfile().memberKey,
        profile: currentWorkerProfile().profile,
        root: opts?.root,
        buffer: "",
        sawAuthAtStart: authHasProvider(oauthId, opts?.root),
    };
    sessions.set(sessionId, session);
    activeSessionId = sessionId;
    const cli = opts?.cli?.trim() || hermesCli();
    const ownedHome = hermesHome(opts?.root);
    const env = {
        ...process.env,
        PATH: augmentedPath(),
        // Force non-interactive device-code prompts into our pipes.
        TERM: "dumb",
        // Hermes (Python) block-buffers when stdout is a pipe; without this the
        // device code never arrives until the process exits.
        PYTHONUNBUFFERED: "1",
        // Always pin Bud's private home — never inherit Desktop ~/.hermes.
        HERMES_HOME: ownedHome,
        REALBUD_HERMES_HOME: ownedHome,
    };
    let child;
    try {
        child = spawnCli(cli, ["-p", currentWorkerProfile().profile, "auth", "add", oauthId, "--type", "oauth", "--no-browser"], { env, stdio: ["ignore", "pipe", "pipe"] });
    }
    catch (err) {
        finishError(session, err instanceof Error ? err.message : String(err));
        return publicSession(session);
    }
    session.child = child;
    child.stdout?.on("data", (chunk) => {
        ingestOutput(session, String(chunk));
        evaluateApproval(session);
    });
    child.stderr?.on("data", (chunk) => {
        ingestOutput(session, String(chunk));
        evaluateApproval(session);
    });
    child.on("error", (err) => {
        finishError(session, err.message || "worker login failed to start");
    });
    child.on("close", (code) => {
        session.child = null;
        if (session.state === "cancelled" || session.state === "approved" || session.state === "error")
            return;
        evaluateApproval(session);
        if (session.state !== "starting" && session.state !== "waiting")
            return;
        if (code === 0 && authHasProvider(oauthId, opts?.root)) {
            markApproved(session);
            return;
        }
        const hint = stripAnsi(session.buffer).trim().split(/\n/).filter(Boolean).slice(-4).join(" ").slice(0, 400);
        finishError(session, hint
            || (code == null
                ? "worker login stopped before it finished"
                : `worker login exited ${code}. Try again, or use an API key instead.`));
    });
    return publicSession(session);
}
export function oauthStatus(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.profile !== currentWorkerProfile().profile) {
        throw Object.assign(new Error("login session not found"), { status: 404 });
    }
    if (session.state === "starting" || session.state === "waiting") {
        evaluateApproval(session);
        // Device-code lines sometimes arrive late; keep scanning the buffer.
        if (!session.userCode || !session.verificationUrl) {
            const parsed = parseDeviceCodeOutput(session.buffer);
            if (parsed) {
                session.userCode = parsed.userCode;
                session.verificationUrl = parsed.verificationUrl;
                if (session.state === "starting")
                    session.state = "waiting";
            }
        }
    }
    return publicSession(session);
}
export function cancelOAuth(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.profile !== currentWorkerProfile().profile) {
        throw Object.assign(new Error("login session not found"), { status: 404 });
    }
    if (session.state === "approved")
        return publicSession(session);
    session.state = "cancelled";
    session.error = null;
    if (session.child) {
        killCliTree(session.child);
        session.child = null;
    }
    if (activeSessionId === sessionId)
        activeSessionId = null;
    return publicSession(session);
}
/** Test helper — clear in-memory sessions between cases. */
export function resetOAuthSessionsForTests() {
    for (const session of sessions.values()) {
        if (session.child)
            killCliTree(session.child);
    }
    sessions.clear();
    activeSessionId = null;
}
export function oauthInFlight() {
    return [...sessions.values()].some(session => session.state === "starting" || session.state === "waiting");
}

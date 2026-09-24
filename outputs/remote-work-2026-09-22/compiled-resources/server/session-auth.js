// Per-boot API session + loopback Host/Origin checks.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export const SESSION_TOKEN = randomBytes(24).toString("hex");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export function hostAllowed(hostHeader, listenPort) {
    if (!hostHeader)
        return false;
    const raw = hostHeader.split(",")[0]?.trim() ?? "";
    const [hostname, port] = raw.startsWith("[")
        ? [raw.slice(0, raw.indexOf("]") + 1), raw.slice(raw.lastIndexOf(":") + 1)]
        : raw.includes(":")
            ? [raw.slice(0, raw.lastIndexOf(":")), raw.slice(raw.lastIndexOf(":") + 1)]
            : [raw, ""];
    if (!LOOPBACK_HOSTS.has(hostname.toLowerCase()))
        return false;
    if (!port)
        return true;
    return Number(port) === listenPort;
}
export function originAllowed(origin, listenPort) {
    if (!origin || origin === "null")
        return true;
    try {
        const url = new URL(origin);
        if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))
            return false;
        if (!url.port)
            return url.protocol === "http:" || url.protocol === "https:";
        const port = Number(url.port);
        const configuredUiPort = Number(process.env.OMB_UI_PORT);
        const uiPortAllowed = Number.isInteger(configuredUiPort) && configuredUiPort > 0 && configuredUiPort <= 65_535
            ? port === configuredUiPort
            : false;
        return port === listenPort || port === 5199 || port === 5173 || uiPortAllowed;
    }
    catch {
        return false;
    }
}
const DOWNLOAD_PATH = /^\/api\/private-backup\/v2\/downloads\/[A-Za-z0-9_-]{32,128}$/;
const DOWNLOAD_COOKIE = 'realbud-backup-download=';
const DOWNLOAD_KEY = randomBytes(32), DOWNLOAD_LIFETIME = 5 * 60_000;
function downloadProof(path, expiresAt) {
    return createHmac('sha256', DOWNLOAD_KEY).update(`backup-download-v1\n${path}\n${expiresAt}`).digest('hex');
}
/** Native downloads cannot attach the renderer's custom header. This separate
 * per-boot proof grants only the exact ticket GET until expiry. It is never an
 * app session token, including if copied into a header or query parameter. */
export function privateBackupDownloadSessionCookie(ticket) {
    const remaining = ticket.expiresAt - Date.now();
    if (!DOWNLOAD_PATH.test(ticket.url) || !Number.isSafeInteger(ticket.expiresAt) || remaining <= 0 || remaining > DOWNLOAD_LIFETIME)
        throw new Error('Invalid backup download grant.');
    return `${DOWNLOAD_COOKIE}${ticket.expiresAt}.${downloadProof(ticket.url, ticket.expiresAt)}; HttpOnly; SameSite=Strict; Path=${ticket.url}; Max-Age=${Math.ceil(remaining / 1000)}`;
}
function downloadSessionOk(req) {
    if ((req.method ?? 'GET') !== 'GET')
        return false;
    try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (!DOWNLOAD_PATH.test(url.pathname))
            return false;
        const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(DOWNLOAD_COOKIE));
        // Ambiguous credentials fail closed; each ticket uses its own cookie path.
        if (values.length !== 1)
            return false;
        const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(values[0].slice(DOWNLOAD_COOKIE.length));
        if (!match)
            return false;
        const expiresAt = Number(match[1]), remaining = expiresAt - Date.now();
        return remaining > 0 && remaining <= DOWNLOAD_LIFETIME && tokensEqual(match[2], downloadProof(url.pathname, expiresAt));
    }
    catch {
        return false;
    }
}
function tokenFromRequest(req) {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer "))
        return auth.slice(7).trim();
    const header = req.headers["x-realbud-session"];
    if (typeof header === "string" && header.trim())
        return header.trim();
    try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const q = url.searchParams.get("session");
        if (q)
            return q;
    }
    catch {
        /* ignore */
    }
    return null;
}
export function tokensEqual(got, want) {
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
}
export function sessionOk(req, listenPort) {
    if (!hostAllowed(typeof req.headers.host === "string" ? req.headers.host : undefined, listenPort)) {
        return { ok: false, status: 403, error: "refused host" };
    }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!originAllowed(origin, listenPort)) {
        return { ok: false, status: 403, error: "refused origin" };
    }
    const token = tokenFromRequest(req);
    if (token ? !tokensEqual(token, SESSION_TOKEN) : !downloadSessionOk(req)) {
        return { ok: false, status: 401, error: "session required" };
    }
    return { ok: true };
}
export function needsSession(path, method) {
    if (path === "/api/health" || path === "/api/session")
        return false;
    if (!path.startsWith("/api/"))
        return false;
    if (path.startsWith("/api/internal/"))
        return false;
    // Ask can create a provider sign-in or execute an approved app operation.
    // Protect every mutation of its bot/thread state, including queued work,
    // edits, steering and approval responses. Keep legacy read-only views intact.
    if (method && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
        /^\/api\/(?:bots|threads|instances)(?:\/|$)/.test(path))
        return true;
    return (path === "/api/config" ||
        path.startsWith("/api/hermes") ||
        path.startsWith("/api/care") ||
        path.startsWith("/api/service-admin") ||
        path.startsWith("/api/service/") ||
        path.startsWith("/api/tts") ||
        path.startsWith("/api/company") ||
        path.startsWith("/api/connected-apps") ||
        path === "/api/browser" || path.startsWith("/api/browser/") ||
        path.startsWith("/api/desk") ||
        path.startsWith("/api/channels") ||
        path.startsWith("/api/rules") ||
        path.startsWith("/api/law-watch") ||
        path.startsWith("/api/workflow-packs") ||
        path.startsWith("/api/customer-packs") ||
        path.startsWith("/api/agency-setup") ||
        /^\/api\/(?:website-requests|office-link)(?:\/|$)/.test(path) ||
        path.startsWith("/api/private-backup") ||
        path.startsWith("/api/mail-workspace") ||
        path.startsWith("/api/workspace-tabs") ||
        path.startsWith("/api/expected-bills") ||
        /^\/api\/bill-(?:register|evidence|occurrences|series|scan|proposals|review-drafts)(?:\/|$)/.test(path) ||
        path.startsWith("/api/recipes") ||
        path.startsWith("/api/job-runs") ||
        path.startsWith("/api/computer-history") ||
        path.startsWith("/api/worker-issues") ||
        path.startsWith("/api/loops") ||
        path.startsWith("/api/loop-runs") ||
        path.startsWith("/api/artifacts") ||
        path.startsWith("/api/portal") ||
        path.startsWith("/api/imports") ||
        path.startsWith("/api/events"));
}

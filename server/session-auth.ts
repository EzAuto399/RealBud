// Per-boot API session + loopback Host/Origin checks.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SESSION_TOKEN = randomBytes(24).toString("hex");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostAllowed(hostHeader: string | undefined, listenPort: number): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.split(",")[0]?.trim() ?? "";
  const [hostname, port] = raw.startsWith("[")
    ? [raw.slice(0, raw.indexOf("]") + 1), raw.slice(raw.lastIndexOf(":") + 1)]
    : raw.includes(":")
      ? [raw.slice(0, raw.lastIndexOf(":")), raw.slice(raw.lastIndexOf(":") + 1)]
      : [raw, ""];
  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) return false;
  if (!port) return true;
  return Number(port) === listenPort;
}

function validConfiguredPort(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export function originAllowed(
  origin: string | undefined,
  listenPort: number,
  configuredUiPort: number | null = validConfiguredPort(process.env.OMB_UI_PORT),
): boolean {
  if (!origin || origin === "null") return true;
  try {
    const url = new URL(origin);
    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false;
    if (!url.port) return url.protocol === "http:" || url.protocol === "https:";
    const port = Number(url.port);
    return port === listenPort || port === 5199 || port === 5173 || port === configuredUiPort;
  } catch {
    return false;
  }
}

function tokenFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-realbud-session"];
  if (typeof header === "string" && header.trim()) return header.trim();
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const q = url.searchParams.get("session");
    if (q) return q;
  } catch {
    /* ignore */
  }
  return null;
}

export function tokensEqual(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionOk(req: IncomingMessage, listenPort: number): { ok: true } | { ok: false; status: number; error: string } {
  if (!hostAllowed(typeof req.headers.host === "string" ? req.headers.host : undefined, listenPort)) {
    return { ok: false, status: 403, error: "refused host" };
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!originAllowed(origin, listenPort)) {
    return { ok: false, status: 403, error: "refused origin" };
  }
  const token = tokenFromRequest(req);
  if (!token || !tokensEqual(token, SESSION_TOKEN)) {
    return { ok: false, status: 401, error: "session required" };
  }
  return { ok: true };
}

export function needsSession(path: string): boolean {
  if (path === "/api/health" || path === "/api/session") return false;
  if (!path.startsWith("/api/")) return false;
  if (path.startsWith("/api/internal/")) return false;
  return (
    path.startsWith("/api/desk") ||
    path.startsWith("/api/loops") ||
    path.startsWith("/api/loop-runs") ||
    path.startsWith("/api/source-connections") ||
    path.startsWith("/api/pilot-discovery") ||
    path.startsWith("/api/execution-adapters") ||
    path.startsWith("/api/work-routing") ||
    path.startsWith("/api/config") ||
    path.startsWith("/api/profile") ||
    path.startsWith("/api/artifacts") ||
    path.startsWith("/api/portal") ||
    path.startsWith("/api/imports") ||
    path.startsWith("/api/events")
  );
}

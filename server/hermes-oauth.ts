// Drive Hermes device-code OAuth for the property profile from RealBud.
// Spawns `hermes -p property auth add <provider> --type oauth --no-browser`,
// parses the printed user code + verification URL, and watches auth.json.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { WORKER_OAUTH_LOGINS } from "../shared/worker-providers.ts";
import { augmentedPath } from "./env-path.ts";
import { hermesHome, propertyProfileDir } from "./hermes-pack.ts";
import { hermesCli, HERMES_PIN } from "./hermes-pin.ts";
import { killCliTree, spawnCli } from "./procs.ts";

export const HERMES_OAUTH_PROVIDERS = ["openai-codex", "xai-oauth"] as const;
export type HermesOAuthProvider = (typeof HERMES_OAUTH_PROVIDERS)[number];

export type OAuthSessionState = "starting" | "waiting" | "approved" | "error" | "cancelled";

export interface OAuthSessionPublic {
  sessionId: string;
  providerId: HermesOAuthProvider;
  state: OAuthSessionState;
  userCode: string | null;
  verificationUrl: string | null;
  error: string | null;
  startedAt: number;
}

type OAuthSession = OAuthSessionPublic & {
  child: ChildProcess | null;
  root?: string;
  buffer: string;
  sawAuthAtStart: boolean;
};

const sessions = new Map<string, OAuthSession>();
let activeSessionId: string | null = null;

const OAUTH_IDS = new Set<string>(HERMES_OAUTH_PROVIDERS);

export function isHermesOAuthProvider(providerId: string): providerId is HermesOAuthProvider {
  return OAUTH_IDS.has(providerId);
}

/** Resolve a picker provider id (or oauth alias) to a startable Hermes oauth id. */
export function resolveOAuthProviderId(providerId: string): HermesOAuthProvider | null {
  if (isHermesOAuthProvider(providerId)) return providerId;
  const mapped = WORKER_OAUTH_LOGINS[providerId]?.oauthId;
  return mapped && isHermesOAuthProvider(mapped) ? mapped : null;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Parse Hermes CLI device-code instructions (codex + shared xAI/Nous block). */
export function parseDeviceCodeOutput(text: string): { userCode: string; verificationUrl: string } | null {
  const clean = stripAnsi(text);
  const url =
    /Open this URL in your browser:\s*\n?\s*(https?:\/\/\S+)/i.exec(clean)?.[1]
    ?? /Open:\s*(https?:\/\/\S+)/i.exec(clean)?.[1]
    ?? /(https:\/\/auth\.openai\.com\/codex\/device)\b/i.exec(clean)?.[1]
    ?? null;
  const userCode =
    /Enter this code:\s*\n?\s*([A-Za-z0-9][A-Za-z0-9-]{3,31})/i.exec(clean)?.[1]
    ?? /enter code:\s*([A-Za-z0-9][A-Za-z0-9-]{3,31})/i.exec(clean)?.[1]
    ?? null;
  if (!url || !userCode) return null;
  return { userCode, verificationUrl: url.replace(/[)\].,;]+$/g, "") };
}

export function authHasProvider(providerId: string, root?: string): boolean {
  const authPaths = [join(propertyProfileDir(root), "auth.json"), join(hermesHome(root), "auth.json")];
  for (const authPath of authPaths) {
    try {
      if (!existsSync(authPath)) continue;
      const auth = JSON.parse(readFileSync(authPath, "utf8")) as {
        providers?: unknown;
        credential_pool?: unknown;
      };
      const hasExactProvider = (collection: unknown): boolean => {
        if (Array.isArray(collection)) {
          return collection.some((entry) => {
            if (entry === providerId) return true;
            if (!entry || typeof entry !== "object") return false;
            const item = entry as { id?: unknown; provider?: unknown; provider_id?: unknown };
            return item.id === providerId || item.provider === providerId || item.provider_id === providerId;
          });
        }
        return Boolean(
          collection
            && typeof collection === "object"
            && Object.prototype.hasOwnProperty.call(collection, providerId),
        );
      };
      if (hasExactProvider(auth.providers) || hasExactProvider(auth.credential_pool)) return true;
    } catch {
      /* try next path */
    }
  }
  return false;
}

function publicSession(session: OAuthSession): OAuthSessionPublic {
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

function finishError(session: OAuthSession, message: string): void {
  if (session.state === "approved" || session.state === "cancelled") return;
  session.state = "error";
  session.error = message.slice(0, 500);
  if (session.child) {
    killCliTree(session.child);
    session.child = null;
  }
  if (activeSessionId === session.sessionId) activeSessionId = null;
}

function markApproved(session: OAuthSession): void {
  if (session.state === "cancelled" || session.state === "error") return;
  session.state = "approved";
  session.error = null;
  if (session.child) {
    killCliTree(session.child);
    session.child = null;
  }
  if (activeSessionId === session.sessionId) activeSessionId = null;
}

function ingestOutput(session: OAuthSession, chunk: string): void {
  session.buffer += chunk;
  if (session.buffer.length > 32_000) session.buffer = session.buffer.slice(-24_000);
  if (session.userCode && session.verificationUrl) return;
  const parsed = parseDeviceCodeOutput(session.buffer);
  if (!parsed) return;
  session.userCode = parsed.userCode;
  session.verificationUrl = parsed.verificationUrl;
  if (session.state === "starting") session.state = "waiting";
}

function evaluateApproval(session: OAuthSession): void {
  if (session.state === "cancelled" || session.state === "error" || session.state === "approved") return;
  const present = authHasProvider(session.providerId, session.root);
  if (!present) return;
  // A credential that already existed at start is not proof this attempt
  // succeeded — wait for a clean CLI exit in that case.
  if (!session.sawAuthAtStart) markApproved(session);
}

export function startOAuth(
  providerId: string,
  opts?: { root?: string; cli?: string },
): OAuthSessionPublic {
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
  const session: OAuthSession = {
    sessionId,
    providerId: oauthId,
    state: "starting",
    userCode: null,
    verificationUrl: null,
    error: null,
    startedAt: Date.now(),
    child: null,
    root: opts?.root,
    buffer: "",
    sawAuthAtStart: authHasProvider(oauthId, opts?.root),
  };
  sessions.set(sessionId, session);
  activeSessionId = sessionId;

  const cli = opts?.cli?.trim() || hermesCli();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: augmentedPath(),
    // Force non-interactive device-code prompts into our pipes.
    TERM: "dumb",
  };
  if (opts?.root) env.HERMES_HOME = opts.root;

  let child: ChildProcess;
  try {
    child = spawnCli(
      cli,
      ["-p", HERMES_PIN.profile, "auth", "add", oauthId, "--type", "oauth", "--no-browser"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
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
    if (session.state === "cancelled" || session.state === "approved" || session.state === "error") return;
    evaluateApproval(session);
    if (session.state !== "starting" && session.state !== "waiting") return;
    if (code === 0 && authHasProvider(oauthId, opts?.root)) {
      markApproved(session);
      return;
    }
    const hint = stripAnsi(session.buffer).trim().split(/\n/).filter(Boolean).slice(-4).join(" ").slice(0, 400);
    finishError(
      session,
      hint
        || (code == null
          ? "worker login stopped before it finished"
          : `worker login exited ${code}. Try again, or use an API key instead.`),
    );
  });

  return publicSession(session);
}

export function oauthStatus(sessionId: string): OAuthSessionPublic {
  const session = sessions.get(sessionId);
  if (!session) {
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
        if (session.state === "starting") session.state = "waiting";
      }
    }
  }
  return publicSession(session);
}

export function cancelOAuth(sessionId: string): OAuthSessionPublic {
  const session = sessions.get(sessionId);
  if (!session) {
    throw Object.assign(new Error("login session not found"), { status: 404 });
  }
  if (session.state === "approved") return publicSession(session);
  session.state = "cancelled";
  session.error = null;
  if (session.child) {
    killCliTree(session.child);
    session.child = null;
  }
  if (activeSessionId === sessionId) activeSessionId = null;
  return publicSession(session);
}

/** Test helper — clear in-memory sessions between cases. */
export function resetOAuthSessionsForTests(): void {
  for (const session of sessions.values()) {
    if (session.child) killCliTree(session.child);
  }
  sessions.clear();
  activeSessionId = null;
}

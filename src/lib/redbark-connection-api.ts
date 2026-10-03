import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { connectorConnectionApi, parseConnectorStart, parseConnectorState, type ConnectorState } from "@shared/mcp-connector";
import { REDBARK_AUTH_ORIGIN, REDBARK_CONNECTOR_ID } from "@shared/redbark-connection";

/** An office connector (Redbark's bank feed first), read and changed only
 *  through the RealBud service by connector id. The service owns every token;
 *  the renderer sees the parsed state and, for a new sign-in, an authorize link
 *  it opens in the person's browser. */

type Request = (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<unknown>;

export const CONNECTOR_STATE_UNREADABLE = "This connection couldn't be checked. Try again.";
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
/** A definite refusal: the service answered and nothing changed. */
const DEFINITE = [400, 401, 403, 404, 409, 410, 422];

export type ConnectorOutcome =
  | { kind: "settled"; state: ConnectorState }
  | { kind: "refused"; message: string; state: ConnectorState | null }
  | { kind: "uncertain"; state: ConnectorState | null };
export type ConnectorStartOutcome = { kind: "started"; authorizeUrl: string } | Exclude<ConnectorOutcome, { kind: "settled" }>;

const statusOf = (cause: unknown) =>
  cause && typeof cause === "object" && typeof (cause as { status?: unknown }).status === "number" ? (cause as { status: number }).status : undefined;

function refusal(status: number): string {
  if (status === 403) return "Only the office owner or an administrator can change this connection.";
  if (status === 401) return "This RealBud sign-in can't change this connection. Sign in again, then retry.";
  if (status === 409) return "This connection changed meanwhile. Check it before trying again.";
  return "That didn't go through. Nothing changed.";
}

export function createConnectorApi(request: Request, connector: string = REDBARK_CONNECTOR_ID, signInOrigin: string = REDBARK_AUTH_ORIGIN) {
  const base = connectorConnectionApi(connector);
  const state = async (signal?: AbortSignal): Promise<ConnectorState> => {
    let body: unknown;
    try {
      body = await request(base, signal ? { signal } : undefined, { timeoutMs: READ_TIMEOUT_MS });
    } catch (cause) {
      throw Object.assign(new Error(CONNECTOR_STATE_UNREADABLE), { cause, status: statusOf(cause) });
    }
    const parsed = parseConnectorState(body, connector);
    if (!parsed) throw new Error(CONNECTOR_STATE_UNREADABLE);
    return parsed;
  };
  const reread = () => state().catch(() => null);

  async function post<T>(path: string, parse: (body: unknown) => T | null): Promise<{ ok: T } | Exclude<ConnectorOutcome, { kind: "settled" }>> {
    let body: unknown;
    try {
      body = await request(path, { method: "POST", body: "{}" }, { timeoutMs: WRITE_TIMEOUT_MS });
    } catch (cause) {
      const status = statusOf(cause);
      if (status !== undefined && DEFINITE.includes(status)) return { kind: "refused", message: refusal(status), state: await reread() };
      return { kind: "uncertain", state: await reread() };
    }
    const parsed = parse(body);
    return parsed ? { ok: parsed } : { kind: "uncertain", state: await reread() };
  }
  const change = async (action: "check" | "disconnect"): Promise<ConnectorOutcome> => {
    const result = await post(`${base}/${action}`, body => parseConnectorState(body, connector));
    return "ok" in result ? { kind: "settled", state: result.ok } : result;
  };

  return {
    state,
    signInOrigin,
    /** Asks the service for a fresh sign-in link. Never opens it. */
    start: async (): Promise<ConnectorStartOutcome> => {
      const result = await post(`${base}/start`, body => parseConnectorStart(body, signInOrigin));
      return "ok" in result ? { kind: "started", authorizeUrl: result.ok.authorizeUrl } : result;
    },
    check: () => change("check"),
    disconnect: () => change("disconnect"),
  };
}
export type ConnectorApi = ReturnType<typeof createConnectorApi>;

/** Opens a sign-in link in the person's browser, never in this window. */
export async function openConnectorSignIn(
  authorizeUrl: string,
  origin: string,
  env: { openExternal?: (url: string) => Promise<boolean>; open?: (url: string, target: string, features: string) => unknown } = browserOpeners(),
): Promise<boolean> {
  if (!parseConnectorStart({ authorizeUrl }, origin)) return false;
  try {
    if (env.openExternal) return (await env.openExternal(authorizeUrl)) === true;
    if (env.open) { env.open(authorizeUrl, "_blank", "noopener,noreferrer"); return true; }
  } catch {
    return false;
  }
  return false;
}

function browserOpeners() {
  if (typeof window === "undefined") return {};
  const external = window.ogb?.openExternal;
  return external ? { openExternal: (url: string) => external(url) } : { open: (url: string, target: string, features: string) => window.open(url, target, features) };
}

export type ConnectorBusy = "connect" | "check" | "disconnect" | null;
export interface ConnectorView {
  state: ConnectorState | null;
  loading: boolean;
  readError: string | null;
  busy: ConnectorBusy;
  notice: { text: string; problem: boolean } | null;
}

export const CONNECTOR_UNCERTAIN = "RealBud couldn't confirm whether that finished. The current connection is shown.";
export const CONNECTOR_UNCERTAIN_UNREAD = "RealBud couldn't confirm whether that finished. Use Check before trying it again.";
export const CONNECTOR_BROWSER_FAILED = "Your browser didn't open. Use Connect again to retry.";

/** One connector for one screen: read on mount, re-read on focus while a
 *  sign-in is pending, and re-read rather than guess when an outcome is unknown. */
export function useConnector(client?: ConnectorApi) {
  const [connection] = useState(() => client ?? createConnectorApi(api));
  const [view, setView] = useState<ConnectorView>({ state: null, loading: true, readError: null, busy: null, notice: null });
  const alive = useRef(true);
  const busy = useRef<ConnectorBusy>(null);
  const patch = useCallback((next: Partial<ConnectorView>) => { if (alive.current) setView(current => ({ ...current, ...next })); }, []);

  const refresh = useCallback(async () => {
    try {
      patch({ state: await connection.state(), loading: false, readError: null });
    } catch (cause) {
      patch({ loading: false, readError: cause instanceof Error ? cause.message : CONNECTOR_STATE_UNREADABLE });
    }
  }, [connection, patch]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  const pending = view.state?.status === "connecting";
  useEffect(() => {
    if (!pending || typeof window === "undefined") return;
    const onFocus = () => { if (!busy.current) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pending, refresh]);

  const run = useCallback(async (kind: Exclude<ConnectorBusy, null>, work: () => Promise<ConnectorView["notice"] | void>) => {
    if (busy.current) return;
    busy.current = kind;
    patch({ busy: kind, notice: null });
    try {
      patch({ notice: (await work()) ?? null });
    } finally {
      busy.current = null;
      patch({ busy: null });
    }
  }, [patch]);

  const settle = useCallback((outcome: ConnectorOutcome | Exclude<ConnectorStartOutcome, { kind: "started" }>): ConnectorView["notice"] => {
    if (outcome.state) patch({ state: outcome.state, readError: null });
    if (outcome.kind === "settled") return null;
    if (outcome.kind === "refused") return { text: outcome.message, problem: true };
    return { text: outcome.state ? CONNECTOR_UNCERTAIN : CONNECTOR_UNCERTAIN_UNREAD, problem: true };
  }, [patch]);

  const connect = useCallback(() => run("connect", async () => {
    const outcome = await connection.start();
    if (outcome.kind !== "started") return settle(outcome);
    const opened = await openConnectorSignIn(outcome.authorizeUrl, connection.signInOrigin);
    await refresh();
    return opened ? null : { text: CONNECTOR_BROWSER_FAILED, problem: true };
  }), [connection, run, settle, refresh]);

  const check = useCallback(() => run("check", async () => settle(await connection.check())), [connection, run, settle]);
  const disconnect = useCallback(() => run("disconnect", async () => {
    const outcome = await connection.disconnect();
    return outcome.kind === "settled" ? { text: "Disconnected. Bud can no longer read it.", problem: false } : settle(outcome);
  }), [connection, run, settle]);

  return { view, refresh, connect, check, disconnect };
}
export type ConnectorControls = ReturnType<typeof useConnector>;

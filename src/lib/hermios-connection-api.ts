import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import {
  HERMIOS_CONNECTION_API,
  HERMIOS_CONNECTION_CHECK_API,
  HERMIOS_CONNECTION_DISCONNECT_API,
  HERMIOS_CONNECTION_START_API,
  parseHermiosConnectionStart,
  parseHermiosConnectionState,
  type HermiosConnectionState,
} from "@shared/hermios-connection";

/** Bud's own Hermios connection, read and changed only through the RealBud
 *  service. The service owns every token; the renderer sees the parsed state
 *  and, for a new sign-in, an authorize link it opens in the person's browser. */

type Request = (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<unknown>;

export const HERMIOS_STATE_UNREADABLE = "Bud's Hermios connection couldn't be checked. Try again.";
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;
/** A definite refusal: the service answered and nothing changed. Anything else
 *  after a POST (no answer, a server failure, a malformed success) may hide a
 *  committed change. */
const DEFINITE = [400, 401, 403, 404, 409, 410, 422];

export type HermiosConnectionOutcome =
  | { kind: "settled"; state: HermiosConnectionState }
  | { kind: "refused"; message: string; state: HermiosConnectionState | null }
  | { kind: "uncertain"; state: HermiosConnectionState | null };

export type HermiosStartOutcome =
  | { kind: "started"; authorizeUrl: string }
  | Exclude<HermiosConnectionOutcome, { kind: "settled" }>;

const statusOf = (cause: unknown) =>
  cause && typeof cause === "object" && typeof (cause as { status?: unknown }).status === "number" ? (cause as { status: number }).status : undefined;

function refusal(status: number): string {
  if (status === 401 || status === 403) return "This RealBud sign-in can't change Bud's Hermios connection. Sign in again, then retry.";
  if (status === 409) return "Bud's Hermios connection changed meanwhile. Check it before trying again.";
  return "That didn't go through. Nothing changed.";
}

export function createHermiosConnectionApi(request: Request) {
  const state = async (signal?: AbortSignal): Promise<HermiosConnectionState> => {
    let body: unknown;
    try {
      body = await request(HERMIOS_CONNECTION_API, signal ? { signal } : undefined, { timeoutMs: READ_TIMEOUT_MS });
    } catch (cause) {
      throw Object.assign(new Error(HERMIOS_STATE_UNREADABLE), { cause, status: statusOf(cause) });
    }
    const parsed = parseHermiosConnectionState(body);
    // A malformed success is an error, never a guessed state.
    if (!parsed) throw new Error(HERMIOS_STATE_UNREADABLE);
    return parsed;
  };
  const reread = () => state().catch(() => null);

  async function post<T>(path: string, parse: (body: unknown) => T | null): Promise<{ ok: T } | Exclude<HermiosConnectionOutcome, { kind: "settled" }>> {
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

  const change = async (path: string): Promise<HermiosConnectionOutcome> => {
    const result = await post(path, parseHermiosConnectionState);
    return "ok" in result ? { kind: "settled", state: result.ok } : result;
  };

  return {
    state,
    /** Asks the service for a fresh Hermios sign-in link. Never opens it. */
    start: async (): Promise<HermiosStartOutcome> => {
      const result = await post(HERMIOS_CONNECTION_START_API, parseHermiosConnectionStart);
      return "ok" in result ? { kind: "started", authorizeUrl: result.ok.authorizeUrl } : result;
    },
    check: () => change(HERMIOS_CONNECTION_CHECK_API),
    disconnect: () => change(HERMIOS_CONNECTION_DISCONNECT_API),
  };
}

export type HermiosConnectionApi = ReturnType<typeof createHermiosConnectionApi>;

/** Opens a Hermios sign-in link in the person's browser, never in this window.
 *  Only a link the shared parser accepted (https on hermios.app) gets here. */
export async function openHermiosSignIn(
  authorizeUrl: string,
  env: { openExternal?: (url: string) => Promise<boolean>; open?: (url: string, target: string, features: string) => unknown } = browserOpeners(),
): Promise<boolean> {
  if (!parseHermiosConnectionStart({ authorizeUrl })) return false;
  try {
    if (env.openExternal) return (await env.openExternal(authorizeUrl)) === true;
    // With noopener the browser returns no handle, so a call that didn't throw
    // is the only signal available outside the desktop app.
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

export type HermiosBusy = "connect" | "check" | "disconnect" | null;
export interface HermiosConnectionView {
  state: HermiosConnectionState | null;
  /** True until the first read settles. */
  loading: boolean;
  /** Set when the latest read failed; the last good state stays shown. */
  readError: string | null;
  busy: HermiosBusy;
  notice: { text: string; problem: boolean } | null;
}

export const HERMIOS_UNCERTAIN = "RealBud couldn't confirm whether that finished. Bud's current Hermios connection is shown.";
export const HERMIOS_UNCERTAIN_UNREAD = "RealBud couldn't confirm whether that finished. Use Check again before trying it again.";
export const HERMIOS_BROWSER_FAILED = "Your browser didn't open. Use Connect again to retry.";

/** Bud's Hermios connection for one screen: read on mount, re-read when the
 *  window regains focus while a sign-in is pending, and every change re-reads
 *  rather than guessing when its outcome is unknown. */
export function useHermiosConnection(client?: HermiosConnectionApi) {
  const [connection] = useState(() => client ?? createHermiosConnectionApi(api));
  const [view, setView] = useState<HermiosConnectionView>({ state: null, loading: true, readError: null, busy: null, notice: null });
  const alive = useRef(true);
  const busy = useRef<HermiosBusy>(null);
  const patch = useCallback((next: Partial<HermiosConnectionView>) => { if (alive.current) setView(current => ({ ...current, ...next })); }, []);

  const refresh = useCallback(async () => {
    try {
      patch({ state: await connection.state(), loading: false, readError: null });
    } catch (cause) {
      patch({ loading: false, readError: cause instanceof Error ? cause.message : HERMIOS_STATE_UNREADABLE });
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

  const run = useCallback(async (kind: Exclude<HermiosBusy, null>, work: () => Promise<HermiosConnectionView["notice"] | void>) => {
    if (busy.current) return;
    busy.current = kind;
    patch({ busy: kind, notice: null });
    try {
      const notice = await work();
      patch({ notice: notice ?? null });
    } finally {
      busy.current = null;
      patch({ busy: null });
    }
  }, [patch]);

  const settle = useCallback((outcome: HermiosConnectionOutcome | Exclude<HermiosStartOutcome, { kind: "started" }>): HermiosConnectionView["notice"] => {
    if (outcome.state) patch({ state: outcome.state, readError: null });
    if (outcome.kind === "settled") return null;
    if (outcome.kind === "refused") return { text: outcome.message, problem: true };
    return { text: outcome.state ? HERMIOS_UNCERTAIN : HERMIOS_UNCERTAIN_UNREAD, problem: true };
  }, [patch]);

  const connect = useCallback(() => run("connect", async () => {
    const outcome = await connection.start();
    if (outcome.kind !== "started") return settle(outcome);
    const opened = await openHermiosSignIn(outcome.authorizeUrl);
    await refresh();
    return opened ? null : { text: HERMIOS_BROWSER_FAILED, problem: true };
  }), [connection, run, settle, refresh]);

  const check = useCallback(() => run("check", async () => settle(await connection.check())), [connection, run, settle]);
  const disconnect = useCallback(() => run("disconnect", async () => {
    const outcome = await connection.disconnect();
    return outcome.kind === "settled" ? { text: "Bud is disconnected from Hermios.", problem: false } : settle(outcome);
  }), [connection, run, settle]);

  return { view, refresh, connect, check, disconnect };
}

export type HermiosConnectionControls = ReturnType<typeof useHermiosConnection>;

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import {
  CONNECTORS_API, connectorConnectionApi, connectorEntryApi, parseConnectorRegistry, parseConnectorStart, parseConnectorState,
  type ConnectorRegistryView,
} from "@shared/mcp-connector";
import { openConnectorSignIn } from "./redbark-connection-api";

/** The office's added services, read and changed only through the RealBud
 *  service. Tokens never come back to the renderer: an access token is sent
 *  once and the reply is the connection state. */

type Request = (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<unknown>;

export const CONNECTORS_UNREADABLE = "Added services couldn't be checked. Try again.";
const DEFINITE = [400, 401, 403, 404, 409, 410, 422];
export type RegistryOutcome = { kind: "settled" } | { kind: "refused"; message: string } | { kind: "uncertain" };

const statusOf = (cause: unknown) =>
  cause && typeof cause === "object" && typeof (cause as { status?: unknown }).status === "number" ? (cause as { status: number }).status : undefined;
function refusal(cause: unknown, status: number): string {
  if (status === 403) return "Only the office owner or an administrator can change added services.";
  if (status === 409) return "This service changed meanwhile. Check it, then review again.";
  // The service's own sentence for a bad address or review; never provider text.
  const message = cause instanceof Error ? cause.message : "";
  return status === 400 && message && message.length <= 200 && !/[<>]/.test(message) ? message : "That didn't go through. Nothing changed.";
}

export interface ConnectorReviewSelection { enabled: string[]; trusted: string[]; consequential: string[]; warning?: string }

export function createConnectorRegistryApi(request: Request) {
  const list = async (): Promise<ConnectorRegistryView> => {
    let body: unknown;
    try { body = await request(CONNECTORS_API, undefined, { timeoutMs: 20_000 }); }
    catch (cause) { throw Object.assign(new Error(CONNECTORS_UNREADABLE), { cause }); }
    const parsed = parseConnectorRegistry(body);
    if (!parsed) throw new Error(CONNECTORS_UNREADABLE);
    return parsed;
  };
  async function post(path: string, payload: unknown, parse: (body: unknown) => unknown): Promise<RegistryOutcome & { body?: unknown }> {
    let body: unknown;
    try { body = await request(path, { method: "POST", body: JSON.stringify(payload) }, { timeoutMs: 45_000 }); }
    catch (cause) {
      const status = statusOf(cause);
      return status !== undefined && DEFINITE.includes(status) ? { kind: "refused", message: refusal(cause, status) } : { kind: "uncertain" };
    }
    const parsed = parse(body);
    return parsed ? { kind: "settled", body: parsed } : { kind: "uncertain" };
  }
  return {
    list,
    add: (input: { serverUrl: string; label: string; auth: "oauth" | "header" }) => post(CONNECTORS_API, input, parseConnectorRegistry),
    review: (id: string, digest: string, selection: ConnectorReviewSelection) => post(`${connectorEntryApi(id)}/review`, { digest, ...selection }, parseConnectorRegistry),
    remove: (id: string) => post(`${connectorEntryApi(id)}/remove`, {}, parseConnectorRegistry),
    /** The token is sent once; the reply is only the connection state. */
    setToken: (id: string, token: string) => post(`${connectorConnectionApi(id)}/token`, { token }, body => parseConnectorState(body, id)),
    check: (id: string) => post(`${connectorConnectionApi(id)}/check`, {}, body => parseConnectorState(body, id)),
    disconnect: (id: string) => post(`${connectorConnectionApi(id)}/disconnect`, {}, body => parseConnectorState(body, id)),
    start: (id: string) => post(`${connectorConnectionApi(id)}/start`, {}, body => parseConnectorStart(body)),
  };
}
export type ConnectorRegistryApi = ReturnType<typeof createConnectorRegistryApi>;

export interface ConnectorRegistryState {
  view: ConnectorRegistryView | null;
  loading: boolean;
  readError: string | null;
  busy: string | null;
  notice: { text: string; problem: boolean } | null;
}
const UNCERTAIN = "RealBud couldn't confirm whether that finished. The current list is shown.";

/** Added services for one screen. Every change re-reads the list instead of guessing. */
export function useConnectorRegistry(client?: ConnectorRegistryApi) {
  const [registry] = useState(() => client ?? createConnectorRegistryApi(api));
  const [state, setState] = useState<ConnectorRegistryState>({ view: null, loading: true, readError: null, busy: null, notice: null });
  const alive = useRef(true), busy = useRef<string | null>(null);
  const patch = useCallback((next: Partial<ConnectorRegistryState>) => { if (alive.current) setState(current => ({ ...current, ...next })); }, []);
  const refresh = useCallback(async () => {
    try { patch({ view: await registry.list(), loading: false, readError: null }); }
    catch (cause) { patch({ loading: false, readError: cause instanceof Error ? cause.message : CONNECTORS_UNREADABLE }); }
  }, [registry, patch]);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; }; }, [refresh]);

  const run = useCallback(async (key: string, work: () => Promise<RegistryOutcome & { body?: unknown }>, done?: string): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = key;
    patch({ busy: key, notice: null });
    try {
      const outcome = await work();
      await refresh();
      patch({ notice: outcome.kind === "settled" ? (done ? { text: done, problem: false } : null)
        : { text: outcome.kind === "refused" ? outcome.message : UNCERTAIN, problem: true } });
      return outcome.kind === "settled";
    } finally { busy.current = null; patch({ busy: null }); }
  }, [patch, refresh]);

  return {
    state, refresh,
    add: (input: { serverUrl: string; label: string; auth: "oauth" | "header" }) => run("add", () => registry.add(input), "Added. Connect it, then review its tools."),
    review: (id: string, digest: string, selection: ConnectorReviewSelection) => run(`review:${id}`, () => registry.review(id, digest, selection), "Reviewed. Bud can now use the tools you turned on."),
    remove: (id: string) => run(`remove:${id}`, () => registry.remove(id), "Removed. Its sign-in was deleted from this computer."),
    setToken: (id: string, token: string) => run(`token:${id}`, () => registry.setToken(id, token)),
    check: (id: string) => run(`check:${id}`, () => registry.check(id)),
    disconnect: (id: string) => run(`disconnect:${id}`, () => registry.disconnect(id), "Disconnected. Bud can no longer use it."),
    connect: (id: string) => run(`connect:${id}`, async () => {
      const outcome = await registry.start(id);
      const link = outcome.kind === "settled" ? (outcome.body as { authorizeUrl: string }).authorizeUrl : null;
      if (link && !(await openConnectorSignIn(link, new URL(link).origin))) return { kind: "refused" as const, message: "Your browser didn't open. Use Connect again to retry." };
      return outcome;
    }),
  };
}
export type ConnectorRegistryControls = ReturnType<typeof useConnectorRegistry>;

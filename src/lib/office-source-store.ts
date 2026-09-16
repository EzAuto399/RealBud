import { readConnectedAppsStatus, type ConnectedAppsStatus } from "./connected-apps";

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
export interface OfficeSourcesView { snapshot: ConnectedAppsStatus | null; loading: boolean; error: string; pendingService: string | null }

/** One observation owner for every surface; late requests cannot restore revoked access. */
export function createOfficeSourceStore(request: Request) {
  let view: OfficeSourcesView = { snapshot: null, loading: false, error: "", pendingService: null };
  const listeners = new Set<() => void>();
  let generation = 0;
  let pending: Promise<ConnectedAppsStatus | null> | null = null;
  let controller: AbortController | null = null;
  const checkError = "Couldn’t check office apps. Your saved settings are kept. Try again.";
  const publish = (patch: Partial<OfficeSourcesView>) => {
    view = { ...view, ...patch };
    listeners.forEach(listener => listener());
  };
  const cancelPending = () => {
    generation++; controller?.abort(); pending = null;
  };
  const invalidate = () => {
    cancelPending();
    publish({ snapshot: null, loading: false, error: "" });
  };
  const observe = (value: unknown, settled = false) => {
    const snapshot = readConnectedAppsStatus(value);
    const service = view.pendingService ? snapshot.services[view.pendingService] : undefined;
    // Status can arrive over the event stream before its HTTP check returns.
    // Settle sign-in here so every surface observes the same result.
    const pendingService = !snapshot.configured || (service?.connected && snapshot.tools.available) ? null : view.pendingService;
    publish({ snapshot, pendingService, error: snapshot.error ?? "", ...(settled ? { loading: false } : {}) });
    return snapshot;
  };
  // A confirmed settings response supersedes checks that started before it.
  const accept = (value: unknown) => {
    cancelPending();
    try {
      return observe(value, true);
    } catch (error) {
      publish({ snapshot: null, loading: false, error: checkError });
      throw error;
    }
  };
  const refresh = (): Promise<ConnectedAppsStatus | null> => {
    if (pending) return pending;
    const epoch = generation;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
    publish({ loading: true, error: "" });
    const run = (async () => {
      try {
        // Assign pending before invoking transports that may throw immediately.
        const body = await Promise.resolve().then(() => {
          signal.throwIfAborted();
          return request("/api/connected-apps/check", { method: "POST", body: "{}", signal });
        });
        if (epoch !== generation) return null;
        return observe(body);
      } catch {
        if (epoch === generation) publish({ snapshot: null, error: checkError });
        return null;
      } finally {
        if (epoch === generation) { pending = null; publish({ loading: false }); }
      }
    })();
    pending = run;
    return run;
  };
  return {
    getSnapshot: () => view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, invalidate, accept,
    setPending: (pendingService: string | null) => publish({ pendingService }),
  };
}

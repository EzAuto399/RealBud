import { api, type HermesStatus } from "@/state/store";

/** A readiness check belongs to the app, so changing views cannot start a
 * second model request. Subscribers only receive pending-state changes. */
export function createReadinessCheck<T>(request: () => Promise<T>) {
  let flight: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    isRunning: () => flight !== null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    run(): Promise<T> {
      if (flight) return flight;
      flight = Promise.resolve().then(request).finally(() => {
        flight = null;
        notify();
      });
      notify();
      return flight;
    },
  };
}

export const budReadinessCheck = createReadinessCheck(async () => {
  const result = await api("/api/hermes/test", { method: "POST", body: "{}" });
  // Read the complete authoritative state. A ping alone cannot override
  // missing safeguards, an offline service or a changed model connection.
  const status: HermesStatus = await api("/api/hermes");
  return { ok: result?.ok === true, detail: result?.detail, status };
});

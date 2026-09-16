import { useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { createOfficeSourceStore } from "./office-source-store";
import { OFFICE_SOURCE_LABELS, officeAppLabel, officeSourceState, type ConnectedAppsStatus } from "@shared/office-sources";

export const officeSources = createOfficeSourceStore((path, init) => api(path, init));
export const useOfficeSources = () => useSyncExternalStore(officeSources.subscribe, officeSources.getSnapshot, officeSources.getSnapshot);
export async function refreshConnectedApps(): Promise<ConnectedAppsStatus> {
  const result = await officeSources.refresh();
  if (!result) throw new Error(officeSources.getSnapshot().error || "App settings changed. Checking again…");
  return result;
}
export function summarizeConnectedApps(snapshot: ConnectedAppsStatus): string {
  if (!snapshot.configured) return "Add an office app to use it with Bud.";
  if (snapshot.error) return "Office apps need attention. Open Add to try again.";
  return Object.keys(snapshot.services).map(slug => `${officeAppLabel(slug)}: ${OFFICE_SOURCE_LABELS[officeSourceState(snapshot, slug)]}`).join(" · ") || "No office accounts connected yet.";
}

/** Mounted by the app, so signing in survives changing pages. Only status reads retry. */
export function watchOfficeSources(): () => void {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0;
  let recheckRequested = false;
  const check = async () => {
    if (stopped || inFlight || document.visibilityState === "hidden") return;
    clearTimeout(timer);
    inFlight = true;
    try {
      const snapshot = await officeSources.refresh();
      if (stopped) return;
      const service = officeSources.getSnapshot().pendingService;
      if (snapshot?.configured === false || (service && snapshot?.services[service]?.connected && snapshot.tools.available)) officeSources.setPending(null);
      if (deadline && Date.now() >= deadline) officeSources.setPending(null);
    } finally {
      inFlight = false;
      if (!stopped) {
        const delay = recheckRequested ? 0 : officeSources.getSnapshot().pendingService ? 4_000 : 120_000;
        recheckRequested = false;
        timer = setTimeout(() => void check(), delay);
      }
    }
  };
  const changed = (event: Event) => {
    const service = (event as CustomEvent<{ service?: string }>).detail?.service;
    if (service) { officeSources.setPending(service); deadline = Date.now() + 5 * 60_000; }
    officeSources.invalidate();
    recheckRequested = inFlight;
    void check();
  };
  const visible = () => {
    const last = Date.parse(officeSources.getSnapshot().snapshot?.checkedAt ?? "");
    if (officeSources.getSnapshot().pendingService || !Number.isFinite(last) || Date.now() - last > 30_000) void check();
  };
  window.addEventListener("realbud:connected-apps-refresh", changed);
  window.addEventListener("focus", visible);
  document.addEventListener("visibilitychange", visible);
  void check();
  return () => {
    stopped = true; clearTimeout(timer); officeSources.invalidate();
    window.removeEventListener("realbud:connected-apps-refresh", changed);
    window.removeEventListener("focus", visible);
    document.removeEventListener("visibilitychange", visible);
  };
}

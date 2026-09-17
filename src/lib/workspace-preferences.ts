import { useSyncExternalStore } from "react";

export interface WorkspacePreferences {
  density: "auto" | "comfortable" | "compact";
  propertyView: "auto" | "cards" | "table";
  pageSize: 20 | 50 | 100;
  queueWidth: number;
  showBud: boolean;
  propertyGrouping: "none" | "building" | "suburb" | "portal";
  propertySort: "address" | "suburb" | "rent" | "late";
}
export const DEFAULT_WORKSPACE: WorkspacePreferences = { density: "auto", propertyView: "auto", pageSize: 50, queueWidth: 280, showBud: true, propertyGrouping: "none", propertySort: "address" };
export function readWorkspacePreferences(value: unknown): WorkspacePreferences {
  const p = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    density: ["auto", "comfortable", "compact"].includes(String(p.density)) ? p.density as WorkspacePreferences["density"] : "auto",
    propertyView: ["auto", "cards", "table"].includes(String(p.propertyView)) ? p.propertyView as WorkspacePreferences["propertyView"] : "auto",
    pageSize: [20, 50, 100].includes(p.pageSize as number) ? p.pageSize as WorkspacePreferences["pageSize"] : 50,
    queueWidth: typeof p.queueWidth === "number" && Number.isFinite(p.queueWidth) ? Math.max(240, Math.min(360, Math.round(p.queueWidth))) : 280,
    showBud: typeof p.showBud === "boolean" ? p.showBud : true,
    propertyGrouping: ["none", "building", "suburb", "portal"].includes(String(p.propertyGrouping)) ? p.propertyGrouping as WorkspacePreferences["propertyGrouping"] : "none",
    propertySort: ["address", "suburb", "rent", "late"].includes(String(p.propertySort)) ? p.propertySort as WorkspacePreferences["propertySort"] : "address",
  };
}
export function portfolioLayout(p: WorkspacePreferences, count: number) {
  return { compact: p.density === "compact" || (p.density === "auto" && count >= 50), table: p.propertyView === "table" || (p.propertyView === "auto" && count >= 50) };
}
const KEY = "realbud.workspace-layout.v1";
let current: WorkspacePreferences | undefined;
let saved = true;
const listeners = new Set<() => void>();
function snapshot() {
  if (!current) {
    try { current = readWorkspacePreferences(JSON.parse(localStorage.getItem(KEY) || "null")); }
    catch { current = { ...DEFAULT_WORKSPACE }; }
  }
  return current;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    current = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}
export function useWorkspacePreferences() {
  const preferences = useSyncExternalStore(subscribe, snapshot);
  const update = (patch: Partial<WorkspacePreferences>) => {
    current = readWorkspacePreferences({ ...snapshot(), ...patch });
    try { localStorage.setItem(KEY, JSON.stringify(current)); saved = true; } catch { saved = false; }
    listeners.forEach(listener => listener());
  };
  return { preferences, update, saved };
}

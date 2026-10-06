import { useCallback, useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { DESIGN_PREVIEW_REASON } from "@/lib/design-preview";
import { currentUsagePeriod, parseInstallationUsage } from "@shared/office-link";
import { usageBudget, type UsageBudget } from "@shared/usage-budget";

/** What the shell shows about the work browser. Only a validated reply counts. */
export type ShellBrowser = { active: boolean; ready: boolean; account: string } | null;

export function parseShellBrowser(value: unknown): ShellBrowser {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== "string" || typeof raw.active !== "boolean" || !Array.isArray(raw.browsers)) return null;
  const chosen = raw.browsers.find(item => item && typeof item === "object" && (item as Record<string, unknown>).id === raw.selectedBrowserId) as Record<string, unknown> | undefined;
  const account = typeof chosen?.label === "string" && chosen.label.trim() ? chosen.label.trim().slice(0, 60) : typeof chosen?.name === "string" ? chosen.name.slice(0, 60) : "Work browser";
  return { active: raw.active, ready: raw.state === "ready", account };
}

const visible = () => document.visibilityState !== "hidden";

/** Polls the local browser status while the app is connected. Stop goes through the
 *  same `/api/browser/stop` route as Workspace → Work browser; it never resumes work. */
export function useShellBrowser() {
  const { state } = useStore();
  const [browser, setBrowser] = useState<ShellBrowser>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const enabled = state.connected && !DESIGN_PREVIEW_REASON;
  const refresh = useCallback(async () => {
    if (!enabled || !visible()) return;
    const request = ++epoch.current;
    try {
      const next = parseShellBrowser(await api("/api/browser", undefined, { timeoutMs: 10_000 }));
      if (request === epoch.current) setBrowser(next);
    } catch { if (request === epoch.current) setBrowser(null); }
  }, [enabled]);
  useEffect(() => {
    if (!enabled) { epoch.current++; setBrowser(null); return; }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => { epoch.current++; window.clearInterval(timer); };
  }, [enabled, refresh]);
  const stop = async () => {
    if (stopping) return;
    const request = ++epoch.current;
    setStopping(true); setError("");
    try {
      const next = parseShellBrowser(await api("/api/browser/stop", { method: "POST", body: "{}" }, { timeoutMs: 90_000 }));
      if (request === epoch.current) setBrowser(next);
    } catch {
      setError("Browser release could not be confirmed. Check Workspace → Work browser before taking over.");
    } finally { setStopping(false); }
  };
  return { browser, stopping, error, stop };
}

/** Spend against the office budget, from the same local read Workspace uses. Anything
 *  other than a validated report reads as unavailable, never as zero. */
export function useShellBudget(): UsageBudget | null {
  const { state } = useStore();
  const [budget, setBudget] = useState<UsageBudget | null>(null);
  const enabled = state.connected && !DESIGN_PREVIEW_REASON;
  useEffect(() => {
    if (!enabled) { setBudget(null); return; }
    let active = true;
    const load = async () => {
      if (!visible()) return;
      try {
        const status = await api("/api/office-link") as { usage?: { state?: string; usage?: unknown } } | null;
        const value = status?.usage;
        if (!active) return;
        if (value?.state !== "ready") { setBudget(null); return; }
        const usage = parseInstallationUsage(value.usage, currentUsagePeriod());
        setBudget(usageBudget(usage.monthlyCapNanoAud, usage.remainingNanoAud));
      } catch { if (active) setBudget(null); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled]);
  return budget;
}

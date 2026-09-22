import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { fmtDateTime } from "@/lib/au";
import { serviceActionFeedback, serviceLifecycleCopy, serviceStatusCopy, type ServiceLifecycle } from "@/lib/service-status";
import { Card } from "./SettingsPrimitives";

/**
 * Copy for the main process's automatic restarts of the office service,
 * re-validated here because the field is optional and older builds omit it.
 * `running` is shown beside a running service, `stopped` in the not-running banner.
 */
export function autoRestartCopy(value: unknown): { running: string | null; stopped: string | null } {
  const report = value && typeof value === "object" ? (value as { autoRestart?: unknown }).autoRestart : null;
  if (!report || typeof report !== "object") return { running: null, stopped: null };
  const { today, pending, exhausted } = report as Record<string, unknown>;
  const count = typeof today === "number" && Number.isSafeInteger(today) && today > 0 ? today : 0;
  return {
    running: count ? `Restarted automatically ${count === 1 ? "once" : `${count} times`} today. Check recent work before retrying an interrupted job; its last action may already have completed.` : null,
    stopped: exhausted === true
      ? "Automatic restarts have paused after five attempts in the last hour. Start it below; if it stops again, contact RealBud support."
      : pending === true ? "RealBud will try to restart it automatically shortly. You can also start it now." : null,
  };
}

export function ServiceStatusCard() {
  const [status, setStatus] = useState<ReturnType<typeof serviceStatusCopy> | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [worker, setWorker] = useState<ServiceLifecycle | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [feedback, setFeedback] = useState<ReturnType<typeof serviceActionFeedback> | null>(null);
  const lifecycleGeneration = useRef(0);
  const actionPending = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  // The desk service supervises itself in the main process. When it has given up
  // the HTTP API cannot report anything, so this is the only place staff can see
  // that their office is down — and the only way to ask for it back.
  const readLifecycle = useCallback(async () => {
    if (actionPending.current) return;
    const current = ++lifecycleGeneration.current;
    try {
      const next = (await window.ogb?.serviceStatus?.()) ?? null;
      if (mounted.current && current === lifecycleGeneration.current) setWorker(next);
    } catch { if (mounted.current && current === lifecycleGeneration.current) setWorker(null); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void readLifecycle();
    const timer = window.setInterval(() => { void readLifecycle(); }, 15_000);
    window.addEventListener("focus", readLifecycle);
    return () => { mounted.current = false; lifecycleGeneration.current++; window.clearInterval(timer); window.removeEventListener("focus", readLifecycle); };
  }, [readLifecycle]);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setPending(true); setError(""); setStatus(null);
    try {
      const next = serviceStatusCopy(await api("/api/service/status", undefined, { timeoutMs: 10_000 }));
      if (current === generation.current) setStatus(next);
    } catch {
      if (current === generation.current) setError("Service status could not be checked. Reconnect and try again.");
    } finally { if (current === generation.current) setPending(false); }
  }, []);
  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => { generation.current++; window.removeEventListener("focus", refresh); };
  }, [refresh]);
  const retryWorker = useCallback(async () => {
    if (actionPending.current) return;
    actionPending.current = true; lifecycleGeneration.current++;
    setRetrying(true); setFeedback(null);
    try {
      const result = await window.ogb?.serviceRetry?.();
      if (!mounted.current) return;
      setWorker(result?.status ?? null);
      setFeedback(serviceActionFeedback("start", result));
      if (result?.ok) await refresh();
    } catch { if (mounted.current) setFeedback(serviceActionFeedback("start", null)); }
    finally { actionPending.current = false; if (mounted.current) setRetrying(false); }
  }, [refresh]);
  const stopOffice = useCallback(async () => {
    if (actionPending.current) return;
    actionPending.current = true; lifecycleGeneration.current++;
    setRetrying(true); setFeedback(null); setConfirmStop(false);
    try {
      const result = await window.ogb?.serviceStop?.();
      if (!mounted.current) return;
      setWorker(result?.status ?? null);
      setFeedback(serviceActionFeedback("stop", result));
    } catch { if (mounted.current) setFeedback(serviceActionFeedback("stop", null)); }
    finally { actionPending.current = false; if (mounted.current) setRetrying(false); }
  }, []);
  const lifecycleCopy = worker ? serviceLifecycleCopy(worker) : null;
  // The office surviving the window is the point of the service split, so say so
  // plainly when it is running and this app can manage it.
  const officeRunning = worker?.running === true;
  const autoRestart = autoRestartCopy(worker);
  return <Card title="RealBud service" subtitle="Access to managed assistance on this computer.">
    {officeRunning ? (
      <div role="status" className="mb-3 rounded-lg bg-raised px-3 py-2 text-[13px] leading-relaxed">
        <p className="font-medium text-ink">The office service is running.</p>
        <p className="mt-1 text-ink-secondary">
          {worker?.adopted
            ? "RealBud connected to a service that was already running on this computer."
            : "It keeps running when you close the window. Keep this computer awake and connected for shared records and scheduled work."}
        </p>
        {autoRestart.running ? <p className="mt-1 text-ink-secondary">{autoRestart.running}</p> : null}
        {worker?.manageable ? (
          <button type="button" disabled={retrying} onClick={() => { setConfirmStop(true); setFeedback(null); }}
            className="pm-control mt-2 rounded border border-line px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-50">
            {retrying ? "Stopping the office service…" : "Stop the office service"}
          </button>
        ) : null}
      </div>
    ) : null}
    {confirmStop && worker?.running && worker.manageable ? <div role="group" aria-label="Confirm stopping the office service" className="mb-3 rounded-lg border border-line p-3 text-[14px]">
      <p className="font-medium">Stop the office service on this computer?</p>
      <p className="mt-1 text-ink-secondary">Scheduled work will stop. If this computer hosts your office, colleagues will lose access to its shared records until it starts again. Review active jobs first; an interrupted external action may already have completed.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={retrying} onClick={() => { void stopOffice(); }} className="min-h-11 rounded border border-line px-3">Confirm stop</button>
        <button type="button" disabled={retrying} onClick={() => setConfirmStop(false)} className="min-h-11 rounded border border-line px-3">Keep service running</button>
      </div>
    </div> : null}
    {feedback && <p role={feedback.ok ? "status" : "alert"} className={`mb-3 text-[14px] ${feedback.ok ? "text-ink-secondary" : "text-danger"}`}>{feedback.message}</p>}
    {lifecycleCopy ? (
      <div role="alert" className="mb-3 rounded-lg bg-hold/10 px-3 py-2 text-[13px] leading-relaxed">
        <p className="font-medium text-hold">{lifecycleCopy.title}</p>
        <p className="mt-1 text-ink-secondary">{lifecycleCopy.detail}</p>
        {worker?.running === false && lifecycleCopy.canRetry && autoRestart.stopped ? <p className="mt-1 text-ink-secondary">{autoRestart.stopped}</p> : null}
        {lifecycleCopy.canRetry ? (
          <button type="button" disabled={retrying} onClick={() => { void retryWorker(); }}
            className="pm-control mt-2 rounded border border-line px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-50">
            {retrying ? "Starting the office service…" : "Start the office service"}
          </button>
        ) : null}
      </div>
    ) : null}
    <div role="status" aria-live="polite" className="text-[13px] leading-relaxed">
      {pending ? "Checking service access…" : status ? <>
        <p className={status.available ? "font-medium text-ink" : "font-medium text-hold"}>{status.title}</p>
        <p className="mt-1 text-ink-secondary">{status.detail}</p>
        {status.expiresAt ? <p className="mt-1 text-ink-muted">Access valid until {fmtDateTime(status.expiresAt)}</p> : null}
      </> : null}
    </div>
    {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    <button type="button" disabled={pending || retrying} onClick={() => { void refresh(); void readLifecycle(); }}
      className="pm-control mt-3 rounded border border-line px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-50">
      {pending ? "Checking…" : error ? "Retry service check" : "Refresh service status"}
    </button>
  </Card>;
}

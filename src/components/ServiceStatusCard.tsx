import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { fmtDateTime } from "@/lib/au";
import { serviceLifecycleCopy, serviceStatusCopy, type ServiceLifecycle } from "@/lib/service-status";
import { Card } from "./SettingsPrimitives";

export function ServiceStatusCard() {
  const [status, setStatus] = useState<ReturnType<typeof serviceStatusCopy> | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [worker, setWorker] = useState<ServiceLifecycle | null>(null);
  const [retrying, setRetrying] = useState(false);
  const generation = useRef(0);
  // The desk service supervises itself in the main process. When it has given up
  // the HTTP API cannot report anything, so this is the only place staff can see
  // that their office is down — and the only way to ask for it back.
  const readLifecycle = useCallback(async () => {
    try { setWorker((await window.ogb?.serviceStatus?.()) ?? null); } catch { setWorker(null); }
  }, []);
  useEffect(() => {
    void readLifecycle();
    const timer = window.setInterval(() => { void readLifecycle(); }, 15_000);
    window.addEventListener("focus", readLifecycle);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", readLifecycle); };
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
    setRetrying(true);
    try {
      const result = await window.ogb?.serviceRetry?.();
      setWorker(result?.status ?? null);
      if (result?.ok) await refresh();
    } catch { /* the next poll reports the truth */ }
    finally { setRetrying(false); }
  }, [refresh]);
  const stopOffice = useCallback(async () => {
    setRetrying(true);
    try {
      const result = await window.ogb?.serviceStop?.();
      setWorker(result?.status ?? null);
    } catch { /* the next poll reports the truth */ }
    finally { setRetrying(false); }
  }, []);
  const lifecycleCopy = worker ? serviceLifecycleCopy(worker) : null;
  // The office surviving the window is the point of the service split, so say so
  // plainly when it is running and this app can manage it.
  const officeRunning = worker?.running === true;
  return <Card title="RealBud service" subtitle="Access to managed assistance on this computer.">
    {officeRunning ? (
      <div role="status" className="mb-3 rounded-lg bg-raised px-3 py-2 text-[13px] leading-relaxed">
        <p className="font-medium text-ink">The office service is running{worker?.port ? ` on port ${worker.port}` : ""}.</p>
        <p className="mt-1 text-ink-secondary">
          {worker?.adopted
            ? "It was already running when RealBud opened, so it kept working while the window was closed."
            : "It keeps running when you close RealBud, so shared records and scheduled work stay available."}
        </p>
        {worker?.manageable ? (
          <button type="button" disabled={retrying} onClick={() => { void stopOffice(); }}
            className="pm-control mt-2 rounded border border-line px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-50">
            {retrying ? "Stopping the office service…" : "Stop the office service"}
          </button>
        ) : null}
      </div>
    ) : null}
    {lifecycleCopy ? (
      <div role="alert" className="mb-3 rounded-lg bg-hold/10 px-3 py-2 text-[13px] leading-relaxed">
        <p className="font-medium text-hold">{lifecycleCopy.title}</p>
        <p className="mt-1 text-ink-secondary">{lifecycleCopy.detail}</p>
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
    <button type="button" disabled={pending} onClick={() => { void refresh(); }}
      className="pm-control mt-3 rounded border border-line px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-50">
      {pending ? "Checking…" : error ? "Retry service check" : "Refresh service status"}
    </button>
  </Card>;
}

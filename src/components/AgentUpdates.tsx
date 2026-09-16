import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";

type UpdateStatus = {
  recommended: { product: string; tag: string };
  selected: { product: string; tag: string } | null;
  restartRequired: boolean;
  canRestorePrevious: boolean;
  customRuntime: boolean;
  upstream?: { latestTag: string; supported: boolean; releaseUrl: string };
};
const button = "rounded border border-line px-3 py-2 text-[12px] text-ink hover:bg-raised disabled:opacity-40";

export function AgentUpdates({ disabled = false, onSettled }: { disabled?: boolean; onSettled: () => Promise<void> }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const settled = useRef(onSettled); settled.current = onSettled;
  useEffect(() => {
    mounted.current = true;
    void Promise.all([api("/api/hermes/update"), api("/api/hermes/install/status")]).then(([value, current]) => {
      if (!mounted.current) return;
      setStatus(value);
      setInstalling(["preflight", "running", "verifying"].includes(current.install?.state));
    }).catch(() => { if (mounted.current) setError("Agent update status is unavailable. Recheck when RealBud reconnects."); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!installing) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { install } = await api("/api/hermes/install/status");
        if (cancelled) return;
        setMessage(install.progress?.detail || "Preparing the agent");
        setError("");
        if (!["preflight", "running", "verifying"].includes(install.state)) {
          const next = await api("/api/hermes/update");
          if (cancelled) return;
          setStatus(next); setInstalling(false);
          if (install.state === "failed") { setError(install.error || "Agent setup did not finish. Your current agent is kept."); setMessage(""); }
          else setMessage(next.restartRequired ? "Agent prepared and verified. Quit and reopen RealBud to use it, then run the readiness check." : "Agent setup finished. Continue connecting Bud.");
          await settled.current();
          return;
        }
      } catch { if (!cancelled) setError("Reconnecting to agent setup. Progress will resume automatically."); }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [installing]);

  async function action(kind: "check" | "install" | "restore" | "cancel") {
    setBusy(true); setError("");
    try {
      const path = kind === "cancel" ? "/api/hermes/install/cancel" : `/api/hermes/update${kind === "check" ? "/check" : kind === "restore" ? "/restore" : ""}`;
      const result = await api(path, { method: "POST", body: "{}" });
      if (!mounted.current) return;
      if (kind === "check") { setStatus(result); setMessage("Agent release check finished."); }
      if (kind === "install") { setInstalling(true); setMessage("Preparing a verified agent release. Your current agent remains available."); }
      if (kind === "restore") { setStatus(await api("/api/hermes/update")); setMessage("Previous agent selected. Quit and reopen RealBud to use it. Your profile and office files are kept."); }
      if (kind === "cancel") setMessage("Stopping setup. Your current agent is kept.");
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : "Agent update did not finish. Try again."); }
    finally { if (mounted.current) setBusy(false); }
  }
  const locked = disabled || busy || installing;
  return <details className="mt-4 border-t border-line/70 pt-3">
    <summary className="cursor-pointer text-[13px] text-ink-muted">Agent updates</summary>
    <div className="mt-3 space-y-3 text-[12.5px] text-ink-secondary">
      <p>Powered by Hermes Agent. RealBud uses unmodified upstream releases checked with its approvals and tools. Your model connection, memory and skills stay in Bud’s private profile.</p>
      {status ? <p>Recommended: {status.recommended.product} ({status.recommended.tag}). {status.restartRequired ? "An agent change is waiting for a restart." : status.selected ? `Selected: ${status.selected.product}.` : "Currently using the existing agent installation."}</p> : null}
      {status?.upstream && !status.upstream.supported ? <p>Hermes {status.upstream.latestTag} is available upstream. Compatibility testing is still needed for that release. Check RealBud’s app updates for newly supported versions.</p> : null}
      {status?.customRuntime ? <p>This computer uses a custom agent path. Manage its updates through that installation.</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={locked} onClick={() => void action("check")}>Check agent updates</button>
        {status && !status.customRuntime ? <button type="button" className={button} disabled={locked || status.selected?.tag === status.recommended.tag} onClick={() => void action("install")}>Install recommended agent</button> : null}
        {status?.canRestorePrevious ? <button type="button" className={button} disabled={locked} onClick={() => void action("restore")}>Use previous agent</button> : null}
        {installing ? <button type="button" className={button} disabled={busy} onClick={() => void action("cancel")}>Stop agent setup</button> : null}
      </div>
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </div>
  </details>;
}

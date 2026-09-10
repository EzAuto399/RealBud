import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";

type Hold = { id: string; revision: number; value: { state: string; reason: string; detail: string; runId: string; binding?: unknown } };
export function HumanHandoffPanel() {
  const { state } = useStore();
  const [holds, setHolds] = useState<Hold[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const refresh = async () => { const result = await api("/api/human-handoffs"); setHolds(result.handoffs); };
  useEffect(() => {
    let closed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const result = await api("/api/human-handoffs", undefined, { timeoutMs: 5000 }); if (!closed) setHolds(result.handoffs); }
      catch { if (!closed) setError("Sign-in status could not be refreshed. Reconnect before continuing."); }
      if (!closed) timer = setTimeout(poll, 4000);
    };
    if (state.connected) void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [state.connected]);
  const action = async (hold: Hold, name: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await api(`/api/human-handoffs/${hold.id}/${name}`, { method: "POST", body: JSON.stringify({ revision: hold.revision }) }, { timeoutMs: 30000 }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This action could not be confirmed. Reload the request."); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  };
  const visible = holds.filter(hold => hold.value.state !== "closed");
  if (!visible.length) return null;
  return <aside className="max-h-[40vh] overflow-y-auto border-b border-line bg-sheet px-4 py-3" aria-label="Sign-in handovers">
    {visible.map(hold => <div key={hold.id} data-handoff-id={hold.id} data-handoff-revision={hold.revision} className="mx-auto max-w-4xl space-y-2 py-2" role="status">
      <h2 className="text-sm font-semibold">{hold.value.reason === "mfa" ? "Verification code needs you" : "Sign-in needs you"} · {hold.value.state.replaceAll("_", " ")}</h2>
      <p className="text-sm text-ink-secondary">{hold.value.detail}</p>
      {hold.value.state === "awaiting_login" && !hold.value.binding && <p className="text-xs text-hold">The account and page check still needs setup. Enter passwords and verification codes only in the original application.</p>}
      <div className="flex flex-wrap gap-2">{[
        ...(hold.value.state === "awaiting_login" ? [["continue", "Continue — check sign-in"]] : []),
        ...(["recovery_required", "releasing"].includes(hold.value.state) ? [["retry-release", "Retry computer release"]] : []),
        ...(["verified", "stopped"].includes(hold.value.state) ? [["close", "Close handover · keep job interrupted"]] : [["stop", "Stop this request"]]),
      ].map(([name, label]) => <button type="button" key={name} disabled={busy || !state.connected} className="rounded border border-line px-3 py-2 text-sm text-ink hover:bg-selected disabled:opacity-50" onClick={() => void action(hold, name)}>{label}</button>)}</div>
    </div>)}
    {busy && <p role="status" className="text-sm">Waiting for confirmed computer state…</p>}{error && <p role="alert" className="text-sm text-hold">{error}</p>}
  </aside>;
}

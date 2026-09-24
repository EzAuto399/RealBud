import { useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";

export type Hold = { id: string; revision: number; value: { state: string; reason: string; detail: string; runId: string; binding?: unknown; steps?: string[]; task?: unknown; inPage?: boolean } };
export type LoginTab = { tabId: number; browserId: string; origin: string; title: string };
type Draft = { tabId: string; accountMarker: string; readyMarker: string };
const EMPTY_DRAFT: Draft = { tabId: "", accountMarker: "", readyMarker: "" };
const stateLabel: Record<string, string> = { releasing: "Stopping browser work", awaiting_login: "Waiting for you", checking: "Checking the page", verified: "Sign-in checked", resuming: "Starting your chosen step", recovery_required: "Needs attention", stopped: "Stopped" };
/** Shown beside Continue when the paused task is kept: Continue carries it on. */
export const CONTINUE_TASK_HINT = "Sign in on the page, then press Continue — Bud carries on from where it stopped.";

/** Bud is waiting inside its own browser step: the page itself takes the sign-in. */
export const waitingOnPage = (hold: Hold) => hold.value.state === "awaiting_login" && hold.value.inPage === true;

/** The buttons a handover offers, as [action, label]. Stop stays until the request is stopped or checked. */
export function handoffButtons(hold: Hold, editing: boolean): Array<[string, string]> {
  const { state, binding } = hold.value;
  return [
    ...(state === "awaiting_login" && !waitingOnPage(hold) && binding && !editing ? [["continue", "Continue — check sign-in"] as [string, string]] : []),
    ...(["recovery_required", "releasing"].includes(state) ? [["retry-release", "Retry computer release"] as [string, string]] : []),
    ...(["verified", "stopped"].includes(state) ? [["close", "Close without continuing"] as [string, string]] : [["stop", "Stop this request"] as [string, string]]),
  ];
}

/** One sign-in handover. All state lives in the panel; this only renders it. */
export function HandoffCard({ hold, busy, connected, editing, tabs, draft, nextStep, onAction, onToggleEdit, onDraft, onNextStep }: {
  hold: Hold;
  busy: boolean;
  connected: boolean;
  editing: boolean;
  tabs: LoginTab[] | undefined;
  draft: Draft | undefined;
  nextStep: string | undefined;
  onAction: (name: string) => void;
  onToggleEdit: () => void;
  onDraft: (patch: Partial<Draft>) => void;
  onNextStep: (value: string) => void;
}) {
  const { state, reason, detail, binding, steps, task } = hold.value;
  const onPage = waitingOnPage(hold);
  const pageForm = state === "awaiting_login" && !onPage && (!binding || editing);
  const buttons = handoffButtons(hold, editing);
  const current = draft ?? EMPTY_DRAFT;
  return <div data-handoff-id={hold.id} data-handoff-revision={hold.revision} className="mx-auto max-w-4xl space-y-2 py-2" role="status">
    <h2 className="text-sm font-semibold">{reason === "mfa" ? "Verification code needs you" : "Sign-in needs you"} · {onPage ? "Waiting for you on the page" : stateLabel[state] || "Needs attention"}</h2>
    <p className="text-sm text-ink-secondary">{detail}</p>
    {state === "verified" && <p className="text-sm text-ink-secondary">Select the checked website tab in your browser, then choose the next step here. The browser will ask again before lending the tab.</p>}
    {state === "awaiting_login" && !onPage && Boolean(binding) && <button type="button" className="min-h-11 rounded border border-line px-3 py-2 text-sm" disabled={busy || !connected} onClick={onToggleEdit}>{editing ? "Keep saved page check" : "Change the page check"}</button>}
    {pageForm && <div className="space-y-3 border-l-2 border-hold pl-3">
      <p className="text-sm">Sign in directly in your browser. Then choose that page and two visible labels so Bud can check the right account without entering any details.</p>
      <button type="button" className="min-h-11 rounded border border-line px-3 py-2 text-sm" disabled={busy || !connected} onClick={() => onAction("tabs")}>Find my signed-in page</button>
      {tabs && (tabs.length ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm sm:col-span-2">Page to check<select aria-label="Page to check" className="min-h-11 w-full min-w-0 max-w-full rounded border border-line bg-sheet px-3" disabled={busy} value={current.tabId} onChange={e => onDraft({ tabId: e.target.value })}><option value="">Choose the page…</option>{tabs.map(tab => <option key={tab.tabId} value={tab.tabId}>{tab.title} · {new URL(tab.origin).hostname}</option>)}</select></label>
        {([['accountMarker', 'Account label visible on the page', 'Example: Office operating account'], ['readyMarker', 'Signed-in page heading', 'Example: Transaction history']] as const).map(([key, label, placeholder]) => <label key={key} className="flex min-w-0 flex-col gap-1 text-sm">{label}<input className="min-h-11 w-full min-w-0 max-w-full rounded border border-line bg-sheet px-3" disabled={busy} maxLength={120} placeholder={placeholder} autoComplete="off" value={current[key]} onChange={e => onDraft({ [key]: e.target.value })} /></label>)}
        <p className="text-sm text-ink-secondary sm:col-span-2">Use labels, never an account number, password or verification code. The browser will ask before lending this tab for the check.</p>
        <button type="button" className="min-h-11 rounded border border-line px-3 py-2 text-sm sm:col-span-2" disabled={busy || !current.tabId || current.accountMarker.trim().length < 4 || current.readyMarker.trim().length < 4} onClick={() => onAction("binding")}>Save page check</button>
      </div> : <p className="text-sm text-hold">No open page matches this job’s exact website. Open it in the browser Bud uses on this computer, then check again.</p>)}
    </div>}
    {buttons.some(([name]) => name === "continue") && Boolean(task) && <p className="text-sm">{CONTINUE_TASK_HINT}</p>}
    {state === "verified" && steps?.length ? <div className="space-y-2"><p className="text-xs">Review what finished before sign-in. Choose only the next step to run; nothing earlier will be replayed.</p><select aria-label="Next reviewed step" className="min-h-11 max-w-full rounded border border-line bg-sheet p-2 text-sm" value={nextStep ?? ""} onChange={event => onNextStep(event.target.value)}><option value="">Choose the next reviewed step…</option>{steps.map((step, index) => <option key={index} value={index}>{index + 1}. {step}</option>)}</select><button type="button" className="min-h-11 rounded border border-line px-3 py-2 text-sm" disabled={busy || !connected || nextStep === undefined || nextStep === ""} onClick={() => onAction("resume-step")}>Run this step only</button></div> : null}
    <div className="flex flex-wrap gap-2">{buttons.map(([name, label]) => <button type="button" key={name} disabled={(busy && name !== "stop") || !connected} className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-selected disabled:opacity-50" onClick={() => onAction(name)}>{label}</button>)}</div>
  </div>;
}

export function HumanHandoffPanel() {
  const { state } = useStore();
  const [nextSteps, setNextSteps] = useState<Record<string, string>>({});
  const [holds, setHolds] = useState<Hold[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [tabs, setTabs] = useState<Record<string, LoginTab[]>>({});
  const [bindings, setBindings] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [refreshError, setRefreshError] = useState("");
  const epoch = useRef(0), actionEpoch = useRef(0), changing = useRef(false), mounted = useRef(true);
  const refresh = async () => {
    const request = ++epoch.current;
    const result = await api("/api/human-handoffs");
    if (mounted.current && request === epoch.current) { setHolds(result.handoffs); setRefreshError(""); }
  };
  useEffect(() => {
    mounted.current = true;
    let closed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const request = changing.current ? null : ++epoch.current;
      if (request !== null) {
        try { const result = await api("/api/human-handoffs", undefined, { timeoutMs: 5000 }); if (!closed && request === epoch.current) { setHolds(result.handoffs); setRefreshError(""); } }
        catch { if (!closed && request === epoch.current) setRefreshError("Sign-in status could not be refreshed. Reconnect before continuing."); }
      }
      if (!closed) timer = setTimeout(poll, 4000);
    };
    if (state.connected) void poll();
    return () => { closed = true; mounted.current = false; epoch.current++; clearTimeout(timer); };
  }, [state.connected]);
  const action = async (hold: Hold, name: string) => {
    if (changing.current && name !== "stop") return;
    const actionId = ++actionEpoch.current;
    changing.current = true; epoch.current++;
    setBusy(true); setError("");
    try {
      if (name === "stop") {
        // A sign-in check claims a new revision while awaiting the browser.
        // Read that revision so Stop remains usable during the check.
        const latest = await api("/api/human-handoffs");
        const current = (latest.handoffs as Hold[]).find(row => row.id === hold.id);
        if (!current) throw new Error("This request has ended. Check Work activity before continuing.");
        hold = current;
      }
      const draft = bindings[hold.id];
      const tab = tabs[hold.id]?.find(t => String(t.tabId) === draft?.tabId);
      if (name === "binding" && (!draft || !tab)) throw new Error("Choose the page you signed in to.");
      const result = await api(`/api/human-handoffs/${hold.id}/${name}`, { method: "POST", body: JSON.stringify({ revision: hold.revision,
        ...(name === "resume-step" ? { step: Number(nextSteps[hold.id]) } : {}),
        ...(name === "binding" ? { binding: { version: 1, browser: { browserId: tab!.browserId, tabId: tab!.tabId }, origin: tab!.origin, accountMarker: draft.accountMarker.trim(), readyMarker: draft.readyMarker.trim() } } : {}),
      }) }, { timeoutMs: 90_000 });
      if (!mounted.current || actionId !== actionEpoch.current) return;
      if (name === "tabs") setTabs(old => ({ ...old, [hold.id]: result.tabs }));
      if (name === "binding") setEditing(old => ({ ...old, [hold.id]: false }));
      await refresh();
    }
    catch (cause) { if (mounted.current && actionId === actionEpoch.current) { setError(cause instanceof Error ? cause.message : "This action could not be confirmed. Reload the request."); await refresh().catch(() => {}); } }
    finally { if (actionId === actionEpoch.current) { changing.current = false; if (mounted.current) setBusy(false); } }
  };
  const visible = holds.filter(hold => hold.value.state !== "closed");
  if (!visible.length) return null;
  return <aside className="max-h-[65vh] overflow-y-auto sm:max-h-[45vh] border-b border-line bg-sheet px-4 py-3" aria-label="Sign-in handovers">
    {visible.map(hold => <HandoffCard key={hold.id} hold={hold} busy={busy} connected={state.connected} editing={Boolean(editing[hold.id])} tabs={tabs[hold.id]} draft={bindings[hold.id]} nextStep={nextSteps[hold.id]}
      onAction={name => void action(hold, name)}
      onToggleEdit={() => setEditing(old => ({ ...old, [hold.id]: !old[hold.id] }))}
      onDraft={patch => setBindings(old => ({ ...old, [hold.id]: { ...(old[hold.id] ?? EMPTY_DRAFT), ...patch } }))}
      onNextStep={value => setNextSteps(old => ({ ...old, [hold.id]: value }))} />)}
    {busy && <p role="status" className="text-sm">Waiting for confirmed computer state…</p>}{(error || refreshError) && <p role="alert" className="text-sm text-hold">{error || refreshError}</p>}
  </aside>;
}

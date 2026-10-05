// "Refresh from REI": Bud reads the office's REI Tenants or Suppliers list in
// the work browser and shows what it found; nothing is saved until Save.
// Server: server/rei-directory-sync.ts (/api/rei-directory/*). The server
// decides every step; this panel shows its state and sends the person's answers.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { BrowserSignInStrip, useBrowserSignIns } from "./BrowserSignInStrip";

export type ReiDirectoryKind = "tenants" | "suppliers";
interface Preview {
  file: { name: string; size: number; sha256: string }; rows: number; footer: number | null; countMatches: boolean | null;
  accepted: number; rejected: Array<{ row: number; reason: string }>; withoutEmail?: number;
  added: number; removed: number; changed: number; unchanged: boolean; baseRevision: number;
}
interface RunView {
  id: string; kind: ReiDirectoryKind; phase: "working" | "preview" | "saved" | "stopped" | "failed"; working: boolean; message: string | null;
  ask: { requestId: string; tool: string; summary: string } | null; signIn: string | null; preview: Preview | null;
}
type Saved = { revision: number; count: number; savedAt: number | null };
export interface ReiDirectoryStatus { account: string | null; tenants: Saved; suppliers: Saved; run: RunView | null }

const control = "min-h-11 rounded border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency";
const NOUN: Record<ReiDirectoryKind, { list: string; one: string; many: string }> = {
  tenants: { list: "tenant list", one: "tenant", many: "tenants" }, suppliers: { list: "supplier list", one: "supplier", many: "suppliers" },
};
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A malformed reply is an error, never a state. */
export function parseReiDirectoryStatus(value: unknown): ReiDirectoryStatus {
  const v = value as ReiDirectoryStatus;
  const saved = (s: Saved) => !!s && Number.isSafeInteger(s.revision) && Number.isSafeInteger(s.count);
  if (!v || typeof v !== "object" || !saved(v.tenants) || !saved(v.suppliers) || (v.run !== null && (typeof v.run?.id !== "string" || !["tenants", "suppliers"].includes(v.run.kind)))) {
    throw new Error("The REI refresh sent details this app cannot read.");
  }
  return v;
}

export function ReiDirectoryRefresh({ kind, onSaved }: { kind: ReiDirectoryKind; onSaved?: (status: ReiDirectoryStatus) => void }) {
  const [status, setStatus] = useState<ReiDirectoryStatus | null>(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
  const noun = NOUN[kind], mounted = useRef(true), saved = useRef(onSaved);
  saved.current = onSaved;
  const run = status?.run?.kind === kind ? status.run : null, other = status?.run && status.run.kind !== kind && status.run.working;
  const signIns = useBrowserSignIns({ threadId: run?.signIn ?? "", busy: Boolean(run?.working), enabled: Boolean(run?.signIn) });
  const show = useCallback((value: unknown) => { const next = parseReiDirectoryStatus(value); if (mounted.current) setStatus(next); return next; }, []);
  useEffect(() => {
    mounted.current = true;
    void api("/api/rei-directory/status").then(show).catch(() => { if (mounted.current) setFailure("The REI refresh could not be loaded."); });
    return () => { mounted.current = false; };
  }, [show]);
  // Poll while Bud works, waits for an answer or for sign-in.
  useEffect(() => {
    if (!status?.run?.working) return;
    const timer = setTimeout(() => void api("/api/rei-directory/status").then(show).catch(() => {}), 1000);
    return () => clearTimeout(timer);
  }, [status, show]);
  const post = (path: string, body: unknown) => {
    setBusy(true); setFailure("");
    return api(path, { method: "POST", body: JSON.stringify(body) }).then(show)
      .catch(cause => { if (mounted.current) setFailure(typeof (cause as { status?: unknown })?.status === "number" ? (cause as Error).message : "RealBud could not confirm this. Refresh to check before trying again."); return null; })
      .finally(() => { if (mounted.current) setBusy(false); });
  };
  const at = run ? `/api/rei-directory/runs/${run.id}` : "";
  const savedList = status?.[kind];
  const preview = run?.phase === "preview" ? run.preview : null;
  const askHeadline = (tool: string) => tool === "browser_download" ? `Allow Bud to download REI's ${noun.list}?` : tool === "browser_select" ? "Allow Bud to choose Export Only on REI's report?" : "Allow this step in REI?";

  return <section aria-label={`Refresh ${noun.list} from REI`} className="space-y-2 rounded-lg border border-line p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={`${control} font-medium`} disabled={busy || !status || Boolean(run?.working) || Boolean(other) || !status.account}
        aria-label={`Refresh ${noun.list} from REI`} onClick={() => void post("/api/rei-directory/runs", { kind })}>Refresh from REI</button>
      <span className="text-[13px] text-ink-secondary">{!status ? "" : !status.account ? "Set up bank imports first so Bud knows which REI business to read."
        : savedList?.count ? `Saved: ${count(savedList.count, noun.one, noun.many)}${savedList.savedAt ? ` · ${new Date(savedList.savedAt).toLocaleDateString()}` : ""}` : `No ${noun.list} saved from REI yet.`}</span>
    </div>
    {other && <p className="text-[13px] text-ink-secondary">Bud is refreshing the other list from REI. Wait for it to finish.</p>}
    {run?.working && !run.ask && !run.signIn && <div role="status" className="flex flex-wrap items-center gap-2"><p className="flex-1">Bud is reading REI's {noun.list}… Nothing in REI changes.</p>
      <button type="button" className={control} disabled={busy} onClick={() => void post(`${at}/stop`, {})}>Stop</button></div>}
    {run?.signIn && <p role="status">Waiting for you to sign in to REI Cloud. Bud carries on by itself once you're signed in; it never types your password.</p>}
    {run && signIns.handovers.map(handover => <BrowserSignInStrip key={handover.id} handover={handover} busy={signIns.acting === handover.id}
      error={signIns.error?.id === handover.id ? signIns.error.text : null} onDone={() => void signIns.act(handover.id, "done")} onStop={() => void signIns.act(handover.id, "stop")} />)}
    {run?.ask && <div role="group" aria-label="Approval for REI" className="space-y-2 rounded-lg border border-portal/40 p-2">
      <p className="font-medium">{askHeadline(run.ask.tool)}</p>
      <p className="text-ink-secondary break-words">{run.ask.summary}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${control} border-agency font-medium`} disabled={busy} onClick={() => void post(`${at}/answer`, { requestId: run.ask!.requestId, allowed: true })}>Allow</button>
        <button type="button" className={control} disabled={busy} onClick={() => void post(`${at}/answer`, { requestId: run.ask!.requestId, allowed: false })}>Don't allow</button>
        <button type="button" className={control} disabled={busy} onClick={() => void post(`${at}/stop`, {})}>Stop</button>
      </div>
    </div>}
    {preview && <div role="group" aria-label={`REI ${noun.list} preview`} className="space-y-2 rounded-lg border border-line p-2">
      <p className="font-medium">{count(preview.accepted, noun.one, noun.many)} ready to save{preview.rejected.length ? ` · ${preview.rejected.length} skipped` : ""}{preview.withoutEmail ? ` · ${preview.withoutEmail} without email` : ""}</p>
      <p className={preview.countMatches === false ? "text-hold" : "text-ink-secondary"}>{preview.rows} rows in REI's export{preview.footer === null ? " · REI's record count was not readable" : preview.countMatches ? ` · matches the ${preview.footer} records REI lists` : ` · REI lists ${preview.footer} records`}</p>
      <p className="text-ink-secondary">{preview.unchanged ? "No changes since the last save." : `${preview.added} new · ${preview.removed} removed · ${preview.changed} changed`}</p>
      {preview.rejected.length > 0 && <details><summary className="min-h-11 cursor-pointer">Skipped rows · {preview.rejected.length}</summary>
        <ul className="list-disc pl-5">{preview.rejected.map((item, index) => <li key={index} className="break-words">{item.reason}</li>)}</ul></details>}
      <p className="text-[12px] text-ink-muted break-all">File {preview.file.name} · sha256 {preview.file.sha256.slice(0, 16)}…</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${control} border-agency font-medium`} disabled={busy || preview.countMatches === false}
          onClick={() => void post(`${at}/save`, { expectedRevision: preview.baseRevision }).then(next => { if (next) saved.current?.(next); })}>{preview.unchanged ? "Confirm" : `Save ${noun.list}`}</button>
        <button type="button" className={control} disabled={busy} onClick={() => void post(`${at}/stop`, {})}>Discard</button>
      </div>
    </div>}
    {run?.message && <p role={run.phase === "failed" ? "alert" : "status"} className={run.phase === "failed" || preview?.countMatches === false ? "text-hold break-words" : "text-ink-secondary break-words"}>{run.message}</p>}
    {failure && <p role="alert" className="text-hold break-words">{failure}</p>}
  </section>;
}

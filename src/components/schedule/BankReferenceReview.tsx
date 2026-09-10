import { useEffect, useState } from "react";
import { api } from "@/state/store";

const request = <T,>(method: string, path: string, body?: unknown): Promise<T> => api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

type Row = { id: string; date: string; amount: string; narrative: string; reference: string; candidates: string[]; issues: string[] };
type Rule = { propertyId: string; reference: string; aliases: string[] };
type Decision = { rowId: string; action: "assign" | "keep"; propertyId?: string; reason: string };
type Saved = { id: string; revision: number; value: { batch: { rows: Row[]; input: { rules: Rule[] }; originalDigest: string }; result?: { changes: unknown[]; outputDigest: string } } };
const control = "rounded border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:opacity-50";

export function BankReferenceReview() {
  const [csv, setCsv] = useState("");
  const [mapping, setMapping] = useState({ date: "", amount: "", narrative: "", reference: "" });
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
  const [directory, setDirectory] = useState("");
  const [page, setPage] = useState(0);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [history, setHistory] = useState<{ id: string; createdAt: number; rows: number; reviewedAt?: number }[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const refresh = async () => setHistory((await request<{ batches: typeof history }>("GET", "/api/bank-reference")).batches);
  useEffect(() => {
    let cancelled = false;
    void request<{ settings: { columns: typeof mapping; dateFormat: string; rules: Rule[] } | null }>("GET", "/api/bank-reference/settings").then(({ settings }) => {
      if (cancelled || !settings) return;
      setMapping(current => Object.values(current).some(Boolean) ? current : settings.columns);
      setDateFormat(settings.dateFormat);
      setDirectory(current => current || settings.rules.map(rule => `${rule.propertyId} | ${rule.reference} | ${rule.aliases.join("; ")}`).join("\n"));
    }).catch(() => { if (!cancelled) setError("The saved bank mapping could not be loaded. Check it before preparing another export."); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { void refresh().catch(() => setError("Bank reviews could not be loaded. Reload before starting another batch.")); }, []);
  const perform = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (cause) { setError(cause instanceof Error ? cause.message : "This review could not be saved. Reload it before continuing."); }
    finally { setBusy(false); }
  };
  const open = async (id: string) => { setSaved(await request<Saved>("GET", `/api/bank-reference/${id}`)); setDecisions({}); setPage(0); };
  const download = async (original: boolean) => {
    if (!saved) return;
    const result = await request<{ csv: string; digest: string }>("POST", `/api/bank-reference/${saved.id}/${original ? "original" : "export"}`, {});
    const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${original ? "bank-original" : "REI-review-copy"}-${result.digest.slice(0, 12)}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="rounded-xl border border-line bg-sheet p-4 space-y-4" aria-labelledby="bank-review-title">
    <div><h2 id="bank-review-title" className="font-medium text-ink">Prepare bank references</h2>
      <p className="mt-1 text-sm text-ink-secondary">Review the daily bank export, match incoming payments to property references, then download a checked copy for REI Cloud.</p>
      <p className="mt-1 text-xs text-ink-muted">The last bank mapping and property references are reused for the next file. Original dates, amounts and order stay intact. Bank download scheduling needs your bank connection calibrated first.</p></div>
    <details><summary className="cursor-pointer text-sm">Prepare a new export</summary><div className="mt-3 space-y-3">
      <label className="block text-sm">Bank CSV <input className={`block mt-1 ${control}`} type="file" accept=".csv,text/csv" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 750000) { setError("Choose a CSV smaller than 750 KB."); return; } void file.text().then(setCsv).catch(() => setError("The file could not be read.")); }} /></label>
      <p className="text-xs text-ink-muted">Enter the exact header names from the export. Amount must be one signed decimal column, such as 1250.00 or -24.50.</p>
      <div className="grid gap-2 sm:grid-cols-2">{Object.keys(mapping).map(key => <label key={key} className="text-sm capitalize">{key} column<input className={`block w-full mt-1 ${control}`} value={mapping[key as keyof typeof mapping]} onChange={e => setMapping({ ...mapping, [key]: e.target.value })} /></label>)}</div>
      <label className="block text-sm">Date format <select aria-label="Date format" className={control} value={dateFormat} onChange={e => setDateFormat(e.target.value)}><option>DD/MM/YYYY</option><option>YYYY-MM-DD</option></select></label>
      <label className="block text-sm">Property reference directory<textarea className={`block w-full mt-1 ${control}`} rows={4} value={directory} onChange={e => setDirectory(e.target.value)} placeholder={"Property name | reference number | payer alias; another alias"} /></label>
      <p className="text-xs text-ink-muted">One property per line. Use the exact reference from your property records. Matches are suggestions for your review.</p>
      <button className={control} disabled={busy || !csv || !directory.trim()} onClick={() => void perform(async () => {
        const rules = directory.split(/\r?\n/).filter(line => line.trim()).map(line => { const [propertyId, reference, aliases, extra] = line.split("|").map(s => s.trim()); if (!propertyId || !reference || !aliases || extra !== undefined) throw new Error("Use property | reference | payer aliases for each directory line."); return { propertyId, reference, aliases: aliases.split(";").map(s => s.trim()).filter(Boolean) }; });
        setSaved(await request<Saved>("POST", "/api/bank-reference", { csv, columns: mapping, dateFormat, rules })); setDecisions({}); setPage(0); await refresh();
      })}>Prepare review</button>
    </div></details>
    {history.length > 0 && <label className="block text-sm">Saved reviews <select aria-label="Saved reviews" className={`max-w-full ${control}`} value={saved?.id ?? ""} onChange={e => e.target.value && void perform(() => open(e.target.value))}><option value="">Choose a review…</option>{history.map(item => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.rows} rows · {item.reviewedAt ? "reviewed" : "needs review"}</option>)}</select></label>}
    {saved && <div className="space-y-3">
      <p className="text-sm">{saved.value.batch.rows.length} transactions · {saved.value.result ? `${saved.value.result.changes.length} reviewed reference changes` : "Review every row, including anything kept unchanged."}</p>
      {!saved.value.result && <div className="max-h-[32rem] overflow-auto space-y-3">{saved.value.batch.rows.slice(page * 20, (page + 1) * 20).map(row => <article className="rounded-lg border border-line p-3 space-y-2" key={row.id}>
        <p className="text-sm font-medium">{row.date} · {row.amount} · {row.narrative}</p><p className="text-xs">Current reference: {row.reference || "empty"} · Suggested property: {row.candidates.join(", ") || "needs review"}</p>
        {row.issues.length > 0 && <p className="text-xs text-hold">{row.issues.join(" ")}</p>}
        <label className="block text-xs">Your decision <select aria-label="Your decision" className={`block mt-1 max-w-full ${control}`} value={decisions[row.id]?.action === "keep" ? "keep" : decisions[row.id]?.propertyId ?? ""} onChange={e => { const choice = e.target.value; setDecisions(current => ({ ...current, [row.id]: { rowId: row.id, action: choice === "keep" ? "keep" : "assign", ...(choice === "keep" ? {} : { propertyId: choice }), reason: current[row.id]?.reason ?? "" } })); }}><option value="">Review this row…</option><option value="keep">Keep original reference</option>{saved.value.batch.input.rules.map(rule => <option key={rule.propertyId} value={rule.propertyId}>{rule.propertyId} → {rule.reference}</option>)}</select></label>
        <label className="block text-xs">Review reason<input className={`block mt-1 w-full ${control}`} maxLength={500} value={decisions[row.id]?.reason ?? ""} placeholder="How did you confirm this payment?" onChange={e => setDecisions(current => ({ ...current, [row.id]: { ...(current[row.id] ?? { rowId: row.id, action: "assign" as const }), reason: e.target.value } }))} /></label>
      </article>)}</div>}
      {!saved.value.result && saved.value.batch.rows.length > 20 && <div className="flex flex-wrap items-center gap-2 text-sm"><button className={control} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous rows</button><span>Rows {page * 20 + 1}–{Math.min((page + 1) * 20, saved.value.batch.rows.length)} of {saved.value.batch.rows.length}</span><button className={control} disabled={(page + 1) * 20 >= saved.value.batch.rows.length} onClick={() => setPage(page + 1)}>Next rows</button></div>}
      <div className="flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={() => void perform(() => download(true))}>Download original</button>
        {saved.value.result ? <button className={control} disabled={busy} onClick={() => void perform(() => download(false))}>Download reviewed REI copy</button> : <button className={control} disabled={busy || saved.value.batch.rows.some(row => !decisions[row.id]?.reason.trim() || (decisions[row.id]?.action === "assign" && !decisions[row.id]?.propertyId))} onClick={() => void perform(async () => { setSaved(await request<Saved>("POST", `/api/bank-reference/${saved.id}/review`, { revision: saved.revision, decisions: Object.values(decisions) })); await refresh(); })}>Save reviewed copy</button>}
        <button className={control} disabled={busy} onClick={() => void perform(() => open(saved.id))}>Reload saved review</button></div>
      <p className="text-xs text-ink-muted">Check the import preview and reconcile the total in REI Cloud before accepting receipts. A repeated source download opens this same review.</p>
    </div>}
    {busy && <p role="status" className="text-sm">Saving or loading review…</p>}{error && <p role="alert" className="text-sm text-hold">{error}</p>}
  </section>;
}

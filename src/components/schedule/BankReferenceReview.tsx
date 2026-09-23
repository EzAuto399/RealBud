import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { bankDownloadBytes, readBankFile } from "@/lib/bank-file";
import { appendBankHistory, bankHistoryUrl, hasUnsavedBankDecisions, parseBankHistory } from "@/lib/bank-history";
import type { BankHistoryPage } from "../../../shared/bank-reference-history";
import type { BankDownloadArtifact, BankSourceArtifact, BankSourceUpload } from "../../../shared/bank-source";
import type { AgencySetupView } from "../../../shared/agency-setup";
import { bankReviewVersion, type BankReviewAmendment as Amendment, type BankReviewSuccessor } from '../../../shared/bank-review';
import { BankReviewAmendment } from './BankReviewAmendment';
import { NAVIGATION_CANCELLED, registerNavigationGuard } from '@/lib/navigation-guard';

const request = <T,>(method: string, path: string, body?: unknown): Promise<T> => api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

type Row = { id: string; date: string; amount: string; narrative: string; reference: string; candidates: string[]; issues: string[] };
type Rule = { propertyId: string; reference: string; aliases: string[] };
type Decision = { rowId: string; action: "assign" | "keep"; propertyId?: string; reason: string };
type Saved = { id: string; revision: number; value: { batch: { version: 1 | 2; source?: BankSourceArtifact; rows: Row[]; input: { columns: {date:string;amount:string;narrative:string;reference:string}; dateFormat:string; rules: Rule[] }; originalDigest: string }; result?: { changes: unknown[]; outputDigest: string }; decisions?: Decision[]; amends?:Amendment; supersededBy?:BankReviewSuccessor } };
const control = "min-h-11 rounded border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency";

export function BankReferenceReview() {
  const [source, setSource] = useState<BankSourceUpload | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const fileRead = useRef(0);
  const [mapping, setMapping] = useState({ date: "", amount: "", narrative: "", reference: "" });
  const settingsDirty = useRef(false);
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
  const [directory, setDirectory] = useState("");
  const [page, setPage] = useState(0);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [history, setHistory] = useState<BankHistoryPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true), [historyError, setHistoryError] = useState("");
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [discardConfirm, setDiscardConfirm] = useState(false), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [amending,setAmending] = useState(false);
  const mounted = useRef(true), historyGeneration = useRef(0), pending = useRef(false);
  const decisionDraft = Boolean(saved && !saved.value.result && hasUnsavedBankDecisions(decisions));
  const unsaved = decisionDraft || amending;
  const preparation = { source, mapping, dateFormat, directory };
  const savedPreparation = useRef<typeof preparation | null>(null);
  const samePreparation = savedPreparation.current && source === savedPreparation.current.source &&
    dateFormat === savedPreparation.current.dateFormat && directory === savedPreparation.current.directory &&
    (Object.keys(mapping) as Array<keyof typeof mapping>).every(key => mapping[key] === savedPreparation.current!.mapping[key]);
  const unfinished = useRef(false), reading = useRef(false);
  unfinished.current = unsaved || Boolean((source || settingsDirty.current) && !samePreparation);
  reading.current = readingFile;
  // This lazy card may mount before App mirrors its door into the address bar.
  const stayingUrl = useRef(typeof location === 'undefined' ? '' : `${location.pathname}${location.search}#/schedule`);
  useEffect(() => {
    const remove = registerNavigationGuard(() => {
      if (!unfinished.current && !reading.current && !pending.current) return true;
      if (reading.current || pending.current) {
        setError('Wait for the bank file or current operation to finish before leaving. Your work is kept here.');
      } else if (window.confirm('Leave Bank review and discard its unsaved file selection, column mapping, property references and transaction decisions? Original bank files and saved reviews are kept.')) return true;
      // Hash/Back navigation has already changed the address before dispatch.
      window.history.replaceState(window.history.state, '', stayingUrl.current);
      window.dispatchEvent(new Event(NAVIGATION_CANCELLED));
      return false;
    });
    const warn = (event: BeforeUnloadEvent) => {
      if (!unfinished.current && !reading.current && !pending.current) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { remove(); window.removeEventListener('beforeunload', warn); };
  }, []);
  const refresh = async (cursor?: string) => {
    const current = ++historyGeneration.current, previous = history;
    setHistoryLoading(true); setHistoryError("");
    try {
      const next = parseBankHistory(await request<unknown>("GET", bankHistoryUrl(cursor)));
      if (!mounted.current || current !== historyGeneration.current) return;
      if (cursor && !previous) throw new Error('Refresh history before loading more reviews.');
      setHistory(cursor ? appendBankHistory(previous!, next, cursor) : next);
    } catch (cause) {
      if (mounted.current && current === historyGeneration.current) setHistoryError(cause instanceof Error ? cause.message : 'Bank history could not be loaded. Your open review and decisions are kept.');
    } finally { if (mounted.current && current === historyGeneration.current) setHistoryLoading(false); }
  };
  useEffect(() => {
    let cancelled = false;
    void request<{ settings: { columns: typeof mapping; dateFormat: string; rules: Rule[] } | null }>("GET", "/api/bank-reference/settings").then(({ settings }) => {
      if (cancelled || !settings || settingsDirty.current) return;
      setMapping(current => Object.values(current).some(Boolean) ? current : settings.columns);
      setDateFormat(settings.dateFormat);
      setDirectory(current => current || settings.rules.map(rule => `${rule.propertyId} | ${rule.reference} | ${rule.aliases.join("; ")}`).join("\n"));
    }).catch(() => { if (!cancelled) setError("The saved bank mapping could not be loaded. Check it before preparing another export."); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; historyGeneration.current++; fileRead.current++; }; }, []);
  const perform = async (fn: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "This review could not be saved. Your open review and decisions are kept."); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const open = async (id: string) => {
    if (unsaved) return;
    const result = await request<Saved>("GET", `/api/bank-reference/${id}`);
    if (result.id !== id) throw new Error('The saved review does not match your selection. Refresh history before reopening it.');
    if (mounted.current) { setSaved(result); setDecisions({}); setDiscardConfirm(false); setPage(0); }
  };
  const download = async (original: boolean) => {
    if (!saved) return;
    const result = await request<BankDownloadArtifact>("POST", `/api/bank-reference/${saved.id}/${original ? "original" : "export"}`, {});
    const bytes = await bankDownloadBytes(result);
    const url = URL.createObjectURL(new Blob([bytes], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = result.filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="rounded-xl border border-line bg-sheet p-4 space-y-4" aria-labelledby="bank-review-title">
    <div><h2 id="bank-review-title" className="font-medium text-ink">Prepare bank references</h2>
      <p className="mt-1 text-sm text-ink-secondary">Review the daily bank export, match incoming payments to property references, then download a checked CSV copy.</p>
      <p className="mt-1 text-xs text-ink-muted">The last bank mapping and property references are reused for the next file. Original dates, amounts and order stay intact. Bank download scheduling needs your bank connection calibrated first.</p></div>
    <details><summary className="cursor-pointer text-sm">Prepare a new export</summary><div className="mt-3 space-y-3">
      <label className="block text-sm">Bank CSV <input className={`block mt-1 ${control}`} type="file" accept=".csv,text/csv" disabled={busy || unsaved} onChange={e => {
        const currentRead = ++fileRead.current, file = e.target.files?.[0];
        reading.current = Boolean(file);
        setSource(null); setError(""); setReadingFile(Boolean(file));
        if (!file) return;
        void readBankFile(file).then(value => { if (mounted.current && currentRead === fileRead.current) setSource(value); })
          .catch(cause => { if (mounted.current && currentRead === fileRead.current) setError(cause instanceof Error ? cause.message : "The file could not be read."); })
          .finally(() => { if (mounted.current && currentRead === fileRead.current) { reading.current = false; setReadingFile(false); } });
      }} /></label>
      <p className="text-xs text-ink-muted">UTF-8 CSV files, including a UTF-8 byte-order mark, are supported. Your original file is kept unchanged; other encodings need a new export from the bank.</p>
      {readingFile && <p role="status" className="text-xs text-ink-muted">Reading original file…</p>}
      <p className="text-xs text-ink-muted">Enter the exact header names from the export. Amount must be one signed decimal column, such as 1250.00 or -24.50.</p>
      <div className="grid gap-2 sm:grid-cols-2">{Object.keys(mapping).map(key => <label key={key} className="text-sm capitalize">{key} column<input className={`block w-full mt-1 ${control}`} value={mapping[key as keyof typeof mapping]} onChange={e => { settingsDirty.current = true; setMapping({ ...mapping, [key]: e.target.value }); }} /></label>)}</div>
      <label className="block text-sm">Date format <select aria-label="Date format" className={control} value={dateFormat} onChange={e => { settingsDirty.current = true; setDateFormat(e.target.value); }}><option>DD/MM/YYYY</option><option>YYYY-MM-DD</option></select></label>
      <button className={control} disabled={busy} onClick={() => { settingsDirty.current = true; void perform(async () => {
        const setup = await request<AgencySetupView>('GET','/api/agency-setup');
        if (!setup.workflows.find(workflow => workflow.id === 'bank-references')?.readyForRun) throw new Error('Review Bank references in Agency workflow setup before using its property directory.');
        const rules = setup.state.settings.propertyReferences;
        if (!rules.length || rules.some(rule => !rule.aliases.length)) throw new Error('Add confirmed payer aliases for each selected property in Agency workflow setup first.');
        setDirectory(rules.map(rule => `${rule.propertyId} | ${rule.reference} | ${rule.aliases.join('; ')}`).join('\n'));
        setDirectoryNotice(`${rules.length} reviewed agency references copied into this new export. Check the selected bank scope before preparing it.`);
      }); }}>Use reviewed agency references</button>
      {directoryNotice && <p role="status" className="text-sm text-ink-secondary">{directoryNotice}</p>}
      <label className="block text-sm">Property reference directory<textarea aria-label="Property reference directory" className={`block w-full mt-1 ${control}`} rows={4} value={directory} onChange={e => { settingsDirty.current = true; setDirectory(e.target.value); }} placeholder={"Property name | reference number | payer alias; another alias"} /></label>
      <p className="text-xs text-ink-muted">One property per line. Use the exact reference from your property records. Matches are suggestions for your review.</p>
      <button className={control} disabled={busy || unsaved || readingFile || !source || !directory.trim()} onClick={() => void perform(async () => {
        if (unsaved) return;
        const rules = directory.split(/\r?\n/).filter(line => line.trim()).map(line => { const [propertyId, reference, aliases, extra] = line.split("|").map(s => s.trim()); if (!propertyId || !reference || !aliases || extra !== undefined) throw new Error("Use property | reference | payer aliases for each directory line."); return { propertyId, reference, aliases: aliases.split(";").map(s => s.trim()).filter(Boolean) }; });
        const prepared = await request<Saved>("POST", "/api/bank-reference", { source, columns: mapping, dateFormat, rules });
        if (!mounted.current) return;
        savedPreparation.current = preparation;
        setSaved(prepared); setDecisions({}); setDiscardConfirm(false); setPage(0); await refresh();
      })}>Prepare review</button>
    </div></details>
    <section aria-label="Saved bank review history" className="rounded-lg border border-line p-3 space-y-3" aria-busy={historyLoading}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-sm">Saved review history</h3><button className={control} disabled={historyLoading} onClick={() => void refresh()}>Refresh bank history</button></div>
      {history && <p className="text-sm text-ink-secondary">{history.batches.length} of {history.total} saved reviews loaded. Refresh includes newer imports; your open review and unsaved decisions stay here.</p>}
      {(Boolean(history?.batches.length) || saved) && <label className="block text-sm">Saved reviews <select aria-label="Saved reviews" className={`mt-1 block w-full ${control}`} disabled={busy || unsaved} value={saved?.id ?? ""} onChange={e => e.target.value && void perform(() => open(e.target.value))}><option value="">Choose a review…</option>{saved && !history?.batches.some(item => item.id === saved.id) && <option value={saved.id}>Currently open review · outside loaded history</option>}{history?.batches.map(item => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString()} · version {bankReviewVersion(item.id)} · {item.rows} rows · {item.supersededBy ? 'earlier version' : item.outputDigest ? "reviewed" : "needs review"}</option>)}</select></label>}
      {history?.total === 0 && <p className="text-sm text-ink-secondary">No saved bank reviews yet.</p>}
      {history?.nextCursor && <button className={control} disabled={historyLoading} onClick={() => void refresh(history.nextCursor!)}>Load more bank reviews</button>}
      {historyLoading && <p role="status" className="text-sm">Checking saved bank history…</p>}
      {historyError && <p role="alert" className="text-sm text-hold">{historyError} Previously loaded history, your open review and unsaved decisions are kept. Use Refresh bank history to try again.</p>}
    </section>
    {decisionDraft && <section aria-label="Unsaved bank decisions" className="rounded-lg border border-hold p-3 space-y-2 text-sm">
      <p>Your transaction decisions are not saved yet. Finish and save this review, or discard these decisions before choosing another review, reloading it or importing another file. You can still refresh or load more history.</p>
      {!discardConfirm ? <button className={control} disabled={busy} onClick={() => setDiscardConfirm(true)}>Review unsaved decisions discard</button> : <div role="group" aria-label="Discard unsaved bank decisions" className="space-y-2">
        <p>Discard only the decisions and reasons entered in this open review? The original export and any previously saved reviewed copy stay intact.</p>
        <div className="flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={() => { setDecisions({}); setDiscardConfirm(false); setNotice('Unsaved decisions discarded. Your original export and saved history are unchanged.'); }}>Discard unsaved bank decisions</button><button className={control} disabled={busy} onClick={() => setDiscardConfirm(false)}>Keep editing this review</button></div>
      </div>}
    </section>}
    {saved && <div className="space-y-3">
      <p className="text-sm font-medium">Review version {bankReviewVersion(saved.id)}</p>
      {saved.value.supersededBy && <div role="note" className="rounded-lg border border-hold p-3 text-sm space-y-2"><p>This is an earlier version. Its saved files remain available for reconciliation.</p><button className={control} disabled={busy || unsaved} onClick={()=>void perform(()=>open(saved.value.supersededBy!.id))}>Open newer review</button></div>}
      {saved.value.amends && <div className="text-sm space-y-2"><p>Correction: {saved.value.amends.reason}</p><button className={control} disabled={busy || unsaved} onClick={()=>void perform(()=>open(saved.value.amends!.id))}>Open previous review</button></div>}
      {saved.value.batch.version === 2 && saved.value.batch.source
        ? <p className="text-xs text-ink-muted">Original: {saved.value.batch.source.filename} · {saved.value.batch.source.byteLength.toLocaleString()} bytes · {saved.value.batch.source.encoding === "utf-8-bom" ? "UTF-8 with byte-order mark" : "UTF-8"}. Downloads are checked against the saved file digest.</p>
        : <p role="note" className="text-xs text-hold">This older review saved text only. The original file bytes and encoding were not captured. The saved text remains available, but check it against your original bank export before use.</p>}
      <p className="text-sm">{saved.value.batch.rows.length} transactions · {saved.value.result ? `${saved.value.result.changes.length} reviewed reference changes` : "Review every row, including anything kept unchanged."}</p>
      {!saved.value.result && !saved.value.supersededBy && !amending && <div className="max-h-[32rem] overflow-auto space-y-3">{saved.value.batch.rows.slice(page * 20, (page + 1) * 20).map(row => <article className="rounded-lg border border-line p-3 space-y-2" key={row.id}>
        <p className="text-sm font-medium break-words">{row.date} · {row.amount} · {row.narrative}</p><p className="text-xs break-words">Current reference: {row.reference || "empty"} · Suggested property: {row.candidates.join(", ") || "needs review"}</p>
        {row.issues.length > 0 && <p className="text-xs text-hold">{row.issues.join(" ")}</p>}
        <label className="block text-xs">Your decision <select aria-label="Your decision" disabled={busy} className={`block mt-1 max-w-full ${control}`} value={decisions[row.id]?.action === "keep" ? "keep" : decisions[row.id]?.propertyId ?? ""} onChange={e => { const choice = e.target.value; setDecisions(current => ({ ...current, [row.id]: { rowId: row.id, action: choice === "keep" ? "keep" : "assign", ...(choice === "keep" ? {} : { propertyId: choice }), reason: current[row.id]?.reason ?? "" } })); }}><option value="">Review this row…</option><option value="keep">Keep original reference</option>{saved.value.batch.input.rules.map(rule => <option key={rule.propertyId} value={rule.propertyId}>{rule.propertyId} → {rule.reference}</option>)}</select></label>
        <label className="block text-xs">Review reason<input className={`block mt-1 w-full ${control}`} maxLength={500} disabled={busy} value={decisions[row.id]?.reason ?? ""} placeholder="How did you confirm this payment?" onChange={e => setDecisions(current => ({ ...current, [row.id]: { ...(current[row.id] ?? { rowId: row.id, action: "assign" as const }), reason: e.target.value } }))} /></label>
      </article>)}</div>}
      {saved.value.decisions && <details><summary className="cursor-pointer text-sm">Saved transaction decisions</summary><div className="mt-2 space-y-2">{saved.value.decisions.slice(page*20,(page+1)*20).map(decision=><p key={decision.rowId} className="text-sm break-words">Transaction {saved.value.batch.rows.findIndex(row=>row.id===decision.rowId)+1}: {decision.action === 'keep' ? 'Kept original reference' : `Assigned to ${decision.propertyId}`} · {decision.reason}</p>)}</div></details>}
      {saved.value.result && !saved.value.decisions && <p role="note" className="text-xs text-hold">This older review retained reasons for changed references only. It did not save a complete record of unchanged-row decisions.</p>}
      {!amending && saved.value.batch.rows.length > 20 && <div className="flex flex-wrap items-center gap-2 text-sm"><button className={control} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous rows</button><span>Rows {page * 20 + 1}–{Math.min((page + 1) * 20, saved.value.batch.rows.length)} of {saved.value.batch.rows.length}</span><button className={control} disabled={(page + 1) * 20 >= saved.value.batch.rows.length} onClick={() => setPage(page + 1)}>Next rows</button></div>}
      <div className="flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={() => void perform(() => download(true))}>{saved.value.batch.version === 2 ? "Download original" : "Download saved text"}</button>
        {saved.value.result ? <button className={control} disabled={busy} onClick={() => void perform(() => download(false))}>{saved.value.supersededBy ? 'Download earlier reviewed copy' : 'Download reviewed REI copy'}</button> : !saved.value.supersededBy && !amending && <button className={control} disabled={busy || saved.value.batch.rows.some(row => !decisions[row.id]?.reason.trim() || (decisions[row.id]?.action === "assign" && !decisions[row.id]?.propertyId))} onClick={() => void perform(async () => { const result = await request<Saved>("POST", `/api/bank-reference/${saved.id}/review`, { revision: saved.revision, decisions: Object.values(decisions) }); if (!mounted.current) return; setSaved(result); setDecisions({}); setDiscardConfirm(false); await refresh(); })}>Save reviewed copy</button>}
        {!saved.value.supersededBy && !amending && <button className={control} disabled={busy || unsaved} onClick={()=>setAmending(true)}>Correct mapping or decisions</button>}
        <button className={control} disabled={busy || unsaved} onClick={() => void perform(() => open(saved.id))}>Reload saved review</button></div>
      {amending && <BankReviewAmendment key={saved.id} mapping={saved.value.batch.input} busy={busy} onCancel={()=>setAmending(false)} onCreate={(mapping,reason)=>perform(async()=>{
        const amended = await request<Saved>('POST',`/api/bank-reference/${saved.id}/amend`,{revision:saved.revision,mapping,reason});
        if (!mounted.current) return;
        setSaved(amended); setAmending(false); setDecisions({}); setDiscardConfirm(false); setPage(0); await refresh();
      })}/>}
      <p className="text-xs text-ink-muted">Check the import preview and reconcile the total in REI Cloud before accepting receipts. A repeated source download opens its saved review; follow the newer-review link if it has been corrected.</p>
    </div>}
    {notice && <p role="status" className="text-sm text-ink-secondary">{notice}</p>}
    {busy && <p role="status" className="text-sm">Saving or loading review…</p>}{error && <p role="alert" className="text-sm text-hold">{error}</p>}
  </section>;
}

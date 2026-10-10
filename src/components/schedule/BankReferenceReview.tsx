import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { bankDownloadBytes, readBankFile } from "@/lib/bank-file";
import { appendBankHistory, bankHistoryUrl, hasUnsavedBankDecisions, parseBankHistory } from "@/lib/bank-history";
import type { BankHistoryPage } from "../../../shared/bank-reference-history";
import type { BankDownloadArtifact, BankSourceArtifact, BankSourceUpload } from "../../../shared/bank-source";
import type { AgencySetupView } from "../../../shared/agency-setup";
import { bankReviewVersion, type BankReviewAmendment as Amendment, type BankReviewSuccessor } from '../../../shared/bank-review';
import { BankReviewAmendment } from './BankReviewAmendment';
import { BrowserSignInStrip, useBrowserSignIns } from "../BrowserSignInStrip";
import { parseReiAccount, ReiDirectoryRefresh } from "../ReiDirectoryRefresh";
import { NAVIGATION_CANCELLED, registerNavigationGuard } from '@/lib/navigation-guard';
import { useRunPoll } from "@/lib/run-poll";
import { AreaStatusLine } from "../desk/AreaStatusLine";

const request = <T,>(method: string, path: string, body?: unknown): Promise<T> => api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

type Row = { id: string; date: string; amount: string; narrative: string; reference: string; candidates: string[]; issues: string[] };
type Rule = { propertyId: string; reference: string; aliases: string[]; tenant?: string };
const directoryLine = (rule: Rule) => `${rule.propertyId} | ${rule.reference} | ${rule.aliases.join("; ")}${rule.tenant ? ` | ${rule.tenant}` : ""}`;
type Decision = { rowId: string; action: "assign" | "keep" | "import" | "hold" | "exclude"; propertyId?: string; reason: string };
type Saved = { id: string; revision: number; firstPass?: FirstPass | null; value: { batch: { version: 1 | 2; source?: BankSourceArtifact; rows: Row[]; input: { columns: {date:string;amount:string;narrative:string;reference:string}; dateFormat:string; rules: Rule[] }; originalDigest: string }; result?: { changes: unknown[]; outputDigest: string }; decisions?: Decision[]; amends?:Amendment; supersededBy?:BankReviewSuccessor } };
export type FirstPassRow = { rowId: string; date: string; amount: string; payer: string; class: "matched" | "invoice" | "exception" | "not-rent"; disposition: "import" | "hold" | "exclude"; propertyId?: string; reason: string; suggestion?: string };
export type FirstPass = { layout: "anz-export" | "bank-feed"; summary: { rows: number; matched: number; invoice: number; exception: number; notRent: number; carried?: number }; rows: FirstPassRow[]; exceptions: FirstPassRow[] };
/** The server's first-pass suggestions; a malformed reply is an error, never a state. */
export function parseFirstPass(value: unknown): FirstPass | null {
  if (value === undefined || value === null) return null;
  const str = (v: unknown) => typeof v === "string", bad = (): never => { throw new Error("The first-pass suggestions could not be checked. Reload the saved review."); };
  const row = (v: unknown) => !!v && typeof v === "object" && ((r: Record<string, unknown>) => [r.rowId, r.date, r.amount, r.payer, r.reason].every(str) &&
    ["matched", "invoice", "exception", "not-rent"].includes(r.class as string) && ["import", "hold", "exclude"].includes(r.disposition as string) &&
    (r.propertyId === undefined || str(r.propertyId)) && (r.suggestion === undefined || str(r.suggestion)) && (r.disposition !== "import" || (r.class === "matched" && str(r.propertyId))))(v as Record<string, unknown>);
  const pass = value as FirstPass;
  if (typeof value !== "object" || !["anz-export", "bank-feed"].includes(pass.layout) || !pass.summary || !Array.isArray(pass.rows) || !Array.isArray(pass.exceptions) ||
      ![pass.summary.rows, pass.summary.matched, pass.summary.invoice, pass.summary.exception, pass.summary.notRent, pass.summary.carried ?? 0].every(Number.isSafeInteger) ||
      !pass.rows.every(row) || !pass.exceptions.every(row)) return bad();
  return pass;
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** Exceptions first: the person decides each one; matched rows only fill in when asked. */
export function FirstPassReview({ pass, decisions, busy, onUseAll, onDecide }: { pass: FirstPass; decisions: Record<string, Decision>; busy: boolean; onUseAll: () => void; onDecide: (row: FirstPassRow, disposition: "import" | "hold" | "exclude") => void }) {
  const { summary } = pass;
  const chosen = (rowId: string) => { const action = decisions[rowId]?.action; return action === "assign" || action === "import" ? "import" : action === "keep" || action === "hold" ? "hold" : action; };
  return <section aria-label="First pass" className="space-y-2 rounded-lg border border-line p-3">
    <p className="text-sm font-medium">{summary.matched} matched · {plural(summary.invoice, "invoice", "invoices")} · {plural(summary.exception, "exception", "exceptions")}{summary.notRent ? ` · ${summary.notRent} not rent` : ""}{summary.carried ? ` · ${summary.carried} held from an earlier pull` : ""}</p>
    <p className="text-xs text-ink-muted">Bud matched references to your property list. These are suggestions: check each exception, then save the reviewed copy. Matched references go in the last column.</p>
    <button className={control} disabled={busy} onClick={onUseAll}>Use first-pass suggestions</button>
    {pass.exceptions.length > 0 && <ul aria-label="First-pass exceptions" className="space-y-2">{pass.exceptions.map(row => <li key={row.rowId} className="rounded border border-line p-2 space-y-1">
      <p className="text-sm break-words">{row.date} · {row.amount}{row.payer ? ` · ${row.payer}` : ""}</p>
      <p className="text-xs text-hold break-words">{row.reason}</p>
      {row.suggestion && <p className="text-xs text-ink-secondary break-words">Suggestion: {row.suggestion}</p>}
      <div role="group" aria-label={`Decision for ${row.date} ${row.amount}`} className="flex flex-wrap gap-2">
        {(["import", "hold", "exclude"] as const).map(choice => <button key={choice} className={control} aria-pressed={chosen(row.rowId) === choice}
          disabled={busy || (choice === "import" && !row.propertyId)} onClick={() => onDecide(row, choice)}>{choice === "import" ? `Import${row.propertyId ? ` for ${row.propertyId}` : ""}` : choice === "hold" ? "Hold" : "Exclude"}</button>)}
      </div>
    </li>)}</ul>}
  </section>;
}
const control = "min-h-11 rounded border border-line bg-sheet px-3 py-2 text-sm text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency";

/** A first-pass choice as a review decision; hold uses "keep", the value the row picker shows. */
const firstPassDecision = (row: FirstPassRow, choice: "import" | "hold" | "exclude", reason: string): Decision =>
  choice === "import" && row.propertyId ? { rowId: row.rowId, action: "assign", propertyId: row.propertyId, reason } : { rowId: row.rowId, action: choice === "exclude" ? "exclude" : "keep", reason };

/** Bank review is operational work inside the bank job's detail, or a Desk work area
 * (`area`: its status line on top and its own scroll region). Saved review history
 * loads only when the person opens Earlier reviews. `registerCloseGuard` lets the
 * surrounding detail ask before closing over unsaved work. */
export function BankReferenceReview({ registerCloseGuard, area = false }: { registerCloseGuard?: (guard: () => boolean) => () => void; area?: boolean }) {
  const [source, setSource] = useState<BankSourceUpload | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const fileRead = useRef(0);
  const [mapping, setMapping] = useState({ date: "", amount: "", narrative: "", reference: "" });
  const settingsDirty = useRef(false);
  const [dateFormat, setDateFormat] = useState("DD/MM/YYYY");
  const [directory, setDirectory] = useState("");
  const [tenantList, setTenantList] = useState<{ filename: string; csv: string } | null>(null), tenantRead = useRef(0);
  /** Tenants in the REI tenant list saved with Refresh from REI: the default directory for every new batch. */
  const [savedTenants, setSavedTenants] = useState(0);
  useEffect(() => { void request<{ tenants?: { count?: unknown } }>("GET", "/api/rei-directory/status").then(value => { if (typeof value.tenants?.count === "number") setSavedTenants(value.tenants.count); }).catch(() => {}); }, []);
  const [page, setPage] = useState(0);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [history, setHistory] = useState<BankHistoryPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [discardConfirm, setDiscardConfirm] = useState(false), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [directoryNotice, setDirectoryNotice] = useState("");
  const [amending,setAmending] = useState(false);
  const bank = useBankAccounts();
  // Each opening re-reads the coverage: an import may have moved it since.
  const [pullOpens, setPullOpens] = useState(0);
  const mounted = useRef(true), historyGeneration = useRef(0), pending = useRef(false);
  const decisionDraft = Boolean(saved && !saved.value.result && hasUnsavedBankDecisions(decisions));
  const unsaved = decisionDraft || amending;
  const preparation = { source, mapping, dateFormat, directory, tenantList };
  const savedPreparation = useRef<typeof preparation | null>(null);
  const samePreparation = savedPreparation.current && source === savedPreparation.current.source &&
    dateFormat === savedPreparation.current.dateFormat && directory === savedPreparation.current.directory && tenantList === savedPreparation.current.tenantList &&
    (Object.keys(mapping) as Array<keyof typeof mapping>).every(key => mapping[key] === savedPreparation.current!.mapping[key]);
  const unfinished = useRef(false), reading = useRef(false);
  unfinished.current = unsaved || Boolean((source || settingsDirty.current) && !samePreparation);
  reading.current = readingFile;
  // Cancelled navigation returns to this card's door. The Schedule drawer may mount before App
  // mirrors its door into the address bar; a Desk area mounts inside Desk, so it keeps Desk's hash.
  const stayingUrl = useRef(typeof location === 'undefined' ? '' : `${location.pathname}${location.search}${area ? (location.hash.startsWith('#/desk') ? location.hash : '#/desk') : '#/schedule'}`);
  useEffect(() => {
    const removeClose = registerCloseGuard?.(() => {
      if (!unfinished.current && !reading.current && !pending.current) return true;
      if (reading.current || pending.current) {
        setError('Wait for the bank file or current operation to finish before closing. Your work is kept here.');
        return false;
      }
      return window.confirm('Close Bank review and discard its unsaved file selection, column mapping, property references and transaction decisions? Original bank files and saved reviews are kept.');
    });
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
    return () => { remove(); removeClose?.(); window.removeEventListener('beforeunload', warn); };
  }, [registerCloseGuard]);
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
      setDirectory(current => current || settings.rules.map(directoryLine).join("\n"));
    }).catch(() => { if (!cancelled) setError("The saved bank mapping could not be loaded. Check it before preparing another export."); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; historyGeneration.current++; fileRead.current++; }; }, []);
  // Saved reviews load on demand; a review just prepared or saved stays open either way.
  const refreshIfOpen = async () => { if (historyOpen || history) await refresh(); };
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
    parseFirstPass(result.firstPass);
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
  const Heading = area ? "h2" : "h3";
  return <section className={`space-y-4${area ? " min-h-0 overflow-y-auto" : ""}`} aria-labelledby="bank-review-title">
    <div><Heading id="bank-review-title" className="font-medium text-ink">Prepare bank references</Heading>
      {/* One way to start an import here: the strip's Start bank import (attended REI sign-in, asks answered in place).
          Check now would start the same run through the clock, which waits on REI sign-in until the office day ends (server/w1-host.ts). */}
      {area && <div className="mt-2"><AreaStatusLine area="bank" checkNow={false} /></div>}
      <p className="mt-1 text-sm text-ink-secondary">Review the daily bank export, match incoming payments to property references, then download a checked CSV copy.</p>
      <p className="mt-1 text-xs text-ink-muted">Pull from the bank feed or choose a bank CSV. The last bank mapping and property references are reused for the next file. Original dates, amounts and order stay intact.</p></div>
    <W1RunPanel accounts={bank.accounts} error={bank.error} onLoadAccounts={() => void bank.load()} onOpenBatch={id => perform(() => open(id))}
      reviewReady={batchId => Boolean(saved?.value.result && !saved.value.supersededBy && saved.id.split(":").slice(0, 2).join(":") === batchId.split(":").slice(0, 2).join(":"))} />
    <ReiDirectoryRefresh kind="tenants" onSaved={next => setSavedTenants(next.tenants.count)} />
    <details onToggle={event => { if (event.currentTarget.open) { setPullOpens(count => count + 1); void bank.load(); } }}><summary className="pm-control flex cursor-pointer items-center text-sm">Prepare a new export</summary><div className="mt-3 space-y-3">
      <BankPullSource key={pullOpens} accounts={bank.accounts} error={bank.error} disabled={busy || unsaved} onPulled={id => perform(async () => { await open(id); await refreshIfOpen(); })} />
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
      <p className="text-xs text-ink-muted">Enter the exact header names from the export. Amount must be one signed decimal column, such as 1250.00 or -24.50. ANZ exports without a header row are recognised automatically.</p>
      <div className="grid gap-2 sm:grid-cols-2">{Object.keys(mapping).map(key => <label key={key} className="text-sm capitalize">{key} column<input className={`block w-full mt-1 ${control}`} value={mapping[key as keyof typeof mapping]} onChange={e => { settingsDirty.current = true; setMapping({ ...mapping, [key]: e.target.value }); }} /></label>)}</div>
      <label className="block text-sm">Date format <select aria-label="Date format" className={control} value={dateFormat} onChange={e => { settingsDirty.current = true; setDateFormat(e.target.value); }}><option>DD/MM/YYYY</option><option>YYYY-MM-DD</option></select></label>
      <button className={control} disabled={busy} onClick={() => { settingsDirty.current = true; void perform(async () => {
        const setup = await request<AgencySetupView>('GET','/api/agency-setup');
        if (!setup.workflows.find(workflow => workflow.id === 'bank-references')?.readyForRun) throw new Error('Review Bank references in Agency workflow setup before using its property directory.');
        const rules = setup.state.settings.propertyReferences;
        if (!rules.length || rules.some(rule => !rule.aliases.length)) throw new Error('Add confirmed payer aliases for each selected property in Agency workflow setup first.');
        setDirectory(rules.map(rule => `${rule.propertyId} | ${rule.reference} | ${rule.aliases.join('; ')}`).join('\n'));
        setDirectoryNotice(`${plural(rules.length, "reviewed agency reference", "reviewed agency references")} copied into this new export. Check the selected bank scope before preparing it.`);
      }); }}>Use reviewed agency references</button>
      {directoryNotice && <p role="status" className="text-sm text-ink-secondary">{directoryNotice}</p>}
      <label className="block text-sm">Property reference directory<textarea aria-label="Property reference directory" className={`block w-full mt-1 ${control}`} rows={4} value={directory} onChange={e => { settingsDirty.current = true; setDirectory(e.target.value); }} placeholder={"Property name | reference number | payer alias; another alias | REI tenant"} /></label>
      <p className="text-xs text-ink-muted">One property per line. Use the exact reference from your property records, and the tenant exactly as REI names it if you import into REI. Matches are suggestions for your review.</p>
      <label className="block text-sm">REI tenant list (optional) <input className={`block mt-1 ${control}`} type="file" accept=".csv,text/csv" disabled={busy || unsaved} onChange={e => {
        const file = e.target.files?.[0], current = ++tenantRead.current;
        settingsDirty.current = true; setTenantList(null); setError("");
        if (!file) return;
        void (async () => {
          if (!file.size || file.size > 750_000) throw new Error("Choose a tenant list CSV smaller than 750 KB.");
          try { return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
          catch { throw new Error("The tenant list is not a UTF-8 CSV. Export it again from REI's Tenants page."); }
        })().then(csv => { if (mounted.current && current === tenantRead.current) setTenantList({ filename: file.name, csv }); })
          .catch(cause => { if (mounted.current && current === tenantRead.current) setError(cause instanceof Error ? cause.message : "The tenant list could not be read."); });
      }} /></label>
      <p className="text-xs text-ink-muted">{tenantList ? `Using ${tenantList.filename}: each tenant's REI reference goes in the last column. Directory lines above fill in properties it does not list.` : savedTenants ? `Using the REI tenant list saved from REI (${plural(savedTenants, "tenant", "tenants")}): each tenant's REI reference goes in the last column. Choose a file only to use a different list.` : "Export Tenants from REI to put each tenant's REI reference in the last column and check payments against the rent."}</p>
      <button className={control} disabled={busy || unsaved || readingFile || !source || (!directory.trim() && !tenantList && !savedTenants)} onClick={() => void perform(async () => {
        if (unsaved) return;
        const rules = directory.split(/\r?\n/).filter(line => line.trim()).map(line => { const [propertyId, reference, aliases, tenant, extra] = line.split("|").map(s => s.trim()); if (!propertyId || !reference || !aliases || tenant === "" || extra !== undefined) throw new Error("Use property | reference | payer aliases | REI tenant (optional) for each directory line."); return { propertyId, reference, aliases: aliases.split(";").map(s => s.trim()).filter(Boolean), ...(tenant ? { tenant } : {}) }; });
        const prepared = await request<Saved>("POST", "/api/bank-reference", { source, columns: mapping, dateFormat, rules, ...(tenantList ? { tenantList: tenantList.csv } : {}) });
        parseFirstPass(prepared.firstPass);
        if (!mounted.current) return;
        savedPreparation.current = preparation;
        setSaved(prepared); setDecisions({}); setDiscardConfirm(false); setPage(0); await refreshIfOpen();
      })}>Prepare review</button>
    </div></details>
    <details className="border-t border-line pt-2" onToggle={event => { const open = event.currentTarget.open; setHistoryOpen(open); if (open && !history && !historyLoading) void refresh(); }}>
    <summary className="pm-control flex cursor-pointer items-center text-sm font-medium">Earlier reviews</summary>
    <section aria-label="Saved bank review history" className="mt-2 space-y-3" aria-busy={historyLoading}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium text-sm">Saved review history</h4><button className={control} disabled={historyLoading} onClick={() => void refresh()}>Refresh bank history</button></div>
      {history && <p className="text-sm text-ink-secondary">{history.batches.length} of {history.total} saved reviews loaded. Refresh includes newer imports; your open review and unsaved decisions stay here.</p>}
      {(Boolean(history?.batches.length) || saved) && <label className="block text-sm">Saved reviews <select aria-label="Saved reviews" className={`mt-1 block w-full ${control}`} disabled={busy || unsaved} value={saved?.id ?? ""} onChange={e => e.target.value && void perform(() => open(e.target.value))}><option value="">Choose a review…</option>{saved && !history?.batches.some(item => item.id === saved.id) && <option value={saved.id}>Currently open review · outside loaded history</option>}{history?.batches.map(item => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString()} · version {bankReviewVersion(item.id)} · {plural(item.rows, "row", "rows")} ·{item.supersededBy ? 'earlier version' : item.outputDigest ? "reviewed" : "needs review"}</option>)}</select></label>}
      {history?.total === 0 && <p className="text-sm text-ink-secondary">No saved bank reviews yet.</p>}
      {history?.nextCursor && <button className={control} disabled={historyLoading} onClick={() => void refresh(history.nextCursor!)}>Load more bank reviews</button>}
      {historyLoading && <p role="status" className="text-sm">Checking saved bank history…</p>}
      {historyError && <p role="alert" className="text-sm text-hold">{historyError} Previously loaded history, your open review and unsaved decisions are kept. Use Refresh bank history to try again.</p>}
    </section>
    </details>
    {decisionDraft && <section aria-label="Unsaved bank decisions" className="rounded-lg border border-hold p-3 space-y-2 text-sm">
      <p>Your transaction decisions are not saved yet. Finish and save this review, or discard these decisions before choosing another review, reloading it or importing another file. You can still refresh or load more history.</p>
      {!discardConfirm ? <button className={control} disabled={busy} onClick={() => setDiscardConfirm(true)}>Discard these decisions…</button> : <div role="group" aria-label="Discard unsaved bank decisions" className="space-y-2">
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
      <p className="text-sm">{plural(saved.value.batch.rows.length, "transaction", "transactions")} · {saved.value.result ? plural(saved.value.result.changes.length, "reviewed reference change", "reviewed reference changes") : "Review every row, including anything kept unchanged."}</p>
      {saved.firstPass && !saved.value.result && !saved.value.supersededBy && !amending && <FirstPassReview pass={saved.firstPass} decisions={decisions} busy={busy}
        onUseAll={() => setDecisions(Object.fromEntries(saved.firstPass!.rows.map(row => [row.rowId, firstPassDecision(row, row.disposition, row.reason)])))}
        onDecide={(row, choice) => setDecisions(current => ({ ...current, [row.rowId]: firstPassDecision(row, choice, current[row.rowId]?.reason.trim() || row.reason) }))} />}
      {!saved.value.result && !saved.value.supersededBy && !amending && <div className="space-y-3">{saved.value.batch.rows.slice(page * 20, (page + 1) * 20).map(row => <article className="rounded-lg border border-line p-3 space-y-2" key={row.id}>
        <p className="text-sm font-medium break-words">{row.date} · {row.amount} · {row.narrative}</p><p className="text-xs break-words">Current reference: {row.reference || "empty"} · Suggested property: {row.candidates.join(", ") || "needs review"}</p>
        {row.issues.length > 0 && <p className="text-xs text-hold">{row.issues.join(" ")}</p>}
        <label className="block text-xs">Your decision <select aria-label="Your decision" disabled={busy} className={`block mt-1 max-w-full ${control}`} value={decisions[row.id]?.action === "keep" || decisions[row.id]?.action === "exclude" ? decisions[row.id]!.action : decisions[row.id]?.propertyId ?? ""} onChange={e => { const choice = e.target.value, held = choice === "keep" || choice === "exclude"; setDecisions(current => ({ ...current, [row.id]: { rowId: row.id, action: held ? choice : "assign", ...(held ? {} : { propertyId: choice }), reason: current[row.id]?.reason ?? "" } })); }}><option value="">Review this row…</option><option value="keep">Hold: keep the original reference, don't import yet</option><option value="exclude">Exclude: not a rent payment</option>{saved.value.batch.input.rules.map(rule => <option key={rule.propertyId} value={rule.propertyId}>{rule.propertyId} → {rule.reference}</option>)}</select></label>
        <label className="block text-xs">Review reason<input className={`block mt-1 w-full ${control}`} maxLength={500} disabled={busy} value={decisions[row.id]?.reason ?? ""} placeholder="How did you confirm this payment?" onChange={e => setDecisions(current => ({ ...current, [row.id]: { ...(current[row.id] ?? { rowId: row.id, action: "assign" as const }), reason: e.target.value } }))} /></label>
      </article>)}</div>}
      {saved.value.decisions && <details><summary className="cursor-pointer text-sm">Saved transaction decisions</summary><div className="mt-2 space-y-2">{saved.value.decisions.slice(page*20,(page+1)*20).map(decision=><p key={decision.rowId} className="text-sm break-words">Transaction {saved.value.batch.rows.findIndex(row=>row.id===decision.rowId)+1}: {decision.action === 'keep' || decision.action === 'hold' ? 'Held with its original reference' : decision.action === 'exclude' ? 'Excluded' : `Imported for ${decision.propertyId}`} · {decision.reason}</p>)}</div></details>}
      {saved.value.result && !saved.value.decisions && <p role="note" className="text-xs text-hold">This older review retained reasons for changed references only. It did not save a complete record of unchanged-row decisions.</p>}
      {!amending && saved.value.batch.rows.length > 20 && <div className="flex flex-wrap items-center gap-2 text-sm"><button className={control} disabled={page === 0} onClick={() => setPage(page - 1)}>Previous rows</button><span>Rows {page * 20 + 1}–{Math.min((page + 1) * 20, saved.value.batch.rows.length)} of {saved.value.batch.rows.length}</span><button className={control} disabled={(page + 1) * 20 >= saved.value.batch.rows.length} onClick={() => setPage(page + 1)}>Next rows</button></div>}
      <div className="flex flex-wrap gap-2"><button className={control} disabled={busy} onClick={() => void perform(() => download(true))}>{saved.value.batch.version === 2 ? "Download original" : "Download saved text"}</button>
        {saved.value.result ? <button className={control} disabled={busy} onClick={() => void perform(() => download(false))}>{saved.value.supersededBy ? 'Download earlier reviewed copy' : 'Download reviewed REI copy'}</button> : !saved.value.supersededBy && !amending && <button className={control} disabled={busy || saved.value.batch.rows.some(row => !decisions[row.id]?.reason.trim() || (decisions[row.id]?.action === "assign" && !decisions[row.id]?.propertyId))} onClick={() => void perform(async () => { const result = await request<Saved>("POST", `/api/bank-reference/${saved.id}/review`, { revision: saved.revision, decisions: Object.values(decisions) }); if (!mounted.current) return; setSaved(result); setDecisions({}); setDiscardConfirm(false); await refreshIfOpen(); })}>Save reviewed copy</button>}
        {!saved.value.supersededBy && !amending && <button className={control} disabled={busy || unsaved} onClick={()=>setAmending(true)}>Correct mapping or decisions</button>}
        <button className={control} disabled={busy || unsaved} onClick={() => void perform(() => open(saved.id))}>Reload saved review</button></div>
      {amending && <BankReviewAmendment key={saved.id} mapping={saved.value.batch.input} busy={busy} onCancel={()=>setAmending(false)} onCreate={(mapping,reason)=>perform(async()=>{
        const amended = await request<Saved>('POST',`/api/bank-reference/${saved.id}/amend`,{revision:saved.revision,mapping,reason});
        parseFirstPass(amended.firstPass);
        if (!mounted.current) return;
        setSaved(amended); setAmending(false); setDecisions({}); setDiscardConfirm(false); setPage(0); await refreshIfOpen();
      })}/>}
      <p className="text-xs text-ink-muted">Check the import preview and reconcile the total in REI Cloud before accepting receipts. A repeated source download opens its saved review; follow the newer-review link if it has been corrected.</p>
    </div>}
    {notice && <p role="status" className="text-sm text-ink-secondary">{notice}</p>}
    {busy && <p role="status" className="text-sm">Saving or loading review…</p>}{error && <p role="alert" className="text-sm text-hold">{error}</p>}
  </section>;
}

// ── Bank feed pull and the W1 bank import run ────────────────────────────
// The bank feed (Redbark) and the run live on the server (server/w1-host.ts).
// The run's REI steps happen in the person's work browser; Bud asks before the
// upload and the receipt-list download, and never processes receipts in REI.
export type BankAccount = { id: string; name: string; institution: string; numberMasked: string | null; category: string };
type Coverage = { coveredThrough: string | null; nextFrom: string };
type W1Step = "fetch" | "review" | "sign_in" | "upload" | "handoff" | "readback" | "check_outcome" | "confirm" | "done";
export type W1Status = {
  settings: { account: string; rei: { urlValue?: string; marker: string }; bankFormat: string; revision: number } | null;
  run: null | { id: string; revision: number; step: W1Step; attention: { reason: string; message: string } | null; outcome: string | null;
    fetch: { from: string; to: string; batchId: string; transactionIds: string[] } | null; handoff: { at: string } | null;
    upload: { preview: { warnings: string[] } | null } | null; confirm: { coveredThrough: string | null } | null };
  working: boolean; ask: { requestId: string; tool: string; summary: string } | null; note: string | null;
  /** The open upload attempt provably never started (RealBud refused it first): it may be closed without a readback. */
  closable?: boolean;
  readback: { accepted: number; rejected: number; pending: number; warnings: string[] } | null; handoff: string | null;
  /** While the run waits for the person to sign in to REI: the handover's thread. */
  signIn?: string | null;
};
const W1_STEPS: W1Step[] = ["fetch", "review", "sign_in", "upload", "handoff", "readback", "check_outcome", "confirm", "done"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string";
/** A malformed reply is an error, never a state. */
export function parseW1Status(value: unknown): W1Status {
  const bad = () => { throw new Error("The bank import status could not be checked. Refresh and try again."); };
  if (!record(value) || typeof value.working !== "boolean" || !(value.note === null || text(value.note)) || !(value.handoff === null || text(value.handoff)) ||
    !(value.signIn === undefined || value.signIn === null || text(value.signIn)) || !(value.closable === undefined || typeof value.closable === "boolean")) return bad();
  const { settings, run, ask, readback } = value;
  if (!(settings === null || record(settings) && text(settings.account) && record(settings.rei) && text(settings.rei.marker) && (settings.rei.urlValue === undefined || text(settings.rei.urlValue)) && text(settings.bankFormat) && Number.isSafeInteger(settings.revision))) return bad();
  if (!(ask === null || record(ask) && text(ask.requestId) && text(ask.tool) && text(ask.summary))) return bad();
  if (!(readback === null || record(readback) && [readback.accepted, readback.rejected, readback.pending].every(Number.isSafeInteger) && Array.isArray(readback.warnings))) return bad();
  if (!(run === null || record(run) && text(run.id) && Number.isSafeInteger(run.revision) && W1_STEPS.includes(run.step as W1Step) &&
    (run.attention === null || record(run.attention) && text(run.attention.reason) && text(run.attention.message)) &&
    (run.fetch === null || record(run.fetch) && DATE.test(String(run.fetch.from)) && DATE.test(String(run.fetch.to)) && text(run.fetch.batchId) && Array.isArray(run.fetch.transactionIds)))) return bad();
  return value as W1Status;
}
const auDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
export const accountLabel = (account: BankAccount) => `${account.institution} · ${account.name}${account.numberMasked ? ` ${account.numberMasked}` : ""}`;
export const coverageLine = (coverage: Coverage) => coverage.coveredThrough
  ? `Covered to ${auDate(coverage.coveredThrough)} · next pull from ${auDate(coverage.nextFrom)}`
  : `Nothing imported yet · first pull from ${auDate(coverage.nextFrom)}`;

/** Bank accounts from the office's bank feed, loaded when first needed. */
function useBankAccounts() {
  const [accounts, setAccounts] = useState<BankAccount[] | null>(null), [error, setError] = useState("");
  const loading = useRef(false);
  const load = async () => {
    if (loading.current || accounts) return;
    loading.current = true; setError("");
    try {
      // The bank feed is the office's Redbark connection; without it the server says to connect it.
      const { accounts: list } = await request<{ accounts: BankAccount[] }>("GET", "/api/w1/accounts");
      if (!Array.isArray(list) || list.some(item => !record(item) || !text(item.id) || !text(item.name) || !text(item.institution) || !(item.numberMasked === null || text(item.numberMasked)))) throw new Error("The bank accounts could not be checked. Try again.");
      setAccounts(list.filter(item => item.category === "banking"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The bank accounts could not be loaded."); }
    finally { loading.current = false; }
  };
  return { accounts, error, load };
}

/** "Pull from bank": the bank feed's transactions for one account, from the confirmed coverage onwards, become a review below. */
function BankPullSource({ accounts, error, disabled, onPulled }: { accounts: BankAccount[] | null; error: string; disabled: boolean; onPulled: (batchId: string) => Promise<void> }) {
  const [account, setAccount] = useState(""), [coverage, setCoverage] = useState<Coverage | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [failure, setFailure] = useState("");
  const chosen = account || accounts?.[0]?.id || "";
  useEffect(() => {
    if (!chosen) return;
    let cancelled = false;
    void request<Coverage>("GET", `/api/w1/coverage?account=${encodeURIComponent(chosen)}`).then(value => {
      if (!cancelled && record(value) && (value.coveredThrough === null || DATE.test(String(value.coveredThrough))) && DATE.test(String(value.nextFrom))) setCoverage(value);
    }).catch(() => { if (!cancelled) setCoverage(null); });
    return () => { cancelled = true; };
  }, [chosen]);
  return <section aria-label="Pull from bank" className="space-y-2 rounded-lg border border-line p-3">
    <h4 className="text-sm font-medium">Pull from bank</h4>
    {error ? <p className="text-sm text-ink-secondary">{error}</p> : !accounts ? <p role="status" className="text-sm text-ink-muted">Loading bank accounts…</p> : !accounts.length
      ? <p className="text-sm text-ink-secondary">The bank feed shows no bank accounts for this office.</p>
      : <>
        <label className="block text-sm">Bank account <select aria-label="Bank account" className={`mt-1 block w-full ${control}`} value={chosen} disabled={busy || disabled} onChange={e => { setAccount(e.target.value); setCoverage(null); setMessage(""); }}>
          {accounts.map(item => <option key={item.id} value={item.id}>{accountLabel(item)}</option>)}</select></label>
        {coverage && <p className="text-sm text-ink-secondary">{coverageLine(coverage)}</p>}
        <button className={control} disabled={busy || disabled || !chosen} onClick={() => {
          setBusy(true); setMessage(""); setFailure("");
          void request<{ batch: { id: string; rows: number } | null; pending: number; alreadyConfirmed: number }>("POST", "/api/w1/pull", { account: chosen })
            .then(async result => {
              if (result.batch) { await onPulled(result.batch.id); setMessage(`${plural(result.batch.rows, "transaction", "transactions")} pulled. Review them below.`); }
              else setMessage(`No new transactions to review${result.alreadyConfirmed ? `; ${result.alreadyConfirmed} were already imported` : ""}.`);
            }).catch(cause => setFailure(cause instanceof Error ? cause.message : "The bank pull did not work."))
            .finally(() => setBusy(false));
        }}>Pull from bank</button>
        <p className="text-xs text-ink-muted">Pulling only reads the bank. Nothing is imported until REI shows the receipts.</p>
      </>}
    {busy && <p role="status" className="text-sm">Pulling from the bank…</p>}
    {message && <p role="status" className="text-sm text-ink-secondary">{message}</p>}
    {failure && <p role="alert" className="text-sm text-hold">{failure}</p>}
  </section>;
}

const STRIP_STEPS = ["Pull from bank", "Review", "Sign in to REI", "Upload preview", "You process in REI", "Check result", "Done"];
const STEP_INDEX: Record<W1Step, number> = { fetch: 0, review: 1, sign_in: 2, upload: 3, handoff: 4, readback: 5, check_outcome: 5, confirm: 6, done: 6 };
export type W1Action = "start" | "advance" | "posted" | "unsure" | "retry-upload" | "abandon" | "allow" | "deny" | "open" | "stop";
type View = { headline: string; detail?: string; list?: string[]; primary?: [W1Action, string]; secondary?: [W1Action, string] };

/** What the strip says and the one next action, from the saved run. */
export function w1View(status: W1Status, reviewReady: boolean): View {
  const { run, ask } = status;
  if (ask) return { headline: ask.tool === "browser_upload" ? "Allow Bud to upload the reviewed file to REI?" : ask.tool === "browser_download" ? "Allow Bud to download REI's receipt list to check the result?" : "Allow this step in REI?",
    detail: ask.summary, primary: ["allow", "Allow"], secondary: ["deny", "Don't allow"] };
  if (status.working && status.signIn) return { headline: "Waiting for you to sign in to REI Cloud", detail: "Bud opened REI Cloud's sign-in page in RealBud's work browser. This import carries on by itself once you're signed in; other work keeps running. Bud never types your password." };
  if (status.working) return { headline: "Working…", detail: "Bud is checking. This page updates by itself." };
  if (!run || run.step === "done") {
    const last = run?.outcome === "imported" ? `Last import confirmed${run.confirm?.coveredThrough ? `. Covered to ${auDate(run.confirm.coveredThrough)}` : ""}.`
      : run?.outcome === "nothing_new" ? "There were no new bank transactions last time." : run?.outcome === "abandoned" ? "The last import was closed without importing." : undefined;
    return { headline: "Ready for the next bank import", detail: last, primary: ["start", "Start bank import"] };
  }
  const reason = run.attention?.reason, message = run.attention?.message;
  switch (run.step) {
    case "fetch": return { headline: "The bank pull didn't work", detail: message, primary: ["advance", "Try again"] };
    case "review": return reviewReady
      ? { headline: "Review saved", detail: "Continue to check REI is signed in.", primary: ["advance", "Continue"] }
      : { headline: "Review the pulled transactions", detail: `${plural(run.fetch?.transactionIds.length ?? 0, "transaction", "transactions")} from ${auDate(run.fetch!.from)} to ${auDate(run.fetch!.to)}. Decide every row and save the reviewed copy, then continue.`, primary: ["open", "Open pulled transactions"] };
    case "sign_in": return reason === "sign_in" ? { headline: "Waiting for you to sign in to REI", detail: "Sign in to REI in your work browser, then press Continue. Bud never types your password.", primary: ["advance", "Continue"] }
      : reason === "account_mismatch" ? { headline: "REI is open in a different business", detail: message, primary: ["advance", "Continue"] }
      : { headline: "Ready to check REI", primary: ["advance", "Continue"] };
    case "upload": return { headline: "Ready to upload the reviewed file", primary: ["advance", "Continue"] };
    case "handoff": return reason === "preview_mismatch"
      ? { headline: "REI's preview doesn't match. Don't process it.", detail: "Nothing was processed. Close this import, check the review, and pull again.", list: run.upload?.preview?.warnings ?? [], primary: ["abandon", "Close this import"] }
      : reason === "handoff_failed" ? { headline: "The preview couldn't be handed over", detail: message, primary: ["advance", "Try again"] }
      : { headline: "Preview matches · Ready for you to process in REI", detail: status.handoff ?? "Check the preview in REI and process the receipts there yourself. Bud doesn't press Process Receipts.",
        primary: ["posted", "I've processed it in REI"], secondary: ["unsure", "I'm not sure it went through"] };
    case "readback": return { headline: reason ? message! : "Ready to check REI's result", primary: ["advance", reason ? "Check again" : "Continue"] };
    case "check_outcome": return reason === "nothing_found"
      ? { headline: "REI shows nothing from the previous upload", detail: "You can upload the reviewed file again.", primary: ["retry-upload", "Upload again"], secondary: ["abandon", "Close this import"] }
      : { headline: "Check previous upload first", detail: reason ? message : "Bud reads REI's receipt list before anything else. Nothing is uploaded again until you decide.", primary: ["advance", reason ? "Check again" : "Check REI"],
        ...(status.closable ? { secondary: ["abandon", "Close and prepare again"] as [W1Action, string] } : {}) };
    case "confirm": return { headline: reason ? message! : "Confirming the import", primary: ["advance", "Try again"] };
  }
}

/** Steps, the current step and the one next action for the open bank import. */
export function W1RunStrip({ status, reviewReady, busy, onAction }: { status: W1Status; reviewReady: boolean; busy: boolean; onAction: (action: W1Action) => void }) {
  const view = w1View(status, reviewReady), current = status.run && status.run.step !== "done" ? STEP_INDEX[status.run.step] : -1;
  const button = ([action, label]: [W1Action, string], primary: boolean) =>
    <button className={`${control} ${primary ? "border-agency font-medium" : ""}`} disabled={busy} onClick={() => onAction(action)}>{label}</button>;
  return <section aria-label="Bank import" className="space-y-3 rounded-lg border border-line p-3">
    <ol aria-label="Bank import steps" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
      {STRIP_STEPS.map((label, index) => <li key={label} aria-current={index === current ? "step" : undefined} className={index === current ? "font-medium text-ink" : index < current ? "text-ink-secondary" : ""}>{index + 1}. {label}</li>)}
    </ol>
    <div role={status.working ? "status" : undefined}><p className="text-sm font-medium">{view.headline}</p>{view.detail && <p className="mt-1 text-sm text-ink-secondary break-words">{view.detail}</p>}</div>
    {view.list && view.list.length > 0 && <ul aria-label="Differences in REI's preview" className="list-disc space-y-1 pl-5 text-sm">{view.list.map((item, index) => <li key={index} className="break-words">{item}</li>)}</ul>}
    {status.readback && status.run?.step !== "fetch" && <p className="text-sm text-ink-secondary">REI's result: {status.readback.accepted} accepted · {status.readback.rejected} rejected · {status.readback.pending} still pending{status.readback.warnings.length ? `. ${status.readback.warnings.join(" ")}` : ""}</p>}
    {status.note && <p className="text-sm text-hold break-words">{status.note}</p>}
    {/* Stop whenever Bud works or waits in REI (an ask, sign-in or a stage in flight): POST /api/w1/runs/:id/stop ends it and declines any open ask. */}
    {(view.primary || view.secondary || status.working) && <div className="flex flex-wrap gap-2">{view.primary && button(view.primary, true)}{view.secondary && button(view.secondary, false)}{status.working && status.run && button(["stop", "Stop"], false)}</div>}
  </section>;
}

/** Saves which bank account feeds which REI account, before the first import. */
export function W1Setup({ accounts, error, onLoad, onSaved }: { accounts: BankAccount[] | null; error: string; onLoad: () => void; onSaved: (status: W1Status) => void }) {
  const [form, setForm] = useState({ account: "", reiAccount: "", reiBusiness: "", bankFormat: "ANZ(csv file)" }), [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
  // The office's saved REI business code: shown here, and its revision sent with the save, so a code saved elsewhere meanwhile is never overwritten.
  const [reiRevision, setReiRevision] = useState(0);
  useEffect(() => {
    onLoad();
    void request<unknown>("GET", "/api/rei/account").then(parseReiAccount).then(saved => {
      if (saved) { setReiRevision(saved.revision); setForm(current => current.reiBusiness ? current : { ...current, reiBusiness: saved.marker }); }
    }).catch(() => {});
  }, []);
  const account = form.account || accounts?.[0]?.id || "";
  const field = (key: keyof typeof form, label: string, hint: string) => <label className="block text-sm">{label}<input aria-label={label} className={`mt-1 block w-full ${control}`} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} /><span className="text-xs text-ink-muted">{hint}</span></label>;
  return <section aria-label="Set up bank imports" className="space-y-2 rounded-lg border border-line p-3">
    <p className="text-sm font-medium">Set up bank imports</p>
    <p className="text-sm text-ink-secondary">Choose the bank account and the REI account its reviewed file goes to.</p>
    {error ? <p className="text-sm text-ink-secondary">{error}</p> : accounts && <label className="block text-sm">Bank account <select aria-label="Bank account for imports" className={`mt-1 block w-full ${control}`} value={account} onChange={e => setForm({ ...form, account: e.target.value })}>{accounts.map(item => <option key={item.id} value={item.id}>{accountLabel(item)}</option>)}</select></label>}
    {field("reiBusiness", "REI business code (top bar, e.g. YOUR-OFFICE)", "Exactly as REI shows it at the top of the page.")}
    {field("reiAccount", "REI account id (optional)", "Only if your office uses one. Leave blank otherwise.")}
    {field("bankFormat", "REI file format", "The File Format option you choose in REI's Bulk receipting.")}
    <button className={`${control} border-agency font-medium`} disabled={busy || !account || !form.reiBusiness.trim() || !form.bankFormat.trim()} onClick={() => {
      setBusy(true); setFailure("");
      void request<unknown>("PUT", "/api/w1/settings", { account, ...(form.reiAccount.trim() ? { reiAccount: form.reiAccount.trim() } : {}), reiBusiness: form.reiBusiness.trim(), bankFormat: form.bankFormat.trim(), expectedRevision: 0, reiRevision })
        .then(() => request<unknown>("GET", "/api/w1/status")).then(value => onSaved(parseW1Status(value)))
        .catch(cause => setFailure(cause instanceof Error ? cause.message : "The settings could not be saved.")).finally(() => setBusy(false));
    }}>Save bank import settings</button>
    {failure && <p role="alert" className="text-sm text-hold">{failure}</p>}
  </section>;
}

/** The open bank import: polls while Bud works or waits for an answer. */
function W1RunPanel({ accounts, error, reviewReady, onOpenBatch, onLoadAccounts }: { accounts: BankAccount[] | null; error: string; reviewReady: (batchId: string) => boolean; onOpenBatch: (batchId: string) => Promise<void>; onLoadAccounts: () => void }) {
  const [status, setStatus] = useState<W1Status | null>(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
  const signIns = useBrowserSignIns({ threadId: status?.signIn ?? "", busy: Boolean(status?.working), enabled: Boolean(status?.signIn) });
  const refresh = useCallback(() => request<unknown>("GET", "/api/w1/status").then(value => setStatus(parseW1Status(value))), []);
  useEffect(() => { void refresh().catch(cause => setFailure(cause instanceof Error ? cause.message : "The bank import could not be loaded.")); }, [refresh]);
  // A failed read keeps polling, so a service blip never freezes the strip on "Working…".
  useRunPoll(Boolean(status?.working), refresh, 1500);
  if (!status) return failure ? <p role="alert" className="text-sm text-hold">{failure}</p> : null;
  if (!status.settings) return <W1Setup accounts={accounts} error={error} onLoad={onLoadAccounts} onSaved={setStatus} />;
  const run = status.run;
  const act = (action: W1Action) => {
    setBusy(true); setFailure("");
    const post = (path: string, body: unknown = {}) => request<unknown>("POST", path, body).then(value => setStatus(parseW1Status(value)));
    const at = run ? `/api/w1/runs/${run.id}` : "";
    const revision = { expectedRevision: run?.revision };
    const work = action === "start" ? post("/api/w1/runs/start")
      : action === "open" ? onOpenBatch(run!.fetch!.batchId)
      : action === "allow" || action === "deny" ? post(`${at}/answer`, { requestId: status.ask!.requestId, allowed: action === "allow" })
      : action === "posted" || action === "unsure" ? post(`${at}/posting`, { ...revision, outcome: action })
      : post(`${at}/${action}`, revision);
    void work.catch(cause => setFailure(cause instanceof Error ? cause.message : "That did not work. Refresh and try again.")).finally(() => setBusy(false));
  };
  return <div className="space-y-2">
    <W1RunStrip status={status} busy={busy} onAction={act} reviewReady={Boolean(run?.step === "review" && run.fetch && reviewReady(run.fetch.batchId))} />
    {signIns.handovers.map(handover => <BrowserSignInStrip key={handover.id} handover={handover} busy={signIns.acting === handover.id}
      error={signIns.error?.id === handover.id ? signIns.error.text : null} onDone={() => void signIns.act(handover.id, "done")} onStop={() => void signIns.act(handover.id, "stop")} />)}
    {failure && <p role="alert" className="text-sm text-hold">{failure}</p>}
  </div>;
}

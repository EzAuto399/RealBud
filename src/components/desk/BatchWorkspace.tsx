import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { batchResultReady as resultReady, filterBatchResults, repeatBatchDraft, type BatchReviewFilter } from "@/lib/batch-review";
import type { PropertyScope } from "@/lib/book-groups";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Copy, Layers3, Loader2, Pause, Play, RotateCcw } from "lucide-react";
import { BATCH_LIMIT, BATCH_HISTORY_ITEMS, BATCH_TASKS, batchCounts, type WorkBatch, type BatchTask, type BatchItem } from "../../../shared/batches";
import type { DeskSnapshot } from "@/lib/desk";
import { useWorkspacePreferences } from "@/lib/workspace-preferences";
import { api, useStore } from "@/state/store";
import { ChatMarkdown } from "../ChatMarkdown";

type Summary = Pick<WorkBatch, "id" | "task" | "status" | "createdAt"> & { counts: ReturnType<typeof batchCounts> };
type Selection = { ids: string[]; task: BatchTask; instruction: string; key: string; submittedRevision?: number; autoContinue?: boolean };
const STORAGE_KEY = "realbud.batch-selection";
function initialSelection(): Selection {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && Array.isArray(saved.ids) && saved.ids.every((id: unknown) => typeof id === "string") && saved.ids.length <= BATCH_LIMIT && Object.hasOwn(BATCH_TASKS, saved.task) && typeof saved.instruction === "string" && typeof saved.key === "string" && (saved.autoContinue === undefined || typeof saved.autoContinue === "boolean")) return saved;
  } catch { /* A draft is optional; server history remains authoritative. */ }
  return { ids: [], task: "owner-update", instruction: "", key: crypto.randomUUID() };
}
const labels: Record<BatchItem["status"], string> = { queued: "Waiting", running: "Preparing", ready: "Ready to review", "needs-review": "Check missing facts", failed: "Needs retry", interrupted: "Interrupted" };
const date = (at: number) => new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const button = "pm-control inline-flex whitespace-nowrap items-center justify-center gap-2 rounded-md border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-45";
const primary = `${button} !border-agency !bg-agency !text-white hover:!bg-agency-hover`;

export function BatchWorkspace({ snapshot, scope, onClearScope, openNewDraft, onDraftOpened }: { snapshot: DeskSnapshot; scope?: PropertyScope | null; onClearScope?: () => void; openNewDraft?: boolean; onDraftOpened?: () => void }) {
  const { state, dispatch } = useStore();
  const { preferences } = useWorkspacePreferences();
  const pageSize = preferences.pageSize;
  const [matchPage, setMatchPage] = useState(0);
  const [resultSearch, setResultSearch] = useState("");
  const [selection, setSelection] = useState(initialSelection);
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(() => { if (openNewDraft) return null; try { return localStorage.getItem("realbud.active-batch"); } catch { return null; } });
  useEffect(() => { if (openNewDraft) onDraftOpened?.(); }, [openNewDraft, onDraftOpened]);
  const [batch, setBatch] = useState<WorkBatch | null>(null);
  const [history, setHistory] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reviewFilter, setReviewFilter] = useState<BatchReviewFilter>("all");
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const latestBatch = useRef<WorkBatch | null>(null);
  useEffect(() => { latestBatch.current = batch; }, [batch]);
  useEffect(() => setMatchPage(0), [search, pageSize, scope]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selection)); } catch { /* Draft remains in this view. */ } }, [selection]);
  useEffect(() => { try { if (activeId) localStorage.setItem("realbud.active-batch", activeId); else localStorage.removeItem("realbud.active-batch"); } catch { /* History still lives on the server. */ } }, [activeId]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const [list, detail] = await Promise.all([
          api("/api/desk/batches", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }),
          activeId ? api(`/api/desk/batches/${activeId}${latestBatch.current?.id === activeId ? `?revision=${latestBatch.current.revision}` : ""}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setHistory(list.batches);
        setPollError("");
        if (detail?.batch) setBatch(current => current?.id === detail.batch.id && current!.revision > detail.batch.revision ? current : detail.batch);
        setLoading(false);
      } catch (cause) {
        if (!cancelled) { setPollError(cause instanceof Error ? cause.message : "Batch progress could not be loaded."); setLoading(false); }
      } finally {
        if (!cancelled) timer = setTimeout(poll, 3_000);
      }
    };
    setLoading(true); void poll();
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [activeId, refresh]);

  const choose = (patch: Partial<Selection>) => {
    setSelection(current => ({ ...current, ...patch, key: crypto.randomUUID(), submittedRevision: undefined }));
    setError(""); setNotice("");
  };
  const open = (id: string) => { setActiveId(id); setBatch(null); setSelected(null); setReviewFilter("all"); setRepeatOpen(false); setResultSearch(""); setError(""); setNotice(""); };
  const start = async () => {
    if (pending || !selection.ids.length) return;
    const request = { ...selection, submittedRevision: selection.submittedRevision ?? snapshot.revision };
    setSelection(request); setPending(true); setError(""); setNotice("");
    try {
      const { batch: created } = await api("/api/desk/batches", { method: "POST", body: JSON.stringify({ task: request.task, propertyIds: request.ids, instruction: request.instruction, requestKey: request.key, expectedRevision: request.submittedRevision, autoContinue: request.autoContinue === true }) }, { timeoutMs: 15_000 });
      if (!mounted.current) return;
      setActiveId(created.id); setBatch(created); setSelected(created.items[0]?.propertyId ?? null);
      setReviewFilter("all"); setResultSearch(""); setRepeatOpen(false);
      setSelection(current => ({ ...current, key: crypto.randomUUID(), submittedRevision: undefined }));
    } catch (cause) {
      if (mounted.current) setError(`${cause instanceof Error ? cause.message : "Submission was not confirmed."} Check recent batches before trying again; your selection is kept.`);
    } finally { if (mounted.current) setPending(false); }
  };
  const control = async (action: string, propertyId?: string) => {
    if (!batch || pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const { batch: updated } = await api(`/api/desk/batches/${batch.id}`, { method: "PATCH", body: JSON.stringify({ action, expectedRevision: batch.revision, propertyId }) }, { timeoutMs: 15_000 });
      if (!mounted.current) return;
      setBatch(current => current?.id === updated.id && current!.revision > updated.revision ? current : updated);
      if (action === "review") {
        setNotice("Review recorded. Nothing was sent or changed outside RealBud.");
        setSelected(filterBatchResults(updated.items, reviewFilter, resultSearch).find((item: BatchItem) => resultReady(item) && !item.reviewedAt)?.propertyId ?? null);
      }
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : "That action could not be confirmed."); setRefresh(n => n + 1); }
    } finally { if (mounted.current) setPending(false); }
  };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); if (mounted.current) setNotice("Copied. Review before using outside RealBud."); }
    catch { if (mounted.current) setError("Copy was unavailable. Select the result text and copy it manually."); }
  };
  const counts = batch ? batchCounts(batch) : null;
  const visible = batch ? filterBatchResults(batch.items, reviewFilter, resultSearch) : [];
  const repeated = batch ? repeatBatchDraft(batch, snapshot.properties.map(property => property.id)) : null;
  const hasSelection = selection.ids.length > 0 || Boolean(selection.instruction.trim());
  const repeat = () => {
    if (!repeated || pending || !repeated.selection.ids.length) return;
    choose(repeated.selection);
    setActiveId(null); setBatch(null); setSelected(null); setRepeatOpen(false); setSearch(""); setMatchPage(0);
    setReviewFilter("all"); setResultSearch("");
    onClearScope?.();
    setNotice(`Ready to review ${repeated.selection.ids.length} properties from the previous batch.${repeated.missing.length ? ` ${repeated.missing.length} removed properties were left out.` : ""} Check dated instructions, then prepare from the current book. Nothing has started.`);
  };
  const item = visible.find(row => row.propertyId === selected) ?? visible[0];
  const scopeIds = scope ? new Set(scope.ids) : null;
  const matches = snapshot.properties.filter(property => (!scopeIds || scopeIds.has(property.id)) && `${property.address} ${property.tenantName}`.toLowerCase().includes(search.toLowerCase()));
  const effectiveMatchPage = Math.min(matchPage, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const shown = matches.slice(effectiveMatchPage * pageSize, (effectiveMatchPage + 1) * pageSize);
  const selectedIds = new Set(selection.ids);
  const resultPage = Math.floor(Math.max(0, visible.findIndex(row => row.propertyId === item?.propertyId)) / pageSize);
  const shownResults = visible.slice(resultPage * pageSize, (resultPage + 1) * pageSize);
  const additions = matches.filter(property => !selectedIds.has(property.id)).slice(0, BATCH_LIMIT - selection.ids.length);
  const sourceChanged = batch && batch.sourceRevision !== snapshot.revision;
  const pack = useMemo(() => batch ? [`# ${BATCH_TASKS[batch.task].label}`, `${batch.sample ? "Training sample" : "Book snapshot"} · ${date(batch.createdAt)} · Drafts for review`, ...batch.items.map(row => `## ${row.address}\n${labels[row.status]}\n\n${row.output || row.detail}\n\n${row.gaps.map(gap => `- ${gap}`).join("\n")}`)].join("\n\n") : "", [batch]);
  return <section className="batch-workspace" aria-label="Batch workspace">
    <div className="batch-heading">
      <div><div className="batch-eyebrow"><Layers3 size={15} /> WORK TOGETHER</div><h2>{batch ? BATCH_TASKS[batch.task].label : "One instruction. A whole batch."}</h2><p>{batch ? "Each property keeps its own result. Review, copy or continue with Bud." : "Choose your properties. Bud prepares the work and brings the exceptions back to you."}</p></div>
      <div className="flex flex-wrap gap-2">
        {batch && <button disabled={pending} className={button} aria-expanded={repeatOpen} aria-controls="batch-repeat-preview" onClick={() => setRepeatOpen(value => !value)}><RotateCcw size={14} />Repeat this work</button>}
        {activeId && <button disabled={pending} className={button} onClick={() => { setActiveId(null); setBatch(null); setRepeatOpen(false); setError(""); setNotice(""); }}><ArrowLeft size={14} />New batch</button>}
        {history.length > 0 && <select disabled={pending} className="batch-history" aria-label="Open a recent batch" value={activeId ?? ""} onChange={event => event.target.value && open(event.target.value)}><option value="" disabled>Recent batches ({history.length})</option>{history.map(row => <option key={row.id} value={row.id}>{BATCH_TASKS[row.task].label} · {row.counts.ready}/{row.counts.total} ready · {date(row.createdAt)}</option>)}</select>}
      </div>
    </div>
    {repeatOpen && batch && repeated && <section id="batch-repeat-preview" className="batch-panel batch-repeat-preview" aria-labelledby="batch-repeat-title">
      <h3 id="batch-repeat-title">Repeat with current book facts</h3>
      <p>{BATCH_TASKS[batch.task].label} · {repeated.selection.ids.length} properties still on your book. Keeps the same selection; new units are not added automatically.</p>
      <p>Review the instruction and selection first. Starting the new batch captures the current Desk facts and saved notes. It does not refresh a connected PMS or inbox.</p>
      {batch.instruction && <blockquote>{batch.instruction}</blockquote>}
      {batch.instruction && <p>Check dates, amounts and one-off directions in this instruction before using it again.</p>}
      {repeated.missing.length > 0 && <details><summary>{repeated.missing.length} properties no longer on your book will be left out</summary><ul>{repeated.missing.map((address, index) => <li key={index}>{address}</li>)}</ul></details>}
      {hasSelection && <p>This replaces your current new-batch selection. Saved batches and their results are kept.</p>}
      <div className="mt-3 flex flex-wrap gap-2"><button className={primary} disabled={pending || !repeated.selection.ids.length} onClick={repeat}>Review new batch</button><button className={button} onClick={() => setRepeatOpen(false)}>Keep current work</button></div>
      {!repeated.selection.ids.length && <p>None of these properties remain on the book. Start a new batch and select current properties.</p>}
    </section>}
    {(error || pollError) && <div role="alert" className="batch-alert"><span>{error || pollError}</span><button className={button} onClick={() => { setError(""); setRefresh(n => n + 1); }}>Refresh progress</button></div>}
    {notice && <p role="status" className="batch-notice">{notice}</p>}
    {!activeId ? <div className="batch-setup">
      <div className="batch-panel">
        <h3>1. Choose the work</h3>
        <div className="batch-task-options">{(Object.entries(BATCH_TASKS) as [BatchTask, { label: string; detail: string }][]).map(([key, task]) => <label key={key} className={selection.task === key ? "is-selected" : ""}><input type="radio" name="batch-task" checked={selection.task === key} disabled={pending} onChange={() => choose({ task: key })}/><span><strong>{task.label}</strong><small>{task.detail}</small></span></label>)}</div>
        <details open={Boolean(selection.instruction)}><summary className="cursor-pointer py-3 text-[13px] text-ink-muted">Add instructions for the whole batch · optional</summary>
        <label className="batch-field">Anything Bud should follow? <span>Optional · applies to every selected property</span><textarea rows={4} maxLength={1000} value={selection.instruction} disabled={pending} placeholder="For example: keep each owner update under 150 words and list unresolved questions separately." onChange={event => choose({ instruction: event.target.value })}/></label></details>
        <label className="batch-continuation"><input type="checkbox" checked={selection.autoContinue === true} disabled={pending} onChange={event => choose({ autoContinue: event.target.checked })}/><span><strong>Continue after reconnect or restart</strong><small>Save each result and resume remaining preparation when RealBud is open and Bud is ready. Retry worker failures up to 3 attempts. A manual pause stays paused.</small></span></label>
        <div className="batch-scope"><strong>{snapshot.demo ? "Training sample" : "Current book snapshot"}</strong><p>Uses each property's Desk facts and notes. Missing facts stay visible. No inbox, live source refresh, sending, booking or record changes.</p></div>
      </div>
      <div className="batch-panel">
        <div className="flex items-center justify-between gap-3"><h3>2. Choose properties</h3><span className="batch-selection-count">{selection.ids.length} selected</span></div>
        {scope && <div className="property-scope-banner"><strong>{scope.label}</strong><span>{matches.length} matching properties · {selection.ids.filter(id => !scopeIds!.has(id)).length} selected outside this group</span><button type="button" onClick={onClearScope}>Show all properties</button><button type="button" disabled={pending || !matches.length} onClick={() => choose({ ids: matches.slice(0, BATCH_LIMIT).map(p => p.id) })}>{matches.length > BATCH_LIMIT ? `Use first ${BATCH_LIMIT} matches only` : "Use this group only"}</button></div>}
        <input className="batch-search" type="search" aria-label="Find properties for this batch" placeholder="Search address or tenant" value={search} onChange={event => setSearch(event.target.value)}/>
        <div className="batch-selection-actions"><button disabled={pending || !additions.length} onClick={() => choose({ ids: [...selection.ids, ...additions.map(p => p.id)] })}>{selection.ids.length ? `Select ${additions.length} more matches` : matches.length > BATCH_LIMIT ? `Select first ${BATCH_LIMIT} matches` : `Select all ${matches.length} matches`}</button><button disabled={pending || !selection.ids.length} onClick={() => choose({ ids: [] })}>Clear selection</button></div>
        <div className="batch-properties" role="group" aria-label="Properties in this batch">{shown.map(property => <label key={property.id}><input type="checkbox" checked={selectedIds.has(property.id)} disabled={pending || (!selectedIds.has(property.id) && selection.ids.length >= BATCH_LIMIT)} onChange={event => choose({ ids: event.target.checked ? [...selection.ids, property.id] : selection.ids.filter(id => id !== property.id) })}/><span><strong>{property.address}</strong><small>{property.tenantName || "Tenant not recorded"}</small></span></label>)}{!matches.length && <p>No properties match. Try another address or tenant.</p>}</div>
        <div className="desk-pagination" aria-label="Batch property pages"><span>{matches.length ? effectiveMatchPage * pageSize + 1 : 0}–{Math.min(matches.length, (effectiveMatchPage + 1) * pageSize)} of {matches.length}</span><button disabled={effectiveMatchPage === 0} onClick={() => setMatchPage(n => n - 1)}>Previous</button><button disabled={(effectiveMatchPage + 1) * pageSize >= matches.length} onClick={() => setMatchPage(n => n + 1)}>Next</button></div>
        <p className="batch-footnote">Up to {BATCH_LIMIT} properties per batch. Selection stays across pages and searches.</p>
      </div>
      <div className="batch-start-bar"><div><strong>{selection.ids.length ? `${selection.ids.length} ${selection.ids.length === 1 ? "property" : "properties"} · ${BATCH_TASKS[selection.task].label.toLowerCase()}` : "Choose at least one property to begin"}</strong><p>One property at a time. Pause between properties and keep every completed result.</p>{!state.hermes?.ready && <p>Bud will pause the batch until its connection is ready.</p>}</div><button className={primary} disabled={pending || !selection.ids.length || snapshot.recovery.active} onClick={() => void start()}>{pending ? <Loader2 size={16} className="animate-spin"/> : <Play size={15}/>}Prepare batch</button></div>
      {selection.submittedRevision !== undefined && <button className={button} disabled={pending} onClick={() => choose({ submittedRevision: undefined })}>Use current book for a new request</button>}
    </div> : batch && counts ? <>
      <div className="batch-progress-panel">
        <div className="batch-progress-title"><strong>{batch.status === "running" ? "Bud is preparing your batch" : batch.status === "paused" ? counts.running ? "Pausing after the current property" : "Your batch is paused" : counts.failed ? "Batch finished · some items need retry" : "Your review pack is ready"}</strong><span>{counts.ready + counts.failed} of {counts.total} settled</span></div>
        <progress aria-label="Properties settled" value={counts.ready + counts.failed} max={counts.total}/>
        <p role="status">{batch.detail}</p>
        <div className="batch-progress-actions"><span>{counts.ready} prepared · {counts.failed} need retry · {counts.reviewed} reviewed</span><div className="flex flex-wrap gap-2">
          {(batch.status === "running" || batch.waitingForWorker) && <button className={button} disabled={pending} onClick={() => void control("pause")}><Pause size={14}/>{batch.waitingForWorker ? "Pause automatic continuation" : "Pause after this property"}</button>}
          {batch.status !== "running" && (counts.remaining > 0 || counts.failed > 0) && !state.hermes?.ready && <button className={primary} onClick={() => { openWorkspaceSetup("bud"); }}>Check Bud connection</button>}
          {batch.status !== "running" && state.hermes?.ready && counts.remaining > 0 && <button className={primary} disabled={pending || counts.running > 0} onClick={() => void control("resume")}><Play size={14}/>Resume {counts.remaining} remaining</button>}
          {batch.status !== "running" && state.hermes?.ready && counts.failed > 0 && <button className={button} disabled={pending || counts.running > 0} onClick={() => void control("retry-failed")}><RotateCcw size={14}/>Retry {counts.failed} failed only</button>}
          <button className={button} disabled={!counts.ready} onClick={() => void copy(pack)}><Copy size={14}/>Copy review pack</button>
        </div></div>
      </div>
      <p className="batch-source-line">{batch.autoContinue ? "Automatic continuation enabled · " : "Manual continuation · "}{batch.sample ? "Training sample" : "Book snapshot"} · {date(batch.createdAt)} · Retries use this saved snapshot.{sourceChanged && <strong> The book has changed; start a new batch for current facts.</strong>}</p>
      <div className="batch-review">
        <div className="batch-result-list"><input className="batch-search" type="search" aria-label="Search batch results" placeholder="Find a property result" value={resultSearch} onChange={e => setResultSearch(e.target.value)} /><div className="batch-review-filters" role="group" aria-label="Filter batch results">{([
          ["all", `All (${counts.total})`], ["unreviewed", `To review (${counts.ready - counts.reviewed})`],
          ["attention", `Needs attention (${counts.attention})`], ["reviewed", `Reviewed (${counts.reviewed})`],
        ] as const).map(([value, label]) => <button key={value} aria-pressed={reviewFilter === value} onClick={() => { setReviewFilter(value); setSelected(null); }}>{label}</button>)}</div><div className="batch-result-rows">{shownResults.map(row => <button key={row.propertyId} aria-pressed={item?.propertyId === row.propertyId} onClick={() => setSelected(row.propertyId)}><strong>{row.address}</strong><span>{row.reviewedAt ? "Reviewed" : labels[row.status]}{row.status === "running" && <Loader2 size={12} className="animate-spin"/>}</span></button>)}{!visible.length && <p>{resultSearch ? "No results match this address." : reviewFilter === "unreviewed" ? "No prepared results waiting for review." : reviewFilter === "reviewed" ? "No results have been reviewed yet." : reviewFilter === "attention" ? "No exceptions in this batch." : "No results yet."}</p>}</div><div className="desk-pagination" aria-label="Batch result pages"><span>{visible.length ? resultPage * pageSize + 1 : 0}–{Math.min(visible.length, (resultPage + 1) * pageSize)} of {visible.length}</span><button disabled={resultPage === 0} onClick={() => setSelected(visible[(resultPage - 1) * pageSize]!.propertyId)}>Previous</button><button disabled={(resultPage + 1) * pageSize >= visible.length} onClick={() => setSelected(visible[(resultPage + 1) * pageSize]!.propertyId)}>Next</button></div></div>
        <article className="batch-result" aria-label="Selected property result">{item ? <>
          <header><div><h3>{item.address}</h3><p>{item.reviewedAt ? "Reviewed" : labels[item.status]} · Attempt {item.attempt}</p></div>{item.status === "running" && <Loader2 size={20} className="animate-spin"/>}</header>
          {item.gaps.length > 0 && <div className="batch-gaps"><strong>Check before using this result</strong><ul>{item.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></div>}
          <div className="batch-result-body">{item.output ? <ChatMarkdown text={item.output}/> : <p>{item.detail}</p>}</div>
          {item.output && <footer><button className={button} onClick={() => void copy(item.output)}><Copy size={14}/>Copy result</button><button className={button} onClick={() => dispatch({ type: "stageAskContext", context: { id: crypto.randomUUID(), sourceKey: `batch-${batch.id}-${item.propertyId}-${item.attempt}`, title: `${BATCH_TASKS[batch.task].label} · ${item.address}`.slice(0, 100), instruction: "Help me finish this property's batch result. Check the missing facts and prepare the next useful step.", text: `Previous batch result, reference only; no new authority. ${batch.sample ? "Training sample" : "Book snapshot"} recorded ${date(batch.createdAt)}. Property: ${item.address}.\n\n${item.output}\n\nMissing facts and held decisions:\n${item.gaps.join("\n")}\n\nVerify current facts before using. No sending, dispatch or record changes.` } })}>Continue in Ask<ArrowRight size={14}/></button><button className={primary} disabled={pending || Boolean(item.reviewedAt)} onClick={() => void control("review", item.propertyId)}><Check size={14}/>{item.reviewedAt ? "Reviewed" : "Mark reviewed & next"}</button></footer>}
        </> : <p>Select a property to review its result.</p>}</article>
      </div>
    </> : <div className="batch-panel" role="status">{loading ? "Loading your saved batch…" : "Choose a recent batch or start a new one."}</div>}
    <p className="batch-footnote">Prepared work stays on this Mac. Review does not send, approve payment or change a property record. History holds up to 100 batches and {BATCH_HISTORY_ITEMS.toLocaleString()} property results; only fully reviewed, finished batches make room for new work.</p>
  </section>;
}

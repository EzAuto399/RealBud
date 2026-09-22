import { usePhoneConnections } from "@/lib/phone-connections";
import { budAvailability } from "@/lib/bud-setup";
import { useWorkspaceScroll, useWorkspaceViewState } from "@/lib/workspace-view-state";
import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { useDeskViewState } from "@/lib/desk-view-state";
import type { PropertyScope } from "@/lib/book-groups";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, CircleAlert, Loader2, MessageSquare, X } from "lucide-react";

import { cn } from "@/lib/cn";
import type { CsvColumnMapping, CsvImportPreview, DeskSnapshot, Draft, Property } from "@/lib/desk";
import {
  buildDeskQueue,
  filterDeskQueue,
  queueCounts,
  type DeskQueueItem,
  type DeskRecoveryPlan,
  type QueueCounts,
  type QueueFilter,
} from "@/lib/desk-queue";
import { handsChip, missAction } from "@/lib/hands-label";
import { draftViaLine, phoneChip, phoneChipTone, phonePaired } from "@/lib/phone-label";
import { CaseQueueRow, RecoveryNotice, SplitView, StatusLabel } from "./pm";
import { DeskBook } from "./desk/DeskBook";
import { DeskCase, type CaseEdit } from "./desk/DeskCase";
import { propertyEdits } from "@/lib/property-edits";
import { deskAskContext, type DeskAskIntent } from "@/lib/desk-ask-context";
import { useWorkspacePreferences, portfolioLayout } from "@/lib/workspace-preferences";
import { WorkspaceLayout } from "./desk/WorkspaceLayout";
import { DeskBud } from "./desk/DeskBud";
import { DeskEvidence } from "./desk/DeskEvidence";
import { GoLiveCard } from "./desk/GoLiveCard";
import { JobRunFeed } from "./desk/JobRunFeed";
import { SharedWorkPanel } from "./desk/SharedWorkPanel";
import { ExpectedBillsBoard } from "./desk/ExpectedBillsBoard";
import { MailWorkPanel } from './desk/MailWorkPanel';
import { BatchWorkspace } from "./desk/BatchWorkspace";
import { CASE_KIND_LABELS } from "./desk/labels";
import { MorningBrief, MorningEmpty } from "./desk/MorningBrief";
import { isDemoWorkerMiss, morningBrief } from "@/lib/morning-brief";
import { deskCheckAction, workdayGuide } from "@/lib/workday";
import { coerceOffice } from "../../shared/office";
import { recheckProgress } from "@/lib/task-progress";
import { api, useStore } from "@/state/store";

function deskFacingError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/revision|stale|conflict/i.test(raw)) return "This card changed — open it again";
  return raw;
}

export function DeskPage({ caseEdits }: { caseEdits: Map<string, CaseEdit> }) {
  const { state, dispatch, refreshHermes } = useStore();
  const { preferences } = useWorkspacePreferences();
  const layout = portfolioLayout(preferences, state.desk?.properties.length ?? 0);
  // Paint instantly from the SSE-pushed snapshot when we have one; the
  // effect below still refreshes from the server on mount.
  const [snap, setSnap] = useState<DeskSnapshot | null>(state.desk ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [recheckStartedAt, setRecheckStartedAt] = useState<number | null>(null);
  const [recheckElapsed, setRecheckElapsed] = useState(0);
  const [ready, setReady] = useState(state.desk != null);
  const [mode, setMode] = useDeskViewState("mode");
  const [jobRunsOpen, setJobRunsOpen] = useWorkspaceViewState("deskResults");
  const [bookNonce, setBookNonce] = useDeskViewState("bookNonce");
  // A "Connect your export" entry elsewhere in the app lands here in Book mode.
  useEffect(() => {
    if (state.deskBookNonce > bookNonce) { setMode("book"); setBookNonce(state.deskBookNonce); }
  }, [state.deskBookNonce]);
  const [filter, setFilter] = useDeskViewState("filter");
  const [selectedId, setSelectedId] = useDeskViewState("selectedId");
  // On narrow windows the queue opens when something needs you
  // (or the PM taps Open Queue). Wide desks keep the side pane always visible.
  const [queueOpen, setQueueOpen] = useState(false);
  const autoOpenedForNeedRef = useRef(false);
  const [railOpen, setRailOpen] = useState(false);
  const [railTab, setRailTab] = useState<"bud" | "evidence">("bud");
  const [announce, setAnnounce] = useState("");
  const [query, setQuery] = useDeskViewState("query");
  const [taskScope, setTaskScope] = useDeskViewState("taskScope");
  const [batchScope, setBatchScope] = useDeskViewState("batchScope");
  const [openNewBatchDraft, setOpenNewBatchDraft] = useState(false);
  const [caseKind, setCaseKind] = useDeskViewState("caseKind");
  const { channels } = usePhoneConnections(state.connected);
  // Keep the overview compact until the PM asks for the day details.
  const [briefExpanded, setBriefExpanded] = useState(false);
  const [keysHint, setKeysHint] = useState(() => {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem("realbud.deskKeysHint") !== "1";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (!announce) return;
    const clear = window.setTimeout(() => setAnnounce(""), 2400);
    return () => window.clearTimeout(clear);
  }, [announce]);

  useEffect(() => {
    if (busy !== "check" || recheckStartedAt == null) return;
    setRecheckElapsed(Math.max(0, Math.floor((Date.now() - recheckStartedAt) / 1_000)));
    const id = window.setInterval(
      () => setRecheckElapsed(Math.max(0, Math.floor((Date.now() - recheckStartedAt) / 1_000))),
      1_000,
    );
    return () => window.clearInterval(id);
  }, [busy, recheckStartedAt]);

  const dismissKeysHint = () => {
    setKeysHint(false);
    try {
      window.localStorage.setItem("realbud.deskKeysHint", "1");
    } catch {
      /* ignore */
    }
  };

  const load = useCallback(async () => {
    try {
      const next = (await api("/api/desk")) as DeskSnapshot;
      setSnap(next);
      dispatch({ type: "deskSnapshot", snapshot: next });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReady(true);
    }
  }, [dispatch]);

  useEffect(() => {
    if (!state.connected) return;
    void load();
    void refreshHermes();
  }, [state.connected, load, refreshHermes]);

  useEffect(() => {
    if (state.desk) setSnap(state.desk);
  }, [state.desk]);

  // Phone Allow/Deny arrives over SSE — toast the via stamp when a draft flips.
  const prevDraftsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!snap) return;
    const prev = prevDraftsRef.current;
    const next = new Map<string, string>();
    for (const draft of snap.drafts) {
      next.set(draft.id, draft.status);
      const was = prev.get(draft.id);
      if (was === "pending" && (draft.status === "allowed" || draft.status === "denied") && draft.via) {
        const line = draftViaLine(draft);
        if (line) setAnnounce(line);
      }
    }
    prevDraftsRef.current = next;
  }, [snap]);

  const run = async (path: string, method: string, body?: unknown, key: string = method, spoken?: string) => {
    setBusy(key);
    if (key === "check") {
      setRecheckStartedAt(Date.now());
      setRecheckElapsed(0);
    }
    setError("");
    try {
      const next = (await api(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      })) as DeskSnapshot & { draft?: Draft; property?: Property };
      if (next.properties) {
        setSnap(next);
        dispatch({ type: "deskSnapshot", snapshot: next });
      } else await load();
      if (spoken) setAnnounce(spoken);
      return true;
    } catch (cause) {
      setError(deskFacingError(cause));
      return false;
    } finally {
      setBusy(null);
      if (key === "check") setRecheckStartedAt(null);
    }
  };

  const previewImport = async (csv: string, mapping?: CsvColumnMapping): Promise<CsvImportPreview> => {
    setError("");
    return (await api("/api/desk/import/preview", {
      method: "POST",
      body: JSON.stringify({ csv, mapping }),
    })) as CsvImportPreview;
  };

  const inspectImport = async (csv: string): Promise<CsvColumnMapping | null> => {
    setError("");
    const result = (await api("/api/desk/import/inspect", {
      method: "POST",
      body: JSON.stringify({ csv }),
    })) as { mapping: CsvColumnMapping | null; detail: string };
    if (!result.mapping) throw new Error(result.detail || "Bud could not read the columns.");
    return result.mapping;
  };

  const importReviewed = async (input: { csv: string; expectedDigest: string; expectedRevision: number; observedAt: number; mapping?: CsvColumnMapping }): Promise<void> => {
    setBusy("import");
    setError("");
    try {
      const next = (await api("/api/desk/import", {
        method: "POST",
        body: JSON.stringify(input),
      })) as DeskSnapshot;
      setSnap(next);
      dispatch({ type: "deskSnapshot", snapshot: next });
      setAnnounce("CSV imported");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBusy(null);
    }
  };

  const rows = useMemo(() => (snap ? buildDeskQueue(snap) : []), [snap]);
  const scopedRows = useMemo(() => {
    if (!taskScope) return rows;
    const ids = new Set(taskScope.ids);
    return rows.filter(row => row.propertyId && ids.has(row.propertyId));
  }, [rows, taskScope]);
  const visible = useMemo(() => filterDeskQueue(scopedRows, filter, query).filter(row => caseKind === "all" || row.kind === caseKind), [scopedRows, filter, query, caseKind]);
  const selected = visible.find((row) => row.id === selectedId) ?? visible[0];
  const counts = queueCounts(scopedRows);
  const bud = state.bots.find(bot => bot.name.trim().toLowerCase() === "bud") ?? state.bots[0];
  const askAboutCase = (intent: DeskAskIntent = "next") => {
    if (!snap || !selected) return;
    dispatch({ type: "stageAskContext", context: deskAskContext(snap, selected, crypto.randomUUID(), selected.draftId ? caseEdits.get(selected.draftId)?.body : undefined, { intent, unsavedNotes: selected.propertyId ? propertyEdits(selected.propertyId).notes : undefined }) });
    setAnnounce("Case attached in Ask. Review the request before sending.");
  };

  const recoverCase = useCallback(
    (item: DeskQueueItem, plan: DeskRecoveryPlan) => {
      if (plan.action === "book") {
        setMode("book");
        setAnnounce("Properties opened for matching");
        return;
      }
      if (plan.action === "you") {
        openWorkspaceSetup("apps");
        return;
      }
      if (plan.action !== "ask" || !plan.prompt) return;
      if (!snap) return;
      dispatch({ type: "stageAskContext", context: deskAskContext(snap, item, crypto.randomUUID(), item.draftId ? caseEdits.get(item.draftId)?.body : undefined, { intent: "investigate", unsavedNotes: item.propertyId ? propertyEdits(item.propertyId).notes : undefined }) });
      setAnnounce("Case attached in Ask. Review the request before sending.");
    },
    [dispatch, snap, caseEdits],
  );

  useEffect(() => {
    if (counts.now <= 0) {
      autoOpenedForNeedRef.current = false;
      return;
    }
    if (autoOpenedForNeedRef.current) return;
    if (typeof window === "undefined" || window.matchMedia("(min-width: 980px)").matches) return;
    autoOpenedForNeedRef.current = true;
    setQueueOpen(true);
    setFilter("now");
  }, [counts.now]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (mode !== "cases" || !visible.length) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
        if (
          target.closest('[role="listbox"]') &&
          (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End" || event.key === "Enter")
        ) {
          return;
        }
      }
      const index = visible.findIndex((row) => row.id === selected?.id);
      if (event.key === "ArrowDown" && index < visible.length - 1) {
        event.preventDefault();
        setSelectedId(visible[index + 1]!.id);
      }
      if (event.key === "ArrowUp" && index > 0) {
        event.preventDefault();
        setSelectedId(visible[index - 1]!.id);
      }
      if (event.key === "Escape") {
        setQueueOpen(false);
        setRailOpen(false);
      }
      if (event.key === "[" ) {
        event.preventDefault();
        setQueueOpen((value) => !value);
      }
      if (event.key === "]") {
        setRailTab("evidence");
        event.preventDefault();
        setRailOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, visible, selected]);

  if (!ready || !snap) {
    if (!state.connected && !snap) {
      const guide = workdayGuide({ connected: false, desk: null, workerReady: Boolean(state.hermes?.ready) });
      return (
        <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-paper text-ink-muted">
          <div className="text-[12px] font-semibold uppercase tracking-[0.12em]">{guide.eyebrow}</div>
          <div className="text-[14px] text-ink">{guide.title}</div>
          <div className="max-w-sm text-center text-[13px]">{guide.detail}</div>
        </main>
      );
    }
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-paper text-ink-muted">
        {ready && error ? (
          <>
            <CircleAlert size={18} className="text-danger" />
            <div className="max-w-sm text-center text-[14px] text-danger">{error}</div>
            <button type="button" onClick={() => void load()} className="rounded bg-agency px-3.5 py-2 text-[13px] font-medium text-white">
              Try again
            </button>
          </>
        ) : (
          <>
            <Loader2 size={20} className="animate-spin" />
            <div className="text-[14px]">Loading desk…</div>
          </>
        )}
      </main>
    );
  }

  const brief = morningBrief(snap);
  const timezone = snap.book?.agency.timezone || snap.timezone;
  const miss = snap.handsDetail && isDemoWorkerMiss(snap.hands, snap.handsDetail) ? missAction(snap.handsDetail) : null;
  const checkAction = deskCheckAction(snap);
  // Empty book already shows the primary check in MorningEmpty — keep the
  // header control secondary so the page has one agency CTA.
  const headerCheckPrimary = snap.lastRunAt != null;
  const empty =
    snap.lastRunAt == null ? (
      <MorningEmpty checkLabel={checkAction.label} brief={brief} busy={busy !== null} onAction={() => { if (!busy) void run(checkAction.path, "POST", undefined, "check", checkAction.path.endsWith("practice") ? "Sample morning ready" : "Recheck ran"); }} />
    ) : visible.length === 0 ? (
      query.trim() ? (
        <MorningEmpty brief={{ ...brief, headline: "No cases match that search." }} actionLabel="Clear search" onAction={() => setQuery("")} />
      ) : filter === "now" ? (
        <MorningEmpty brief={{ ...brief, headline: brief.headline }} />
      ) : (
        <MorningEmpty brief={{ ...brief, headline: "No cases in this filter." }} actionLabel="Show all tasks" onAction={() => { setFilter("all"); setCaseKind("all"); }} />
      )
    ) : null;

  return (
    <main className="desk-workspace flex h-full min-w-0 flex-1 flex-col bg-paper" data-density={layout.compact ? "compact" : "comfortable"} data-bud-pinned={preferences.showBud} style={{ "--desk-queue-width": `${preferences.queueWidth}px` } as React.CSSProperties}>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      {announce ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-line bg-sheet px-4 py-2 text-[13px] font-medium text-ink shadow-sm"
        >
          {announce}
        </div>
      ) : null}
      <header className="pm-desk-header shrink-0 border-b border-line px-5 pb-3 pt-4">
        <div className="pm-desk-toolbar">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <Building2 size={21} className="shrink-0 text-agency" />
            <h1 className="pm-screen-title text-ink">Desk</h1>
            <StatusLabel
              tone={snap.hands === "held" || isDemoWorkerMiss(snap.hands, snap.handsDetail) ? "hold" : snap.hands === "hermes" || snap.hands === "csv" ? "agency" : "muted"}
            >
              {handsChip(snap.hands)}
            </StatusLabel>
            {phonePaired(channels) ? (
              <StatusLabel
                tone={phoneChipTone(channels)}
                title="Your paired messaging app can receive supported review requests"
              >
                {phoneChip(channels)}
              </StatusLabel>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mode === "cases" ? (
              <button
                type="button"
                className="desk-queue-toggle pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink"
                aria-expanded={queueOpen}
                onClick={() => setQueueOpen((value) => !value)}
              >
                {queueOpen ? "Hide queue" : `Queue · ${counts.now}`}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (busy === "check") return;
                void run(checkAction.path, "POST", undefined, "check", checkAction.path.endsWith("practice") ? "Sample morning ready" : "Recheck ran");
              }}
              disabled={busy !== null}
              aria-busy={busy === "check"}
              className={cn(
                "pm-control flex items-center gap-2 rounded px-3.5 text-[14px] font-medium",
                headerCheckPrimary
                  ? "bg-agency text-white hover:bg-agency-hover"
                  : "border border-line bg-sheet text-ink hover:bg-selected",
                busy === "check" && "cursor-progress opacity-80",
              )}
            >
              {busy === "check" ? <Loader2 size={14} className="animate-spin" /> : null}
              {checkAction.label}
            </button>
            <button type="button" onClick={() => dispatch({ type: "showAsk" })} className="desk-secondary-button desk-chat-button">
              <MessageSquare size={16} aria-hidden />Ask Bud
            </button>
            <details className="desk-more">
              <summary className="desk-secondary-button">More</summary>
              <div className="desk-more-panel" role="group" aria-label="More Desk tools">
                <button type="button" className="desk-more-item" aria-pressed={jobRunsOpen} onClick={() => setJobRunsOpen((value) => !value)}>
                  {jobRunsOpen ? "Hide activity" : "Activity"}
                </button>
                {mode === "cases" ? (
                  <button
                    type="button"
                    className={cn("desk-more-item", preferences.showBud && "min-[1320px]:hidden")}
                    aria-expanded={railOpen}
                    onClick={() => setRailOpen((value) => !value)}
                  >
                    Bud & evidence
                  </button>
                ) : null}
                <button type="button" className="desk-more-item" aria-pressed={mode === "book"} onClick={() => setMode("book")}>
                  Book · import & addresses
                </button>
                <button type="button" className="desk-more-item" aria-pressed={mode === "batch"} onClick={() => setMode("batch")}>
                  Batch prepare
                </button>
                <div className="desk-more-layout">
                  <WorkspaceLayout />
                </div>
              </div>
            </details>
          </div>
        </div>
        <p className="pm-desk-subtitle mt-1 max-w-[46rem] text-[12.5px] text-ink-muted">
          {snap.demo || snap.mode === "demo" ? "Sample book. " : ""}
          {mode === "batch"
            ? "Prepare the same check across a few addresses, then review exceptions."
            : mode === "book"
              ? "Import or tidy the book when an address is missing — daily work stays on Needs you."
              : "Recheck the office systems, clear what needs you, let Bud assist. No second property catalogue."}
        </p>
        {mode !== "batch" && isDemoWorkerMiss(snap.hands, snap.handsDetail) && snap.handsDetail ? (
          <div role="status" className="mt-2 flex max-w-full flex-wrap items-center gap-2 border border-hold/30 bg-hold/10 px-3 py-2 text-[13px] text-hold">
            <span className="min-w-0 flex-1">Missed — facts held. {snap.handsDetail}</span>
            {miss ? (
              <button
                type="button"
                className="pm-control rounded border border-hold/40 bg-sheet px-3 text-[13px] text-ink"
                onClick={() => {
                  if (miss.hash.includes("recovery")) { location.hash = miss.hash; dispatch({ type: "showYou" }); }
                  else openWorkspaceSetup("bud");
                }}
              >
                {miss.label}
              </button>
            ) : null}
          </div>
        ) : null}
        {busy === "check" ? (
          <div role="status" className="mt-2 max-w-[46rem] rounded border border-agency/20 bg-agency/5 px-3 py-2 text-[13px] text-ink-secondary">
            <span className="font-medium text-ink">{recheckProgress(recheckElapsed).label}</span>
            <span> · {recheckProgress(recheckElapsed).reassurance}</span>
            <span className="ml-1 tabular-nums text-ink-muted">{recheckElapsed}s</span>
          </div>
        ) : null}
        {snap.recovery?.active ? (
          <div className="mt-3">
            <RecoveryNotice>Desk is in recovery. Writes, schedules and browser work are paused. The book was not replaced with Demo data. Open You to unlock with your recovery key.</RecoveryNotice>
          </div>
        ) : null}
        {error ? (
          <div
            className={cn(
              "mt-3 flex items-start gap-2 px-3 py-2.5 text-[13px]",
              error.startsWith("This Mac is out of space")
                ? "border border-hold/30 bg-hold/10 text-hold"
                : "border border-danger/30 bg-danger/10 text-danger",
            )}
          >
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError("")}
              className={cn(
                "shrink-0 text-[12px] underline-offset-2 hover:underline",
                error.startsWith("This Mac is out of space") ? "text-hold/80" : "text-danger/80",
              )}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {mode !== "batch" && <MorningBrief
          brief={brief}
          timezone={timezone}
          interactive
          collapsed={!briefExpanded}
          onToggle={() => setBriefExpanded((value) => !value)}
          onOpenAddress={(propertyId) => {
            const row = rows.find((item) => item.propertyId === propertyId);
            if (!row) return;
            setMode("cases");
            setFilter(row.bucket);
            setCaseKind("all");
            setQuery("");
            setTaskScope(null);
            setSelectedId(row.id);
            setQueueOpen(false);
          }}
        />}
        {mode !== "batch" ? <div className="mt-3 space-y-3"><MailWorkPanel compact /><ExpectedBillsBoard compact /><SharedWorkPanel /></div> : null}
        {/* Setup stays available with the expanded overview and on You. */}
        {mode === "batch" || !briefExpanded ? null : (
          <GoLiveCard
            mode={snap.mode}
            agencyName={snap.book?.agency.name ?? ""}
            workerReady={Boolean(state.hermes?.ready)}
            compact
            jurisdictions={snap.book?.agency.jurisdictions ?? []}
            office={snap.book?.office ? coerceOffice(snap.book.office) : undefined}
            onConnectExport={() => setMode("book")}
            onAttachWorker={() => { openWorkspaceSetup("bud"); }}
            onNameAgency={() => { openWorkspaceSetup("office"); }}
          />
        )}
        {briefExpanded && keysHint && mode === "cases" ? (
          <p className="pm-desk-hint mt-2 flex items-center gap-3 text-[12px] text-ink-muted"><span>↑↓ move the queue · [ ] toggle Queue / Evidence</span><button type="button" onClick={dismissKeysHint} className="text-agency">Got it</button></p>
        ) : null}
        <nav className="desk-workspace-nav" aria-label="Desk workspace">
          <div className="desk-workspace-tabs">
            <button type="button" aria-pressed={mode === "cases"} onClick={() => setMode("cases")}>
              Needs you{counts.now > 0 ? <span>{counts.now}</span> : null}
            </button>
            {mode !== "cases" ? (
              <button type="button" aria-pressed={true} onClick={() => setMode("cases")} className="desk-workspace-back">
                Back to Needs you
              </button>
            ) : null}
          </div>
          <span className="desk-workspace-help">
            {mode === "cases"
              ? "Exceptions and wording from Recheck — Bud helps, you decide"
              : mode === "book"
                ? "Book tools for import and missing addresses"
                : "Batch prepare across a few addresses"}
          </span>
        </nav>
        {jobRunsOpen ? <div className="desk-activity-feed"><JobRunFeed limit={6} /></div> : null}
      </header>

      {mode === "batch" ? <BatchWorkspace snapshot={snap} scope={batchScope} onClearScope={() => setBatchScope(null)} openNewDraft={openNewBatchDraft} onDraftOpened={() => setOpenNewBatchDraft(false)}/> : mode === "book" ? (
        <DeskBook
          operationError={error}
          snap={snap}
          busy={busy}
          onGroupTasks={(scope) => {
            setTaskScope(scope); setFilter("all"); setCaseKind("all"); setQuery("");
            const ids = new Set(scope.ids);
            setSelectedId(rows.find(row => row.propertyId && ids.has(row.propertyId))?.id ?? null);
            setMode("cases"); setQueueOpen(true);
          }}
          onGroupBatch={(scope) => { setBatchScope(scope); setOpenNewBatchDraft(true); setMode("batch"); }}
          onOpenTasks={(property) => {
            const first = rows.find(row => row.propertyId === property.id);
            setMode("cases");
            setFilter("all");
            setCaseKind("all");
            setTaskScope({ label: property.address, ids: [property.id] });
            setQuery("");
            setSelectedId(first?.id ?? null);
            setQueueOpen(!first);
          }}
          onAdd={(input) => run("/api/desk/properties", "POST", input, "add", "Property added")}
          onAllowBookProposal={(id) => void run(`/api/desk/book-proposals/${id}/allow`, "POST", {}, id, "Property added to the book")}
          onDenyBookProposal={(id) => void run(`/api/desk/book-proposals/${id}/deny`, "POST", {}, id)}
          onAllowAllBookProposals={() => void run("/api/desk/book-proposals/allow-all", "POST", {}, "allow-all", "Properties added to the book")}
          onSave={(id, options) => run(`/api/desk/properties/${id}`, "PATCH", options, id, "Options saved")}
          onNotes={(id, body) => run(`/api/desk/properties/${id}/notes`, "PUT", { body }, `notes-${id}`, "Notes saved")}
          onDelete={(id) => void run(`/api/desk/properties/${id}`, "DELETE", undefined, `delete-${id}`, "Property removed")}
          onReset={() => void run("/api/desk/reset", "POST", undefined, "reset", "Sample morning replayed")}
          onPreviewImport={previewImport}
          onInspect={inspectImport}
          onImport={importReviewed}
        />
      ) : (
        <SplitView
          className="desk-task-split"
          queueOpen={queueOpen}
          railOpen={railOpen}
          onCloseQueue={() => setQueueOpen(false)}
          queue={
            <QueuePane
              scope={taskScope}
              onClearScope={() => setTaskScope(null)}
              caseKind={caseKind}
              onCaseKind={setCaseKind}
              filter={filter}
              onFilter={setFilter}
              query={query}
              onQuery={setQuery}
              rows={visible}
              counts={counts}
              selectedId={selected?.id}
              onClose={() => setQueueOpen(false)}
              onHighlight={setSelectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setQueueOpen(false);
              }}
            />
          }
          canvas={
            <DeskCase
              key={selected?.id ?? "empty"}
              edits={caseEdits}
              snap={snap}
              item={selected}
              busy={busy}
              empty={empty}
              onAllow={(draft) => void run(`/api/desk/drafts/${draft.id}/allow`, "POST", { expectedRevision: snap.revision }, draft.id, "Wording allowed")}
              onDeny={(draft, reason) =>
                void run(
                  `/api/desk/drafts/${draft.id}/deny`,
                  "POST",
                  { expectedRevision: snap.revision, ...(reason ? { reason } : {}) },
                  draft.id,
                  "Wording denied",
                )
              }
              onEdit={(draft, body, expectedRevision) => run(`/api/desk/drafts/${draft.id}`, "PATCH", { body, expectedRevision }, draft.id, "Wording saved")}
              onAsk={() => askAboutCase()}
              onEvidence={() => { setRailTab("evidence"); setRailOpen(true); }}
              onCopy={(body) => {
                const street = selected?.address ? selected.address.split(",")[0]?.trim() : "";
                void navigator.clipboard.writeText(body).then(
                  () => setAnnounce(street ? `Copied… ${street}` : "Copied…"),
                  () => setError("Copy was unavailable. Select the wording and copy it manually."),
                );
              }}
              onPrepare={(draft) => void run(`/api/desk/drafts/${draft.id}/prepare`, "POST", undefined, `prepare-${draft.id}`, "Portal prepared")}
              onRecover={recoverCase}
            />
          }
          rail={
            <div className="desk-assistant-rail">
              <div className="desk-rail-tabs" role="group" aria-label="Case support">
                <button type="button" aria-pressed={railTab === "bud"} onClick={() => setRailTab("bud")}>Bud</button>
                <button type="button" aria-pressed={railTab === "evidence"} onClick={() => setRailTab("evidence")}>Evidence</button>
                <button type="button" className="desk-rail-close desk-icon-button" aria-label="Close case support" onClick={() => setRailOpen(false)}><X size={16} /></button>
              </div>
              {railTab === "bud" ? <DeskBud availability={budAvailability(state.hermes, state.connected, Boolean(state.desk?.recovery?.active))} item={selected} connected={state.connected} ready={Boolean(state.hermes?.ready)} working={Boolean(bud?.busy)} onAsk={askAboutCase} onOpenChat={() => dispatch({ type: "showAsk" })} onSetup={() => { openWorkspaceSetup("bud"); }} /> : <DeskEvidence
                snap={snap}
                item={selected}
                onPresent={(presentation) => void run("/api/desk/handoff/present", "POST", { presentation }, "present", "Browser view changed")}
              />}
            </div>
          }
        />
      )}
    </main>
  );
}

function queueRowId(id: string): string {
  return `queue-row-${id}`;
}

function QueuePane({
  scope,
  onClearScope,
  caseKind,
  onCaseKind,
  filter,
  onFilter,
  query,
  onQuery,
  rows,
  counts,
  selectedId,
  onHighlight,
  onSelect,
  onClose,
}: {
  scope: PropertyScope | null;
  onClearScope: () => void;
  caseKind: string;
  onCaseKind: (kind: string) => void;
  filter: QueueFilter;
  onFilter: (filter: QueueFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  rows: ReturnType<typeof filterDeskQueue>;
  counts: QueueCounts;
  selectedId?: string;
  onHighlight: (id: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { preferences } = useWorkspacePreferences();
  const pageSize = preferences.pageSize;
  const page = Math.floor(Math.max(0, rows.findIndex(row => row.id === selectedId)) / pageSize);
  const pageRows = rows.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => { document.getElementById(queueRowId(selectedId ?? ""))?.scrollIntoView({ block: "nearest" }); }, [selectedId]);
  const filters: Array<[QueueFilter, string]> = [
    ["now", "Needs you"],
    ["next", "Next"],
    ["waiting", "Waiting"],
    ["done", "Done"],
    ["all", "All"],
  ];
  const highlight = (id: string) => {
    onHighlight(id);
    document.getElementById(queueRowId(id))?.scrollIntoView({ block: "nearest" });
  };
  const scrollRef = useWorkspaceScroll("desk-queue");
  return (
    <div className="flex h-full min-h-0 flex-col bg-sheet">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2.5">
        <h2 className="mr-1 text-[14px] font-semibold text-ink">Task queue</h2>
        {counts.licensee > 0 ? (
          <StatusLabel tone="danger" title="For the licensed person — RealBud will not draft a notice">
            {counts.licensee} licensee
          </StatusLabel>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="desk-queue-toggle pm-control ml-auto inline-flex items-center gap-1.5 rounded border border-line bg-paper px-2.5 text-[12px] text-ink"
          aria-label="Close queue"
        >
          <X size={14} aria-hidden />
          Close
        </button>
      </div>
      <div className="desk-queue-filters" role="toolbar" aria-label="Queue filters">
        {filters.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => onFilter(value)}
            className={cn(
              "min-h-9 rounded border px-2 py-1.5 text-[12px]",
              filter === value ? "border-agency bg-selected text-ink" : "border-line bg-paper text-ink-muted",
            )}
          >
            {label}{value !== "all" ? ` · ${counts[value]}` : ""}
          </button>
        ))}
      </div>
      <label className="block border-b border-line px-3 py-2 text-[11px] text-ink-muted">
        Search address or person
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          className="mt-1 w-full rounded border border-line bg-paper px-2 py-1.5 text-[13px] text-ink"
        />
      </label>
      {scope && <div className="property-scope-banner"><strong>{scope.label}</strong><button type="button" onClick={onClearScope}>Show all properties</button></div>}
      <label className="desk-case-kind">Type<select value={caseKind} onChange={e => onCaseKind(e.target.value)}><option value="all">All case types</option>{Object.entries(CASE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        role="listbox"
        tabIndex={0}
        aria-label="Case queue"
        aria-activedescendant={selectedId ? queueRowId(selectedId) : undefined}
        onKeyDown={(event) => {
          if (!rows.length) return;
          const current = rows.findIndex((row) => row.id === selectedId);
          if (event.key === "ArrowDown") {
            event.preventDefault();
            const next = current < 0 ? 0 : Math.min(rows.length - 1, current + 1);
            highlight(rows[next]!.id);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            const next = current < 0 ? rows.length - 1 : Math.max(0, current - 1);
            highlight(rows[next]!.id);
          } else if (event.key === "Home") {
            event.preventDefault();
            highlight(rows[0]!.id);
          } else if (event.key === "End") {
            event.preventDefault();
            highlight(rows[rows.length - 1]!.id);
          } else if (event.key === "Enter") {
            event.preventDefault();
            const id = selectedId ?? rows[0]?.id;
            if (id) onSelect(id);
          }
        }}
      >
        {rows.length === 0 ? (
          query.trim() ? (
            <div className="px-3 py-4 text-[13px] text-ink-muted"><p>No cases match “{query}”.</p><button type="button" className="pm-control text-agency" onClick={() => onQuery("")}>Clear search</button></div>
          ) : filter === "now" ? (
            <div className="space-y-3 px-3 py-4 text-[13px] text-ink-muted">
              <p>Nothing needs you right now.</p>
              <button
                type="button"
                onClick={() => onFilter("waiting")}
                className="pm-control rounded border border-line bg-paper px-3 text-[13px] text-ink"
              >
                Open Waiting
              </button>
            </div>
          ) : (
            <p className="px-3 py-4 text-[13px] text-ink-muted">No cases in this filter. Try another filter above.</p>
          )
        ) : (
          pageRows.map((row) => (
            <CaseQueueRow
              key={row.id}
              id={queueRowId(row.id)}
              title={row.address}
              meta={`${CASE_KIND_LABELS[row.kind] ?? row.kind} · ${row.meta}`}
              action={row.action}
              selected={row.id === selectedId}
              onSelect={() => onSelect(row.id)}
            />
          ))
        )}
      </div>
      {rows.length > 0 && <div className="desk-pagination" aria-label="Task pages"><span>{page * pageSize + 1}–{Math.min(rows.length, (page + 1) * pageSize)} of {rows.length}</span><button type="button" disabled={page === 0} onClick={() => onHighlight(rows[(page - 1) * pageSize]!.id)}>Previous</button><button type="button" disabled={(page + 1) * pageSize >= rows.length} onClick={() => onHighlight(rows[(page + 1) * pageSize]!.id)}>Next</button></div>}
    </div>
  );
}

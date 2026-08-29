import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Building2, CircleAlert, Loader2, Upload } from "lucide-react";

import { cn } from "@/lib/cn";
import { deskCopyPulse, DESK_ROW_MOTION_MS, RECHECK_GRAPH_LINGER_MS, recheckBeatMs, recheckButtonLabel, recheckLandCaption, recheckLandRevealed } from "@/lib/desk-motion";
import { prefersReducedMotion, staggerMs, withViewTransition } from "@/lib/motion";
import type { DeskSnapshot, Draft, Property } from "@/lib/desk";
import { buildDeskQueue, filterDeskQueue, groupDeskQueue, queueCounts, type DeskQueueItem, type QueueFilter } from "@/lib/desk-queue";
import { CaseQueueRow, RecoveryNotice, SplitView, StatusLabel } from "./pm";
import { DeskBook } from "./desk/DeskBook";
import { DeskCase } from "./desk/DeskCase";
import { DeskEvidence } from "./desk/DeskEvidence";
import { CASE_KIND_LABELS } from "./desk/labels";
import { api, useStore } from "@/state/store";
import { GoLiveChecklist } from "./GoLiveChecklist";
import { AskActionCard } from "./AskActionCard";
import { PmsImportReviewDialog } from "./desk/PmsImportReviewDialog";
import type { PmsImportPreview } from "@shared/contracts";

// The server caps JSON bodies at 1 MB. Leave headroom for JSON escaping so a
// client-accepted CSV cannot become a server-rejected request in transit.
const MAX_CSV_BYTES = 450_000;

interface PendingPmsImport {
  csv: string;
  fileLabel: string;
  preview: PmsImportPreview;
}

export function DeskPage({ onOpenSetupJourney }: { onOpenSetupJourney?: () => void } = {}) {
  const { state, dispatch } = useStore();
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingPmsImport | null>(null);
  const [importReviewError, setImportReviewError] = useState("");
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"cases" | "book">("cases");
  const [filter, setFilter] = useState<QueueFilter>("needs-you");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shareFromId, setShareFromId] = useState<string | null>(null);
  const [landingIds, setLandingIds] = useState<string[]>([]);
  const [exitingIds, setExitingIds] = useState<string[]>([]);
  const [exitingRows, setExitingRows] = useState<DeskQueueItem[]>([]);
  const [needTick, setNeedTick] = useState(false);
  const [checkedTick, setCheckedTick] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [query, setQuery] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [caseDetail, setCaseDetail] = useState<DeskSnapshot | null>(null);
  const [propertyDetails, setPropertyDetails] = useState<Record<string, DeskSnapshot>>({});
  const dragDepth = useRef(0);
  const csvInput = useRef<HTMLInputElement>(null);
  const checkLand = useRef(false);
  const prevQueueIds = useRef<Set<string>>(new Set());
  const pendingExit = useRef<DeskQueueItem | null>(null);
  const countsPrimed = useRef(false);
  const checkedPrimed = useRef(false);

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
    void load();
  }, [load]);

  useEffect(() => {
    if (state.desk) setSnap(state.desk);
  }, [state.desk]);

  const run = async (path: string, method: string, body?: unknown, key: string = method, spoken?: string) => {
    setBusy(key);
    setError("");
    setCaseDetail(null);
    setPropertyDetails({});
    try {
      await api(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }) as DeskSnapshot & { draft?: Draft; property?: Property };
      // Mutation responses can contain the command's focused result. Reload
      // the bounded queue projection so portfolio history never remains in
      // renderer state after the action completes.
      await load();
      if (spoken) setAnnounce(spoken);
      if (key === "check" || key === "demo-inbox") checkLand.current = true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A stale revision or an uncertain atomic-commit outcome must not leave
      // the renderer presenting the snapshot it attempted to mutate.
      try {
        const next = (await api("/api/desk")) as DeskSnapshot;
        setSnap(next);
        dispatch({ type: "deskSnapshot", snapshot: next });
      } catch {
        // Keep the original actionable mutation error; the normal load path
        // retries authoritative state when the PM returns to Desk.
      }
      setError(message);
    } finally {
      setBusy(null);
    }
  };

  const previewCsv = async (csv: string, fileLabel = "Selected PMS export") => {
    if (!csv.trim()) {
      setError("That CSV is empty.");
      return;
    }
    if (new Blob([csv]).size > MAX_CSV_BYTES) {
      setError("That CSV is too large. Export only the current property ledger (450 KB maximum).");
      return;
    }
    if (!snap) return;
    if (busy !== null && busy !== "import-preview") {
      setError("Wait for the current Desk change to finish, then choose the export again.");
      return;
    }
    setBusy("import-preview");
    setError("");
    setImportReviewError("");
    try {
      const body = await api("/api/desk/import-preview", {
        method: "POST",
        body: JSON.stringify({ csv, expectedRevision: snap.revision }),
      }) as { preview?: PmsImportPreview };
      if (body.preview?.kind !== "realbud.pms-import-preview.v1") {
        throw new Error("RealBud could not verify the import review response.");
      }
      setPendingImport({ csv, fileLabel: fileLabel.trim().slice(0, 120) || "Selected PMS export", preview: body.preview });
      setAnnounce("PMS export is ready to review");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (pendingImport) setImportReviewError(message);
      else setError(message);
    } finally {
      setBusy(null);
    }
  };

  const commitPmsImport = async () => {
    const pending = pendingImport;
    if (!pending) return;
    setBusy("import");
    setError("");
    setImportReviewError("");
    try {
      await api("/api/desk/import", {
        method: "POST",
        body: JSON.stringify({
          csv: pending.csv,
          expectedRevision: pending.preview.deskRevision,
          observedAt: pending.preview.observedAt,
          previewDigest: pending.preview.csvDigest,
        }),
      });
      await load();
      setPendingImport(null);
      setAnnounce("PMS export imported");
    } catch (cause) {
      setImportReviewError(cause instanceof Error ? cause.message : String(cause));
      // Refresh the revision behind the modal. Review again will parse the
      // same selected bytes against this current authoritative book.
      try {
        await load();
      } catch {
        // Keep the exact import failure visible in the review sheet.
      }
    } finally {
      setBusy(null);
    }
  };

  const importFile = async (file: File) => {
    const csvLike = file.name.toLowerCase().endsWith(".csv") || (!file.name.includes(".") && file.type === "text/csv");
    if (!csvLike) {
      setError("Choose a CSV export from your PMS.");
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setError("That CSV is too large. Export only the current property ledger (450 KB maximum).");
      return;
    }
    if (busy !== null) {
      setError("Wait for the current Desk change to finish, then drop the CSV again.");
      return;
    }
    try {
      await previewCsv(await file.text(), file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const rows = useMemo(() => (snap ? buildDeskQueue(snap) : []), [snap]);
  const visible = useMemo(() => filterDeskQueue(rows, filter, query), [rows, filter, query]);
  const selected = rows.find((row) => row.id === selectedId) ?? visible[0];
  const selectedCaseId = selected?.workItemId ?? selected?.escalationId;
  const selectedSnap = caseDetail && snap && caseDetail.revision === snap.revision && selectedCaseId && (
    caseDetail.workItems.some((item) => item.id === selectedCaseId) ||
    caseDetail.escalations.some((item) => item.id === selectedCaseId) ||
    caseDetail.book?.cases.some((item) => item.id === selectedCaseId)
  ) ? caseDetail : snap;
  const counts = queueCounts(rows);
  const deskSummary = !snap
    ? ""
    : snap.lastRunAt == null
      ? "Bud is ready to check the book and bring back only the exceptions."
      : counts["needs-you"] > 0
        ? `Bud prepared ${counts["needs-you"]} ${counts["needs-you"] === 1 ? "item" : "items"} for your decision. Review the exceptions; the rest of the book stays out of your way.`
        : counts.waiting > 0
          ? `Nothing needs a decision. Bud is tracking ${counts.waiting} ${counts.waiting === 1 ? "follow-up" : "follow-ups"} while someone else responds.`
          : counts.handling > 0
            ? `Nothing needs a decision. Bud is handling ${counts.handling} ${counts.handling === 1 ? "item" : "items"}.`
          : "Nothing needs a decision. Bud has already checked the current book.";
  const bud = state.bots.find((bot) => bot.id === "bud" || bot.name === "Bud") ?? state.bots[0];
  const desktopRemindersAvailable = Boolean(window.ogb?.notifyRoutine);
  const pendingAskActions = useMemo(
    () => bud
      ? bud.messages.filter((message) => message.kind === "action" && message.action?.status === "pending")
      : [],
    [bud],
  );
  const pendingActionBookIds = useMemo(
    () => new Set(pendingAskActions.flatMap((message) =>
      message.action?.kind === "add-property" ? message.action.bookProposalIds : [],
    )),
    [pendingAskActions],
  );
  const bookSnap = useMemo(() => {
    if (!snap?.book || pendingActionBookIds.size === 0) return snap;
    return {
      ...snap,
      book: {
        ...snap.book,
        // The Ask action card is the review UI for these exact proposal ids.
        // Hiding the lower-level duplicate avoids two Allow controls whose
        // receipts could otherwise appear to disagree.
        bookProposals: snap.book.bookProposals.filter((proposal) => !pendingActionBookIds.has(proposal.id)),
      },
    };
  }, [snap, pendingActionBookIds]);

  const queueRows = useMemo(() => {
    const ids = new Set(visible.map((row) => row.id));
    const ghosts = exitingRows.filter((row) => !ids.has(row.id));
    return ghosts.length ? [...visible, ...ghosts] : visible;
  }, [visible, exitingRows]);

  const noteExit = useCallback((row?: DeskQueueItem) => {
    pendingExit.current = row ?? null;
  }, []);

  useEffect(() => {
    const ids = visible.map((row) => row.id);
    if (checkLand.current) {
      checkLand.current = false;
      const landed = ids.filter((id) => !prevQueueIds.current.has(id));
      prevQueueIds.current = new Set(ids);
      if (landed.length === 0 || prefersReducedMotion()) return;
      setLandingIds(landed);
      window.setTimeout(() => {
        setLandingIds((current) => current.filter((id) => !landed.includes(id)));
      }, staggerMs(landed.length - 1) + DESK_ROW_MOTION_MS);
      return;
    }
    prevQueueIds.current = new Set(ids);
  }, [visible]);

  useEffect(() => {
    const pending = pendingExit.current;
    if (!pending || visible.some((row) => row.id === pending.id)) return;
    pendingExit.current = null;
    if (prefersReducedMotion()) return;
    setExitingRows([pending]);
    setExitingIds([pending.id]);
    window.setTimeout(() => {
      setExitingRows((current) => current.filter((row) => row.id !== pending.id));
      setExitingIds((current) => current.filter((id) => id !== pending.id));
    }, DESK_ROW_MOTION_MS);
  }, [visible]);

  useEffect(() => {
    if (!countsPrimed.current) {
      countsPrimed.current = true;
      return;
    }
    setNeedTick(true);
    const hide = window.setTimeout(() => setNeedTick(false), DESK_ROW_MOTION_MS);
    return () => window.clearTimeout(hide);
  }, [counts["needs-you"]]);

  useEffect(() => {
    if (snap?.loadOff?.recordsChecked == null) return;
    if (!checkedPrimed.current) {
      checkedPrimed.current = true;
      return;
    }
    setCheckedTick(true);
    const hide = window.setTimeout(() => setCheckedTick(false), DESK_ROW_MOTION_MS);
    return () => window.clearTimeout(hide);
  }, [snap?.loadOff?.recordsChecked]);

  const openCase = useCallback((id: string) => {
    if (!selectedId) {
      flushSync(() => setShareFromId(id));
    }
    withViewTransition(() => {
      setSelectedId(id);
      setShareFromId(null);
      setQueueOpen(false);
    });
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !selected || selected.id === selectedId) return;
    setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    if (mode !== "cases" || !selectedCaseId || !snap) {
      setCaseDetail(null);
      return;
    }
    let active = true;
    setCaseDetail(null);
    void api(`/api/desk/cases/${selectedCaseId}/detail`)
      .then((detail: DeskSnapshot) => {
        if (active && detail.revision === snap.revision) setCaseDetail(detail);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [mode, selectedCaseId, snap?.revision]);

  const loadPropertyDetail = useCallback(async (id: string) => {
    try {
      const detail = (await api(`/api/desk/properties/${id}/detail`)) as DeskSnapshot;
      setPropertyDetails((current) => detail.revision === snap?.revision ? { ...current, [id]: detail } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, [snap?.revision]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      if (event.key === "Escape") {
        setQueueOpen(false);
        setRailOpen(false);
        return;
      }
      if (event.key === "[") {
        event.preventDefault();
        if (mode === "book") {
          setMode("cases");
          setQueueOpen(true);
        } else {
          setQueueOpen((value) => !value);
        }
        return;
      }
      if (event.key === "]") {
        event.preventDefault();
        if (mode === "book") {
          setMode("cases");
          setRailOpen(true);
        } else {
          setRailOpen((value) => !value);
        }
        return;
      }
      if (mode !== "cases" || !visible.length) return;
      const index = visible.findIndex((row) => row.id === selected?.id);
      if (event.key === "ArrowDown" && index < visible.length - 1) {
        event.preventDefault();
        openCase(visible[index + 1]!.id);
      }
      if (event.key === "ArrowUp" && index > 0) {
        event.preventDefault();
        openCase(visible[index - 1]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, visible, selected, openCase]);

  if (!ready || !snap) {
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

  const emptyReason =
    snap.lastRunAt == null
      ? "Press Recheck to run this morning’s money check. Opening Desk never starts a check."
      : visible.length === 0
        ? query.trim()
          ? "No cases match that search."
          : filter === "needs-you"
            ? "Nothing waiting. Recheck after you change options, or open Held."
            : "No cases in this filter."
        : "";

  return (
    <main
      className="relative flex h-full min-w-0 flex-1 flex-col bg-paper"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        const files = [...event.dataTransfer.files];
        if (files.length !== 1) {
          setError("Drop one current PMS CSV at a time.");
          return;
        }
        void importFile(files[0]!);
      }}
    >
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      <input
        ref={csvInput}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
          event.target.value = "";
        }}
      />
      {pendingImport ? (
        <PmsImportReviewDialog
          preview={pendingImport.preview}
          fileLabel={pendingImport.fileLabel}
          busy={busy === "import"}
          reviewing={busy === "import-preview"}
          error={importReviewError}
          onCancel={() => {
            setPendingImport(null);
            setImportReviewError("");
          }}
          onConfirm={() => void commitPmsImport()}
          onReviewAgain={() => void previewCsv(pendingImport.csv, pendingImport.fileLabel)}
        />
      ) : null}
      {dragActive ? (
        <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center border-2 border-dashed border-agency bg-selected/95 text-agency shadow-[0_14px_40px_rgb(37_35_31/0.15)]">
          <div className="flex items-center gap-3 text-[15px] font-semibold">
            <Upload size={21} />
            Drop one current PMS CSV to connect the book
          </div>
        </div>
      ) : null}
      <header className="shrink-0 border-b border-line px-5 pb-3 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <Building2 size={21} className="text-agency" />
              <h1 className="pm-screen-title text-ink">Desk</h1>
            </div>
            <p className="mt-1 max-w-[46rem] text-[12.5px] text-ink-muted">
              {snap.demo || snap.mode === "demo" ? "Demo book. " : ""}
              {deskSummary}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink min-[1100px]:hidden"
              aria-expanded={queueOpen}
              onClick={() => {
                if (mode === "book") {
                  setMode("cases");
                  setQueueOpen(true);
                  return;
                }
                setQueueOpen((value) => !value);
              }}
            >
              Queue
            </button>
            <button
              type="button"
              className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink min-[960px]:hidden"
              aria-expanded={railOpen}
              onClick={() => {
                if (mode === "book") {
                  setMode("cases");
                  setRailOpen(true);
                  return;
                }
                setRailOpen((value) => !value);
              }}
            >
              Evidence
            </button>
            <button
              type="button"
              aria-pressed={mode === "book"}
              onClick={() => setMode((value) => (value === "book" ? "cases" : "book"))}
              className={cn("pm-control rounded border px-3 text-[13px]", mode === "book" ? "border-agency bg-selected text-ink" : "border-line bg-sheet text-ink")}
            >
              Properties
            </button>
            <button
              type="button"
              onClick={() => void run("/api/desk/check", "POST", undefined, "check", "Recheck finished")}
              disabled={busy != null}
              aria-busy={busy === "check"}
              aria-label="Recheck the current book"
              className="pm-control flex items-center gap-2 rounded bg-agency px-3.5 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-60"
            >
              {busy === "check" ? (
                <Loader2 size={14} className={prefersReducedMotion() ? undefined : "animate-spin"} aria-hidden="true" />
              ) : null}
              {recheckButtonLabel(busy === "check")}
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
          <StatusLabel tone="agency" className={needTick ? "count-tick" : undefined}>{counts["needs-you"]} need you</StatusLabel>
          <StatusLabel tone="muted">{counts.waiting} waiting</StatusLabel>
          <StatusLabel tone="muted">{counts.handling} Bud handling</StatusLabel>
          <StatusLabel tone="muted">{snap.properties.length} properties</StatusLabel>
          {snap.loadOff && snap.lastRunAt != null ? (
            <>
              <StatusLabel tone="muted" className={checkedTick ? "count-tick" : undefined}>{snap.loadOff.recordsChecked} checked</StatusLabel>
              <StatusLabel tone="muted">{snap.loadOff.draftsPrepared} drafts prepared</StatusLabel>
              {snap.loadOff.followUpsClosed > 0 ? <StatusLabel tone="muted">{snap.loadOff.followUpsClosed} follow-ups closed</StatusLabel> : null}
            </>
          ) : null}
          <StatusLabel tone={snap.hands === "held" ? "hold" : snap.hands === "hermes" || snap.hands === "csv" ? "agency" : "muted"}>
            {snap.hands === "hermes" ? "Worker live" : snap.hands === "csv" ? "CSV live" : snap.hands === "held" ? "Held" : "Demo"}
          </StatusLabel>
        </div>
        <RecheckGraph
          running={busy === "check"}
          properties={snap.properties.map((property) => ({ id: property.id, address: property.address }))}
          recordsChecked={snap.loadOff?.recordsChecked}
        />
        {snap.recovery?.active ? (
          <div className="mt-3">
            <RecoveryNotice>Desk is in recovery. Writes, schedules and browser work are paused. The book was not replaced with Demo data. Restart RealBud once; if it stays locked, open You for the guided recovery step.</RecoveryNotice>
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 flex items-start gap-2 border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : null}
        {(snap.properties.length === 0 || snap.recovery?.active) ? (
        <div className="mt-3 empty:hidden">
          <GoLiveChecklist
            mode={snap.mode}
            recoveryActive={Boolean(snap.recovery?.active)}
            worker={state.hermes}
            agencyName={snap.book?.agency.name}
            onOpenPortfolio={() => dispatch({ type: "showAsk" })}
            onOpenDesk={() => setMode("book")}
            onOpenWorker={() => {
              if (onOpenSetupJourney) onOpenSetupJourney();
              else dispatch({ type: "showYou", focus: "worker" });
            }}
            onOpenAgency={() => dispatch({ type: "showYou", focus: "agency" })}
            onOpenComputerUse={() => dispatch({ type: "showYou", focus: "computer-use" })}
            onOpenRecovery={() => dispatch({ type: "showYou", focus: "recovery" })}
            onOpenReminders={() => dispatch({ type: "showYou", focus: "desktop-reminders" })}
            onOpenConnections={() => dispatch({ type: "showYou", focus: "connections" })}
            remindersAvailable={desktopRemindersAvailable}
            remindersOn={Boolean(bud?.notifications)}
            pocket={state.config?.pocket}
            compact
          />
        </div>
        ) : null}
      </header>

      {bud && pendingAskActions.length > 0 ? (
        <aside className="shrink-0 border-b border-line bg-app px-5 py-3" aria-labelledby="desk-bud-changes-title">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="desk-bud-changes-title" className="text-[12.5px] font-semibold text-ink">Bud prepared changes</h2>
              <p className="text-[11.5px] text-ink-muted">Nothing below applies until you Allow it.</p>
            </div>
            <button type="button" onClick={() => dispatch({ type: "showAsk" })} className="text-[12px] font-medium text-agency hover:underline">
              View conversation
            </button>
          </div>
          <div className="grid max-h-72 gap-2 overflow-y-auto lg:grid-cols-2">
            {pendingAskActions.map((message) => (
              <AskActionCard key={message.id} botId={bud.id} threadId={bud.threadId} message={message} compact />
            ))}
          </div>
        </aside>
      ) : null}

      {mode === "book" ? (
        <div key="book" className="desk-door flex min-h-0 min-w-0 flex-1 flex-col">
        <DeskBook
          snap={bookSnap ?? snap}
          busy={busy}
          onAdd={(input) => void run("/api/desk/properties", "POST", input, "add", "Property added")}
          onAllowBookProposal={(id) => void run(`/api/desk/book-proposals/${id}/allow`, "POST", { expectedRevision: snap.revision }, id, "Property added to the book")}
          onDenyBookProposal={(id) => void run(`/api/desk/book-proposals/${id}/deny`, "POST", {}, id)}
          onAllowAllBookProposals={() => {
            const ids = (bookSnap?.book?.bookProposals ?? []).map((p) => p.id);
            void run(
              "/api/desk/book-proposals/allow",
              "POST",
              { ids, expectedRevision: snap.revision },
              "allow-all-book-proposals",
              `${ids.length} ${ids.length === 1 ? "property" : "properties"} added to the book`,
            );
          }}
          onSave={(id, options) => void run(`/api/desk/properties/${id}`, "PATCH", options, id, "Options saved")}
          onNotes={(id, body) => void run(`/api/desk/properties/${id}/notes`, "PUT", { body }, `notes-${id}`, "Notes saved")}
          onDelete={(id) => void run(`/api/desk/properties/${id}`, "DELETE", undefined, `delete-${id}`, "Property removed")}
          onReset={() => void run("/api/desk/reset", "POST", undefined, "reset", "Sample morning replayed")}
          onDemoInbox={snap.demo
            ? () => void run("/api/desk/inbound/demo", "POST", { expectedRevision: snap.revision }, "demo-inbox", "Demo inbox triaged")
            : undefined}
          onImport={(file) => void importFile(file)}
          onOpenAsk={() => dispatch({ type: "showAsk" })}
          propertyDetails={propertyDetails}
          onLoadProperty={loadPropertyDetail}
          onResolveImport={(issueId, action, propertyId) => void run(
            `/api/desk/import-issues/${issueId}/${action === "linked" ? "link" : "reject"}`,
            "POST",
            {
              expectedRevision: snap.revision,
              propertyId,
              requestId: `import-resolution:${crypto.randomUUID()}`,
            },
            `import-${issueId}`,
            action === "linked" ? "Import row linked" : "Import row rejected",
          )}
        />
        </div>
      ) : (
        <div key="cases" className="desk-door flex min-h-0 min-w-0 flex-1 flex-col">
        <SplitView
          queueOpen={queueOpen}
          railOpen={railOpen}
          queue={
            <QueuePane
              filter={filter}
              onFilter={setFilter}
              query={query}
              onQuery={setQuery}
              rows={queueRows}
              counts={counts}
              total={rows.length}
              selectedId={selected?.id}
              shareFromId={shareFromId}
              landingIds={landingIds}
              exitingIds={exitingIds}
              onSelect={openCase}
            />
          }
          canvas={
            <DeskCase
              key={selected?.id ?? "empty"}
              snap={selectedSnap ?? snap}
              item={selected}
              shareAddress={Boolean(selectedId)}
              busy={busy}
              emptyReason={emptyReason}
              copyPulse={deskCopyPulse(announce)}
              onAllow={(draft) => {
                noteExit(selected);
                void run(`/api/desk/drafts/${draft.id}/allow`, "POST", { expectedRevision: snap.revision }, draft.id, "Wording allowed");
              }}
              onDeny={(draft) => {
                noteExit(selected);
                void run(`/api/desk/drafts/${draft.id}/deny`, "POST", { expectedRevision: snap.revision }, draft.id, "Wording denied");
              }}
              onEdit={(draft, body) => void run(`/api/desk/drafts/${draft.id}`, "PATCH", { body }, draft.id, "Wording saved")}
              onCopy={(body) => {
                void navigator.clipboard.writeText(body);
                setAnnounce("Wording copied");
              }}
              onPrepare={(draft) => void run(`/api/desk/drafts/${draft.id}/prepare`, "POST", undefined, `prepare-${draft.id}`, "Portal prepared")}
              onWaiting={(workItemId) => void run(`/api/desk/cases/${workItemId}/waiting`, "POST", { expectedRevision: snap.revision }, `waiting-${workItemId}`, "Case is waiting for a reply")}
              onClose={(workItemId) => void run(`/api/desk/cases/${workItemId}/close`, "POST", { expectedRevision: snap.revision, closureKind: "resolved-externally" }, `close-${workItemId}`, "Case closed with a receipt")}
              onSnooze={(workItemId, until) => void run(`/api/desk/cases/${workItemId}/snooze`, "POST", { expectedRevision: snap.revision, until }, `snooze-${workItemId}`, "Reminder moved")}
              onCancel={(workItemId) => void run(`/api/desk/cases/${workItemId}/cancel`, "POST", { expectedRevision: snap.revision, closureKind: "not-needed" }, `cancel-${workItemId}`, "Case closed without action")}
            />
          }
          rail={
            <DeskEvidence
              snap={selectedSnap ?? snap}
              item={selected}
              onPresent={(presentation) => void run("/api/desk/handoff/present", "POST", { presentation }, "present", "Browser view changed")}
            />
          }
        />
        </div>
      )}
    </main>
  );
}

function RecheckGraph({
  running,
  properties,
  recordsChecked,
}: {
  running: boolean;
  properties: Array<{ id: string; address: string }>;
  recordsChecked?: number;
}) {
  const [phase, setPhase] = useState<"idle" | "run" | "done">("idle");
  const [armed, setArmed] = useState(false);
  const [revealed, setRevealed] = useState(0);
  const startedAt = useRef(0);
  const durationMs = recheckBeatMs(properties.length || 8);
  const reduceMotion = prefersReducedMotion();

  useEffect(() => {
    if (running) {
      startedAt.current = Date.now();
      setPhase("run");
      setRevealed(reduceMotion ? properties.length : 0);
      return;
    }
    if (phase !== "run") return;
    const remain = reduceMotion ? 0 : Math.max(0, durationMs - (Date.now() - startedAt.current));
    const finish = window.setTimeout(() => setPhase("done"), remain);
    return () => window.clearTimeout(finish);
  }, [running, phase, durationMs, properties.length, reduceMotion]);

  useEffect(() => {
    if (phase !== "done") return;
    setRevealed(properties.length);
    const hide = window.setTimeout(() => setPhase("idle"), reduceMotion ? 0 : RECHECK_GRAPH_LINGER_MS);
    return () => window.clearTimeout(hide);
  }, [phase, properties.length, reduceMotion]);

  useEffect(() => {
    if (phase !== "run") {
      setArmed(false);
      return;
    }
    const id = window.setTimeout(() => setArmed(true), 16);
    return () => window.clearTimeout(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== "run" || reduceMotion || properties.length === 0) return;
    const tick = () => {
      const elapsed = Date.now() - startedAt.current;
      setRevealed(recheckLandRevealed({
        count: properties.length,
        elapsedMs: elapsed,
        durationMs,
        done: false,
      }));
    };
    tick();
    const step = Math.max(40, durationMs / Math.max(properties.length, 1));
    const timer = window.setInterval(tick, step);
    return () => window.clearInterval(timer);
  }, [phase, properties.length, durationMs, reduceMotion]);

  if (phase === "idle") return null;

  const now = phase === "done" ? 100 : 92;
  const visible = properties.slice(0, revealed);
  const current = visible[visible.length - 1];
  const caption = recheckLandCaption(
    current?.address,
    revealed,
    properties.length,
    phase === "done",
  );
  return (
    <div className="mt-3">
      <div
        className="recheck-graph"
        role="progressbar"
        aria-label="Recheck"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={now}
        aria-valuetext={phase === "done" ? `${recordsChecked ?? properties.length} checked` : caption}
        style={{ ["--recheck-ms" as string]: `${durationMs}ms` }}
      >
        <div className={cn("recheck-graph-fill", phase === "done" ? "is-done" : armed && "is-run")} />
      </div>
      {visible.length > 0 ? (
        <ol className="recheck-land mt-2" aria-live="polite" aria-label={caption}>
          {visible.map((property, index) => (
            <li
              key={property.id}
              className={reduceMotion ? undefined : "queue-row-land"}
              style={reduceMotion ? undefined : { animationDelay: `${Math.min(index * 40, 200)}ms` }}
            >
              <span className="truncate">{property.address}</span>
              <span className="shrink-0 text-ink-muted">{index + 1 === visible.length && phase !== "done" ? "Checking" : "Checked"}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function QueuePane({
  filter,
  onFilter,
  query,
  onQuery,
  rows,
  counts,
  total,
  selectedId,
  shareFromId,
  landingIds = [],
  exitingIds = [],
  onSelect,
}: {
  filter: QueueFilter;
  onFilter: (filter: QueueFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  rows: ReturnType<typeof filterDeskQueue>;
  counts: ReturnType<typeof queueCounts>;
  total: number;
  selectedId?: string;
  shareFromId?: string | null;
  landingIds?: string[];
  exitingIds?: string[];
  onSelect: (id: string) => void;
}) {
  const filters: Array<[QueueFilter, string, number]> = [
    ["needs-you", "Needs you", counts["needs-you"]],
    ["waiting", "Waiting", counts.waiting],
    ["handling", "Bud handling", counts.handling],
    ["all", "All", total],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-[12px] font-semibold text-ink">Work queue</h2>
          <span className="text-[12px] tabular-nums text-ink-muted">{total} total</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {filters.map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => onFilter(value)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[12px]",
                filter === value ? "border-agency bg-selected text-ink" : "border-line bg-sheet text-ink-muted",
              )}
            >
              {label} <span className="tabular-nums">{count}</span>
            </button>
          ))}
        </div>
      </div>
      <label className="block border-b border-line px-3 py-2.5 text-[12px] font-medium text-ink-muted">
        Search the desk
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Oak St or Sam Nguyen"
          className="mt-1.5 min-h-9 w-full rounded border border-line bg-sheet px-2.5 py-1.5 text-[13px] font-normal text-ink placeholder:text-ink-muted/70"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Case queue">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-[13px] leading-relaxed text-ink-muted">
            {query.trim() ? "No address or person matches that search." : "No cases in this filter."}
          </p>
        ) : (
          groupDeskQueue(rows).map((group) => {
            const sharing = Boolean(shareFromId && !selectedId && group.items.some((item) => item.id === shareFromId));
            return (
            <div key={group.key} role="group" aria-label={group.address}>
              {group.items.length > 1 ? (
                <div className={cn("border-b border-line px-3.5 pb-1 pt-3 text-[12px] font-semibold text-ink", sharing && "desk-shared-address")}>{group.address}</div>
              ) : null}
              {group.items.map((row) => {
                const landIndex = landingIds.indexOf(row.id);
                return (
                <div
                  key={row.id}
                  className={cn(exitingIds.includes(row.id) && "queue-row-exit", landIndex >= 0 && "queue-row-land")}
                  style={landIndex >= 0 ? { animationDelay: `${staggerMs(landIndex)}ms` } : undefined}
                >
                  <div className="min-h-0 overflow-hidden">
                    <CaseQueueRow
                      title={group.items.length > 1 ? (CASE_KIND_LABELS[row.kind] ?? row.kind) : row.address}
                      meta={group.items.length > 1 ? row.meta : `${CASE_KIND_LABELS[row.kind] ?? row.kind} · ${row.meta}`}
                      action={row.action}
                      selected={row.id === selectedId}
                      shareAddress={sharing && group.items.length === 1}
                      onSelect={() => onSelect(row.id)}
                    />
                  </div>
                </div>
                );
              })}
            </div>
            );
          })
        )}
      </div>
    </div>
  );
}

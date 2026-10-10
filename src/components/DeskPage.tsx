import { usePhoneConnections } from "@/lib/phone-connections";
import { useWorkspaceScroll, useWorkspaceViewState } from "@/lib/workspace-view-state";
import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { useDeskViewState, visibleDeskAreas } from "@/lib/desk-view-state";
import type { PropertyScope } from "@/lib/book-groups";
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Building2, CircleAlert, Loader2, MessageSquare, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { bindMenuDismiss, closeMenu } from "@/lib/menu-dismiss";
import type { CsvColumnMapping, CsvImportPreview, DeskSnapshot, Draft, Property } from "@/lib/desk";
import {
  buildDeskQueue,
  filterDeskQueue,
  queueCounts,
  queueReason,
  type DeskQueueItem,
  type DeskRecoveryPlan,
  type QueueCounts,
  type QueueFilter,
} from "@/lib/desk-queue";
import { deskHandsStatus, missAction } from "@/lib/hands-label";
import { useServiceAdminAccess } from "@/lib/use-service-admin-access";
import { OwnerRequestButton } from "./OwnerRequestButton";
import { stableOrder } from "@/lib/schedule-rows";
import { draftViaLine, phoneChip, phoneChipTone, phonePaired } from "@/lib/phone-label";
import { StatusLabel } from "./pm";
import { DeskBook } from "./desk/DeskBook";
import { DeskCase, type CaseEdit } from "./desk/DeskCase";
import { propertyEdits } from "@/lib/property-edits";
import { deskAskContext, type DeskAskIntent } from "@/lib/desk-ask-context";
import { useWorkspacePreferences, portfolioLayout } from "@/lib/workspace-preferences";
import { DeskEvidence } from "./desk/DeskEvidence";
import { GoLiveCard } from "./desk/GoLiveCard";
import { ReiSignInCard } from "./desk/ReiSignInCard";
import { useReiSignIn } from "@/lib/rei-sign-in";
import { JobRunFeed } from "./desk/JobRunFeed";
import { SharedWorkPanel } from "./desk/SharedWorkPanel";
import { ExpectedBillsBoard } from "./desk/ExpectedBillsBoard";
import { MailWorkPanel } from './desk/MailWorkPanel';
import { RemindersPanel } from "./desk/RemindersPanel";
import { DeskRecoveryNotice, DeskRemindersDisclosure, DeskWorkArea, LicenseeBadge } from "./desk/DeskSections";
import type { DeskOtherWork } from "@/lib/desk-view-state";
import { CardMenu, DeskCardMenu } from "./shell/DeskArrangement";
import { setDeskTabSlot } from "./shell/use-desk-nav";
import { openArrangeDesk, useDeskDataStatus } from "./shell/shell-layout";
import { useWorkspaceTabs } from "@/lib/workspace-tabs";
import { DESK_SECTION_LABELS, deskSectionsOrDefault } from "@shared/workspace-tabs";
import { BatchWorkspace } from "./desk/BatchWorkspace";
import { CASE_KIND_LABELS } from "./desk/labels";
import { MorningBrief, MorningEmpty, TASK_CHECK_FAILED_EMPTY, TASK_CHECK_NEVER } from "./desk/MorningBrief";
import { OfficeBookEmpty, StartOfficeBook, isEmptyOfficeBook, offersOfficeBookStart } from "./desk/OfficeBookNotice";
import { isDemoWorkerMiss, morningBrief } from "@/lib/morning-brief";
import { deskCheckAction, missedCheckLine, workdayGuide } from "@/lib/workday";
import { recheckProgress } from "@/lib/task-progress";
import { api, useStore } from "@/state/store";
import { HermiosMark } from "./HermiosMark";

// Hermios is its own chunk: Desk never downloads it until the tab is opened.
const HermiosTab = lazy(() => import("./desk/HermiosTab").then((module) => ({ default: module.HermiosTab })));

/** A Hermios asset that fails to load must not take Tasks with it. */
class HermiosBoundary extends Component<{ children: ReactNode; onLeave: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-paper p-6 text-center text-[14px] text-ink">
        <p className="font-semibold">Could not open Hermios</p>
        <p className="max-w-md text-ink-secondary">Your tasks are still on the Tasks tab. Reload RealBud to try Hermios again.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className="pm-control rounded border border-line bg-sheet px-3 text-ink" onClick={this.props.onLeave}>Back to tasks</button>
          <button type="button" className="pm-control rounded border border-line bg-sheet px-3 text-ink" onClick={() => window.location.reload()}>Reload RealBud</button>
        </div>
      </div>
    );
  }
}

function deskFacingError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/revision|stale|conflict/i.test(raw)) return "This card changed — open it again";
  return raw;
}

export function DeskPage({ caseEdits }: { caseEdits: Map<string, CaseEdit> }) {
  const { state, dispatch, refreshHermes } = useStore();
  const canAdminister = useServiceAdminAccess(state.serviceAdmin ?? state.config?.serviceAdmin);
  const { preferences } = useWorkspacePreferences();
  // Saved Desk sections; an absent or invalid layout renders today's order.
  const deskLayout = useWorkspaceTabs().data?.state?.desk.sections;
  // The day's REI sign-in: while REI needs it, it is Desk's one primary action.
  const rei = useReiSignIn();
  const reiNeeded = rei.view?.state === "needed";
  // Disconnected office or stale check: one line says so above everything Desk shows.
  const dataStatus = useDeskDataStatus();
  const activityShown = deskLayout?.find(section => section.id === "activity")?.visible !== false;
  const layout = portfolioLayout(preferences, state.desk?.properties.length ?? 0);
  // Paint instantly from the SSE-pushed snapshot when we have one; the
  // effect below still refreshes from the server on mount.
  const [snap, setSnap] = useState<DeskSnapshot | null>(state.desk ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [recheckStartedAt, setRecheckStartedAt] = useState<number | null>(null);
  const [recheckElapsed, setRecheckElapsed] = useState(0);
  const [ready, setReady] = useState(state.desk != null);
  const [mode, setDeskMode] = useDeskViewState("mode");
  // Hermios is a Desk tab beside Tasks, not a Desk mode: choosing any mode
  // (here or from the shell's queue shortcuts) leaves it, and a fresh Desk opens on Tasks.
  const [hermiosOpen, setHermiosOpen] = useDeskViewState("hermios");
  useEffect(() => () => setHermiosOpen(false), []);
  // A work-area tab (mail, bills, shared work) replaces the task area while open. Opened
  // surfaces stay mounted (hidden) so their unsaved drafts and request identities survive switching.
  const areas = visibleDeskAreas(deskLayout);
  const [otherWork, setOtherWork] = useDeskViewState("otherWork");
  const [openedOther, setOpenedOther] = useState<ReadonlySet<DeskOtherWork>>(() => new Set(otherWork ? [otherWork] : []));
  const setMode = (next: typeof mode) => {
    setHermiosOpen(false);
    setOtherWork(null);
    setDeskMode(next);
  };
  const openOtherWork = (id: DeskOtherWork) => {
    setHermiosOpen(false);
    setDeskMode("cases");
    setQueueState(false);
    setOpenedOther(current => (current.has(id) ? current : new Set([...current, id])));
    setOtherWork(id);
  };
  const [jobRunsOpen, setJobRunsOpen] = useWorkspaceViewState("deskResults");
  const [bookNonce, setBookNonce] = useDeskViewState("bookNonce");
  // A "Connect your export" entry elsewhere in the app lands here in Book mode.
  useEffect(() => {
    if (state.deskBookNonce > bookNonce) { setMode("book"); setBookNonce(state.deskBookNonce); }
  }, [state.deskBookNonce]);
  const [filter, setFilter] = useDeskViewState("filter");
  const [selectedId, setSelectedId] = useDeskViewState("selectedId");
  // On narrow windows the queue is a drawer that opens when something needs
  // you (or the PM taps Tasks). Wide desks always show it beside the case.
  const [queueOpen, setQueueState] = useState(false);
  const setQueueOpen = (next: boolean | ((value: boolean) => boolean)) =>
    setQueueState(value => {
      const resolved = typeof next === "function" ? next(value) : next;
      return resolved && !narrowDesk() ? false : resolved;
    });
  const autoOpenedForNeedRef = useRef(false);
  const queueToggleRef = useRef<HTMLButtonElement | null>(null);
  const drawerWasOpen = useRef(false);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  // "More" is a <details class="desk-more"> menu: close it on Escape, on a press
  // outside, and once an item is chosen. The desk-more class is also the signal
  // Hermios uses to hide its native view under an open menu.
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  const moreUnbind = useRef<(() => void) | null>(null);
  const moreMenuRef = useCallback((node: HTMLDetailsElement | null) => {
    moreUnbind.current?.();
    moreUnbind.current = node ? bindMenuDismiss(node) : null;
    moreRef.current = node;
  }, []);
  const chooseMore = (action: () => void) => () => {
    action();
    closeMenu(moreRef.current);
  };
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

  // A newer saved check supersedes a request that failed or went unanswered.
  useEffect(() => { setCheckFailed(false); }, [snap?.lastRunAt]);

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
      if (key === "check") setCheckFailed(false);
      return true;
    } catch (cause) {
      setError(deskFacingError(cause));
      if (key === "check") setCheckFailed(true);
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
  const live = useMemo(() => filterDeskQueue(scopedRows, filter, query).filter(row => caseKind === "all" || row.kind === caseKind), [scopedRows, filter, query, caseKind]);
  // While a case is open, new data never reorders the rows under the person
  // (Schedule does the same). Changing the view or Update order applies the live order.
  const viewKey = `${mode}|${filter}|${query}|${caseKind}|${taskScope?.label ?? ""}`;
  const reviewed = useRef<{ view: string; ids: string[] } | null>(null);
  const [, setOrderNonce] = useState(0);
  const { rows: visible, updates: orderUpdates } = reviewOrder(selectedId && reviewed.current?.view === viewKey ? reviewed.current.ids : null, live);
  reviewed.current = { view: viewKey, ids: visible.map((row) => row.id) };
  const updateOrder = () => {
    reviewed.current = null;
    setOrderNonce((value) => value + 1);
    document.getElementById("desk-queue-list")?.focus();
  };
  const selected = visible.find((row) => row.id === selectedId) ?? visible[0];
  // A new licensee escalation joins the end of a held order, so it is always announced too.
  const licenseeSeen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!snap) return;
    const seen = licenseeSeen.current;
    const licensee = rows.filter((row) => row.kind === "licensee-required");
    licenseeSeen.current = new Set(licensee.map((row) => row.id));
    const fresh = seen ? licensee.find((row) => !seen.has(row.id)) : undefined;
    if (fresh) setAnnounce(`New licensee escalation · ${fresh.address.split(",")[0]?.trim() || fresh.address}`);
  }, [rows]);
  const counts = queueCounts(scopedRows);
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
    if (counts.now <= 0 || otherWork) {
      autoOpenedForNeedRef.current = false;
      return;
    }
    if (autoOpenedForNeedRef.current) return;
    if (!narrowDesk()) return;
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
      if (mode !== "cases" || hermiosOpen || otherWork || !visible.length) return;
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
      if (event.key === "Escape") setQueueOpen(false);
      if (event.key === "[" ) {
        event.preventDefault();
        setQueueOpen((value) => !value);
      }
      if (event.key === "]") {
        event.preventDefault();
        setEvidenceOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, hermiosOpen, otherWork, visible, selected]);

  // Widening the window turns the drawer back into the side column.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const wide = window.matchMedia(WIDE_DESK_QUERY);
    const onChange = () => { if (wide.matches) setQueueState(false); };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  // The drawer takes focus when it opens and returns it to Tasks when it closes.
  useEffect(() => {
    if (queueOpen) {
      drawerWasOpen.current = true;
      document.getElementById("desk-queue-list")?.focus({ preventScroll: true });
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      queueToggleRef.current?.focus({ preventScroll: true });
    }
  }, [queueOpen]);

  // A work area hidden from the saved layout (here, by Bud or another window) closes back to Tasks.
  useEffect(() => { if (otherWork && !areas.includes(otherWork)) setOtherWork(null); }, [otherWork, areas.join()]);

  // One scroll owner for Desk; each surface keeps its own return position.
  const contentScrollRef = useWorkspaceScroll(`desk-content:${otherWork ?? mode}`, ready && snap != null && !hermiosOpen);

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
  const missed = isDemoWorkerMiss(snap.hands, snap.handsDetail);
  const miss = snap.handsDetail && missed ? missAction(snap.handsDetail, canAdminister) : null;
  const checkAction = deskCheckAction(snap);
  // "Sample book" unless the book is live and not a demo.
  const sampleBook = Boolean(snap.demo || snap.mode === "demo");
  const checkLabel = sampleBook ? "Check sample tasks" : "Check tasks";
  // A missed or failed check is shown as such; it never reads as a clean one.
  const checkState: QueueCheckState = (snap.lastRunAt != null && missed) || checkFailed ? "failed" : snap.lastRunAt == null ? "never" : "ok";
  const runCheck = () => {
    if (busy) return;
    void run(checkAction.path, "POST", undefined, "check", checkAction.path.endsWith("practice") ? "Sample tasks checked" : "Tasks checked");
  };
  // Empty book already shows the primary check in MorningEmpty — keep the
  // toolbar control secondary so the page has one agency CTA.
  const headerCheckPrimary = snap.lastRunAt != null && !reiNeeded;
  // A live, empty office book has nothing to check and no sample to run.
  const liveEmpty = isEmptyOfficeBook(snap);
  const bookChip = deskHandsStatus(snap.hands, snap.handsDetail, liveEmpty);
  // Unmatched imports can need review before the first property is added.
  // Only replace the queue when it has no work in any status or filter.
  const emptyWorkspace = liveEmpty && rows.length === 0;
  const offerOfficeBook = offersOfficeBookStart(snap, Boolean(state.hermes?.modelAccess?.managed));
  const empty =
    liveEmpty ? (
      <OfficeBookEmpty onOpenBook={() => setMode("book")} onAsk={() => dispatch({ type: "showAsk" })} />
    ) : snap.lastRunAt == null ? (
      <MorningEmpty checkLabel={checkLabel} brief={brief} busy={busy !== null} onAction={runCheck} />
    ) : visible.length === 0 ? (
      query.trim() ? (
        <MorningEmpty brief={{ ...brief, headline: "No cases match that search." }} actionLabel="Clear search" onAction={() => setQuery("")} />
      ) : filter === "now" ? (
        <MorningEmpty brief={brief} failed={checkState === "failed"} />
      ) : (
        <MorningEmpty brief={{ ...brief, headline: "No cases in this filter." }} actionLabel="Show all tasks" onAction={() => { setFilter("all"); setCaseKind("all"); }} />
      )
    ) : null;
  // Saved Desk sections choose what Check details show; work areas are tabs.
  const sections = deskSectionsOrDefault(deskLayout);
  const sectionShown = (id: string) => sections.find(section => section.id === id)?.visible !== false;
  // An empty office has no property tasks to check yet. Its setup card owns
  // that explanation; a failed check must still stay visible above it.
  const statusShown = !(emptyWorkspace && checkState === "never") && (sectionShown("brief") || checkState !== "ok");
  const tasksActive = mode === "cases" && !hermiosOpen && !otherWork;
  const drawerOpen = queueOpen && tasksActive && !emptyWorkspace;
  const openCaseHeading = () => {
    window.requestAnimationFrame(() => document.getElementById("desk-case-column")?.scrollIntoView({ block: "nearest" }));
  };

  const casesArea = (
    <>
      {/* The one setup checklist. It sits above the brief so a fresh, empty
          office still sees it, and it hides itself once every step is done. */}
      <ReiSignInCard rei={rei} inert={drawerOpen} menu={<CardMenu label="REI sign-in" locked shown />} />
      {sectionShown("go-live") ? (
        <GoLiveCard agencyName={snap.book?.agency.name ?? ""} compact quiet={reiNeeded} inert={drawerOpen} menu={<DeskCardMenu id="go-live" />} />
      ) : null}
      {statusShown ? (
        <div className="desk-status-row flex items-start gap-2" inert={drawerOpen}>
          <div className="min-w-0 flex-1">
          <MorningBrief
            brief={brief}
            timezone={timezone}
            failed={checkState === "failed"}
            failedLine={missed && snap.lastRunAt != null ? missedCheckLine(snap.handsDetail) : undefined}
            failedAction={miss ? "ownerRequest" in miss ? <OwnerRequestButton request={miss.ownerRequest} /> : (
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
            ) : undefined}
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
              openCaseHeading();
            }}
          >
            {keysHint ? (
              <p className="pm-desk-hint mt-2 flex items-center gap-3 text-[12px] text-ink-muted"><span>↑↓ move the queue · [ ] toggle Tasks / Evidence</span><button type="button" onClick={dismissKeysHint} className="text-agency">Got it</button></p>
            ) : null}
          </MorningBrief>
          </div>
          <DeskCardMenu id="brief" />
        </div>
      ) : null}
      {emptyWorkspace ? (
        <div className="desk-empty-workspace">
          {empty}
          <div className="desk-empty-reminders">
            <DeskRemindersDisclosure initialOpen>{toggle => <RemindersPanel headerAction={toggle} />}</DeskRemindersDisclosure>
          </div>
        </div>
      ) : (
      <div className="desk-task-split" data-queue-open={drawerOpen ? "true" : undefined}>
        {drawerOpen ? <button type="button" className="desk-queue-backdrop" aria-label="Close tasks" onClick={() => setQueueOpen(false)} /> : null}
        <div
          className="desk-queue-column"
          role={drawerOpen ? "dialog" : undefined}
          aria-modal={drawerOpen ? true : undefined}
          aria-label={drawerOpen ? "Tasks" : undefined}
          onKeyDown={drawerOpen ? (event) => { if (event.key === "Escape") { event.stopPropagation(); setQueueOpen(false); } } : undefined}
        >
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
            checkState={checkState}
            liveEmpty={liveEmpty}
            selectedId={selected?.id}
            orderUpdates={orderUpdates}
            onUpdateOrder={updateOrder}
            onClose={() => setQueueOpen(false)}
            onHighlight={setSelectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setQueueOpen(false);
              openCaseHeading();
            }}
            reminders={<DeskRemindersDisclosure>{toggle => <RemindersPanel headerAction={toggle} />}</DeskRemindersDisclosure>}
          />
        </div>
        <div id="desk-case-column" tabIndex={-1} className="desk-case-column" data-empty={!selected ? "true" : undefined} inert={drawerOpen}>
          <DeskCase
            key={selected?.id ?? "empty"}
            edits={caseEdits}
            snap={snap}
            item={selected}
            busy={busy}
            empty={<div className="desk-empty-canvas">{empty}</div>}
            onAllow={(draft) => void run(`/api/desk/drafts/${draft.id}/allow`, "POST", { expectedRevision: snap.revision }, draft.id, "Wording approved")}
            onDeny={(draft, reason) =>
              void run(
                `/api/desk/drafts/${draft.id}/deny`,
                "POST",
                { expectedRevision: snap.revision, ...(reason ? { reason } : {}) },
                draft.id,
                "Wording declined",
              )
            }
            onEdit={(draft, body, expectedRevision) => run(`/api/desk/drafts/${draft.id}`, "PATCH", { body, expectedRevision }, draft.id, "Wording saved")}
            onAsk={() => askAboutCase()}
            onEvidence={() => setEvidenceOpen((value) => !value)}
            evidenceOpen={evidenceOpen}
            evidence={
              <DeskEvidence
                snap={snap}
                item={selected}
                onPresent={(presentation) => void run("/api/desk/handoff/present", "POST", { presentation }, "present", "Browser view changed")}
              />
            }
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
        </div>
      </div>
      )}
    </>
  );

  const tasks =
    mode === "batch" ? (
      <BatchWorkspace snapshot={snap} scope={batchScope} onClearScope={() => setBatchScope(null)} openNewDraft={openNewBatchDraft} onDraftOpened={() => setOpenNewBatchDraft(false)} />
    ) : mode === "book" ? (
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
        onResolveReiDiffer={(id, field, pick) => void run(`/api/desk/properties/${id}/rei-differs/${field}/${pick}`, "POST", {}, `rei-${id}-${field}`, pick === "rei" ? "REI value used" : "Desk value kept")}
        onSave={(id, options) => run(`/api/desk/properties/${id}`, "PATCH", options, id, "Options saved")}
        onNotes={(id, body) => run(`/api/desk/properties/${id}/notes`, "PUT", { body }, `notes-${id}`, "Notes saved")}
        onDelete={(id) => void run(`/api/desk/properties/${id}`, "DELETE", undefined, `delete-${id}`, "Property removed")}
        onReset={() => void run("/api/desk/reset", "POST", undefined, "reset", "Sample morning replayed")}
        onPreviewImport={previewImport}
        onInspect={inspectImport}
        onImport={importReviewed}
      />
    ) : (
      casesArea
    );

  return (
    <main className="desk-workspace flex h-full min-w-0 flex-1 flex-col bg-paper" data-density={layout.compact ? "compact" : "comfortable"} style={{ "--desk-queue-width": `${preferences.queueWidth}px` } as React.CSSProperties}>
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
      {/* A shallow toolbar that never scrolls; Desk's one scroll region sits below it. */}
      <header className="pm-desk-header desk-toolbar shrink-0 border-b border-line" inert={drawerOpen}>
        <div className="pm-desk-toolbar">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <Building2 size={21} className="shrink-0 text-agency" />
            <h1 className="pm-screen-title text-ink">Desk</h1>
            {sampleBook ? (
              <StatusLabel tone={missed ? "hold" : "muted"}>Sample book</StatusLabel>
            ) : (
              <StatusLabel tone={bookChip.tone}>{bookChip.label}</StatusLabel>
            )}
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
            {tasksActive && !emptyWorkspace ? (
              <button
                ref={queueToggleRef}
                type="button"
                className="desk-queue-toggle pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink"
                aria-expanded={queueOpen}
                onClick={() => setQueueOpen((value) => !value)}
              >
                Tasks · {counts.now}
              </button>
            ) : null}
            {liveEmpty ? null : <button
              type="button"
              onClick={runCheck}
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
              {checkLabel}
            </button>}
            <button type="button" onClick={() => dispatch({ type: "showAsk" })} className="desk-secondary-button desk-chat-button">
              <MessageSquare size={16} aria-hidden />Ask Bud
            </button>
            <details ref={moreMenuRef} className="desk-more">
              <summary className="desk-secondary-button">More</summary>
              <div className="desk-more-panel" role="group" aria-label="More Desk tools">
                {activityShown ? (
                  <button type="button" className="desk-more-item" aria-pressed={jobRunsOpen} onClick={chooseMore(() => setJobRunsOpen((value) => !value))}>
                    {jobRunsOpen ? "Hide activity" : "Activity"}
                  </button>
                ) : null}
                <button type="button" className="desk-more-item" aria-pressed={mode === "book"} onClick={chooseMore(() => setMode("book"))}>
                  Properties and imports
                </button>
                <button type="button" className="desk-more-item" aria-pressed={mode === "batch"} onClick={chooseMore(() => setMode("batch"))}>
                  Prepare several properties
                </button>
                <button type="button" className="desk-more-item" onClick={chooseMore(openArrangeDesk)}>
                  Arrange Desk
                </button>
              </div>
            </details>
          </div>
        </div>
        <nav className="desk-workspace-nav" aria-label="Desk workspace">
          <div className="desk-workspace-tabs">
            <button type="button" aria-pressed={tasksActive} onClick={() => setMode("cases")}>
              Tasks{counts.now > 0 ? <span>{counts.now}</span> : null}
            </button>
            {areas.map(id => (
              <button key={id} type="button" aria-pressed={mode === "cases" && !hermiosOpen && otherWork === id} onClick={() => openOtherWork(id)}>
                {DESK_SECTION_LABELS[id]}
              </button>
            ))}
            <button type="button" aria-pressed={hermiosOpen} onClick={() => { setOtherWork(null); setHermiosOpen(true); }}>
              <HermiosMark size={18} />
              Hermios
            </button>
          </div>
          {/* The shell's Properties and saved-view tabs join this row on Desk. */}
          <div ref={setDeskTabSlot} className="desk-shell-tabs" />
        </nav>
        {/* Recovery stays outside the configurable sections, above every Desk surface. */}
        {snap.recovery?.active ? (
          <div className="mt-2">
            <DeskRecoveryNotice onOpenWorkspace={() => { location.hash = "you-recovery"; dispatch({ type: "showYou" }); }} />
          </div>
        ) : null}
        {error ? (
          <div
            className={cn(
              "mt-2 flex items-start gap-2 px-3 py-2.5 text-[13px]",
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
      </header>
      {hermiosOpen ? (
        /* Hermios is an exclusive surface: its native view owns its own
           scrolling, so RealBud adds no outer scroller around it. */
        <HermiosBoundary onLeave={() => setMode("cases")}>
          <Suspense
            fallback={
              <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 bg-paper text-[14px] text-ink-muted">
                <Loader2 size={18} className="animate-spin" aria-hidden />
                Opening Hermios…
              </div>
            }
          >
            <HermiosTab />
          </Suspense>
        </HermiosBoundary>
      ) : (
        <div ref={contentScrollRef} className="desk-content min-h-0 flex-1 overflow-y-auto" data-drawer-open={drawerOpen ? "true" : undefined}>
          <div className="desk-notices empty:hidden" inert={drawerOpen}>
            {dataStatus.notice ? (
              <div role="status" className="flex max-w-[46rem] items-center gap-2 rounded border border-hold/30 bg-hold/10 px-3 py-2 text-[13px] text-ink">
                <CircleAlert size={16} className="shrink-0 text-hold" aria-hidden />
                {dataStatus.notice}
              </div>
            ) : null}
            {offerOfficeBook ? (
              <StartOfficeBook busy={busy !== null} onStart={() => { void run("/api/desk/live", "POST", { expectedRevision: snap.revision }, "live", "Office book started"); }} />
            ) : null}
            {busy === "check" ? (
              <div role="status" className="max-w-[46rem] rounded border border-agency/20 bg-agency/5 px-3 py-2 text-[13px] text-ink-secondary">
                <span className="font-medium text-ink">{recheckProgress(recheckElapsed).label}</span>
                <span> · {recheckProgress(recheckElapsed).reassurance}</span>
                <span className="ml-1 tabular-nums text-ink-muted">{recheckElapsed}s</span>
              </div>
            ) : null}
            {jobRunsOpen && activityShown ? <div className="desk-activity-feed"><div className="rb-card-menu-row"><DeskCardMenu id="activity" /></div><JobRunFeed limit={6} /></div> : null}
          </div>
          <DeskWorkArea
            active={otherWork}
            opened={openedOther}
            tasks={tasks}
            panels={{
              mail: <><div className="rb-card-menu-row"><DeskCardMenu id="mail" /></div><MailWorkPanel /></>,
              bills: <><div className="rb-card-menu-row"><DeskCardMenu id="bills" /></div><ExpectedBillsBoard /></>,
              "shared-work": <><div className="rb-card-menu-row"><DeskCardMenu id="shared-work" /></div><SharedWorkPanel initialExpanded /></>,
            }}
          />
        </div>
      )}
    </main>
  );
}

const WIDE_DESK_QUERY = "(min-width: 960px)";
/** The queue is a drawer only below the 959px breakpoint. */
function narrowDesk(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && !window.matchMedia(WIDE_DESK_QUERY).matches;
}

type QueueCheckState = "ok" | "never" | "failed";

function queueRowId(id: string): string {
  return `queue-row-${id}`;
}

/** Rows in the order the person is reviewing: rows stay put, finished rows drop
 *  out and new rows join the end. `updates` says the live order differs. */
export function reviewOrder(frozen: readonly string[] | null, live: readonly DeskQueueItem[]): { rows: DeskQueueItem[]; updates: boolean } {
  if (!frozen) return { rows: [...live], updates: false };
  const liveIds = live.map((row) => row.id);
  const byId = new Map(live.map((row) => [row.id, row]));
  const ids = stableOrder(frozen, liveIds);
  return { rows: ids.map((id) => byId.get(id)!), updates: ids.some((id, index) => id !== liveIds[index]) };
}

/** A queue row: a pointer to the case, two lines, plus the licensee badge so a
 *  licensee hold is conspicuous before the case is opened, and one muted line
 *  saying why the row sits where it does. */
function QueueRow({ row, selected, onSelect }: { row: DeskQueueItem; selected: boolean; onSelect: () => void }) {
  const licensee = row.kind === "licensee-required";
  const meta = licensee ? row.meta : `${CASE_KIND_LABELS[row.kind] ?? row.kind} · ${row.meta}`;
  const showAction = !licensee && row.action.trim() && !meta.toLowerCase().includes(row.action.replace(/^Waiting — /i, "").toLowerCase());
  return (
    <button
      id={queueRowId(row.id)}
      type="button"
      onClick={onSelect}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col items-start gap-0.5 border-b border-line px-3 py-2.5 text-left",
        selected ? "bg-selected" : "bg-transparent hover:bg-raised/60",
      )}
    >
      <span className="text-[14px] font-medium text-ink">{row.address}</span>
      {licensee ? <LicenseeBadge /> : null}
      <span className="desk-queue-meta line-clamp-2 text-[12px] text-ink-muted" title={meta}>{meta}</span>
      {showAction ? <span className="text-[12px] text-agency">{row.action}</span> : null}
      <span className="desk-queue-reason text-[13px] text-ink-muted">{queueReason(row)}</span>
    </button>
  );
}

const QUEUE_STATUSES: Array<[QueueFilter, string]> = [
  ["now", "Needs you"],
  ["next", "Next"],
  ["waiting", "Waiting"],
  ["done", "Done"],
  ["all", "All"],
];

/** What an empty status says; "now" has its own message with an Open Waiting shortcut. */
const QUEUE_EMPTY: Record<QueueFilter, string> = {
  now: "Nothing needs you right now.",
  next: "Nothing is up next.",
  waiting: "Nothing is waiting on someone else.",
  done: "Nothing done today yet.",
  all: "No tasks yet.",
};

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
  checkState,
  liveEmpty,
  selectedId,
  orderUpdates,
  onUpdateOrder,
  onHighlight,
  onSelect,
  onClose,
  reminders,
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
  checkState: QueueCheckState;
  liveEmpty: boolean;
  selectedId?: string;
  orderUpdates: boolean;
  onUpdateOrder: () => void;
  onHighlight: (id: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  reminders?: ReactNode;
}) {
  const { preferences } = useWorkspacePreferences();
  const pageSize = preferences.pageSize;
  const page = Math.floor(Math.max(0, rows.findIndex(row => row.id === selectedId)) / pageSize);
  const pageRows = rows.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => { document.getElementById(queueRowId(selectedId ?? ""))?.scrollIntoView({ block: "nearest" }); }, [selectedId]);
  const highlight = (id: string) => {
    onHighlight(id);
    document.getElementById(queueRowId(id))?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div className="desk-queue-pane flex flex-col bg-sheet">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2.5">
        <h2 className="mr-1 text-[16px] font-semibold text-ink">Task queue</h2>
        <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onClose}
          className="desk-queue-close pm-control ml-auto items-center gap-1.5 rounded border border-line bg-paper px-2.5 text-[12px] text-ink"
          aria-label="Close tasks"
        >
          <X size={14} aria-hidden />
          Close
        </button>
        <DeskCardMenu id="queue" />
        </div>
      </div>
      <div className="desk-queue-controls border-b border-line px-3 py-2">
        <label className="desk-queue-status">
          <span>Status</span>
          <select aria-label="Status" value={filter} onChange={(event) => onFilter(event.target.value as QueueFilter)}>
            {QUEUE_STATUSES.map(([value, label]) => (
              <option key={value} value={value}>{label}{value !== "all" ? ` · ${counts[value]}` : ""}</option>
            ))}
          </select>
        </label>
        <label className="mt-3 block text-[13px] leading-5 text-ink-muted">
          Search address or person
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            className="mt-1.5 min-h-11 w-full rounded border border-line bg-sheet px-3 py-2 text-[14px] text-ink"
          />
        </label>
        <details className="desk-queue-filters mt-1">
          <summary>Filters{caseKind !== "all" ? ` · ${CASE_KIND_LABELS[caseKind] ?? caseKind}` : ""}</summary>
          <label className="desk-case-kind">Type<select value={caseKind} onChange={e => onCaseKind(e.target.value)}><option value="all">All case types</option>{Object.entries(CASE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </details>
      </div>
      {scope && <div className="property-scope-banner"><strong>{scope.label}</strong><button type="button" onClick={onClearScope}>Show all properties</button></div>}
      {reminders ? <div className="desk-queue-reminders border-b border-line px-3 py-2">{reminders}</div> : null}
      {orderUpdates ? (
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 text-[13px] text-ink-muted">
          <span>Updates available</span>
          <button type="button" onClick={onUpdateOrder} className="pm-control text-agency">Update order</button>
        </div>
      ) : null}
      <div
        id="desk-queue-list"
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
          ) : filter === "now" && checkState !== "ok" ? (
            // A missed, failed or absent check is never "nothing needs you".
            <p className="px-3 py-4 text-[13px] text-hold">{checkState === "failed" ? TASK_CHECK_FAILED_EMPTY : TASK_CHECK_NEVER}</p>
          ) : liveEmpty ? (
            <p className="px-3 py-4 text-[13px] text-ink-muted">No property tasks yet. Add properties to start your queue.</p>
          ) : filter === "now" ? (
            <div className="space-y-3 px-3 py-4 text-[13px] text-ink-muted">
              <p>{QUEUE_EMPTY.now}</p>
              {counts.waiting > 0 ? (
                <button
                  type="button"
                  onClick={() => onFilter("waiting")}
                  className="pm-control rounded border border-line bg-paper px-3 text-[13px] text-ink"
                >
                  Open Waiting
                </button>
              ) : null}
            </div>
          ) : (
            <p className="px-3 py-4 text-[13px] text-ink-muted">{QUEUE_EMPTY[filter]}</p>
          )
        ) : (
          pageRows.map((row) => (
            <QueueRow key={row.id} row={row} selected={row.id === selectedId} onSelect={() => onSelect(row.id)} />
          ))
        )}
      </div>
      {rows.length > 0 && <div className="desk-pagination" aria-label="Task pages"><span>{page * pageSize + 1}–{Math.min(rows.length, (page + 1) * pageSize)} of {rows.length}</span><button type="button" disabled={page === 0} onClick={() => onHighlight(rows[(page - 1) * pageSize]!.id)}>Previous</button><button type="button" disabled={(page + 1) * pageSize >= rows.length} onClick={() => onHighlight(rows[(page + 1) * pageSize]!.id)}>Next</button></div>}
    </div>
  );
}

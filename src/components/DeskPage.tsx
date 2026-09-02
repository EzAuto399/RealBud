import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, CircleAlert, Loader2, X } from "lucide-react";

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
import { readChannels, type ChannelsState } from "@/lib/telegram-channel";
import { CaseQueueRow, RecoveryNotice, SplitView, StatusLabel } from "./pm";
import { DeskBook } from "./desk/DeskBook";
import { DeskCase } from "./desk/DeskCase";
import { DeskEvidence } from "./desk/DeskEvidence";
import { GoLiveCard } from "./desk/GoLiveCard";
import { JobRunFeed } from "./desk/JobRunFeed";
import { CASE_KIND_LABELS } from "./desk/labels";
import { MorningBrief, MorningEmpty } from "./desk/MorningBrief";
import { isDemoWorkerMiss, morningBrief } from "@/lib/morning-brief";
import { workdayGuide } from "@/lib/workday";
import { recheckProgress } from "@/lib/task-progress";
import { COMPACT_WINDOW_QUERY, useMediaQuery } from "@/lib/use-media-query";
import { api, useStore } from "@/state/store";

function deskFacingError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/revision|stale|conflict/i.test(raw)) return "This card changed — open it again";
  return raw;
}

export function DeskPage() {
  const { state, dispatch, refreshHermes } = useStore();
  // Paint instantly from the SSE-pushed snapshot when we have one; the
  // effect below still refreshes from the server on mount.
  const [snap, setSnap] = useState<DeskSnapshot | null>(state.desk ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [recheckStartedAt, setRecheckStartedAt] = useState<number | null>(null);
  const [recheckElapsed, setRecheckElapsed] = useState(0);
  const [ready, setReady] = useState(state.desk != null);
  const [mode, setMode] = useState<"cases" | "book">("cases");
  const [jobRunsOpen, setJobRunsOpen] = useState(false);
  // A "Connect your export" entry elsewhere in the app lands here in Book mode.
  useEffect(() => {
    if (state.deskBookNonce > 0) setMode("book");
  }, [state.deskBookNonce]);
  const [filter, setFilter] = useState<QueueFilter>("now");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Case stays primary under 1280; queue opens only when something needs you
  // (or the PM taps Open Queue). Wide desks keep the side pane always visible.
  const [queueOpen, setQueueOpen] = useState(false);
  const autoOpenedForNeedRef = useRef(false);
  const [railOpen, setRailOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [query, setQuery] = useState("");
  const [channels, setChannels] = useState<ChannelsState | null>(null);
  // Short windows (Electron floor is 600px) fold the brief to one line so the
  // case wording stays visible; the PM can still expand it for the day.
  const compact = useMediaQuery(COMPACT_WINDOW_QUERY);
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

  useEffect(() => {
    if (!state.connected) return;
    void api("/api/channels")
      .then((body) => setChannels(readChannels(body)))
      .catch(() => setChannels(null));
  }, [state.connected, state.desk?.revision]);

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
    } catch (cause) {
      setError(deskFacingError(cause));
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
  const visible = useMemo(() => filterDeskQueue(rows, filter, query), [rows, filter, query]);
  const selected = visible.find((row) => row.id === selectedId) ?? visible[0];
  const counts = queueCounts(rows);

  const recoverCase = useCallback(
    (item: DeskQueueItem, plan: DeskRecoveryPlan) => {
      if (plan.action === "book") {
        setMode("book");
        setAnnounce("Properties opened for matching");
        return;
      }
      if (plan.action === "you") {
        dispatch({ type: "showYou" });
        return;
      }
      if (plan.action !== "ask" || !plan.prompt) return;
      const bud = state.bots.find((bot) => bot.name.trim().toLowerCase() === "bud") ?? state.bots[0];
      if (!bud) {
        setError("Bud is not ready yet. Open You to finish setup.");
        return;
      }
      dispatch({ type: "showAsk" });
      dispatch({ type: "send", botId: bud.id, text: plan.prompt });
      setAnnounce(`Bud is investigating ${item.address.split(",")[0]?.trim() || "this case"}`);
    },
    [dispatch, state.bots],
  );

  useEffect(() => {
    if (counts.now <= 0) {
      autoOpenedForNeedRef.current = false;
      return;
    }
    if (autoOpenedForNeedRef.current) return;
    if (typeof window === "undefined" || window.matchMedia("(min-width: 1280px)").matches) return;
    autoOpenedForNeedRef.current = true;
    setQueueOpen(true);
    setFilter("now");
  }, [counts.now]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
  const empty =
    snap.lastRunAt == null ? (
      <MorningEmpty brief={brief} />
    ) : visible.length === 0 ? (
      query.trim() ? (
        <MorningEmpty brief={{ ...brief, headline: "No cases match that search." }} />
      ) : filter === "now" ? (
        <MorningEmpty brief={{ ...brief, headline: brief.headline }} />
      ) : (
        <MorningEmpty brief={{ ...brief, headline: "No cases in this filter." }} />
      )
    ) : null;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-paper">
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
                title="Pair Telegram, Discord, or Slack under You → Phone to Allow courtesy wording from your phone"
              >
                {phoneChip(channels)}
              </StatusLabel>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={mode === "book"}
              title="Addresses, options, and CSV import"
              onClick={() => setMode((value) => (value === "book" ? "cases" : "book"))}
              className={cn("pm-control rounded border px-3 text-[13px]", mode === "book" ? "border-agency bg-selected text-ink" : "border-line bg-sheet text-ink")}
            >
              Properties
            </button>
            <button
              type="button"
              aria-expanded={jobRunsOpen}
              onClick={() => setJobRunsOpen((value) => !value)}
              className={cn("pm-control rounded border px-3 text-[13px]", jobRunsOpen ? "border-agency bg-selected text-ink" : "border-line bg-sheet text-ink")}
            >
              Activity
            </button>
            <button
              type="button"
              className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink min-[960px]:hidden"
              aria-expanded={railOpen}
              onClick={() => setRailOpen((value) => !value)}
            >
              Evidence
            </button>
            <button
              type="button"
              className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink xl:hidden"
              aria-expanded={queueOpen}
              onClick={() => setQueueOpen((value) => !value)}
            >
              {queueOpen ? "Hide queue" : `Queue · ${counts.now}`}
            </button>
            <button
              type="button"
              onClick={() => {
                // Second press while a check is in flight is a no-op, not a second run.
                if (busy === "check") return;
                void run("/api/desk/check", "POST", undefined, "check", "Recheck ran");
              }}
              aria-busy={busy === "check"}
              className={cn(
                "pm-control flex items-center gap-2 rounded bg-agency px-3.5 text-[14px] font-medium text-white hover:bg-agency-hover",
                busy === "check" && "cursor-progress opacity-80",
              )}
            >
              {busy === "check" ? <Loader2 size={14} className="animate-spin" /> : null}
              Recheck
            </button>
          </div>
        </div>
        <p className="pm-desk-subtitle mt-1 max-w-[46rem] text-[12.5px] text-ink-muted">
          {snap.demo || snap.mode === "demo" ? "Sample book. " : ""}
          Queue → case → Allow → Copy into your PMS. Recheck asks Bud; a miss stays a miss.
        </p>
        {isDemoWorkerMiss(snap.hands, snap.handsDetail) && snap.handsDetail ? (
          <div role="status" className="mt-2 flex max-w-full flex-wrap items-center gap-2 border border-hold/30 bg-hold/10 px-3 py-2 text-[13px] text-hold">
            <span className="min-w-0 flex-1">Missed — facts held. {snap.handsDetail}</span>
            {miss ? (
              <button
                type="button"
                className="pm-control rounded border border-hold/40 bg-sheet px-3 text-[13px] text-ink"
                onClick={() => {
                  location.hash = miss.hash;
                  dispatch({ type: "showYou" });
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
        {keysHint ? (
          <p className="pm-desk-hint mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
            <span>↑↓ move the queue · [ ] toggle Queue / Evidence</span>
            <button type="button" onClick={dismissKeysHint} className="text-agency hover:underline">
              Got it
            </button>
          </p>
        ) : null}
        <MorningBrief
          brief={brief}
          timezone={timezone}
          interactive
          collapsed={compact && !briefExpanded}
          onToggle={compact ? () => setBriefExpanded((value) => !value) : undefined}
          onOpenAddress={(propertyId) => {
            const row = rows.find((item) => item.propertyId === propertyId);
            if (!row) return;
            setMode("cases");
            setFilter(row.bucket);
            setSelectedId(row.id);
            setQueueOpen(false);
          }}
        />
        {/* In a short window with a case open, the case wins the space; the same
            go-live journey stays on You and in the sidebar pulse. */}
        {compact && selected && mode === "cases" ? null : (
          <GoLiveCard
            mode={snap.mode}
            agencyName={snap.book?.agency.name ?? ""}
            workerReady={Boolean(state.hermes?.ready)}
            compact
            onConnectExport={() => setMode("book")}
            onAttachWorker={() => dispatch({ type: "showYou" })}
            onNameAgency={() => dispatch({ type: "showYou" })}
          />
        )}
        {jobRunsOpen ? <JobRunFeed limit={6} className="mt-3" /> : null}
      </header>

      {mode === "book" ? (
        <DeskBook
          snap={snap}
          busy={busy}
          onAdd={(input) => void run("/api/desk/properties", "POST", input, "add", "Property added")}
          onAllowBookProposal={(id) => void run(`/api/desk/book-proposals/${id}/allow`, "POST", {}, id, "Property added to the book")}
          onDenyBookProposal={(id) => void run(`/api/desk/book-proposals/${id}/deny`, "POST", {}, id)}
          onAllowAllBookProposals={() => void run("/api/desk/book-proposals/allow-all", "POST", {}, "allow-all", "Properties added to the book")}
          onSave={(id, options) => void run(`/api/desk/properties/${id}`, "PATCH", options, id, "Options saved")}
          onNotes={(id, body) => void run(`/api/desk/properties/${id}/notes`, "PUT", { body }, `notes-${id}`, "Notes saved")}
          onDelete={(id) => void run(`/api/desk/properties/${id}`, "DELETE", undefined, `delete-${id}`, "Property removed")}
          onReset={() => void run("/api/desk/reset", "POST", undefined, "reset", "Sample morning replayed")}
          onPreviewImport={previewImport}
          onInspect={inspectImport}
          onImport={importReviewed}
        />
      ) : (
        <SplitView
          queueOpen={queueOpen}
          railOpen={railOpen}
          onCloseQueue={() => setQueueOpen(false)}
          queue={
            <QueuePane
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
              onEdit={(draft, body) => void run(`/api/desk/drafts/${draft.id}`, "PATCH", { body }, draft.id, "Wording saved")}
              onCopy={(body) => {
                void navigator.clipboard.writeText(body);
                const street = selected?.address ? selected.address.split(",")[0]?.trim() : "";
                setAnnounce(street ? `Copied… ${street}` : "Copied…");
              }}
              onPrepare={(draft) => void run(`/api/desk/drafts/${draft.id}/prepare`, "POST", undefined, `prepare-${draft.id}`, "Portal prepared")}
              onRecover={recoverCase}
            />
          }
          rail={
            <DeskEvidence
              snap={snap}
              item={selected}
              onPresent={(presentation) => void run("/api/desk/handoff/present", "POST", { presentation }, "present", "Browser view changed")}
            />
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
  const filters: Array<[QueueFilter, string]> = [
    ["now", "Now"],
    ["next", "Next"],
    ["waiting", "Waiting"],
    ["done", "Done"],
    ["all", "All"],
  ];
  const highlight = (id: string) => {
    onHighlight(id);
    document.getElementById(queueRowId(id))?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-sheet">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2.5">
        <h2 className="mr-1 text-[14px] font-semibold text-ink">Queue</h2>
        <button type="button" onClick={() => onFilter("now")} className="rounded-full">
          <StatusLabel tone="agency">{counts.now} need you</StatusLabel>
        </button>
        <button type="button" onClick={() => onFilter("waiting")} className="rounded-full">
          <StatusLabel tone="hold">{counts.waiting} waiting</StatusLabel>
        </button>
        {counts.next > 0 ? (
          <button type="button" onClick={() => onFilter("next")} className="rounded-full">
            <StatusLabel tone="muted">{counts.next} next</StatusLabel>
          </button>
        ) : null}
        {counts.done > 0 ? <StatusLabel tone="muted">{counts.done} done today</StatusLabel> : null}
        {counts.licensee > 0 ? (
          <StatusLabel tone="danger" title="For the licensed person — RealBud will not draft a notice">
            {counts.licensee} licensee
          </StatusLabel>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="pm-control ml-auto inline-flex items-center gap-1.5 rounded border border-line bg-paper px-2.5 text-[12px] text-ink xl:hidden"
          aria-label="Close queue"
        >
          <X size={14} aria-hidden />
          Close
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2.5" role="toolbar" aria-label="Queue filters">
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
            {label}
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
      <div
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
          filter === "now" ? (
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
            <p className="px-3 py-4 text-[13px] text-ink-muted">No cases in this filter.</p>
          )
        ) : (
          rows.map((row) => (
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
    </div>
  );
}

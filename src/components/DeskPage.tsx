import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, CircleAlert, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import type { DeskSnapshot, Draft, Property } from "@/lib/desk";
import { buildDeskQueue, filterDeskQueue, queueCounts, type QueueFilter } from "@/lib/desk-queue";
import { handsChip } from "@/lib/hands-label";
import { CaseQueueRow, RecoveryNotice, SplitView, StatusLabel } from "./pm";
import { DeskBook } from "./desk/DeskBook";
import { DeskCase } from "./desk/DeskCase";
import { DeskEvidence } from "./desk/DeskEvidence";
import { GoLiveCard } from "./desk/GoLiveCard";
import { MorningBrief, MorningEmpty } from "./desk/MorningBrief";
import { morningBrief } from "@/lib/morning-brief";
import { fmtDateTime } from "@/lib/au";
import { api, useStore } from "@/state/store";

export function DeskPage() {
  const { state, dispatch, refreshHermes } = useStore();
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"cases" | "book">("cases");
  const [filter, setFilter] = useState<QueueFilter>("needs-you");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [query, setQuery] = useState("");

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
    void refreshHermes();
  }, [load, refreshHermes]);

  useEffect(() => {
    if (state.desk) setSnap(state.desk);
  }, [state.desk]);

  const run = async (path: string, method: string, body?: unknown, key: string = method, spoken?: string) => {
    setBusy(key);
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const rows = useMemo(() => (snap ? buildDeskQueue(snap) : []), [snap]);
  const visible = useMemo(() => filterDeskQueue(rows, filter, query), [rows, filter, query]);
  const selected = visible.find((row) => row.id === selectedId) ?? visible[0];
  const counts = queueCounts(rows);

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
  const empty =
    snap.lastRunAt == null ? (
      <MorningEmpty
        brief={brief}
        busy={busy === "check"}
        onRecheck={() => void run("/api/desk/check", "POST", undefined, "check", "Recheck finished")}
      />
    ) : visible.length === 0 ? (
      query.trim() ? (
        <MorningEmpty brief={{ ...brief, headline: "No cases match that search." }} />
      ) : filter === "needs-you" ? (
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
      <header className="shrink-0 border-b border-line px-5 pb-3 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <Building2 size={21} className="text-agency" />
              <h1 className="pm-screen-title text-ink">Desk</h1>
            </div>
            <p className="mt-1 max-w-[46rem] text-[12.5px] text-ink-muted">
              {snap.demo || snap.mode === "demo" ? "Demo book. " : ""}
              Queue, case, evidence. Recheck lands every address. You send from the PMS. It will not send a notice or move trust.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink xl:hidden"
              aria-expanded={queueOpen}
              onClick={() => setQueueOpen((value) => !value)}
            >
              Queue
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
              aria-pressed={mode === "book"}
              onClick={() => setMode((value) => (value === "book" ? "cases" : "book"))}
              className={cn("pm-control rounded border px-3 text-[13px]", mode === "book" ? "border-agency bg-selected text-ink" : "border-line bg-sheet text-ink")}
            >
              Book
            </button>
            <button
              type="button"
              onClick={() => void run("/api/desk/check", "POST", undefined, "check", "Recheck finished")}
              aria-busy={busy === "check"}
              className="pm-control flex items-center gap-2 rounded bg-agency px-3.5 text-[14px] font-medium text-white hover:bg-agency-hover"
            >
              {busy === "check" ? <Loader2 size={14} className="animate-spin" /> : null}
              Recheck
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <StatusLabel tone="agency">{counts["needs-you"]} need you</StatusLabel>
          <StatusLabel tone="hold">{counts.held} held</StatusLabel>
          {counts["on-book"] > 0 ? (
            <button type="button" onClick={() => { setFilter("all"); setMode("cases"); }} className="rounded-full">
              <StatusLabel tone="muted">{counts["on-book"]} on the book</StatusLabel>
            </button>
          ) : null}
          <StatusLabel tone="danger">{counts.licensee} licensee</StatusLabel>
          <StatusLabel tone="muted">{snap.properties.length} properties</StatusLabel>
          <StatusLabel tone={snap.hands === "held" ? "hold" : snap.hands === "hermes" || snap.hands === "csv" ? "agency" : "muted"}>
            {handsChip(snap.hands)}
          </StatusLabel>
          {snap.lastRunAt ? (
            <StatusLabel tone="muted">Last check {fmtDateTime(snap.lastRunAt, timezone)}</StatusLabel>
          ) : null}
        </div>
        {snap.recovery?.active ? (
          <div className="mt-3">
            <RecoveryNotice>Desk is in recovery. Writes, schedules and browser work are paused. The book was not replaced with Demo data. Open You to unlock with your recovery key.</RecoveryNotice>
          </div>
        ) : null}
        {error ? (
          <div className="mt-3 flex items-start gap-2 border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        ) : null}
        <MorningBrief
          brief={brief}
          timezone={timezone}
          interactive
          onOpenAddress={(propertyId) => {
            const row = rows.find((item) => item.propertyId === propertyId);
            if (!row) return;
            setMode("cases");
            setFilter(row.bucket === "decided" || row.bucket === "on-book" ? "all" : row.bucket);
            setSelectedId(row.id);
            setQueueOpen(false);
          }}
        />
        <GoLiveCard
          mode={snap.mode}
          agencyName={snap.book?.agency.name ?? ""}
          workerReady={Boolean(state.hermes?.ready) || snap.hands === "hermes"}
          compact={snap.lastRunAt != null}
          onConnectExport={() => setMode("book")}
          onAttachWorker={() => dispatch({ type: "showYou" })}
          onSaveAgency={(name) => void run("/api/desk/agency", "PATCH", { name }, "agency", "Agency saved")}
        />
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
          onImport={(csv) => void run("/api/desk/import", "POST", { csv, expectedRevision: snap.revision }, "import", "CSV imported")}
        />
      ) : (
        <SplitView
          queueOpen={queueOpen}
          railOpen={railOpen}
          queue={
            <QueuePane
              filter={filter}
              onFilter={setFilter}
              query={query}
              onQuery={setQuery}
              rows={visible}
              selectedId={selected?.id}
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
              onDeny={(draft) => void run(`/api/desk/drafts/${draft.id}/deny`, "POST", { expectedRevision: snap.revision }, draft.id, "Wording denied")}
              onEdit={(draft, body) => void run(`/api/desk/drafts/${draft.id}`, "PATCH", { body }, draft.id, "Wording saved")}
              onCopy={(body) => {
                void navigator.clipboard.writeText(body);
                setAnnounce("Wording copied");
              }}
              onPrepare={(draft) => void run(`/api/desk/drafts/${draft.id}/prepare`, "POST", undefined, `prepare-${draft.id}`, "Portal prepared")}
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

function QueuePane({
  filter,
  onFilter,
  query,
  onQuery,
  rows,
  selectedId,
  onSelect,
}: {
  filter: QueueFilter;
  onFilter: (filter: QueueFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  rows: ReturnType<typeof filterDeskQueue>;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const filters: Array<[QueueFilter, string]> = [
    ["needs-you", "Needs you"],
    ["held", "Held"],
    ["licensee", "Licensee"],
    ["all", "All"],
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap gap-1 border-b border-line px-3 py-3">
        {filters.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => onFilter(value)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11px]",
              filter === value ? "border-agency bg-selected text-ink" : "border-line bg-sheet text-ink-muted",
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
          className="mt-1 w-full rounded border border-line bg-sheet px-2 py-1.5 text-[13px] text-ink"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Case queue">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-[13px] text-ink-muted">No cases in this filter.</p>
        ) : (
          rows.map((row) => (
            <CaseQueueRow
              key={row.id}
              title={row.address}
              meta={`${row.kind.replace("-", " ")} · ${row.meta}`}
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

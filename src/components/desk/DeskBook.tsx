import { useDeskViewState } from "@/lib/desk-view-state";
import { useDialogKeyboard } from "@/lib/use-dialog-keyboard";
import { usePropertyEdits, propertyEdits, changePropertyEdits, discardPropertyEdits, savePropertyEdits, hasPropertyEdits } from "@/lib/property-edits";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Loader2, Plus, RotateCcw, ShieldAlert, Trash2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtDate } from "@/lib/au";
import { aud, type CsvColumnMapping, type CsvImportPreview, type DeskSnapshot, type LedgerFacts, type NotifyChannel, type Property, type PropertyOptions, type RentSource } from "@/lib/desk";
import { useWorkspacePreferences, portfolioLayout } from "@/lib/workspace-preferences";
import { groupBySuburb, groupProperties, sortBook, type PropertyScope } from "@/lib/book-groups";
import { completenessLine, propertyCompleteness } from "@/lib/completeness";
import { handsFactSource } from "@/lib/hands-label";
import { CONTACT_ROLE_LABELS, NOTIFY_LABELS, RENT_SOURCE_LABELS } from "./labels";

function csvHeaderCells(text: string): string[] {
  const src = text.replace(/^\uFEFF/, "");
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") break;
    cell += ch;
  }
  cells.push(cell.trim());
  return cells.some((value) => value) ? cells : [];
}

function isMissingColumnError(message: string): boolean {
  return /csv missing column/i.test(message);
}

type ImportReview = {
  fileName: string;
  fileSize: number;
  csv: string;
  preview: CsvImportPreview | null;
  headers: string[];
  mapping?: CsvColumnMapping;
};


export function DeskBook({
  snap,
  busy,
  onAdd,
  onSave,
  onNotes,
  onDelete,
  onReset,
  onPreviewImport,
  onInspect,
  onImport,
  onAllowBookProposal,
  onDenyBookProposal,
  onAllowAllBookProposals,
  onOpenTasks,
  onGroupTasks,
  onGroupBatch,
  operationError,
}: {
  snap: DeskSnapshot;
  operationError: string;
  busy: string | null;
  onAdd: (input: { address: string; tenantName: string; tenantPhone: string; weeklyRentCents: number; propertyCode?: string }) => Promise<boolean>;
  onSave: (id: string, options: Partial<PropertyOptions>) => Promise<boolean>;
  onNotes: (id: string, body: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  onReset: () => void;
  onPreviewImport: (csv: string, mapping?: CsvColumnMapping) => Promise<CsvImportPreview>;
  onInspect: (csv: string) => Promise<CsvColumnMapping | null>;
  onImport: (input: { csv: string; expectedDigest: string; expectedRevision: number; observedAt: number; mapping?: CsvColumnMapping }) => Promise<void>;
  onAllowBookProposal: (id: string) => void;
  onDenyBookProposal: (id: string) => void;
  onAllowAllBookProposals: () => void;
  onOpenTasks: (property: Property) => void;
  onGroupTasks: (scope: PropertyScope) => void;
  onGroupBatch: (scope: PropertyScope) => void;
}) {
  const [adding, setAdding] = useState(false);
  const { preferences, update } = useWorkspacePreferences();
  const PROPERTY_PAGE_SIZE = preferences.pageSize;
  const arrange = preferences.propertySort;
  const setArrange = (propertySort: typeof arrange) => update({ propertySort });
  const { table } = portfolioLayout(preferences, snap.properties.length);
  const [expandedProperty, setExpandedProperty] = useDeskViewState("bookExpanded");
  const [filter, setFilter] = useDeskViewState("bookFilter");
  const [groupKey, setGroupKey] = useDeskViewState("bookGroup");
  const grouping = preferences.propertyGrouping;
  const [importReview, setImportReview] = useState<ImportReview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [page, setPage] = useDeskViewState("bookPage");
  const [proposalShown, setProposalShown] = useState(50);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return snap.properties;
    return snap.properties.filter((p) =>
      `${p.address} ${p.tenantName} ${p.propertyCode ?? ""}`.toLowerCase().includes(q),
    );
  }, [snap.properties, filter]);
  const groups = useMemo(() => grouping === "none" ? [] : groupProperties(visible, grouping, snap.book?.propertyPortals), [visible, grouping, snap.book?.propertyPortals]);
  const activeGroup = groups.find(group => group.key === groupKey);
  const browsingGroups = grouping !== "none" && groupKey === null;
  // A vanished group stays empty until the PM explicitly returns to the overview.
  const scoped = grouping === "none" ? visible : activeGroup?.properties ?? [];
  const ordered = useMemo(
    () =>
      arrange === "suburb"
        ? groupBySuburb(scoped).flatMap((group) => group.properties)
        : sortBook(scoped, snap.ledger, arrange),
    [arrange, snap.ledger, scoped],
  );
  const totalShown = browsingGroups ? groups.length : ordered.length;
  const pageCount = Math.max(1, Math.ceil(totalShown / PROPERTY_PAGE_SIZE));
  const effectivePage = Math.min(page, pageCount - 1);
  const pageProperties = ordered.slice(effectivePage * PROPERTY_PAGE_SIZE, (effectivePage + 1) * PROPERTY_PAGE_SIZE);
  const ledgerByProperty = useMemo(() => new Map(snap.ledger.map((row) => [row.propertyId, row])), [snap.ledger]);
  const tenanciesByProperty = useMemo(() => {
    const map = new Map<string, NonNullable<DeskSnapshot["book"]>["tenancies"]>();
    for (const row of snap.book?.tenancies ?? []) map.set(row.propertyId, [...(map.get(row.propertyId) ?? []), row]);
    return map;
  }, [snap.book?.tenancies]);
  const contactsByProperty = useMemo(() => {
    const map = new Map<string, NonNullable<DeskSnapshot["book"]>["contacts"]>();
    for (const row of snap.book?.contacts ?? []) map.set(row.propertyId, [...(map.get(row.propertyId) ?? []), row]);
    return map;
  }, [snap.book?.contacts]);
  const resultByProperty = useMemo(() => new Map(snap.results.map((row) => [row.propertyId, row])), [snap.results]);

  const pageContext = JSON.stringify([arrange, filter, PROPERTY_PAGE_SIZE, grouping, groupKey]);
  const previousPageContext = useRef(pageContext);
  useEffect(() => {
    if (previousPageContext.current !== pageContext) { previousPageContext.current = pageContext; setPage(0); }
  }, [pageContext]);
  const groupContext = JSON.stringify([grouping, filter]);
  const previousGroupContext = useRef(groupContext);
  useEffect(() => {
    if (previousGroupContext.current !== groupContext) { previousGroupContext.current = groupContext; setGroupKey(null); setExpandedProperty(null); }
  }, [groupContext]);
  useEffect(() => setPage((current) => Math.min(current, pageCount - 1)), [pageCount]);
  useEffect(() => setProposalShown(50), [snap.book?.bookProposals.length]);

  const cardFor = (property: Property) => (
    <PropertyCard
      key={property.id}
      property={property}
      facts={resultByProperty.has(property.id) ? ledgerByProperty.get(property.id) : undefined}
      tenancies={tenanciesByProperty.get(property.id) ?? []}
      contacts={contactsByProperty.get(property.id) ?? []}
      hands={snap.hands}
      result={resultByProperty.get(property.id)}
      onSave={(options) => onSave(property.id, options)}
      onNotes={(body) => onNotes(property.id, body)}
      onDelete={() => onDelete(property.id)}
      onOpenTasks={() => onOpenTasks(property)}
    />
  );

  const readImportFile = async (file: File) => {
    setImportError("");
    if (file.size === 0) {
      setImportError("That CSV is empty.");
      return;
    }
    if (file.size > 750_000) {
      setImportError("That CSV is too large. Use a file under 750 KB.");
      return;
    }
    setImportBusy(true);
    try {
      const csv = await file.text();
      const headers = csvHeaderCells(csv);
      try {
        const preview = await onPreviewImport(csv);
        setImportReview({ fileName: file.name, fileSize: file.size, csv, preview, headers: preview.headers.length ? preview.headers : headers });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (isMissingColumnError(message) && headers.length) {
          setImportError(message);
          setImportReview({ fileName: file.name, fileSize: file.size, csv, preview: null, headers });
        } else {
          setImportError(message);
        }
      }
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImportBusy(false);
    }
  };
  return (
    <div className="desk-property-book min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Properties</h2>
          <p className="mt-1 text-[13px] text-ink-muted">Find a property, update its notes and options, or open its tasks.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter address, tenant, code"
            aria-label="Filter the book"
            className="w-44 rounded border border-line bg-inset px-2 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-muted/70"
          />
          <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            Arrange
            <select
              value={arrange}
              onChange={(event) => setArrange(event.target.value as typeof arrange)}
              className="rounded border border-line bg-inset px-2 py-1.5 text-[12.5px] text-ink outline-none"
            >
              <option value="suburb">By suburb</option>
              <option value="address">Address A–Z</option>
              <option value="rent">Rent high–low</option>
              <option value="late">Days late</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="pm-control flex items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover"
          >
            <Plus size={14} />
            Add property
          </button>
          <label className="pm-control flex cursor-pointer items-center gap-1.5 rounded border border-line bg-sheet px-3 text-[13px] font-medium text-ink hover:bg-raised">
            {importBusy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
            Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              disabled={importBusy || busy !== null}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void readImportFile(file);
              }}
            />
          </label>
        </div>
      </div>
      <nav className="property-group-tabs" aria-label="Group properties">
        {([ ["none", "All properties"], ["building", "Buildings"], ["suburb", "Suburbs"], ["portal", "Portals"] ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={grouping === value} onClick={() => { update({ propertyGrouping: value }); setGroupKey(null); setPage(0); }}>{label}</button>)}
        <span>{visible.length} properties{grouping !== "none" ? ` · ${groups.length} groups` : ""}</span>
      </nav>
      {grouping !== "none" && !browsingGroups && <div className="property-group-path">
        <button type="button" onClick={() => { setGroupKey(null); setPage(0); }}>← All groups</button>
        <strong>{activeGroup?.label ?? "Group no longer available"}</strong>
        {activeGroup && <><span>{activeGroup.properties.length} properties · {aud(activeGroup.weeklyRentCents)}/wk</span><div><button type="button" onClick={() => onGroupTasks({ label: activeGroup.label, ids: activeGroup.properties.map(p => p.id) })}>View group tasks</button><button type="button" onClick={() => onGroupBatch({ label: activeGroup.label, ids: activeGroup.properties.map(p => p.id) })}>Prepare group work</button></div></>}
      </div>}
      {browsingGroups && groups.length > 0 ? <div className="property-group-grid" aria-label="Property groups">
        {groups.slice(effectivePage * PROPERTY_PAGE_SIZE, (effectivePage + 1) * PROPERTY_PAGE_SIZE).map(group => <button type="button" className="property-group-card" key={group.key} onClick={() => { setGroupKey(group.key); setPage(0); }}>
          <strong>{group.label}</strong><span>{group.properties.length} {group.properties.length === 1 ? "property" : "properties"} <span aria-hidden="true">→</span></span><small>{aud(group.weeklyRentCents)}/wk · {group.detail}</small>
        </button>)}
      </div> : (browsingGroups ? groups.length === 0 : ordered.length === 0) ? (
        <p className="rounded-lg border border-line bg-sheet px-4 py-6 text-center text-[13px] text-ink-muted">
          {filter.trim() ? `Nothing on the book matches “${filter.trim()}”.` : groupKey ? "No properties remain in this group. Return to all groups to continue." : "No properties yet. Add a property to get started."}
          {filter.trim() && <button type="button" onClick={() => setFilter("")} className="ml-3 text-agency underline">Clear search</button>}
        </p>
      ) : table ? (
        <div className="desk-property-table-wrap"><table className="desk-property-table"><caption className="sr-only">Property book</caption><thead><tr><th>Property</th><th>Tenant</th><th>Weekly rent</th><th>Recorded status</th><th>Actions</th></tr></thead><tbody>
          {pageProperties.map(property => {
            const facts = resultByProperty.has(property.id) ? ledgerByProperty.get(property.id) : undefined;
            return <Fragment key={property.id}><tr><th scope="row">{property.address}<span>{property.propertyCode}</span>{(propertyEdits(property.id).notes !== undefined || propertyEdits(property.id).options) && <span className="text-hold">Unsaved edits</span>}</th><td>{property.tenantName || "Not recorded"}</td><td>{aud(property.weeklyRentCents)}</td><td>{!facts ? "Not checked" : facts.rentLanded ? "Rent recorded" : `${facts.daysSinceDue}d since due`}</td><td><div className="desk-table-actions"><button type="button" onClick={() => onOpenTasks(property)}>View tasks</button><button type="button" aria-expanded={expandedProperty === property.id} aria-label={`Manage ${property.address}`} onClick={() => setExpandedProperty(current => current === property.id ? null : property.id)}>{expandedProperty === property.id ? "Close" : "Manage"}</button></div></td></tr>
              {expandedProperty === property.id && <tr><td colSpan={5}>{cardFor(property)}</td></tr>}
            </Fragment>;
          })}
        </tbody></table></div>
      ) : arrange === "suburb" ? (
        <div className="space-y-6">
          {groupBySuburb(pageProperties).map((group) => (
            <section key={group.suburb}>
              <h3 className="mb-2 flex items-baseline gap-2 text-[13px] font-semibold text-ink">
                {group.suburb}
                <span className="text-[12px] font-normal text-ink-muted">
                  {group.properties.length} · {aud(group.weeklyRentCents)}/wk
                </span>
              </h3>
              <div className="grid gap-3 xl:grid-cols-2">{group.properties.map(cardFor)}</div>
            </section>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">{pageProperties.map(cardFor)}</div>
      )}
      {totalShown > 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[12px] text-ink-muted">
          <span>
            Showing {effectivePage * PROPERTY_PAGE_SIZE + 1}–{Math.min((effectivePage + 1) * PROPERTY_PAGE_SIZE, totalShown)} of {totalShown}{browsingGroups ? " groups" : ""}
          </span>
          {pageCount > 1 ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={effectivePage === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                className="pm-control rounded border border-line bg-sheet px-3 text-[12px] text-ink disabled:opacity-40"
              >
                Previous
              </button>
              <span className="tabular-nums">Page {effectivePage + 1} of {pageCount}</span>
              <button
                type="button"
                disabled={effectivePage >= pageCount - 1}
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                className="pm-control rounded border border-line bg-sheet px-3 text-[12px] text-ink disabled:opacity-40"
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {(snap.book?.archivedProperties.length ?? 0) > 0 ? (
        <section className="mt-6">
          <h3 className="text-[13px] font-semibold text-ink">Archived</h3>
          <p className="mt-1 text-[12px] text-ink-muted">Removed from the live book. Cases, evidence and decisions stay.</p>
          <ul className="mt-2 space-y-1 text-[13px] text-ink">
            {snap.book?.archivedProperties.map((property) => (
              <li key={property.id}>{property.address}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {(snap.book?.bookProposals.length ?? 0) > 0 && snap.book && (
        <section className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-semibold text-ink">Intake drafts — Bud prepared these</h3>
            <button
              type="button"
              disabled={busy !== null}
              onClick={onAllowAllBookProposals}
              className="rounded-lg bg-agency px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              Allow all
            </button>
          </div>
          <p className="mt-1 text-[12px] text-ink-muted">From what you gave Bud. Nothing is in the book until you allow it.</p>
          <ul className="mt-2 space-y-2">
            {snap.book.bookProposals.slice(0, proposalShown).map((proposal) => (
              <li key={proposal.id} className="rounded-xl border border-line bg-sheet px-3 py-2.5">
                <div className="text-[13px] font-medium text-ink">{proposal.address}</div>
                <div className="text-[12px] text-ink-muted">
                  {proposal.tenantName} · {proposal.tenantPhone} · ${proposal.weeklyRentCents / 100}/wk
                </div>
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => onAllowBookProposal(proposal.id)}
                    className="rounded-lg bg-agency px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
                  >
                    Add to book
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => onDenyBookProposal(proposal.id)}
                    className="rounded-lg px-2.5 py-1 text-[12px] text-ink-muted hover:bg-raised hover:text-ink disabled:opacity-40"
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {snap.book.bookProposals.length > proposalShown ? (
            <button
              type="button"
              onClick={() => setProposalShown((current) => current + 50)}
              className="pm-control mt-2 rounded border border-line bg-sheet px-3 text-[12px] text-ink"
            >
              Show 50 more ({snap.book.bookProposals.length - proposalShown} hidden)
            </button>
          ) : null}
        </section>
      )}
      {(snap.book?.importIssues.length ?? 0) > 0 ? (
        <section className="mt-6">
          <h3 className="text-[13px] font-semibold text-ink">Import issues</h3>
          <p className="mt-1 text-[12px] text-ink-muted">Unmatched or ambiguous source rows. Not properties.</p>
          <ul className="mt-2 space-y-1 text-[13px] text-ink">
            {snap.book?.importIssues.map((issue) => (
              <li key={issue.id}>
                {issue.kind} · {issue.status} · {issue.rawIdentity}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {snap.demo && <button
        type="button"
        disabled={busy !== null || hasPropertyEdits()}
        onClick={onReset}
        className="mt-4 flex items-center gap-1.5 text-[12px] text-ink-muted hover:text-ink"
      >
        {busy === "reset" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        Replay sample morning
      </button>}
      {importError && !importReview ? <p role="alert" className="mt-1 text-[12px] text-danger">{importError}</p> : null}
      {adding ? (
        <AddPropertyModal
          saveError={operationError}
          onClose={() => setAdding(false)}
          onAdd={async (input) => {
            const saved = await onAdd(input);
            if (saved) setAdding(false);
            return saved;
          }}
        />
      ) : null}
      {importReview ? (
        <CsvImportReviewModal
          review={importReview}
          busy={importBusy}
          error={importError}
          onClose={() => {
            if (importBusy) return;
            setImportReview(null);
            setImportError("");
          }}
          onInspect={async () => {
            setImportBusy(true);
            setImportError("");
            try {
              const mapping = await onInspect(importReview.csv);
              if (mapping) setImportReview({ ...importReview, mapping });
              return mapping;
            } catch (cause) {
              setImportError(cause instanceof Error ? cause.message : String(cause));
              return null;
            } finally {
              setImportBusy(false);
            }
          }}
          onRemap={async (mapping) => {
            setImportBusy(true);
            setImportError("");
            try {
              const preview = await onPreviewImport(importReview.csv, mapping);
              setImportReview({ ...importReview, preview, mapping, headers: preview.headers.length ? preview.headers : importReview.headers });
            } catch (cause) {
              setImportError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setImportBusy(false);
            }
          }}
          onImport={async () => {
            if (!importReview.preview) return;
            setImportBusy(true);
            setImportError("");
            try {
              await onImport({
                csv: importReview.csv,
                expectedDigest: importReview.preview.digest,
                expectedRevision: importReview.preview.expectedRevision,
                observedAt: importReview.preview.observedAt,
                mapping: importReview.mapping,
              });
              setImportReview(null);
            } catch (cause) {
              setImportError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setImportBusy(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function columnLine(detected: CsvColumnMapping): string {
  const parts: string[] = [];
  if (detected.identity) parts.push(`Match by: ${detected.identity}`);
  if (detected.daysSinceDue) parts.push(`Days late: ${detected.daysSinceDue}`);
  if (detected.rentLanded) parts.push(`Rent landed: ${detected.rentLanded}`);
  if (detected.levyPaid) parts.push(`Levy paid: ${detected.levyPaid}`);
  return parts.join(" · ");
}

function CsvImportReviewModal({
  review,
  busy,
  error,
  onClose,
  onImport,
  onInspect,
  onRemap,
}: {
  review: ImportReview;
  busy: boolean;
  error: string;
  onClose: () => void;
  onImport: () => void;
  onInspect: () => Promise<CsvColumnMapping | null>;
  onRemap: (mapping: CsvColumnMapping) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [identity, setIdentity] = useState(review.mapping?.identity ?? "");
  const [daysSinceDue, setDaysSinceDue] = useState(review.mapping?.daysSinceDue ?? "");
  const [rentLanded, setRentLanded] = useState(review.mapping?.rentLanded ?? "");
  const [levyPaid, setLevyPaid] = useState(review.mapping?.levyPaid ?? "");
  const [budNote, setBudNote] = useState("");
  useDialogKeyboard(dialogRef, onClose, busy);
  const { preview } = review;
  const mappingReady = Boolean(identity && daysSinceDue && rentLanded && levyPaid);
  const inputClass = "mt-1 w-full rounded border border-line bg-inset px-3 py-2 text-[13.5px] text-ink outline-none";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-5" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="csv-review-title" className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto border border-line bg-sheet p-5 shadow-lg outline-none">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div id="csv-review-title" className="text-[16px] font-semibold text-ink">Review this CSV before it changes the book</div>
            <p className="mt-1 text-[12px] text-ink-muted">{review.fileName} · {Math.max(1, Math.ceil(review.fileSize / 1024))} KB{preview ? ` · ${preview.totalRows} rows` : ""}</p>
          </div>
          <button type="button" disabled={busy} onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-raised disabled:opacity-40" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {preview ? (
          <>
            {columnLine(preview.detected) ? <p className="mt-3 text-[12px] text-ink-muted">Columns · {columnLine(preview.detected)}</p> : null}
            {preview.rejected.length ? <p className="mt-2 text-[12px] text-hold">{preview.rejected.length} rows need attention</p> : null}
            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[12px]">
              <div className="rounded bg-agency/10 px-2 py-2 text-agency"><strong className="block text-[16px]">{preview.matched.length}</strong>Matched</div>
              <div className="rounded bg-hold/10 px-2 py-2 text-hold"><strong className="block text-[16px]">{preview.unmatched.length}</strong>Unmatched</div>
              <div className="rounded bg-hold/10 px-2 py-2 text-hold"><strong className="block text-[16px]">{preview.ambiguous.length}</strong>Ambiguous</div>
            </div>
            <div className="mt-4 space-y-3 text-[12px]">
              {preview.matched.length ? <section><h3 className="font-semibold text-ink">Will update</h3><ul className="mt-1 space-y-1 text-ink-muted">{preview.matched.map((row) => <li key={row.propertyId}>{row.address}</li>)}</ul></section> : null}
              {preview.unmatched.length ? <section><h3 className="font-semibold text-hold">Will be held for mapping</h3><ul className="mt-1 space-y-1 text-ink-muted">{preview.unmatched.map((row, index) => <li key={`${row.kind}-${row.value}-${index}`}>{row.kind}: {row.value}</li>)}</ul></section> : null}
              {preview.ambiguous.length ? <section><h3 className="font-semibold text-hold">Needs one exact property</h3><ul className="mt-1 space-y-1 text-ink-muted">{preview.ambiguous.map((row, index) => <li key={`${row.kind}-${row.value}-${index}`}>{row.kind}: {row.value} · {row.matchCount} matches</li>)}</ul></section> : null}
            </div>
            <p className="mt-4 border border-line bg-inset px-3 py-2 text-[12px] text-ink-muted">No changes have been made yet. Importing updates matched ledger facts and places unresolved rows on Desk as holds.</p>
          </>
        ) : (
          <div className="mt-4">
            {review.headers.length > 0 ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    const mapping = await onInspect();
                    if (!mapping) {
                      setBudNote("");
                      return;
                    }
                    setIdentity(mapping.identity ?? "");
                    setDaysSinceDue(mapping.daysSinceDue ?? "");
                    setRentLanded(mapping.rentLanded ?? "");
                    setLevyPaid(mapping.levyPaid ?? "");
                    setBudNote("Bud read the file — check the columns, then preview.");
                  })();
                }}
                className="text-[12px] text-ink-muted hover:text-ink disabled:opacity-40"
              >
                Ask Bud to read the columns
              </button>
            ) : null}
            {budNote ? <p className="mt-2 text-[12px] text-ink-muted">{budNote}</p> : null}
            <div className={cn("grid grid-cols-2 gap-3", review.headers.length > 0 && "mt-3")}>
            {([
              ["Identity column", identity, setIdentity],
              ["Days late", daysSinceDue, setDaysSinceDue],
              ["Rent landed", rentLanded, setRentLanded],
              ["Levy paid", levyPaid, setLevyPaid],
            ] as const).map(([label, value, setValue]) => (
              <label key={label} className="block text-[12px] text-ink-muted">
                {label}
                <select value={value} onChange={(event) => setValue(event.target.value)} className={inputClass}>
                  <option value="">Select column</option>
                  {review.headers.map((header) => (
                    <option key={`${label}-${header}`} value={header}>{header}</option>
                  ))}
                </select>
              </label>
            ))}
            </div>
          </div>
        )}
        {error ? <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="pm-control rounded px-4 text-[13px] text-ink-muted hover:bg-raised disabled:opacity-40">Cancel</button>
          {preview ? (
            <button type="button" disabled={busy || preview.matched.length === 0} onClick={onImport} className="pm-control flex items-center gap-2 rounded bg-agency px-4 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40">
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              Import reviewed rows
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || !mappingReady}
              onClick={() => onRemap({ identity, daysSinceDue, rentLanded, levyPaid })}
              className="pm-control flex items-center gap-2 rounded bg-agency px-4 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              Preview columns
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PropertyCard({
  property,
  facts,
  tenancies,
  contacts,
  hands,
  result,
  onSave,
  onNotes,
  onDelete,
  onOpenTasks,
}: {
  property: Property;
  facts?: LedgerFacts;
  tenancies: NonNullable<DeskSnapshot["book"]>["tenancies"];
  contacts: NonNullable<DeskSnapshot["book"]>["contacts"];
  hands: DeskSnapshot["hands"];
  result?: DeskSnapshot["results"][number];
  onSave: (options: Partial<PropertyOptions>) => Promise<boolean>;
  onNotes: (body: string) => Promise<boolean>;
  onDelete: () => void;
  onOpenTasks: () => void;
}) {
  const edits = usePropertyEdits(property.id);
  const [open, setOpen] = useState(Boolean(edits.options));
  const optionEdits = edits.options ?? {};
  const graceDays = optionEdits.graceDays ?? String(property.options.graceDays);
  const courtesyUntilDay = optionEdits.courtesyUntilDay ?? String(property.options.courtesyUntilDay);
  const levyOn = optionEdits.levyOn ?? Boolean(property.options.levyFromRent);
  const levyAmount = optionEdits.levyAmount ?? String((property.options.levyFromRent?.amountCents ?? 42000) / 100);
  const rentSource = optionEdits.rentSource ?? property.options.rentSource;
  const notifyChannel = optionEdits.notifyChannel ?? property.options.notifyChannel;
  const notes = edits.notes ?? property.notes ?? "";
  const setGraceDays = (value: string) => changePropertyEdits(property.id, { options: { graceDays: value } });
  const setCourtesyUntilDay = (value: string) => changePropertyEdits(property.id, { options: { courtesyUntilDay: value } });
  const setLevyOn = (value: boolean) => changePropertyEdits(property.id, { options: { levyOn: value } });
  const setLevyAmount = (value: string) => changePropertyEdits(property.id, { options: { levyAmount: value } });
  const setRentSource = (value: RentSource) => changePropertyEdits(property.id, { options: { rentSource: value } });
  const setNotifyChannel = (value: NotifyChannel) => changePropertyEdits(property.id, { options: { notifyChannel: value } });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const validOptions = graceDays.trim() !== "" && courtesyUntilDay.trim() !== "" && Number.isInteger(Number(graceDays)) && Number.isInteger(Number(courtesyUntilDay)) && Number(graceDays) >= 0 && Number(graceDays) <= 28 && Number(courtesyUntilDay) > Number(graceDays) && Number(courtesyUntilDay) <= 60 && (!levyOn || (Number.isFinite(Number(levyAmount)) && Number(levyAmount) > 0));

  const resultLabel = result
    ? {
        "rent-unpaid-courtesy": `${result.daysLate}d late · courtesy draft`,
        "rent-landed-levy-unpaid": "Rent in · levy not paid out",
        "rent-landed": "Checked · rent landed",
        "inside-grace": `Checked · day ${result.daysLate}, still in grace`,
        "already-reminded": "Checked · already reminded",
        "statutory-clock": `${result.daysLate}d late · licensee`,
        "stale-source": "Held · stale source",
        "unknown-facts": "Held · unknown facts",
        unmatched: "Held · unmatched",
        reversed: "Held · reversed payment",
        partial: "Held · partial payment",
        "uncovered-by-worker": "Held · Bud missed this property",
        "ambiguous-match": "Held · ambiguous match",
      }[result.reason]
    : "Not checked yet";

  return (
    <article className="desk-property-card rounded-lg border border-line bg-sheet p-4" aria-label={property.address}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-ink">{property.address}</div>
          <div className="mt-0.5 text-[12px] text-ink-muted">
            {property.tenantName} · {property.tenantPhone} · {aud(property.weeklyRentCents)}/wk
          </div>
          {completenessLine(propertyCompleteness(property, { tenancies, contacts })) ? (
            <div className="mt-1 text-[11px] text-ink-muted/80">
              {completenessLine(propertyCompleteness(property, { tenancies, contacts }))}
            </div>
          ) : null}
        </div>
        <span className={cn("rounded px-2 py-1 text-[11px]", result?.outcome === "escalate" ? "bg-hold/15 text-hold" : "bg-raised text-ink-muted")}>
          {resultLabel}
        </span>
      </div>

      {tenancies.length ? (
        <div className="mt-2 text-[12px] text-ink-muted">
          {tenancies.map((tenancy) => (
            <div key={tenancy.id}>
              {tenancy.status === "current" ? "Current" : "Closed"} tenancy · {aud(tenancy.weeklyRentCents)}/wk
              {tenancy.closedAt ? ` · closed ${fmtDate(tenancy.closedAt)}` : ""}
            </div>
          ))}
        </div>
      ) : null}
      {contacts.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {contacts.map((contact) => (
            <span key={contact.id} className="rounded bg-inset px-2 py-1 text-[11px] text-ink-muted">
              {CONTACT_ROLE_LABELS[contact.role] ?? contact.role} · {contact.name}
            </span>
          ))}
        </div>
      ) : null}

      {facts ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="rounded bg-inset px-2 py-1 text-ink-muted">{facts.daysSinceDue}d late</span>
          <span className={cn("rounded px-2 py-1", facts.rentLanded ? "bg-agency/10 text-agency" : "bg-inset text-ink-muted")}>
            {facts.rentLanded ? "Rent in" : "No rent yet"}
          </span>
          {property.options.levyFromRent ? (
            <span className={cn("rounded px-2 py-1", facts.levyPaid ? "bg-agency/10 text-agency" : "bg-hold/10 text-hold")}>
              Levy {facts.levyPaid ? "paid" : "not paid"}
            </span>
          ) : null}
          <span className="ml-auto text-[10.5px] text-ink-muted">
            {handsFactSource(hands)}
          </span>
        </div>
      ) : null}

      <details open={edits.notes !== undefined} className="desk-property-notes mt-3 text-[12px] text-ink-muted">
        <summary className="cursor-pointer py-1.5">{notes.trim() ? "View or edit notes" : "Add a note"}</summary>
        <label className="block"><span className="sr-only">Notes for {property.address}</span>
        <textarea
          value={notes}
          onChange={(event) => changePropertyEdits(property.id, { notes: event.target.value })}
          disabled={edits.pending}
          maxLength={20000}
          rows={3}
          placeholder="Useful context for this property, such as access instructions or contact preferences."
          className="mt-1 w-full resize-y rounded border border-line bg-inset px-3 py-2 text-[13px] text-ink outline-none"
        />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-3"><button type="button" disabled={edits.pending || edits.notes === undefined} onClick={() => void savePropertyEdits(property.id, "notes", () => onNotes(notes))} className="pm-control rounded bg-agency px-3 text-white disabled:opacity-40">{edits.pending ? "Saving…" : "Save notes"}</button>{edits.notes !== undefined && <button type="button" disabled={edits.pending} onClick={() => discardPropertyEdits(property.id, "notes")}>Discard note edits</button>}</div>
        <p className="mt-1 text-[11px] text-ink-muted">Unsaved edits stay while you move around RealBud. Save before closing the app.</p>
      </details>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onOpenTasks} className="pm-control rounded border border-line px-3 text-[12px] font-medium text-agency hover:bg-raised">View tasks</button>
        <button type="button" onClick={() => setOpen((value) => !value)} className="text-[12px] text-agency hover:underline">
          {open ? "Hide options" : "Edit options"}
        </button>
        <div className="ml-auto">
          {confirmDelete ? (
            <span className="flex items-center gap-1.5 text-[12px]">
              <span className="text-ink-muted">Remove from book?</span>
              <button type="button" disabled={Boolean(edits.pending || edits.notes !== undefined || edits.options)} onClick={onDelete} className="rounded bg-danger px-2 py-1 font-medium text-white">
                Remove
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded px-2 py-1 text-ink-muted hover:bg-raised">
                Keep
              </button>
            </span>
          ) : (
            <button type="button" disabled={Boolean(edits.pending || edits.notes !== undefined || edits.options)} title={edits.notes !== undefined || edits.options ? "Save or discard edits before removing this property" : undefined} onClick={() => setConfirmDelete(true)} className="flex items-center gap-1 text-[11.5px] text-ink-muted hover:text-danger">
              <Trash2 size={12} />
              Remove
            </button>
          )}
        </div>
      </div>

      {(edits.notes !== undefined || edits.options) && <p className="mt-2 text-[12px] text-hold">Unsaved {edits.notes !== undefined && edits.options ? "notes and options" : edits.options ? "options" : "notes"} · kept for this session</p>}
      {edits.error && <p role="alert" className="mt-2 text-[12px] text-danger">{edits.error}</p>}
      {edits.notice && <p role="status" className="mt-2 text-[12px] text-agency">{edits.notice}</p>}
      {open ? (
        <form
          className="mt-3 space-y-3 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!validOptions) return;
            const patch: Partial<PropertyOptions> = {
              ...(optionEdits.graceDays !== undefined ? { graceDays: Number(graceDays) } : {}),
              ...(optionEdits.courtesyUntilDay !== undefined ? { courtesyUntilDay: Number(courtesyUntilDay) } : {}),
              ...(optionEdits.levyOn !== undefined || optionEdits.levyAmount !== undefined ? { levyFromRent: levyOn ? { amountCents: Math.round(Number(levyAmount) * 100), cadence: property.options.levyFromRent?.cadence ?? "quarterly" } : null } : {}),
              ...(optionEdits.rentSource !== undefined ? { rentSource } : {}),
              ...(optionEdits.notifyChannel !== undefined ? { notifyChannel } : {}),
            };
            void savePropertyEdits(property.id, "options", () => onSave(patch));
          }}
        >
          <fieldset disabled={edits.pending} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12px] text-ink-muted">
              Rent source
              <select value={rentSource} onChange={(event) => setRentSource(event.target.value as RentSource)} className="mt-1 w-full rounded border border-line bg-inset px-3 py-2 text-[13px] text-ink">
                {(Object.keys(RENT_SOURCE_LABELS) as RentSource[]).map((value) => (
                  <option key={value} value={value}>{RENT_SOURCE_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[12px] text-ink-muted">
              Notify channel
              <select value={notifyChannel} onChange={(event) => setNotifyChannel(event.target.value as NotifyChannel)} className="mt-1 w-full rounded border border-line bg-inset px-3 py-2 text-[13px] text-ink">
                {(Object.keys(NOTIFY_LABELS) as NotifyChannel[]).map((value) => (
                  <option key={value} value={value}>{NOTIFY_LABELS[value]}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12px] text-ink-muted">
              Grace days
              <input type="number" min={0} max={28} value={graceDays} onChange={(event) => setGraceDays(event.target.value)} className="mt-1 w-full rounded border border-line bg-inset px-3 py-2 text-[13px] text-ink" />
            </label>
            <label className="block text-[12px] text-ink-muted">
              Courtesy until day
              <input type="number" min={1} max={60} value={courtesyUntilDay} onChange={(event) => setCourtesyUntilDay(event.target.value)} className="mt-1 w-full rounded border border-line bg-inset px-3 py-2 text-[13px] text-ink" />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked={levyOn} onChange={(event) => setLevyOn(event.target.checked)} />
            Levy taken from rent
          </label>
          {levyOn ? (
            <label className="block text-[12px] text-ink-muted">
              Levy amount (AUD)
              <input type="number" min={1} step="0.01" value={levyAmount} onChange={(event) => setLevyAmount(event.target.value)} className="mt-1 w-full rounded border border-line bg-inset px-3 py-2 text-[13px] text-ink" />
            </label>
          ) : null}
          <div className="flex items-center gap-2 text-[11.5px] text-ink-muted">
            <ShieldAlert size={13} className="text-hold" />
            Formal notices and trust payments need separate handling.
          </div>
          {!validOptions && <p role="alert" className="text-[12px] text-danger">Use whole days, with the courtesy limit later than the grace period. Any levy amount must be positive.</p>}
          <button type="submit" disabled={edits.pending || !edits.options || !validOptions} className="rounded bg-agency px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40">{edits.pending ? "Saving…" : "Save options"}</button>
          {edits.options && <button type="button" disabled={edits.pending} onClick={() => discardPropertyEdits(property.id, "options")} className="ml-3 text-[12px] text-ink-muted">Discard option edits</button>}
          </fieldset>
        </form>
      ) : null}
    </article>
  );
}

function AddPropertyModal({
  saveError,
  onClose,
  onAdd,
}: {
  saveError: string;
  onClose: () => void;
  onAdd: (input: { address: string; tenantName: string; tenantPhone: string; weeklyRentCents: number; propertyCode?: string }) => Promise<boolean>;
}) {
  const [address, setAddress] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
  const [propertyCode, setPropertyCode] = useState("");
  const [rent, setRent] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const valid = Boolean(address.trim() && tenantName.trim() && Number.isFinite(Number(rent)) && Number(rent) > 0);
  useDialogKeyboard(dialogRef, onClose, busy);
  const submit = async () => {
    if (!valid || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const saved = await onAdd({ address: address.trim(), tenantName: tenantName.trim(), tenantPhone: tenantPhone.trim(), weeklyRentCents: Math.round(Number(rent) * 100), ...(propertyCode.trim() ? { propertyCode: propertyCode.trim() } : {}) });
      if (!saved) setError("Could not add the property. Check the connection and try again.");
    } catch { setError("Could not add the property."); }
    finally { saving.current = false; setBusy(false); }
  };
  const inputClass = "mt-1 w-full rounded border border-line bg-inset px-3 py-2 text-[13.5px] text-ink outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-5" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="add-property-title" className="max-h-[85vh] overflow-y-auto w-full max-w-[440px] border border-line bg-sheet p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div id="add-property-title" className="text-[16px] font-semibold text-ink">Add a property</div>
            <p className="mt-0.5 text-[12px] text-ink-muted">Add the property and tenant details. You can review its options and add notes next.</p>
          </div>
          <button type="button" disabled={busy} onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-raised" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <fieldset disabled={busy} className="mt-4 min-w-0 space-y-3">
          <label className="block text-[12px] text-ink-muted">
            Address
            <input data-dialog-autofocus maxLength={160} value={address} onChange={(event) => setAddress(event.target.value)} className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12px] text-ink-muted">
              Tenant
              <input value={tenantName} onChange={(event) => setTenantName(event.target.value)} className={inputClass} />
            </label>
            <label className="block text-[12px] text-ink-muted">
              Phone
              <input value={tenantPhone} onChange={(event) => setTenantPhone(event.target.value)} className={inputClass} />
            </label>
          </div>
          <label className="block text-[12px] text-ink-muted">
            Weekly rent (AUD)
            <input type="number" min={1} step="0.01" value={rent} onChange={(event) => setRent(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submit()} className={inputClass} />
          </label>
          <label className="block text-[12px] text-ink-muted">
            Property code in your PMS (optional — your export can match on it)
            <input maxLength={80} value={propertyCode} onChange={(event) => setPropertyCode(event.target.value)} className={inputClass} />
          </label>
        </fieldset>
        {error && <p role="alert" className="mt-3 text-[12px] text-danger">{saveError || error} Your details are kept here. If a previous attempt was interrupted, check the book before retrying.</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="pm-control rounded px-4 text-[13px] text-ink-muted hover:bg-raised">
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={!valid || busy} className="pm-control rounded bg-agency px-4 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40">
            {busy ? "Adding…" : "Add to book"}
          </button>
        </div>
      </div>
    </div>
  );
}

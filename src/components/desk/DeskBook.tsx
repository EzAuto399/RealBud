import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, RotateCcw, ShieldAlert, Trash2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtDate } from "@/lib/au";
import { aud, type CsvColumnMapping, type CsvImportPreview, type DeskSnapshot, type LedgerFacts, type NotifyChannel, type Property, type PropertyOptions, type RentSource } from "@/lib/desk";
import { groupBySuburb, sortBook } from "@/lib/book-groups";
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
}: {
  snap: DeskSnapshot;
  busy: string | null;
  onAdd: (input: { address: string; tenantName: string; tenantPhone: string; weeklyRentCents: number; propertyCode?: string }) => void;
  onSave: (id: string, options: Partial<PropertyOptions>) => void;
  onNotes: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onReset: () => void;
  onPreviewImport: (csv: string, mapping?: CsvColumnMapping) => Promise<CsvImportPreview>;
  onInspect: (csv: string) => Promise<CsvColumnMapping | null>;
  onImport: (input: { csv: string; expectedDigest: string; expectedRevision: number; observedAt: number; mapping?: CsvColumnMapping }) => Promise<void>;
  onAllowBookProposal: (id: string) => void;
  onDenyBookProposal: (id: string) => void;
  onAllowAllBookProposals: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [arrange, setArrange] = useState<"suburb" | "address" | "rent" | "late">("suburb");
  const [filter, setFilter] = useState("");
  const [importReview, setImportReview] = useState<ImportReview | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return snap.properties;
    return snap.properties.filter((p) =>
      `${p.address} ${p.tenantName} ${p.propertyCode ?? ""}`.toLowerCase().includes(q),
    );
  }, [snap.properties, filter]);
  const cardFor = (property: Property) => (
    <PropertyCard
      key={property.id}
      property={property}
      facts={snap.ledger.find((row) => row.propertyId === property.id)}
      tenancies={snap.book?.tenancies.filter((row) => row.propertyId === property.id) ?? []}
      contacts={snap.book?.contacts.filter((row) => row.propertyId === property.id) ?? []}
      hands={snap.hands}
      result={snap.results.find((row) => row.propertyId === property.id)}
      onSave={(options) => onSave(property.id, options)}
      onNotes={(body) => onNotes(property.id, body)}
      onDelete={() => onDelete(property.id)}
    />
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Book</h2>
          <p className="mt-1 text-[13px] text-ink-muted">Properties, tenancies and policies. Recheck stamps each address. This is not the case queue.</p>
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="rounded-lg border border-line bg-sheet px-4 py-6 text-center text-[13px] text-ink-muted">
          Nothing on the book matches “{filter.trim()}”.
        </p>
      ) : arrange === "suburb" ? (
        <div className="space-y-6">
          {groupBySuburb(visible).map((group) => (
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
        <div className="grid gap-3 xl:grid-cols-2">{sortBook(visible, snap.ledger, arrange).map(cardFor)}</div>
      )}
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
            {snap.book.bookProposals.map((proposal) => (
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
      <button
        type="button"
        onClick={onReset}
        className="mt-4 flex items-center gap-1.5 text-[12px] text-ink-muted hover:text-ink"
      >
        {busy === "reset" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
        Replay sample morning
      </button>
      <label className="mt-3 flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-muted hover:text-ink">
        Import CSV
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          disabled={importBusy || busy !== null}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            event.target.value = "";
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
          }}
        />
        {importBusy ? <Loader2 size={12} className="animate-spin" /> : null}
      </label>
      {importError && !importReview ? <p role="alert" className="mt-1 text-[12px] text-danger">{importError}</p> : null}
      {adding ? (
        <AddPropertyModal
          onClose={() => setAdding(false)}
          onAdd={(input) => {
            setAdding(false);
            onAdd(input);
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
  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [busy, onClose]);
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
}: {
  property: Property;
  facts?: LedgerFacts;
  tenancies: NonNullable<DeskSnapshot["book"]>["tenancies"];
  contacts: NonNullable<DeskSnapshot["book"]>["contacts"];
  hands: DeskSnapshot["hands"];
  result?: DeskSnapshot["results"][number];
  onSave: (options: Partial<PropertyOptions>) => void;
  onNotes: (body: string) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [graceDays, setGraceDays] = useState(String(property.options.graceDays));
  const [courtesyUntilDay, setCourtesyUntilDay] = useState(String(property.options.courtesyUntilDay));
  const [levyOn, setLevyOn] = useState(Boolean(property.options.levyFromRent));
  const [levyAmount, setLevyAmount] = useState(
    property.options.levyFromRent ? String(property.options.levyFromRent.amountCents / 100) : "420",
  );
  const [rentSource, setRentSource] = useState<RentSource>(property.options.rentSource);
  const [notifyChannel, setNotifyChannel] = useState<NotifyChannel>(property.options.notifyChannel);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notes, setNotes] = useState(property.notes ?? "");

  useEffect(() => {
    setGraceDays(String(property.options.graceDays));
    setCourtesyUntilDay(String(property.options.courtesyUntilDay));
    setLevyOn(Boolean(property.options.levyFromRent));
    setLevyAmount(property.options.levyFromRent ? String(property.options.levyFromRent.amountCents / 100) : "420");
    setRentSource(property.options.rentSource);
    setNotifyChannel(property.options.notifyChannel);
    setNotes(property.notes ?? "");
  }, [property]);

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
    <article className="border border-line bg-sheet p-4">
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

      <label className="mt-3 block text-[12px] text-ink-muted">
        Notes
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => {
            if (notes !== (property.notes ?? "")) onNotes(notes);
          }}
          rows={3}
          placeholder="How they like to be contacted. Hardship or deals. Anything the PMS does not keep."
          className="mt-1 w-full resize-y rounded border border-line bg-inset px-3 py-2 text-[13px] text-ink outline-none"
        />
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={() => setOpen((value) => !value)} className="text-[12px] text-agency hover:underline">
          {open ? "Hide options" : "Edit options"}
        </button>
        <div className="ml-auto">
          {confirmDelete ? (
            <span className="flex items-center gap-1.5 text-[12px]">
              <span className="text-ink-muted">Remove from book?</span>
              <button type="button" onClick={onDelete} className="rounded bg-danger px-2 py-1 font-medium text-white">
                Remove
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="rounded px-2 py-1 text-ink-muted hover:bg-raised">
                Keep
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="flex items-center gap-1 text-[11.5px] text-ink-muted hover:text-danger">
              <Trash2 size={12} />
              Remove
            </button>
          )}
        </div>
      </div>

      {open ? (
        <form
          className="mt-3 space-y-3 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              graceDays: Number(graceDays),
              courtesyUntilDay: Number(courtesyUntilDay),
              levyFromRent: levyOn
                ? { amountCents: Math.round(Number(levyAmount) * 100), cadence: property.options.levyFromRent?.cadence ?? "quarterly" }
                : null,
              rentSource,
              notifyChannel,
            });
          }}
        >
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
            Never allowed: {property.options.never.join(" · ")}
          </div>
          <button type="submit" className="rounded bg-agency px-3 py-1.5 text-[12px] font-medium text-white hover:bg-agency-hover">
            Save options
          </button>
        </form>
      ) : null}
    </article>
  );
}

function AddPropertyModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (input: { address: string; tenantName: string; tenantPhone: string; weeklyRentCents: number; propertyCode?: string }) => void;
}) {
  const [address, setAddress] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
  const [propertyCode, setPropertyCode] = useState("");
  const [rent, setRent] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const valid = Boolean(address.trim() && tenantName.trim() && Number(rent) > 0);
  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...root.querySelectorAll<HTMLElement>("button, input, textarea, select")];
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  const submit = () => {
    if (!valid) return;
    onAdd({
      address: address.trim(),
      tenantName: tenantName.trim(),
      tenantPhone: tenantPhone.trim(),
      weeklyRentCents: Math.round(Number(rent) * 100),
      ...(propertyCode.trim() ? { propertyCode: propertyCode.trim() } : {}),
    });
  };
  const inputClass = "mt-1 w-full rounded border border-line bg-inset px-3 py-2 text-[13.5px] text-ink outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-5" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-property-title" className="w-full max-w-[440px] border border-line bg-sheet p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div id="add-property-title" className="text-[16px] font-semibold text-ink">Add a property</div>
            <p className="mt-0.5 text-[12px] text-ink-muted">Shop defaults apply. Quiet until the hands report real numbers.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-muted hover:bg-raised" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <label className="block text-[12px] text-ink-muted">
            Address
            <input autoFocus value={address} onChange={(event) => setAddress(event.target.value)} className={inputClass} />
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
            <input value={propertyCode} onChange={(event) => setPropertyCode(event.target.value)} className={inputClass} />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="pm-control rounded px-4 text-[13px] text-ink-muted hover:bg-raised">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={!valid} className="pm-control rounded bg-agency px-4 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40">
            Add to book
          </button>
        </div>
      </div>
    </div>
  );
}

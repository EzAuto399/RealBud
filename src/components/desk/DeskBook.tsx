import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Loader2, Plus, RotateCcw, ShieldAlert, Trash2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { fmtDate } from "@/lib/au";
import { aud, type DeskSnapshot, type LedgerFacts, type NotifyChannel, type Property, type PropertyOptions, type RentSource } from "@/lib/desk";
import { CONTACT_ROLE_LABELS, NOTIFY_LABELS, RENT_SOURCE_LABELS } from "./labels";

export function DeskBook({
  snap,
  busy,
  onAdd,
  onSave,
  onNotes,
  onDelete,
  onReset,
  onImport,
  onOpenAsk,
  onAllowBookProposal,
  onDenyBookProposal,
  onAllowAllBookProposals,
  propertyDetails,
  onLoadProperty,
  onResolveImport,
}: {
  snap: DeskSnapshot;
  busy: string | null;
  onAdd: (input: { address: string; tenantName: string; tenantPhone: string; weeklyRentCents: number }) => void;
  onSave: (id: string, options: Partial<PropertyOptions>) => void;
  onNotes: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onReset: () => void;
  onImport: (file: File) => void;
  onOpenAsk: () => void;
  onAllowBookProposal: (id: string) => void;
  onDenyBookProposal: (id: string) => void;
  onAllowAllBookProposals: () => void;
  propertyDetails: Record<string, DeskSnapshot>;
  onLoadProperty: (id: string) => Promise<void>;
  onResolveImport: (issueId: string, action: "linked" | "rejected", propertyId?: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState(snap.properties[0]?.id ?? "");
  const pageSize = 24;
  const filteredProperties = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return snap.properties;
    return snap.properties.filter((property) =>
      `${property.address} ${property.propertyCode ?? ""} ${property.tenantName} ${property.tenantPhone}`.toLowerCase().includes(needle),
    );
  }, [query, snap.properties]);
  const pageCount = Math.max(1, Math.ceil(filteredProperties.length / pageSize));
  const visibleProperties = filteredProperties.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => setPage(0), [query, snap.properties.length]);
  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);
  useEffect(() => {
    if (selectedId && filteredProperties.some((property) => property.id === selectedId)) return;
    setSelectedId(filteredProperties[0]?.id ?? "");
  }, [filteredProperties, selectedId]);
  useEffect(() => {
    if (selectedId) void onLoadProperty(selectedId);
  }, [onLoadProperty, selectedId]);
  const selected = filteredProperties.find((property) => property.id === selectedId)
    ?? snap.properties.find((property) => property.id === selectedId);
  const selectedDetail = selected ? propertyDetails[selected.id] : undefined;
  const selectedProperty = selected
    ? selectedDetail?.properties.find((item) => item.id === selected.id) ?? selected
    : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between px-5 pb-3 pt-4">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Properties</h2>
          <p className="mt-1 text-[13px] text-ink-muted">The book, not the case queue.</p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="pm-control flex items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover"
        >
          <Plus size={14} />
          Add property
        </button>
      </div>
      <div className="mx-5 mb-3 flex shrink-0 flex-wrap items-end justify-between gap-3 rounded border border-line bg-card px-3 py-2.5">
        <label className="min-w-[220px] flex-1 text-[12px] font-medium text-ink-muted">
          Find a property
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Address, property code, tenant or phone"
            className="mt-1 min-h-9 w-full rounded border border-line bg-sheet px-2.5 text-[13px] font-normal text-ink placeholder:text-ink-muted/70"
          />
        </label>
        <div className="text-[12px] tabular-nums text-ink-muted">
          {filteredProperties.length === 0 ? "No properties" : `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, filteredProperties.length)} of ${filteredProperties.length}`}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden border-t border-line">
        <div className="flex w-[min(320px,42%)] shrink-0 flex-col border-r border-line bg-paper">
          <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Properties">
            {visibleProperties.map((property) => {
              const result = snap.results.find((row) => row.propertyId === property.id);
              return (
                <button
                  key={property.id}
                  type="button"
                  role="option"
                  aria-selected={property.id === selectedId}
                  onClick={() => setSelectedId(property.id)}
                  className={cn(
                    "w-full border-b border-line px-3.5 py-2.5 text-left",
                    property.id === selectedId ? "bg-selected" : "bg-paper hover:bg-raised/50",
                  )}
                >
                  <span className="block truncate text-[13px] font-semibold text-ink">{property.address}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-ink-muted">
                    {property.propertyCode ? `${property.propertyCode} · ` : ""}{property.tenantName}
                  </span>
                  {result ? (
                    <span className="mt-1 block text-[12px] text-ink-muted">{resultLabelFor(result)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {pageCount > 1 ? (
            <nav className="flex shrink-0 items-center justify-center gap-2 border-t border-line px-3 py-2" aria-label="Property pages">
              <button type="button" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="pm-control rounded border border-line bg-sheet px-3 text-[12px] text-ink disabled:opacity-40">Previous</button>
              <span className="text-[12px] tabular-nums text-ink-muted">Page {page + 1} of {pageCount}</span>
              <button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} className="pm-control rounded border border-line bg-sheet px-3 text-[12px] text-ink disabled:opacity-40">Next</button>
            </nav>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto bg-sheet px-5 py-4">
          {selected && selectedProperty ? (
            <PropertyCard
              key={selected.id}
              property={selectedProperty}
              facts={(selectedDetail ?? snap).ledger.find((row) => row.propertyId === selected.id)}
              tenancies={selectedDetail?.book?.tenancies.filter((row) => row.propertyId === selected.id) ?? []}
              contacts={selectedDetail?.book?.contacts.filter((row) => row.propertyId === selected.id) ?? []}
              hands={snap.hands}
              result={snap.results.find((row) => row.propertyId === selected.id)}
              detailLoaded={Boolean(selectedDetail)}
              alwaysOpen
              onOpen={() => onLoadProperty(selected.id)}
              onSave={(options) => onSave(selected.id, options)}
              onNotes={(body) => onNotes(selected.id, body)}
              onDelete={() => onDelete(selected.id)}
            />
          ) : (
            <p className="text-[13px] text-ink-muted">Select a property from the list.</p>
          )}
        </div>
      </div>
      <div className="shrink-0 overflow-y-auto border-t border-line px-5 py-4">
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
              aria-busy={busy === "allow-all-book-proposals"}
              className="flex items-center gap-1.5 rounded-lg bg-agency px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy === "allow-all-book-proposals" ? <Loader2 size={12} className="animate-spin" /> : null}
              {busy === "allow-all-book-proposals" ? "Adding…" : "Allow all"}
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
      {snap.book?.importIssues.some((issue) => issue.status === "open") ? (
        <section className="mt-6">
          <h3 className="text-[13px] font-semibold text-ink">Import issues</h3>
          <p className="mt-1 text-[12px] text-ink-muted">Unmatched or ambiguous source rows. Not properties.</p>
          <ul className="mt-2 space-y-1 text-[13px] text-ink">
            {snap.book?.importIssues.filter((issue) => issue.status === "open").map((issue) => (
              <ImportIssueResolver
                key={issue.id}
                issue={issue}
                properties={snap.properties}
                busy={busy === `import-${issue.id}`}
                onResolve={onResolveImport}
              />
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
      <section className="mt-5 border border-line bg-card px-3.5 py-3" aria-labelledby="desk-book-intake-heading">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded border border-line bg-sheet text-agency"><FileUp size={16} /></span>
          <div className="min-w-[14rem] flex-1">
            <h3 id="desk-book-intake-heading" className="text-[13px] font-semibold text-ink">Bring in or refresh the portfolio</h3>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
              A current structured PMS CSV updates the whole book and can verify money facts. Excel, PDFs, documents, screenshots and photos go through Ask and create reviewable property proposals only.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <label className="pm-control pm-tactile flex cursor-pointer items-center rounded bg-agency px-3 text-[11.5px] font-semibold text-white hover:bg-agency-hover">
                Choose PMS CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    onImport(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                onClick={onOpenAsk}
                className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[11.5px] font-semibold text-ink hover:border-agency/55 hover:bg-selected/45"
              >
                Use another format in Ask
              </button>
            </div>
          </div>
        </div>
      </section>
      </div>
      {adding ? (
        <AddPropertyModal
          onClose={() => setAdding(false)}
          onAdd={(input) => {
            setAdding(false);
            onAdd(input);
          }}
        />
      ) : null}
    </div>
  );
}

function ImportIssueResolver({
  issue,
  properties,
  busy,
  onResolve,
}: {
  issue: NonNullable<DeskSnapshot["book"]>["importIssues"][number];
  properties: Property[];
  busy: boolean;
  onResolve: (issueId: string, action: "linked" | "rejected", propertyId?: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return properties
      .filter((property) => !needle || `${property.address} ${property.propertyCode ?? ""} ${property.tenantName}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(issue.candidates.includes(b.id)) - Number(issue.candidates.includes(a.id)))
      .slice(0, 6);
  }, [issue.candidates, properties, query]);
  const selected = properties.find((property) => property.id === selectedId);

  return (
    <li className="rounded border border-hold/25 bg-hold/5 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium text-ink">{issue.rawIdentity}</div>
          <div className="mt-0.5 text-[11px] text-ink-muted">
            {issue.kind === "ambiguous" ? `${issue.candidates.length} possible matches` : "No exact property match"} · {issue.identityKind ?? "address"}
          </div>
        </div>
        <button type="button" disabled={busy} onClick={() => onResolve(issue.id, "rejected")} className="rounded px-2 py-1 text-[11.5px] text-ink-muted hover:bg-raised disabled:opacity-40">
          Not in this book
        </button>
      </div>
      <label className="mt-2 block text-[11px] font-medium text-ink-muted">
        Find the correct property
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Address, code or tenant" className="mt-1 min-h-9 w-full rounded border border-line bg-sheet px-2.5 text-[12.5px] font-normal text-ink" />
      </label>
      {matches.length ? (
        <div className="mt-1.5 grid gap-1 sm:grid-cols-2">
          {matches.map((property) => (
            <button
              key={property.id}
              type="button"
              disabled={busy}
              aria-pressed={selectedId === property.id}
              onClick={() => setSelectedId(property.id)}
              className={cn("min-h-9 rounded border px-2.5 py-1.5 text-left text-[11.5px]", selectedId === property.id ? "border-agency bg-selected text-ink" : "border-line bg-sheet text-ink-muted")}
            >
              <span className="block truncate font-medium text-ink">{property.address}</span>
              <span className="block truncate">{property.propertyCode ? `${property.propertyCode} · ` : ""}{property.tenantName}</span>
            </button>
          ))}
        </div>
      ) : <p className="mt-2 text-[11.5px] text-ink-muted">No property matches that search.</p>}
      <button
        type="button"
        disabled={busy || !selected}
        onClick={() => selected && onResolve(issue.id, "linked", selected.id)}
        className="mt-2 inline-flex min-h-8 items-center rounded bg-agency px-3 text-[11.5px] font-medium text-white disabled:opacity-40"
      >
        {busy ? <Loader2 size={12} className="mr-1.5 animate-spin" /> : null}
        {selected ? `Link to ${selected.address}` : "Choose a property"}
      </button>
    </li>
  );
}

function resultLabelFor(result: DeskSnapshot["results"][number]): string {
  return {
    "rent-unpaid-courtesy": `${result.daysLate}d late · courtesy draft`,
    "rent-landed-levy-unpaid": "Rent in · levy not paid out",
    "rent-landed": "Rent landed",
    "inside-grace": `Day ${result.daysLate} · still in grace`,
    "already-reminded": "Already reminded this period",
    "statutory-clock": `${result.daysLate}d late · licensee`,
    "stale-source": "Held · stale source",
    "unknown-facts": "Held · unknown facts",
    unmatched: "Held · unmatched",
    reversed: "Held · reversed payment",
    partial: "Held · partial payment",
    "ambiguous-match": "Held · ambiguous match",
    "uncovered-source": "Held · missing from export",
    "conflicted-source": "Held · conflicting source rows",
  }[result.reason];
}

function PropertyCard({
  property,
  facts,
  tenancies,
  contacts,
  hands,
  result,
  detailLoaded,
  alwaysOpen = false,
  onOpen,
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
  detailLoaded: boolean;
  alwaysOpen?: boolean;
  onOpen: () => Promise<void>;
  onSave: (options: Partial<PropertyOptions>) => void;
  onNotes: (body: string) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(alwaysOpen);
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
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    setGraceDays(String(property.options.graceDays));
    setCourtesyUntilDay(String(property.options.courtesyUntilDay));
    setLevyOn(Boolean(property.options.levyFromRent));
    setLevyAmount(property.options.levyFromRent ? String(property.options.levyFromRent.amountCents / 100) : "420");
    setRentSource(property.options.rentSource);
    setNotifyChannel(property.options.notifyChannel);
    setNotes(property.notes ?? "");
  }, [property]);

  const resultLabel = result ? resultLabelFor(result) : "Not checked yet";

  return (
    <article className={alwaysOpen ? "bg-sheet" : "border border-line bg-sheet p-4"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-ink">{property.address}</div>
          <div className="mt-0.5 text-[12px] text-ink-muted">
            {property.propertyCode ? `${property.propertyCode} · ` : ""}{property.tenantName} · {property.tenantPhone} · {aud(property.weeklyRentCents)}/wk
          </div>
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
            {hands === "hermes" ? "from worker" : hands === "csv" ? "from CSV" : hands === "held" ? "held" : "Demo"}
          </span>
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        {alwaysOpen ? null : (
        <button
          type="button"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && !detailLoaded) {
              setLoadingDetail(true);
              void onOpen().catch(() => {}).finally(() => setLoadingDetail(false));
            }
          }}
          className="inline-flex items-center gap-1.5 text-[12px] text-agency hover:underline"
        >
          {loadingDetail ? <Loader2 size={12} className="animate-spin" /> : null}
          {open ? "Close property" : "Open property"}
        </button>
        )}
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

      {open || alwaysOpen ? (
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
          <label className="block text-[12px] text-ink-muted">
            Notes
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              onBlur={() => {
                if (detailLoaded && notes !== (property.notes ?? "")) onNotes(notes);
              }}
              disabled={!detailLoaded}
              rows={3}
              placeholder={detailLoaded ? "How they like to be contacted. Hardship or deals. Anything the PMS does not keep." : "Loading selected property notes…"}
              className="mt-1 w-full resize-y rounded border border-line bg-inset px-3 py-2 text-[13px] text-ink outline-none disabled:opacity-60"
            />
            <span className="mt-1 block text-[10.5px] text-ink-muted">Loaded only for this selected property. Bud's money evaluator never reads Notes.</span>
          </label>
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
  onAdd: (input: { address: string; tenantName: string; tenantPhone: string; weeklyRentCents: number }) => void;
}) {
  const [address, setAddress] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
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

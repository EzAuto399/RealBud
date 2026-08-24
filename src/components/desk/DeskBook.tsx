import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, RotateCcw, ShieldAlert, Trash2, X } from "lucide-react";

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
}: {
  snap: DeskSnapshot;
  busy: string | null;
  onAdd: (input: { address: string; tenantName: string; tenantPhone: string; weeklyRentCents: number }) => void;
  onSave: (id: string, options: Partial<PropertyOptions>) => void;
  onNotes: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onReset: () => void;
  onImport: (csv: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Book</h2>
          <p className="mt-1 text-[13px] text-ink-muted">Properties, tenancies and policies. This is not the active case queue.</p>
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
      <div className="grid gap-3 xl:grid-cols-2">
        {snap.properties.map((property) => (
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
        ))}
      </div>
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
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.text().then(onImport);
            event.target.value = "";
          }}
        />
      </label>
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
            {hands === "hermes" ? "from Hermes" : hands === "csv" ? "from CSV" : hands === "held" ? "held" : "Demo"}
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

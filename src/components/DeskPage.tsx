import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  Check,
  CircleAlert,
  Copy,
  Info,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import {
  aud,
  type DeskSnapshot,
  type Draft,
  type LedgerFacts,
  type NotifyChannel,
  type Property,
  type PropertyOptions,
  type RentSource,
} from "@/lib/desk";
import { api, useStore } from "@/state/store";

const RENT_SOURCE_LABELS: Record<RentSource, string> = {
  mepay: "MePay",
  bank: "Bank feed",
  "pms-export": "PMS export",
  fixture: "Sample ledger",
  csv: "CSV export",
};
const NOTIFY_LABELS: Record<NotifyChannel, string> = {
  sms: "SMS",
  email: "Email",
  portal: "Portal",
  desk: "Desk only",
};

function sourceLabel(source: RentSource): string {
  return RENT_SOURCE_LABELS[source];
}

export function DeskPage() {
  const { state, dispatch } = useStore();
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"check" | "reset" | string | null>(null);
  const [adding, setAdding] = useState(false);

  const [ready, setReady] = useState(false);

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

  // a scheduled loop pressed Recheck while we were elsewhere — the server
  // pushes the fresh snapshot so the cards are already here on arrival
  useEffect(() => {
    if (state.desk) setSnap(state.desk);
  }, [state.desk]);

  const run = async (path: string, method: string, body?: unknown, key: string = method) => {
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!ready || !snap) {
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">
        {ready && error ? (
          <>
            <CircleAlert size={18} className="text-danger" />
            <div className="max-w-sm text-center text-[14px] text-danger">{error}</div>
            <button onClick={() => void load()} className="rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white">
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

  const pending = snap.drafts.filter((d) => d.status === "pending");
  const decided = snap.drafts.filter((d) => d.status !== "pending");
  const propertyById = new Map(snap.properties.map((p) => [p.id, p]));

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="shrink-0 px-5 pb-4 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <Building2 size={21} className="text-accent" />
              <h1 className="text-[20px] font-semibold tracking-tight text-ink">Desk</h1>
            </div>
            <p className="mt-1 max-w-[46rem] text-[12.5px] text-ink-secondary">
              {snap.demo || snap.mode === "demo" ? "Demo book. " : ""}
              Morning money exceptions only. RealBud drafts the courtesy. You send from the PMS or click the portal. It will not send a notice or move trust money.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => run("/api/desk/check", "POST", undefined, "check")}
              className="flex items-center gap-2 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white shadow-lg shadow-accent/10 hover:brightness-110"
            >
              {busy === "check" ? <Loader2 size={14} className="animate-spin" /> : null}
              Recheck
            </button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-accent">{pending.length} need you</span>
          <span className="rounded-full border border-warning/25 bg-warning/10 px-2.5 py-1 text-warning">{snap.escalations.length} escalate</span>
          <span className="rounded-full border border-hairline/50 bg-panel px-2.5 py-1 text-ink-secondary">{snap.properties.length} properties</span>
          <span
            title={snap.handsDetail ?? state.hermes?.detail ?? undefined}
            className={cn(
              "rounded-full border px-2.5 py-1",
              snap.hands === "hermes" || snap.hands === "csv"
                ? "border-success/25 bg-success/10 text-success"
                : snap.hands === "held"
                  ? "border-warning/25 bg-warning/10 text-warning"
                  : "border-hairline/50 bg-panel text-ink-secondary",
            )}
          >
            {snap.hands === "hermes" ? "Hermes live" : snap.hands === "csv" ? "CSV live" : snap.hands === "held" ? "Held" : "Demo"}
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => dispatch({ type: "showYou" })}
              className="rounded-full border border-hairline/50 bg-panel px-2.5 py-1 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Manage
            </button>
          </span>
        </div>
        {snap.recovery?.active && (
          <div className="mt-3 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            Desk is in recovery. Writes and schedules are paused. The book was not replaced with Demo data.
          </div>
        )}
        {snap.hands !== "hermes" && snap.hands !== "csv" && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2.5 text-[12.5px] text-ink-secondary">
            <Info size={15} className="mt-0.5 shrink-0 text-ink-secondary/70" />
            <span>
              Desk is on the Demo book{snap.handsDetail ? ` — ${snap.handsDetail}` : "."}{" "}
              <button onClick={() => dispatch({ type: "showYou" })} className="font-medium text-accent hover:underline">
                Open You
              </button>{" "}
              to check hands and sources.
            </span>
          </div>
        )}
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {snap.escalations.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">For the licensee — do not draft</h2>
            {snap.escalations.map((item) => (
              <div key={item.id} className="rounded-2xl border border-warning/30 bg-warning/10 p-4">
                <div className="flex items-start gap-2 text-[14px] font-semibold text-ink">
                  <ShieldAlert size={16} className="mt-0.5 text-warning" />
                  {propertyById.get(item.propertyId)?.address ?? item.propertyId}
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{item.detail}</p>
              </div>
            ))}
          </section>
        )}

        {snap.workItems.some((w) => w.state === "held") && (
          <section className="mb-8 space-y-3">
            <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">Held</h2>
            {snap.workItems
              .filter((w) => w.state === "held")
              .map((work) => (
                <div key={work.id} className="rounded-2xl border border-warning/30 bg-warning/5 p-4">
                  <div className="text-[14px] font-semibold text-ink">
                    {propertyById.get(work.propertyId)?.address ?? work.propertyId}
                  </div>
                  <p className="mt-1 text-[13px] text-ink-secondary">
                    Held · {work.holdReason ?? "unknown"} · observed {new Date(work.observedAt).toLocaleString()} ·{" "}
                    {work.sourceIds.join(", ")}
                  </p>
                </div>
              ))}
          </section>
        )}

        <section className={cn("space-y-3", snap.escalations.length > 0 && "mt-8")}>
          <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">Approve wording</h2>
          {pending.length === 0 ? (
            <div className="rounded-2xl border border-hairline/40 bg-panel px-4 py-6 text-[13.5px] text-ink-secondary">
              {snap.lastRunAt == null
                ? "Press Recheck to run this morning’s money check. A GET of Desk never starts a check."
                : "Nothing waiting. Recheck after you change options."}
            </div>
          ) : (
            pending.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                property={propertyById.get(draft.propertyId)}
                work={snap.workItems.find((w) => w.id === draft.workItemId || w.draftId === draft.id)}
                busy={busy}
                onAllow={() => run(`/api/desk/drafts/${draft.id}/allow`, "POST", { expectedRevision: snap.revision }, draft.id)}
                onDeny={() => run(`/api/desk/drafts/${draft.id}/deny`, "POST", { expectedRevision: snap.revision }, draft.id)}
                onEdit={(body) => run(`/api/desk/drafts/${draft.id}`, "PATCH", { body }, draft.id)}
              />
            ))
          )}
        </section>

        {decided.length > 0 && (
          <section className="mt-8 space-y-3">
            <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">Decided</h2>
            {decided.map((draft) => (
              <div key={draft.id} className="rounded-2xl border border-hairline/30 bg-panel p-4">
                <div className="text-[13px] font-medium text-ink">
                  {propertyById.get(draft.propertyId)?.address} · {draft.status === "allowed" ? "Wording approved" : "Denied"}
                </div>
                {draft.status === "allowed" && (
                  <p className="mt-1 text-[12.5px] text-ink-secondary">
                    {draft.kind === "levy-from-rent"
                      ? "Noted. If a bill and trust authority exist, handle the levy in the PMS. RealBud did not pay anything."
                      : "Approved wording. Copy it and send from the PMS yourself. RealBud did not send it."}
                  </p>
                )}
                <pre className="mt-2 whitespace-pre-wrap font-sans text-[12.5px] leading-relaxed text-ink-secondary">{draft.body}</pre>
                {draft.status === "allowed" && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={() => void navigator.clipboard.writeText(draft.body)}
                      className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                    >
                      <Copy size={14} />
                      Copy
                    </button>
                    {draft.channel === "portal" && (
                      <button
                        onClick={() => run(`/api/desk/drafts/${draft.id}/prepare`, "POST", undefined, `prepare-${draft.id}`)}
                        className="rounded-xl bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-110"
                      >
                        Prepare portal
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        <section className="mt-8 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">Book</h2>
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110"
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
                hands={snap.hands}
                result={snap.results.find((row) => row.propertyId === property.id)}
                onSave={(options) => run(`/api/desk/properties/${property.id}`, "PATCH", options, property.id)}
                onNotes={(body) => run(`/api/desk/properties/${property.id}/notes`, "PUT", { body }, `notes-${property.id}`)}
                onDelete={() => run(`/api/desk/properties/${property.id}`, "DELETE", undefined, `delete-${property.id}`)}
              />
            ))}
          </div>
          <button
            onClick={() => run("/api/desk/reset", "POST", undefined, "reset")}
            className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary/70 hover:text-ink-secondary"
          >
            {busy === "reset" ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            Replay sample morning
          </button>
          <label className="mt-3 flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-secondary/70 hover:text-ink-secondary">
            Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                void file.text().then((csv) => run("/api/desk/import", "POST", { csv, expectedRevision: snap.revision }, "import"));
                event.target.value = "";
              }}
            />
          </label>
        </section>
      </div>

      {adding && (
        <AddPropertyModal
          onClose={() => setAdding(false)}
          onAdd={(input) => {
            setAdding(false);
            run("/api/desk/properties", "POST", input, "add");
          }}
        />
      )}
    </main>
  );
}

function DraftCard({
  draft,
  property,
  work,
  busy,
  onAllow,
  onDeny,
  onEdit,
}: {
  draft: Draft;
  property?: Property;
  work?: DeskSnapshot["workItems"][number];
  busy: string | null;
  onAllow: () => void;
  onDeny: () => void;
  onEdit: (body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const waiting = busy === draft.id;
  const levy = draft.kind === "levy-from-rent";
  const owner = draft.kind === "owner-letter";

  return (
    <article className="rounded-2xl border border-accent/40 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-ink">{property?.address ?? draft.propertyId}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">
            {owner
              ? "Owner letter — factual catch-up from the book"
              : levy
                ? "Levy from rent — desk flag"
                : `Courtesy ${draft.channel.toUpperCase()} draft`}{" "}
            · {draft.to}
            {work && (
              <>
                {" "}
                · {work.sourceIds.join(", ")} · {new Date(work.observedAt).toLocaleString()} · {work.state}
              </>
            )}
          </div>
        </div>
        <span className="rounded-md bg-raised px-2 py-1 text-[11px] text-ink-secondary">
          {levy ? "Not a payment" : owner ? "Copy only · you send it" : "Not sent · not a notice"}
        </span>
      </div>

      {editing ? (
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={5}
          className="mt-3 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[13.5px] leading-relaxed text-ink outline-none focus:border-accent/70"
        />
      ) : (
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-sans text-[13px] leading-relaxed text-ink">
          {draft.body}
        </pre>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <button
              onClick={() => {
                onEdit(body);
                setEditing(false);
              }}
              disabled={waiting || !body.trim()}
              className="rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              Save wording
            </button>
            <button
              onClick={() => {
                setBody(draft.body);
                setEditing(false);
              }}
              className="rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => void navigator.clipboard.writeText(draft.body)}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110"
            >
              <Copy size={14} />
              Copy
            </button>
            <button
              onClick={onAllow}
              disabled={waiting}
              className="flex items-center gap-1.5 rounded-xl border border-hairline/50 bg-panel px-3.5 py-2 text-[13px] text-ink hover:bg-raised disabled:opacity-40"
            >
              {waiting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {levy ? "Got it" : "Approve wording"}
            </button>
            <button
              onClick={onDeny}
              disabled={waiting}
              className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              <X size={14} />
              Deny
            </button>
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <Pencil size={14} />
              Edit
            </button>
            <span className="text-[11.5px] text-ink-secondary">RealBud will not send or pay this.</span>
          </>
        )}
      </div>
    </article>
  );
}

function PropertyCard({
  property,
  facts,
  hands,
  result,
  onSave,
  onNotes,
  onDelete,
}: {
  property: Property;
  facts?: LedgerFacts;
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
    <article className="rounded-2xl border border-hairline/40 bg-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-ink">{property.address}</div>
          <div className="mt-0.5 text-[12px] text-ink-secondary">
            {property.tenantName} · {property.tenantPhone} · {aud(property.weeklyRentCents)}/wk
          </div>
        </div>
        <span className={cn("rounded-md px-2 py-1 text-[11px]", result?.outcome === "escalate" ? "bg-warning/15 text-warning" : "bg-raised text-ink-secondary")}>
          {resultLabel}
        </span>
      </div>

      {facts && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="rounded-md bg-inset px-2 py-1 text-ink-secondary">{facts.daysSinceDue}d late</span>
          <span className={cn("rounded-md px-2 py-1", facts.rentLanded ? "bg-success/10 text-success" : "bg-inset text-ink-secondary")}>
            {facts.rentLanded ? "Rent in" : "No rent yet"}
          </span>
          {property.options.levyFromRent && (
            <span className={cn("rounded-md px-2 py-1", facts.levyPaid ? "bg-success/10 text-success" : "bg-warning/10 text-warning")}>
              Levy {facts.levyPaid ? "paid" : "not paid"}
            </span>
          )}
          <span className="rounded-md bg-inset px-2 py-1 text-ink-secondary">
            {facts.daysSinceCourtesy == null ? "Not reminded" : `Reminded ${facts.daysSinceCourtesy}d ago`}
          </span>
          <span className="ml-auto text-[10.5px] text-ink-secondary/60">{hands === "hermes" ? "from Hermes" : hands === "csv" ? "from CSV" : hands === "held" ? "held" : "Demo"}</span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-ink-secondary">
        <span className="rounded-md bg-inset px-2 py-1">{sourceLabel(property.options.rentSource)}</span>
        <span className="rounded-md bg-inset px-2 py-1">Notify: {NOTIFY_LABELS[property.options.notifyChannel]}</span>
        <span className="rounded-md bg-inset px-2 py-1">Grace {property.options.graceDays}d</span>
        <span className="rounded-md bg-inset px-2 py-1">Courtesy to day {property.options.courtesyUntilDay}</span>
        {property.options.levyFromRent && (
          <span className="rounded-md bg-inset px-2 py-1">
            Levy {aud(property.options.levyFromRent.amountCents)} {property.options.levyFromRent.cadence}
          </span>
        )}
      </div>

      <label className="mt-3 block text-[12px] text-ink-secondary">
        Notes
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => {
            if (notes !== (property.notes ?? "")) onNotes(notes);
          }}
          rows={3}
          placeholder="How they like to be contacted. Hardship or deals. Anything the PMS does not keep."
          className="mt-1 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/70"
        />
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => setOpen((value) => !value)} className="text-[12px] text-accent hover:underline">
          {open ? "Hide options" : "Edit options"}
        </button>
        <div className="ml-auto">
          {confirmDelete ? (
            <span className="flex items-center gap-1.5 text-[12px]">
              <span className="text-ink-secondary">Remove from book?</span>
              <button
                onClick={onDelete}
                className="rounded-md bg-danger px-2 py-1 font-medium text-white hover:brightness-110"
              >
                Remove
              </button>
              <button onClick={() => setConfirmDelete(false)} className="rounded-md px-2 py-1 text-ink-secondary hover:bg-raised hover:text-ink">
                Keep
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title="Remove this property from the book"
              className="flex items-center gap-1 text-[11.5px] text-ink-secondary/70 hover:text-danger"
            >
              <Trash2 size={12} />
              Remove
            </button>
          )}
        </div>
      </div>

      {open && (
        <form
          className="mt-3 space-y-3 border-t border-hairline/30 pt-3"
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
            <label className="block text-[12px] text-ink-secondary">
              Rent source
              <select
                value={rentSource}
                onChange={(event) => setRentSource(event.target.value as RentSource)}
                className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/70"
              >
                {(Object.keys(RENT_SOURCE_LABELS) as RentSource[]).map((value) => (
                  <option key={value} value={value}>{RENT_SOURCE_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label className="block text-[12px] text-ink-secondary">
              Notify channel
              <select
                value={notifyChannel}
                onChange={(event) => setNotifyChannel(event.target.value as NotifyChannel)}
                className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/70"
              >
                {(Object.keys(NOTIFY_LABELS) as NotifyChannel[]).map((value) => (
                  <option key={value} value={value}>{NOTIFY_LABELS[value]}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12px] text-ink-secondary">
              Grace days
              <input
                type="number"
                min={0}
                max={28}
                value={graceDays}
                onChange={(event) => setGraceDays(event.target.value)}
                className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/70"
              />
            </label>
            <label className="block text-[12px] text-ink-secondary">
              Courtesy until day
              <input
                type="number"
                min={1}
                max={60}
                value={courtesyUntilDay}
                onChange={(event) => setCourtesyUntilDay(event.target.value)}
                className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/70"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input type="checkbox" checked={levyOn} onChange={(event) => setLevyOn(event.target.checked)} />
            Levy taken from rent
          </label>
          {levyOn && (
            <label className="block text-[12px] text-ink-secondary">
              Levy amount (AUD)
              <input
                type="number"
                min={1}
                step="0.01"
                value={levyAmount}
                onChange={(event) => setLevyAmount(event.target.value)}
                className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/70"
              />
            </label>
          )}
          <div className="flex items-center gap-2 text-[11.5px] text-ink-secondary">
            <ShieldAlert size={13} className="text-warning" />
            Never allowed, on any property: {property.options.never.join(" · ")}
          </div>
          <button type="submit" className="rounded-xl bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110">
            Save options
          </button>
        </form>
      )}
    </article>
  );
}

function AddPropertyModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (input: {
    address: string;
    tenantName: string;
    tenantPhone: string;
    weeklyRentCents: number;
  }) => void;
}) {
  const [address, setAddress] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [tenantPhone, setTenantPhone] = useState("");
  const [rent, setRent] = useState("");
  const valid = Boolean(address.trim() && tenantName.trim() && Number(rent) > 0);

  const submit = () => {
    if (!valid) return;
    onAdd({
      address: address.trim(),
      tenantName: tenantName.trim(),
      tenantPhone: tenantPhone.trim(),
      weeklyRentCents: Math.round(Number(rent) * 100),
    });
  };

  const inputClass =
    "mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-5" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="w-full max-w-[440px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[16px] font-semibold text-ink">Add a property</div>
            <p className="mt-0.5 text-[12px] text-ink-secondary">
              It lands in the book with shop defaults — quiet until the hands report real numbers.
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="mt-4 space-y-3">
          <label className="block text-[12px] text-ink-secondary">
            Address
            <input autoFocus value={address} onChange={(event) => setAddress(event.target.value)} placeholder="12 Oak St, Dickson ACT" className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12px] text-ink-secondary">
              Tenant
              <input value={tenantName} onChange={(event) => setTenantName(event.target.value)} placeholder="Sam Nguyen" className={inputClass} />
            </label>
            <label className="block text-[12px] text-ink-secondary">
              Phone
              <input value={tenantPhone} onChange={(event) => setTenantPhone(event.target.value)} placeholder="0400 111 222" className={inputClass} />
            </label>
          </div>
          <label className="block text-[12px] text-ink-secondary">
            Weekly rent (AUD)
            <input
              type="number"
              min={1}
              step="0.01"
              value={rent}
              onChange={(event) => setRent(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
              placeholder="620"
              className={inputClass}
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">
            Cancel
          </button>
          <button onClick={submit} disabled={!valid} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">
            Add to book
          </button>
        </div>
      </div>
    </div>
  );
}

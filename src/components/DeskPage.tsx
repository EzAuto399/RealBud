import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  Check,
  CircleAlert,
  Copy,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldAlert,
  X,
} from "lucide-react";

import { cn } from "@/lib/cn";
import {
  aud,
  type DeskSnapshot,
  type Draft,
  type Property,
  type PropertyOptions,
} from "@/lib/desk";
import { api } from "@/state/store";

function sourceLabel(source: Property["options"]["rentSource"]): string {
  return { mepay: "MePay", bank: "Bank", "pms-export": "PMS export", fixture: "Sample ledger" }[source];
}

export function DeskPage() {
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"check" | "reset" | string | null>(null);

  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = (await api("/api/desk")) as DeskSnapshot;
      setSnap(next);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (path: string, method: string, body?: unknown, key: string = method) => {
    setBusy(key);
    setError("");
    try {
      const next = (await api(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      })) as DeskSnapshot & { draft?: Draft; property?: Property };
      if (next.properties) setSnap(next);
      else await load();
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
              Morning arrears on a sample book. RealBud drafts the courtesy. It will not send a notice or move trust money.
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
        <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-accent">{pending.length} need you</span>
          <span className="rounded-full border border-warning/25 bg-warning/10 px-2.5 py-1 text-warning">{snap.escalations.length} escalate</span>
          <span className="rounded-full border border-hairline/50 bg-panel px-2.5 py-1 text-ink-secondary">{snap.properties.length} properties</span>
        </div>
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

        <section className={cn("space-y-3", snap.escalations.length > 0 && "mt-8")}>
          <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">Approve wording</h2>
          {pending.length === 0 ? (
            <div className="rounded-2xl border border-hairline/40 bg-panel px-4 py-6 text-[13.5px] text-ink-secondary">
              Nothing waiting. Recheck after you change options.
            </div>
          ) : (
            pending.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                property={propertyById.get(draft.propertyId)}
                busy={busy}
                onAllow={() => run(`/api/desk/drafts/${draft.id}/allow`, "POST", undefined, draft.id)}
                onDeny={() => run(`/api/desk/drafts/${draft.id}/deny`, "POST", undefined, draft.id)}
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
                  <button
                    onClick={() => void navigator.clipboard.writeText(draft.body)}
                    className="mt-2 flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                  >
                    <Copy size={14} />
                    Copy
                  </button>
                )}
              </div>
            ))}
          </section>
        )}

        <section className="mt-8 space-y-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.14em] text-ink-secondary">Book</h2>
          <div className="grid gap-3 xl:grid-cols-2">
            {snap.properties.map((property) => (
              <PropertyCard
                key={property.id}
                property={property}
                result={snap.results.find((row) => row.propertyId === property.id)}
                onSave={(options) => run(`/api/desk/properties/${property.id}`, "PATCH", options, property.id)}
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
        </section>
      </div>
    </main>
  );
}

function DraftCard({
  draft,
  property,
  busy,
  onAllow,
  onDeny,
  onEdit,
}: {
  draft: Draft;
  property?: Property;
  busy: string | null;
  onAllow: () => void;
  onDeny: () => void;
  onEdit: (body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const waiting = busy === draft.id;
  const levy = draft.kind === "levy-from-rent";

  return (
    <article className="rounded-2xl border border-accent/40 bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-ink">{property?.address ?? draft.propertyId}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-secondary">
            {levy ? "Levy from rent — desk flag" : `Courtesy ${draft.channel.toUpperCase()} draft`} · {draft.to}
          </div>
        </div>
        <span className="rounded-md bg-raised px-2 py-1 text-[11px] text-ink-secondary">
          {levy ? "Not a payment" : "Not sent · not a notice"}
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
  result,
  onSave,
}: {
  property: Property;
  result?: DeskSnapshot["results"][number];
  onSave: (options: Partial<PropertyOptions>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [graceDays, setGraceDays] = useState(String(property.options.graceDays));
  const [courtesyUntilDay, setCourtesyUntilDay] = useState(String(property.options.courtesyUntilDay));
  const [levyOn, setLevyOn] = useState(Boolean(property.options.levyFromRent));
  const [levyAmount, setLevyAmount] = useState(
    property.options.levyFromRent ? String(property.options.levyFromRent.amountCents / 100) : "420",
  );

  useEffect(() => {
    setGraceDays(String(property.options.graceDays));
    setCourtesyUntilDay(String(property.options.courtesyUntilDay));
    setLevyOn(Boolean(property.options.levyFromRent));
    setLevyAmount(property.options.levyFromRent ? String(property.options.levyFromRent.amountCents / 100) : "420");
  }, [property]);

  const resultLabel = result
    ? {
        "rent-unpaid-courtesy": `${result.daysLate}d late · courtesy draft`,
        "rent-landed-levy-unpaid": "Rent in · levy not paid out",
        "rent-landed": "Rent landed",
        "inside-grace": `Day ${result.daysLate} · still in grace`,
        "already-reminded": "Already reminded this period",
        "statutory-clock": `${result.daysLate}d late · licensee`,
      }[result.reason]
    : "Not checked yet";

  return (
    <article className="rounded-2xl border border-hairline/40 bg-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-ink">{property.address}</div>
          <div className="mt-0.5 text-[12px] text-ink-secondary">
            {property.tenantName} · {aud(property.weeklyRentCents)}/wk
          </div>
        </div>
        <span className={cn("rounded-md px-2 py-1 text-[11px]", result?.outcome === "escalate" ? "bg-warning/15 text-warning" : "bg-raised text-ink-secondary")}>
          {resultLabel}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] text-ink-secondary">
        <span className="rounded-md bg-inset px-2 py-1">{sourceLabel(property.options.rentSource)}</span>
        <span className="rounded-md bg-inset px-2 py-1">Grace {property.options.graceDays}d</span>
        <span className="rounded-md bg-inset px-2 py-1">Courtesy to day {property.options.courtesyUntilDay}</span>
        {property.options.levyFromRent && (
          <span className="rounded-md bg-inset px-2 py-1">
            Levy {aud(property.options.levyFromRent.amountCents)} {property.options.levyFromRent.cadence}
          </span>
        )}
      </div>
      <button onClick={() => setOpen((value) => !value)} className="mt-3 text-[12px] text-accent hover:underline">
        {open ? "Hide options" : "Edit options"}
      </button>
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
            });
          }}
        >
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
          <button type="submit" className="rounded-xl bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110">
            Save options
          </button>
        </form>
      )}
    </article>
  );
}

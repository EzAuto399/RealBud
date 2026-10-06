// The Austin pack on Schedule: install it (six workflows at office times, every
// one off until reviewed) and a short setup checklist whose items each open
// the place where that step is done.
import { useState } from "react";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";

import { AUSTIN_CHECKLIST_IDS, type AustinChecklistItem, type AustinPackView } from "@shared/austin-pack";
import type { Loop } from "@/lib/routines";
import { openDeskBills } from "@/lib/desk-view-state";
import { api, useStore } from "@/state/store";
import { Card } from "../SettingsPrimitives";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string";
/** A malformed answer is an error, never a half-filled checklist. */
export function parseAustinPackView(body: unknown): AustinPackView {
  const ok = object(body) && object(body.pack) && str(body.pack.title) && str(body.timeZone) && typeof body.timeZoneFromOffice === "boolean" &&
    (body.installed === null || (object(body.installed) && Number.isFinite(body.installed.revision))) &&
    Array.isArray(body.loops) && body.loops.every(l => object(l) && str(l.loopId) && str(l.owner) && object(l.plan) && ["reads", "waitsFor", "notifies", "approval"].every(k => str((l.plan as Record<string, unknown>)[k]))) &&
    Array.isArray(body.rules) && body.rules.every(r => object(r) && str(r.text) && typeof r.matches === "boolean") &&
    Array.isArray(body.checklist) && body.checklist.every(i => object(i) && (AUSTIN_CHECKLIST_IDS as readonly unknown[]).includes(i.id) && str(i.label) && str(i.detail) && typeof i.done === "boolean");
  if (!ok) throw new Error("The Austin setup could not be read. Reload Schedule.");
  return body as unknown as AustinPackView;
}

/** Where each checklist step is done. */
export function checklistLink(item: AustinChecklistItem, loops: readonly Loop[]): { label: string; hash?: string; bills?: true } {
  if (item.id === "gmail" || item.id === "redbark") return { label: "Open Connected apps", hash: "you-connected-apps" };
  if (item.id === "rei" || item.id === "tenants") return { label: "Open Bank reference review", hash: "job-bank-references" };
  if (item.id === "suppliers") return { label: "Open Maintenance checks", bills: true };
  const next = item.next ?? "bank-references";
  return { label: `Review ${loops.find(loop => loop.id === next)?.name ?? "the next workflow"}`, hash: `job-${next}` };
}

/** A city name for "Brisbane time" from an IANA zone. */
export const zoneCity = (zone: string) => zone.split("/").pop()!.replace(/_/g, " ");

export function AustinPackCard({ view, loops, onChanged, className = "" }: {
  view: AustinPackView | null;
  loops: readonly Loop[];
  onChanged: (next: AustinPackView) => void;
  className?: string;
}) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  if (!view) return null;
  const install = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const body = await api("/api/austin-pack/install", { method: "POST", body: "{}" }, { timeoutMs: 30_000 });
      const next = parseAustinPackView(body);
      const kept = Array.isArray(body.results) ? body.results.filter((r: { outcome?: string }) => r.outcome === "kept").length : 0;
      onChanged(next);
      setNotice(`Six workflows are set to ${zoneCity(next.timeZone)} time and stay off until you review each one.${kept ? ` ${kept} kept the times your office set.` : ""}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Austin pack could not be installed.");
    } finally { setBusy(false); }
  };
  const open = (item: AustinChecklistItem) => {
    const link = checklistLink(item, loops);
    if (link.bills) { openDeskBills(); dispatch({ type: "showDesk" }); return; }
    location.hash = link.hash!;
    if (link.hash === "you-connected-apps") dispatch({ type: "showYou" });
  };
  const done = view.checklist.filter(item => item.done).length;
  return (
    <section aria-label="Austin pack" className={className}>
    <Card
      title={view.installed ? "Austin setup checklist" : "Austin pack"}
      subtitle={view.installed
        ? `${done} of ${view.checklist.length} done. Times are ${zoneCity(view.timeZone)} time${view.timeZoneFromOffice ? "" : " (the pack's office time; change it in agency setup)"}.`
        : `Sets bank references, weekly bills, morning priorities, maintenance checks, the supplier list check and the inspection draft to ${zoneCity(view.timeZone)} times. Each stays off until you review it and switch it on. Times your office already changed are kept.`}
    >
      {view.installed ? (
        <ul aria-label="Austin setup checklist" className="divide-y divide-line">
          {view.checklist.map(item => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              {item.done ? <CheckCircle2 size={16} className="text-agency" aria-hidden /> : <Circle size={16} className="text-ink-muted" aria-hidden />}
              <span className="min-w-[14rem] flex-1">
                <span className="block text-[14px] text-ink">{item.label}<span className="sr-only">{item.done ? " (done)" : " (not done)"}</span></span>
                <span className="block text-[13px] text-ink-secondary">{item.detail}</span>
              </span>
              <button type="button" onClick={() => open(item)} aria-label={`${checklistLink(item, loops).label}: ${item.label}`}
                className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected">
                {checklistLink(item, loops).label}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <button type="button" disabled={busy} onClick={() => void install()} className="pm-decision inline-flex items-center gap-1.5 rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}Install the Austin pack
        </button>
      )}
      {error ? <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p> : null}
      {notice ? <p role="status" className="mt-2 text-[13px] text-ink-secondary">{notice}</p> : null}
    </Card>
    </section>
  );
}

/** The pack's plain plan for one workflow, shown in its job details. */
export function AustinPlanDetail({ view, loopId }: { view: AustinPackView | null; loopId: string }) {
  const item = view?.installed ? view.loops.find(loop => loop.loopId === loopId) : undefined;
  if (!item) return null;
  const rows: Array<[string, string]> = [["Reads", item.plan.reads], ["Waits for", item.plan.waitsFor], ["Tells", item.plan.notifies], ["Approval", item.plan.approval]];
  const needs = item.needs.flatMap(id => view!.checklist.filter(check => check.id === id));
  return (
    <section aria-label="What this job does" className="border-t border-line pt-3">
      <h3 className="text-[14px] font-medium text-ink">What this job does · {item.owner}</h3>
      {item.note ? <p className="mt-1 text-[13px] text-ink-muted">{item.note}</p> : null}
      <dl className="mt-2 grid gap-x-3 gap-y-1.5 text-[13px] min-[720px]:grid-cols-[8rem_1fr]">
        {rows.map(([term, text]) => <div key={term} className="contents"><dt className="text-ink-muted">{term}</dt><dd className="text-ink-secondary">{text}</dd></div>)}
        {needs.length ? <div className="contents"><dt className="text-ink-muted">Needs</dt><dd>
          <ul className="space-y-1">{needs.map(check => (
            <li key={check.id} className="text-ink-secondary">{check.done ? "Done: " : "Not yet: "}{check.label}{check.done ? "" : `. ${check.detail}`}</li>
          ))}</ul>
        </dd></div> : null}
      </dl>
    </section>
  );
}

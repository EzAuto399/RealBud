import { useEffect, useRef, useState, type ReactNode } from "react";
import { DESK_SECTION_LABELS, type DeskArea } from "@shared/workspace-tabs";
import type { DeskAreaId } from "@shared/desk-areas";
import type { NeedsYouArea, NeedsYouItem, NeedsYouLevel } from "@shared/needs-you";
import { refreshNeedsYou, type NeedsYouState } from "@/lib/needs-you";
import { openDeskArea } from "@/lib/desk-view-state";
import { useStore } from "@/state/store";
import { StatusLabel } from "../pm";

const FIRST_ROWS = 5;
const SEEN_KEY = "realbud.needsYouSeenAt";
/** When this computer last showed the panel. Storage can be missing or blocked; this copy keeps "New" working for the session. */
let seenThisSession: number | null = null;
export function readNeedsYouSeen(): number | null {
  try {
    const stored = Number(window.localStorage.getItem(SEEN_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch { /* no storage */ }
  return seenThisSession;
}
function markNeedsYouSeen(at = Date.now()) {
  seenThisSession = at;
  try { window.localStorage.setItem(SEEN_KEY, String(at)); } catch { /* no storage */ }
}
const clock = (iso: string) => new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).replace(/\s/g, " ");

type Row = { key: string; area: NeedsYouArea; level: NeedsYouLevel; title: string; reason: string; next?: string; fresh: boolean; action: ReactNode };

/** "From your workflows" on the Tasks tab: what each workflow found for a person, problems first.
 *  Decisions stay in the area that owns the item; each row's button opens it. A source that
 *  couldn't be read is a problem row, never an empty list. */
export function NeedsYouPanel({ state, active, areas, onShowArea, inert }: {
  state: NeedsYouState;
  /** The Tasks tab is showing: "New" is measured from the last time it was. */
  active: boolean;
  /** This office's work areas as this computer shows them (titles, hidden or shown). */
  areas: readonly DeskArea[];
  /** Shows a hidden area on this Desk, then opens it. */
  onShowArea: (area: DeskAreaId) => void;
  inert?: boolean;
}) {
  const { dispatch } = useStore();
  const { snapshot, error, checking } = state;
  const [expanded, setExpanded] = useState(false);
  const [seenAt, setSeenAt] = useState(readNeedsYouSeen);
  const [arrived, setArrived] = useState("");
  const shown = useRef(false), known = useRef<ReadonlySet<string> | null>(null);
  const titleOf = (area: NeedsYouArea) => area === "schedule" ? "Scheduled jobs" : areas.find(row => row.id === area)?.title ?? DESK_SECTION_LABELS[area];

  // Leaving Tasks (another tab, Desk closing, or the window going away) marks everything shown as seen.
  useEffect(() => {
    if (!active) return;
    setSeenAt(readNeedsYouSeen());
    const leave = () => { if (shown.current) markNeedsYouSeen(); };
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); leave(); shown.current = false; };
  }, [active]);
  useEffect(() => { if (active && snapshot) shown.current = true; }, [active, snapshot]);
  // Arrivals while Tasks is open are announced once, politely.
  useEffect(() => {
    if (!snapshot) return;
    const before = known.current;
    known.current = new Set(snapshot.items.map(item => item.key));
    const fresh = before && active ? snapshot.items.filter(item => !before.has(item.key)) : [];
    if (fresh.length) setArrived(fresh.length === 1 ? `New from ${titleOf(fresh[0]!.area)}: ${fresh[0]!.title}` : `${fresh.length} new items from your workflows`);
  }, [snapshot]);

  const tryAgain = (label = "Try again") => <button type="button" className="pm-control needs-you-action" onClick={() => void refreshNeedsYou()}>{label}</button>;
  const open = (item: NeedsYouItem): Pick<Row, "next" | "action"> => {
    const hidden = item.area !== "schedule" && areas.find(row => row.id === item.area)?.visible === false;
    if (hidden) {
      const area = item.area as DeskAreaId;
      return { next: item.next, action: <button type="button" className="pm-control needs-you-action" onClick={() => onShowArea(area)}>Show {titleOf(area)} on my Desk</button> };
    }
    return { action: <button type="button" className="pm-control needs-you-action" onClick={() => item.area === "schedule" ? dispatch({ type: "showRoutines" }) : openDeskArea(item.area)}>{item.next}</button> };
  };
  const rows: Row[] = snapshot ? [
    ...snapshot.unavailable.map((source): Row => ({ key: `unavailable:${source.area}`, area: source.area, level: "problem", title: `Couldn't check ${titleOf(source.area)}`,
      reason: "Anything it found is missing from this list until it can be checked.", fresh: false, action: tryAgain() })),
    ...snapshot.items.map((item): Row => ({ key: item.key, area: item.area, level: item.level, title: item.title, reason: item.reason,
      fresh: seenAt !== null && item.foundAt !== null && Date.parse(item.foundAt) > seenAt, ...open(item) })),
  ].sort((a, b) => (a.level === b.level ? 0 : a.level === "problem" ? -1 : 1)) : [];
  const listed = expanded ? rows : rows.slice(0, FIRST_ROWS);
  const checked = snapshot ? `checked ${clock(snapshot.checkedAt)}` : "";
  const failure = error ? (
    <div role="alert" className="needs-you-error">
      <span>{error}</span>{tryAgain()}
    </div>
  ) : null;

  const group = (level: NeedsYouLevel, heading: string) => {
    const items = listed.filter(row => row.level === level);
    return items.length ? (
      <div className="needs-you-group">
        <h3>{heading}</h3>
        <ul>
          {items.map(row => (
            <li key={row.key} className="needs-you-row">
              <div className="needs-you-text">
                <p className="needs-you-source">
                  {row.level === "problem" ? <StatusLabel tone="danger">Problem</StatusLabel> : null}
                  {row.fresh ? <StatusLabel tone="agency">New</StatusLabel> : null}
                  <span>{titleOf(row.area)}</span>
                </p>
                <p className="needs-you-item">{row.title}</p>
                <p className="needs-you-reason">{row.reason}</p>
                {row.next ? <p className="needs-you-reason">{row.next} · Hidden on this Desk.</p> : null}
              </div>
              {row.action}
            </li>
          ))}
        </ul>
      </div>
    ) : null;
  };
  const body = !snapshot && !error ? (
    // The same heading and row shapes as the list, so nothing jumps when the first read lands.
    <section className="needs-you" aria-labelledby="needs-you-title" aria-busy="true" inert={inert}>
      <div className="needs-you-head"><h2 id="needs-you-title">From your workflows</h2></div>
      <p role="status" className="sr-only">Checking what your workflows found…</p>
      <ul className="needs-you-group" aria-hidden>
        {[0, 1].map(index => (
          <li key={index} className="needs-you-row">
            <div className="needs-you-text needs-you-skeleton"><span /><span /><span /></div>
            <span className="needs-you-skeleton-action" />
          </li>
        ))}
      </ul>
    </section>
  ) : snapshot && !rows.length ? (
    <section className="needs-you needs-you-quiet" aria-label="From your workflows" inert={inert}>
      <p>Nothing from your workflows needs you · {checked}</p>
      {failure}
    </section>
  ) : (
    <section className="needs-you" aria-labelledby="needs-you-title" aria-busy={checking || undefined} inert={inert}>
      <div className="needs-you-head">
        <h2 id="needs-you-title">From your workflows</h2>
        {snapshot ? <p>{rows.length} need{rows.length === 1 ? "s" : ""} you · {checked}</p> : null}
      </div>
      {failure}
      {group("problem", "Problems")}
      {group("review", "To review")}
      {rows.length > FIRST_ROWS ? (
        <button type="button" className="needs-you-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </section>
  );
  // One live region that outlives every state above, so arrivals are announced.
  return <>{body}<p className="sr-only" aria-live="polite">{arrived}</p></>;
}

// One work list, grouped by the decision needed. Actions retain the scheduler's
// authority and each job opens the same detail drawer.
import { CircleAlert, Square } from "lucide-react";
import { useRef } from "react";

import type { AttentionWord, ScheduleRow } from "@/lib/schedule-rows";
import { scheduleRowGuidance, scheduleRowSection, type ScheduleSection } from "@/lib/schedule-presentation";
import { StatusLabel } from "../pm";

const DANGER_WORDS: ReadonlySet<AttentionWord> = new Set(["Failed", "Missed", "Interrupted"]);
const SECTIONS: readonly { key: ScheduleSection; label: string }[] = [
  { key: "running", label: "In progress" },
  { key: "attention", label: "Needs you" },
  { key: "ready", label: "Other jobs" },
  { key: "paused", label: "Paused" },
];

function domId(key: string): string {
  return `schedule-row-${key.replace(/[^\w-]/g, "-")}`;
}

export function JobList({
  rows,
  selectedKey,
  freezeOrder = false,
  actionBlocked,
  onOpen,
  onAction,
  onInteract,
}: {
  rows: readonly ScheduleRow[];
  selectedKey?: string | null;
  /** Keep section placement stable while someone reads or acts on a row. */
  freezeOrder?: boolean;
  /** Extra page-level hold (busy, offline) for actions that change work. */
  actionBlocked?: (row: ScheduleRow) => boolean;
  onOpen: (row: ScheduleRow) => void;
  onAction: (row: ScheduleRow) => void;
  /** True while the pointer or keyboard focus is inside the list. */
  onInteract?: (active: boolean) => void;
}) {
  const pointerInside = useRef(false);
  const sections = useRef(new Map<string, ScheduleSection>());
  sections.current = new Map(rows.map((row) => [row.key,
    freezeOrder ? sections.current.get(row.key) ?? scheduleRowSection(row) : scheduleRowSection(row),
  ]));
  return (
    <div
      onPointerEnter={() => { pointerInside.current = true; onInteract?.(true); }}
      onPointerLeave={(event) => { pointerInside.current = false; onInteract?.(event.currentTarget.contains(document.activeElement)); }}
      onFocus={() => onInteract?.(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onInteract?.(pointerInside.current); }}
    >
      <ul aria-label="Jobs">
        {SECTIONS.flatMap((section) => {
          const members = rows.filter((row) => sections.current.get(row.key) === section.key);
          if (!members.length) return [];
          return [
            <li key={`section:${section.key}`} className="schedule-section-heading" data-section={section.key}>
              <h2>{section.label}<span className="schedule-section-count">{members.length}</span></h2>
              <span aria-hidden="true">Timing</span>
            </li>,
            ...members.map((row) => {
                const id = domId(row.key);
                const disabled = row.actionDisabled || Boolean(actionBlocked?.(row));
                return (
                  <li key={row.key} className="schedule-row" data-selected={selectedKey === row.key ? "" : undefined}>
                    <button
                      type="button"
                      id={id}
                      className="schedule-row-open"
                      aria-label={`Open job: ${row.name}`}
                      aria-describedby={`${id}-guidance ${id}-next${row.attention ? ` ${id}-attention` : ""}`}
                      onClick={() => onOpen(row)}
                    >
                      <span className="schedule-row-description">
                        <span className="schedule-row-title-line">
                          <span className="schedule-row-name">{row.name}</span>
                          {row.attention ? (
                            <span id={`${id}-attention`} className="schedule-row-attention">
                              <StatusLabel tone={DANGER_WORDS.has(row.attention) ? "danger" : "hold"}>
                                <CircleAlert size={12} aria-hidden />{row.attention}
                              </StatusLabel>
                            </span>
                          ) : null}
                        </span>
                        <span id={`${id}-guidance`} className="schedule-row-guidance">{scheduleRowGuidance(row)}</span>
                      </span>
                      <span id={`${id}-next`} className="schedule-row-next">{row.next}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`${row.actionLabel}: ${row.name}`}
                      disabled={disabled}
                      onClick={() => onAction(row)}
                      className="schedule-row-action pm-control inline-flex items-center justify-center gap-1.5 rounded border border-line bg-sheet px-3 text-[14px] text-ink hover:bg-selected disabled:opacity-40"
                    >
                      {row.action === "stop" ? <Square size={12} className="fill-current" aria-hidden /> : null}
                      {row.actionLabel}
                    </button>
                  </li>
                );
            }),
          ];
        })}
      </ul>
    </div>
  );
}

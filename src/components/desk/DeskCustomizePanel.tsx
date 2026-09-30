import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import {
  DESK_SECTION_LABELS,
  defaultDeskSections,
  sameDeskSections,
  simpleDeskSections,
  type DeskLayoutHistoryEntry,
  type DeskSection,
} from "@shared/workspace-tabs";
import { useWorkspaceTabs } from "@/lib/workspace-tabs";
import { cn } from "@/lib/cn";

const control = "pm-control inline-flex min-h-11 items-center justify-center gap-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agency";
export const DESK_LAYOUT_CONFLICT = "This card changed — open it again";

export function moveDeskSection(sections: DeskSection[], index: number, distance: -1 | 1): DeskSection[] {
  const target = index + distance;
  if (target < 0 || target >= sections.length) return sections;
  const next = sections.map(section => ({ ...section }));
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
export function toggleDeskSection(sections: DeskSection[], index: number): DeskSection[] {
  return sections.map((section, i) => (i === index && section.id !== "queue" ? { ...section, visible: !section.visible } : { ...section }));
}
export const deskLayoutSummary = (sections: readonly DeskSection[]) =>
  sections.filter(section => section.visible).map(section => DESK_SECTION_LABELS[section.id]).join(", ");
const when = (entry: DeskLayoutHistoryEntry) =>
  entry.savedAt === null ? "Before customizing" : new Date(entry.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export interface DeskCustomizeViewProps {
  draft: DeskSection[];
  current: DeskSection[];
  history: DeskLayoutHistoryEntry[];
  saving: boolean;
  stale: boolean;
  message: string;
  onChange(sections: DeskSection[]): void;
  onSave(): void;
  onRevert(revision: number): void;
  onReopen(): void;
  onClose(): void;
}

/** Presentational panel: toggles, keyboard-accessible reorder, save, presets and recent layouts. */
export function DeskCustomizeView({ draft, current, history, saving, stale, message, onChange, onSave, onRevert, onReopen, onClose }: DeskCustomizeViewProps) {
  const changed = !sameDeskSections(draft, current);
  return (
    <section aria-labelledby="desk-customize-title" className="desk-customize rounded-lg border border-line bg-sheet p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="desk-customize-title" className="text-[15px] font-medium text-ink">Customize desk</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">Choose what shows on your Desk and in what order. This changes only your view, not records or permissions.</p>
        </div>
        <button type="button" className={control} aria-label="Close Customize desk" onClick={onClose}><X size={16} aria-hidden /></button>
      </div>
      {stale ? (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded border border-hold/40 bg-hold/10 px-3 py-2 text-[13px] text-hold">
          <span className="min-w-0 flex-1">{DESK_LAYOUT_CONFLICT}. Your changes are kept here until you reopen.</span>
          <button type="button" className={control} onClick={onReopen}>Open again</button>
        </div>
      ) : null}
      <ol className="mt-3 divide-y divide-line" aria-label="Desk sections">
        {draft.map((section, index) => {
          const label = DESK_SECTION_LABELS[section.id];
          const fixed = section.id === "queue";
          return (
            <li key={section.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <label className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-[14px] text-ink", fixed && "text-ink-secondary")}>
                <input
                  type="checkbox"
                  className="size-4 accent-agency"
                  checked={section.visible}
                  disabled={fixed || saving}
                  aria-label={fixed ? `${label} always shows` : `Show ${label}`}
                  onChange={() => onChange(toggleDeskSection(draft, index))}
                />
                <span>{label}</span>
                {fixed ? <span className="text-[12px] text-ink-muted">Always shown</span> : null}
              </label>
              <button type="button" className={control} disabled={saving || index === 0} aria-label={`Move ${label} up`} onClick={() => onChange(moveDeskSection(draft, index, -1))}>
                <ArrowUp size={15} aria-hidden />
              </button>
              <button type="button" className={control} disabled={saving || index === draft.length - 1} aria-label={`Move ${label} down`} onClick={() => onChange(moveDeskSection(draft, index, 1))}>
                <ArrowDown size={15} aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={cn(control, "border-agency bg-agency text-white hover:bg-agency-hover")} disabled={saving || stale || !changed} onClick={onSave}>
          {saving ? "Saving…" : "Save layout"}
        </button>
        <button type="button" className={control} disabled={saving || sameDeskSections(draft, defaultDeskSections())} onClick={() => onChange(defaultDeskSections())}>Reset to default</button>
        <button type="button" className={control} disabled={saving || sameDeskSections(draft, simpleDeskSections())} onClick={() => onChange(simpleDeskSections())}>Simple desk</button>
      </div>
      <p role="status" className="mt-2 min-h-5 text-[13px] text-ink-secondary">{message}</p>
      {history.length ? (
        <div className="mt-2 border-t border-line pt-3">
          <h3 className="text-[13px] font-medium text-ink">Recent layouts</h3>
          <ul className="mt-1 divide-y divide-line" aria-label="Recent layouts">
            {history.map((entry, index) => {
              const isCurrent = index === history.findIndex(item => sameDeskSections(item.sections, current));
              return (
                <li key={entry.revision} className="flex flex-wrap items-center gap-2 py-1.5">
                  <div className="min-w-0 flex-1 text-[13px]">
                    <div className="text-ink">{when(entry)}{isCurrent ? <span className="ml-2 text-ink-muted">Current</span> : null}</div>
                    <div className="truncate text-ink-secondary">{deskLayoutSummary(entry.sections)}</div>
                  </div>
                  <button type="button" className={control} disabled={saving || stale || sameDeskSections(entry.sections, current)} aria-label={`Restore layout from ${when(entry)}`} onClick={() => onRevert(entry.revision)}>Restore</button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Store-backed panel. Saves with the revision it opened on; a conflict keeps the draft. */
export function DeskCustomizePanel({ onClose }: { onClose(): void }) {
  const { data, saving, error, saveDesk, revertDesk } = useWorkspaceTabs();
  const state = data?.state ?? null;
  const [draft, setDraft] = useState<DeskSection[] | null>(state ? state.desk.sections : null);
  const [base, setBase] = useState<number | null>(state ? state.revision : null);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => { ref.current?.scrollIntoView?.({ block: "nearest" }); }, []);
  useEffect(() => {
    if (state && draft === null) { setDraft(state.desk.sections); setBase(state.revision); }
  }, [state, draft]);
  if (!state || !draft || base === null) {
    return (
      <div ref={ref} role="status" className="rounded-lg border border-line bg-sheet p-4 text-[13px] text-ink-secondary">
        {error || data?.recovery?.message || "Loading your Desk layout…"}
        <button type="button" className={cn(control, "ml-3")} onClick={onClose}>Close</button>
      </div>
    );
  }
  // The panel moves its base revision forward with its own write, so only another window's change reads as stale.
  const stale = conflict || (!saving && state.revision !== base);
  const settle = async (action: () => Promise<void>, done: string) => {
    const expected = base;
    setMessage(""); setBase(expected + 1);
    try { await action(); setConflict(false); setMessage(done); }
    catch (cause) {
      setBase(expected);
      if ((cause as { status?: number }).status === 409) setConflict(true);
      else setMessage(cause instanceof Error ? cause.message : "The layout change could not be confirmed. Refresh before retrying.");
    }
  };
  return (
    <div ref={ref}>
      <DeskCustomizeView
        draft={draft}
        current={state.desk.sections}
        history={state.history}
        saving={saving}
        stale={stale}
        message={message}
        onChange={next => { setDraft(next); setMessage(""); }}
        onSave={() => void settle(() => saveDesk(draft, base), "Desk layout saved.")}
        onRevert={revision => void settle(async () => {
          await revertDesk(revision, base);
          const entry = state.history.find(item => item.revision === revision);
          if (entry) setDraft(entry.sections);
        }, "Earlier layout restored.")}
        onReopen={() => { setDraft(state.desk.sections); setBase(state.revision); setConflict(false); setMessage(""); }}
        onClose={onClose}
      />
    </div>
  );
}

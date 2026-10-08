import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowDown, ArrowUp, MoreHorizontal, X } from "lucide-react";
import {
  DESK_SECTION_LABELS, SHELL_PANEL_LABELS, defaultDeskSections, defaultShellLayout, deskSectionsOrDefault,
  sameDeskSections, simpleDeskSections, type DeskLayoutHistoryEntry, type DeskSection, type DeskSectionId, type ShellLayout, type ShellPanelId,
} from "@shared/workspace-tabs";
import { useWorkspaceTabs } from "@/lib/workspace-tabs";
import { bindMenuDismiss, closeMenu } from "@/lib/menu-dismiss";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  ARRANGE_DESK_EVENT, LAYOUT_CONFLICT, deskSectionLocked, openArrangeDesk, shellOrDefault, shellPanelLocked, withDeskSection, withShellPanel,
} from "./shell-layout";

const control = "pm-control inline-flex min-h-11 items-center justify-center gap-1.5 rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency";

/** The member's Desk cards and side panels, saved together with one revision. A
 *  conflict keeps the stored layout, rereads it and says so; it never retries. */
export function useDeskArrangement() {
  const tabs = useWorkspaceTabs();
  const { dispatch } = useStore();
  const state = tabs.data?.state ?? null;
  const sections = deskSectionsOrDefault(state?.desk.sections);
  const shell = shellOrDefault(state?.shell);
  const write = useCallback(async (commit: (revision: number) => Promise<void>) => {
    if (!state) { dispatch({ type: "error", message: tabs.error || "Your Desk layout is still loading. Try again in a moment." }); return false; }
    try { await commit(state.revision); return true; }
    catch (cause) {
      dispatch({ type: "error", message: (cause as { status?: number }).status === 409 ? LAYOUT_CONFLICT : cause instanceof Error ? cause.message : "The layout change could not be confirmed. Refresh before retrying." });
      return false;
    }
  }, [dispatch, state, tabs]);
  const save = useCallback((nextSections: DeskSection[], nextShell: ShellLayout) => write(revision => tabs.saveDesk(nextSections, revision, nextShell)), [write, tabs]);
  /** Puts an earlier Desk card layout back (the side panel is not part of history). */
  const restore = useCallback((toRevision: number) => write(revision => tabs.revertDesk(toRevision, revision)), [write, tabs]);
  return {
    ready: Boolean(state), saving: tabs.saving, sections, shell, history: state?.history ?? [], revision: state?.revision ?? null, save, restore,
    setSection: (id: DeskSectionId, visible: boolean) => save(withDeskSection(sections, id, visible), shell),
    setPanel: (id: ShellPanelId, visible: boolean) => save(sections, withShellPanel(shell, id, visible)),
  };
}

type Arrangement = { sections: DeskSection[]; shell: ShellLayout };

export function moveDeskSection(sections: readonly DeskSection[], index: number, distance: -1 | 1): DeskSection[] {
  const next = sections.map(section => ({ ...section }));
  const target = index + distance;
  if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
const layoutSummary = (sections: readonly DeskSection[]) => sections.filter(section => section.visible).map(section => DESK_SECTION_LABELS[section.id]).join(", ");
const savedWhen = (entry: DeskLayoutHistoryEntry) =>
  entry.savedAt === null ? "Before customizing" : new Date(entry.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A card's ⋯ menu: Hide (or "Always shown" for locked cards) and Arrange Desk. */
export function CardMenu({ label, locked, shown, onShow, onHide, children }: { label: string; locked: boolean; shown: boolean; onShow?: () => void; onHide?: () => void; children?: ReactNode }) {
  const unbind = useRef<(() => void) | null>(null);
  const menu = useRef<HTMLDetailsElement | null>(null);
  const ref = useCallback((node: HTMLDetailsElement | null) => {
    unbind.current?.(); menu.current = node;
    unbind.current = node ? bindMenuDismiss(node) : null;
  }, []);
  const choose = (action?: () => void) => () => { closeMenu(menu.current); action?.(); };
  return (
    <details ref={ref} className="desk-more rb-card-menu">
      <summary className="rb-card-menu-trigger" aria-label={`${label} options`} title={`${label} options`}><MoreHorizontal size={16} aria-hidden /></summary>
      <div className="desk-more-panel rb-card-menu-panel" role="group" aria-label={`${label} options`}>
        {children}
        {locked ? <p className="px-2.5 py-2 text-[12px] text-ink-muted">Always shown: approvals, safety and recovery stay visible.</p>
          : shown ? <button type="button" className="desk-more-item" onClick={choose(onHide)}>Hide</button>
          : <button type="button" className="desk-more-item" onClick={choose(onShow)}>Show on my Desk</button>}
        <button type="button" className="desk-more-item" onClick={choose(openArrangeDesk)}>Arrange Desk</button>
      </div>
    </details>
  );
}

/** ⋯ menu for one saved Desk section. */
export function DeskCardMenu({ id }: { id: DeskSectionId }) {
  const arrangement = useDeskArrangement();
  const label = DESK_SECTION_LABELS[id];
  const shown = arrangement.sections.find(section => section.id === id)?.visible !== false;
  return <CardMenu label={label} locked={deskSectionLocked(id)} shown={shown} onHide={() => void arrangement.setSection(id, false)} onShow={() => void arrangement.setSection(id, true)} />;
}

export interface ArrangeDeskViewProps {
  dialogRef: Ref<HTMLDivElement>;
  ready: boolean; saving: boolean; message: string;
  /** Another window or Bud changed the saved layout after this draft began. */
  stale: boolean;
  stored: Arrangement; current: Arrangement; history: DeskLayoutHistoryEntry[];
  onChange(next: Partial<Arrangement>): void;
  onSave(): void; onRestore(revision: number): void; onReopen(): void; onClose(): void;
}

/** Presentational Arrange Desk sheet: Desk cards (show, hide, order), side panels,
 *  Save, Reset to recommended, Simple desk and the change history with Restore.
 *  Locked items are shown checked and cannot change. */
export function ArrangeDeskView({ dialogRef, ready, saving, message, stale, stored, current, history, onChange, onSave, onRestore, onReopen, onClose }: ArrangeDeskViewProps) {
  const recommended = { sections: defaultDeskSections(), shell: { ...defaultShellLayout(), panelWidth: current.shell.panelWidth } };
  const unchanged = sameDeskSections(current.sections, stored.sections) && JSON.stringify(current.shell) === JSON.stringify(stored.shell);
  const isRecommended = sameDeskSections(current.sections, recommended.sections) && JSON.stringify(current.shell) === JSON.stringify(recommended.shell);
  const currentEntry = history.findIndex(entry => sameDeskSections(entry.sections, stored.sections));
  const row = (key: string, label: string, checked: boolean, locked: boolean, toggle: () => void, after?: ReactNode) => (
    <li key={key} className="flex items-center gap-1">
      <label className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-[14px] text-ink", locked && "text-ink-secondary")}>
        <input type="checkbox" className="size-4 accent-agency" checked={checked} disabled={locked || saving} aria-label={locked ? `${label} always shows` : `Show ${label} on my Desk`} onChange={toggle} />
        <span className="min-w-0 flex-1">{label}</span>
        {locked ? <span className="text-[12px] text-ink-muted">Always shown</span> : null}
      </label>
      {after}
    </li>
  );
  const mover = (index: number, label: string) => (
    <>
      <button type="button" className={control} disabled={saving || index === 0} aria-label={`Move ${label} up`} onClick={() => onChange({ sections: moveDeskSection(current.sections, index, -1) })}><ArrowUp size={15} aria-hidden /></button>
      <button type="button" className={control} disabled={saving || index === current.sections.length - 1} aria-label={`Move ${label} down`} onClick={() => onChange({ sections: moveDeskSection(current.sections, index, 1) })}><ArrowDown size={15} aria-hidden /></button>
    </>
  );
  return (
    <div className="rb-arrange-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="rb-arrange-title" className="rb-arrange-sheet"
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
          if (event.key !== "Tab") return;
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")];
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="rb-arrange-title" className="text-[16px] font-semibold text-ink">Arrange Desk</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">Choose what shows on this Desk. This changes only the view, not records or permissions. Ask Bud for bigger changes.</p>
            <p className="mt-0.5 text-[12px] text-ink-muted">Saved on this computer and shared by everyone who uses it.</p>
          </div>
          <button type="button" className={control} aria-label="Close Arrange Desk" onClick={onClose}><X size={16} aria-hidden /></button>
        </div>
        {!ready ? <p role="status" className="mt-3 text-[13px] text-ink-secondary">Loading your Desk layout…</p> : <>
          {stale ? (
            <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 rounded border border-hold/40 bg-hold/10 px-3 py-2 text-[13px] text-hold">
              <span className="min-w-0 flex-1">{LAYOUT_CONFLICT}. Your changes are kept here until you reopen.</span>
              <button type="button" className={control} onClick={onReopen}>Open again</button>
            </div>
          ) : null}
          <fieldset className="mt-3">
            <legend className="text-[13px] font-medium text-ink">Desk cards</legend>
            <ul className="mt-1 divide-y divide-line">
              {current.sections.map((section, index) => row(section.id, DESK_SECTION_LABELS[section.id], section.visible, deskSectionLocked(section.id),
                () => onChange({ sections: withDeskSection(current.sections, section.id, !section.visible) }), mover(index, DESK_SECTION_LABELS[section.id])))}
            </ul>
          </fieldset>
          <fieldset className="mt-3">
            <legend className="text-[13px] font-medium text-ink">Side panel</legend>
            <ul className="mt-1 divide-y divide-line">
              {current.shell.panels.map(panel => row(panel.id, SHELL_PANEL_LABELS[panel.id], panel.visible, shellPanelLocked(panel.id),
                () => onChange({ shell: withShellPanel(current.shell, panel.id, !panel.visible) })))}
            </ul>
          </fieldset>
          {history.length ? (
            <section className="mt-3 border-t border-line pt-3" aria-labelledby="rb-arrange-history">
              <h3 id="rb-arrange-history" className="text-[13px] font-medium text-ink">Change history</h3>
              <p className="mt-0.5 text-[12px] text-ink-muted">Earlier Desk card layouts. Restore does not change the side panel.</p>
              <ul className="mt-1 divide-y divide-line" aria-label="Change history">
                {history.map((entry, index) => (
                  <li key={entry.revision} className="flex flex-wrap items-center gap-2 py-1.5">
                    <div className="min-w-0 flex-1 text-[13px]">
                      <div className="text-ink">{savedWhen(entry)}{index === currentEntry ? <span className="ml-2 text-ink-muted">Current</span> : null}</div>
                      <div className="truncate text-ink-secondary">{layoutSummary(entry.sections)}</div>
                    </div>
                    <button type="button" className={control} disabled={saving || index === currentEntry} aria-label={`Restore layout from ${savedWhen(entry)}`} onClick={() => onRestore(entry.revision)}>Restore</button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="rb-arrange-actions"><div className="flex flex-wrap gap-2">
            <button type="button" className={cn(control, "border-agency bg-agency text-white hover:bg-agency-hover")} disabled={saving || stale || unchanged} onClick={onSave}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" className={control} disabled={saving || isRecommended} onClick={() => onChange(recommended)}>Reset to recommended</button>
            <button type="button" className={control} disabled={saving || sameDeskSections(current.sections, simpleDeskSections())} onClick={() => onChange({ sections: simpleDeskSections() })}>Simple desk</button>
          </div>
          <p role="status" className="mt-2 min-h-5 text-[13px] text-ink-secondary">{message}</p></div>
        </>}
        {!ready && <p role="status" className="mt-2 min-h-5 text-[13px] text-ink-secondary">{message}</p>}
      </div>
    </div>
  );
}

/** The one Arrange Desk sheet, opened by ARRANGE_DESK_EVENT from any card, panel or menu. */
export function ArrangeDeskSheet() {
  const arrangement = useDeskArrangement();
  const [open, setOpen] = useState(false);
  // `base` is the stored revision the draft started from; a different revision later means someone else saved.
  const [draft, setDraft] = useState<(Arrangement & { base: number | null }) | null>(null);
  const [message, setMessage] = useState("");
  const opener = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const show = () => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDraft(null); setMessage(""); setOpen(true);
    };
    window.addEventListener(ARRANGE_DESK_EVENT, show);
    return () => window.removeEventListener(ARRANGE_DESK_EVENT, show);
  }, []);
  useEffect(() => { if (open) dialog.current?.querySelector<HTMLElement>("input:not(:disabled), button")?.focus(); }, [open]);
  // Escape closes even when focus fell to the page (a just-disabled Save drops focus).
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !dialog.current?.contains(event.target as Node)) { event.preventDefault(); close(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  if (!open) return null;
  function close() {
    setOpen(false);
    const back = opener.current;
    if (back?.isConnected) back.focus();
    else document.querySelector<HTMLElement>('.rb-sidebar [aria-current="page"]')?.focus();
  }
  const stored = { sections: arrangement.sections, shell: arrangement.shell };
  const current: Arrangement = draft ?? stored;
  const save = async () => {
    setMessage("");
    if (await arrangement.save(current.sections, current.shell)) {
      setDraft(null); setMessage("Desk arrangement saved.");
      dialog.current?.querySelector<HTMLElement>('[aria-label="Close Arrange Desk"]')?.focus();
    }
  };
  const restore = async (revision: number) => {
    setMessage("");
    if (await arrangement.restore(revision)) { setDraft(null); setMessage("Earlier layout restored."); }
  };
  return (
    <ArrangeDeskView dialogRef={dialog} ready={arrangement.ready} saving={arrangement.saving} message={message} stored={stored} current={current} history={arrangement.history}
      stale={draft !== null && draft.base !== arrangement.revision}
      onChange={next => { setMessage(""); setDraft({ sections: current.sections, shell: current.shell, ...next, base: draft ? draft.base : arrangement.revision }); }}
      onSave={() => void save()} onRestore={revision => void restore(revision)} onReopen={() => { setDraft(null); setMessage(""); }} onClose={close} />
  );
}


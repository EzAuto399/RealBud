import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ArrowDown, ArrowUp, MoreHorizontal, X } from "lucide-react";
import {
  DESK_SECTION_LABELS, SHELL_PANEL_LABELS, defaultShellLayout, deskSectionsOrDefault, effectiveDeskAreas, officeDefaultSections,
  sameDeskSections, simpleDeskSections, type DeskLayoutHistoryEntry, type DeskSection, type DeskSectionId, type ShellLayout, type ShellPanelId,
} from "@shared/workspace-tabs";
import {
  AREA_LAYOUTS, DESK_LAYOUT_LABELS, NOTICE_LEVELS, NOTICE_LEVEL_LABELS, coreOfficeDesk,
  type DeskAreaId, type DeskLayoutName, type NoticeLevel, type OfficeDesk,
} from "@shared/desk-areas";
import { undoBudDeskChange, useWorkspaceTabs } from "@/lib/workspace-tabs";
import { bindMenuDismiss, closeMenu } from "@/lib/menu-dismiss";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import type { useToasts } from "../ui/ToastStack";
import { WorkspaceLayout } from "../desk/WorkspaceLayout";
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
    ready: Boolean(state), saving: tabs.saving, sections, shell, history: state?.history ?? [], revision: state?.revision ?? null, office: tabs.office ?? coreOfficeDesk(), save, restore,
    setSection: (id: DeskSectionId, visible: boolean) => save(withDeskSection(sections, id, visible), shell),
    setPanel: (id: ShellPanelId, visible: boolean) => save(sections, withShellPanel(shell, id, visible)),
  };
}

/** One notice with Undo each time Bud arranges Desk, wherever the person is. Undo restores
 *  the layout before Bud's change; if Desk changed since, it changes nothing and offers Arrange Desk. */
export function useBudDeskReceipt({ push, dismiss }: Pick<ReturnType<typeof useToasts>, "push" | "dismiss">) {
  const tabs = useWorkspaceTabs();
  const { dispatch } = useStore();
  const change = tabs.budChange;
  useEffect(() => {
    if (!change) return;
    // One slot: Bud's newest Desk change, or what its Undo did, replaces the last, so an older notice never reads as current.
    const id = "bud-desk";
    push(`Bud arranged Desk: ${change.summary}.`, { label: "Undo", run: () => {
      dismiss(id);
      undoBudDeskChange(change, tabs.revertDesk).then(({ message, openArrange }) => {
        push(message, openArrange ? { label: "Open Arrange Desk", run: () => { dismiss(id); openArrangeDesk(); } } : undefined, id);
      },
        cause => dispatch({ type: "error", message: cause instanceof Error ? cause.message : "Undo could not be confirmed. Refresh before retrying." }));
    } }, id);
  }, [change]); // once per Bud change
}

type Arrangement = { sections: DeskSection[]; shell: ShellLayout };

/** Swaps two sections' places; every other section keeps its slot. Work areas move only among themselves. */
export function swapDeskSections(sections: readonly DeskSection[], a: DeskSectionId, b: DeskSectionId): DeskSection[] {
  const next = sections.map(section => ({ ...section }));
  const i = next.findIndex(section => section.id === a), j = next.findIndex(section => section.id === b);
  if (i >= 0 && j >= 0) [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
/** A work area's notice level or layout on this computer. Choosing the office's own value
 *  drops the choice, so the area follows the office preset again. */
export function withAreaChoice(sections: readonly DeskSection[], id: DeskAreaId, choice: { notify?: NoticeLevel; layout?: DeskLayoutName }, office: OfficeDesk): DeskSection[] {
  const preset = office.areas.find(area => area.id === id);
  return sections.map(section => {
    if (section.id !== id) return { ...section };
    const { notify, layout, ...rest } = { ...section, ...choice };
    return { ...rest, ...(notify && notify !== preset?.notify ? { notify } : {}), ...(layout && layout !== preset?.layout ? { layout } : {}) };
  });
}
/** Cards on the Tasks tab, in the order they show there. */
const TASK_CARDS: readonly DeskSectionId[] = ["go-live", "brief", "queue", "activity"];
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
  /** The office's Desk preset: which work areas exist, their names and defaults. */
  office: OfficeDesk;
  /** This computer's presentation (spacing, property view, rows, queue width); applies at once. */
  layout?: ReactNode;
  onChange(next: Partial<Arrangement>): void;
  onSave(): void; onRestore(revision: number): void; onUndo(revision: number): void; onReopen(): void; onClose(): void;
}

const select = "min-h-11 w-full min-w-0 rounded border border-line bg-sheet px-2 text-[14px] text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-agency";
const LOCKED_REASON = "Always shown: approvals, safety and recovery stay visible.";

/** Presentational Arrange Desk sheet: the work-area tabs (show, order, notices, layout), the
 *  cards on Tasks (show or hide), side panels, Save, Reset to office default, Undo last change,
 *  Simple desk, the change history with Restore and, last, this computer's layout. Locked
 *  items are shown checked, with the reason, and cannot change. */
export function ArrangeDeskView({ dialogRef, ready, saving, message, stale, stored, current, history, office, layout, onChange, onSave, onRestore, onUndo, onReopen, onClose }: ArrangeDeskViewProps) {
  const officeDefault = { sections: officeDefaultSections(office), shell: { ...defaultShellLayout(), panelWidth: current.shell.panelWidth } };
  const same = (a: Arrangement, b: Arrangement) => sameDeskSections(a.sections, b.sections) && JSON.stringify(a.shell) === JSON.stringify(b.shell);
  const currentEntry = history.findIndex(entry => sameDeskSections(entry.sections, stored.sections));
  // Undo puts back the saved layout before the current one.
  const previous = currentEntry >= 0 ? history[currentEntry + 1] : undefined;
  const areas = effectiveDeskAreas(current.sections, office);
  const visibility = (label: string, checked: boolean, locked: boolean, toggle: () => void) => (
    <label className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-[14px] text-ink", locked && "text-ink-secondary")}>
      <input type="checkbox" className="size-4 shrink-0 accent-agency" checked={checked} disabled={locked || saving} aria-label={locked ? `${label} always shows` : `Show ${label} on my Desk`} onChange={toggle} />
      <span className="min-w-0 flex-1">{label}{locked ? <span className="block text-[12px] text-ink-muted">{LOCKED_REASON}</span> : null}</span>
    </label>
  );
  const move = (button: HTMLButtonElement, id: DeskAreaId, neighbour: DeskAreaId, toEdge: boolean) => {
    onChange({ sections: swapDeskSections(current.sections, id, neighbour) });
    // Reaching the first or last place disables this button; keep keyboard focus on the row's other mover.
    if (toEdge) requestAnimationFrame(() => [...button.parentElement?.querySelectorAll("button") ?? []].find(other => other !== button && !other.disabled)?.focus());
  };
  const row = (key: string, label: string, checked: boolean, locked: boolean, toggle: () => void) => (
    <li key={key} className="flex items-center gap-1">{visibility(label, checked, locked, toggle)}</li>
  );
  return (
    <div className="rb-arrange-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="rb-arrange-title" className="rb-arrange-sheet"
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
          if (event.key !== "Tab") return;
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)")];
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="rb-arrange-title" className="text-[16px] font-semibold text-ink">Arrange Desk</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">Changes this computer&apos;s Desk. Your office&apos;s workflows and permissions stay the same.</p>
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
          {areas.length ? (
            <fieldset className="mt-3">
              <legend className="text-[13px] font-medium text-ink">Work areas (tabs)</legend>
              <ul className="mt-1 divide-y divide-line">
                {areas.map((area, index) => {
                  const section = current.sections.find(item => item.id === area.id)!;
                  const choices = AREA_LAYOUTS[area.id];
                  return (
                    <li key={area.id} className="py-1">
                      <div className="flex items-center gap-1">
                        {visibility(area.title, section.visible, false, () => onChange({ sections: withDeskSection(current.sections, area.id, !section.visible) }))}
                        <button type="button" className={control} disabled={saving || index === 0} aria-label={`Move ${area.title} up`} onClick={event => move(event.currentTarget, area.id, areas[index - 1]!.id, index === 1)}><ArrowUp size={15} aria-hidden /></button>
                        <button type="button" className={control} disabled={saving || index === areas.length - 1} aria-label={`Move ${area.title} down`} onClick={event => move(event.currentTarget, area.id, areas[index + 1]!.id, index === areas.length - 2)}><ArrowDown size={15} aria-hidden /></button>
                      </div>
                      {area.notify !== null || choices.length > 1 ? (
                        <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2 pb-1.5 pl-[26px]">
                          {area.notify !== null ? (
                            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-muted">Notices
                              <select className={select} aria-label={`${area.title} notices`} value={area.notify} disabled={saving}
                                onChange={event => onChange({ sections: withAreaChoice(current.sections, area.id, { notify: event.target.value as NoticeLevel }, office) })}>
                                {NOTICE_LEVELS.map(level => <option key={level} value={level}>{NOTICE_LEVEL_LABELS[level]}</option>)}
                              </select>
                            </label>
                          ) : null}
                          {choices.length > 1 ? (
                            <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-muted">Layout
                              <select className={select} aria-label={`${area.title} layout`} value={area.layout} disabled={saving}
                                onChange={event => onChange({ sections: withAreaChoice(current.sections, area.id, { layout: event.target.value as DeskLayoutName }, office) })}>
                                {choices.map(choice => <option key={choice} value={choice}>{DESK_LAYOUT_LABELS[choice]}</option>)}
                              </select>
                            </label>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          ) : null}
          <fieldset className="mt-3">
            <legend className="text-[13px] font-medium text-ink">Cards on Tasks</legend>
            <ul className="mt-1 divide-y divide-line">
              {TASK_CARDS.map(id => row(id, DESK_SECTION_LABELS[id], current.sections.find(section => section.id === id)?.visible !== false, deskSectionLocked(id),
                () => onChange({ sections: withDeskSection(current.sections, id, current.sections.find(section => section.id === id)?.visible === false) })))}
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
              <p className="mt-0.5 text-[12px] text-ink-muted">Earlier Desk layouts. Restore does not change the side panel.</p>
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
          {layout ? (
            <section className="mt-3 border-t border-line pt-3" aria-labelledby="rb-arrange-computer">
              <h3 id="rb-arrange-computer" className="text-[13px] font-medium text-ink">On this computer</h3>
              {layout}
            </section>
          ) : null}
          <div className="rb-arrange-actions"><div className="flex flex-wrap gap-2">
            <button type="button" className={cn(control, "border-agency bg-agency text-white hover:bg-agency-hover")} disabled={saving || stale || same(current, stored)} onClick={onSave}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" className={control} disabled={saving || same(current, officeDefault)} onClick={() => onChange(officeDefault)}>Reset to office default</button>
            <button type="button" className={control} disabled={saving || !previous} aria-describedby={previous ? undefined : "rb-arrange-undo-none"} onClick={() => previous && onUndo(previous.revision)}>Undo last change</button>
            <button type="button" className={control} disabled={saving || sameDeskSections(current.sections, simpleDeskSections())} onClick={() => onChange({ sections: simpleDeskSections() })}>Simple desk</button>
          </div>
          {previous ? null : <p id="rb-arrange-undo-none" className="mt-1 text-[12px] text-ink-muted">Nothing to undo: no earlier saved layout yet.</p>}
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
  useEffect(() => { if (open) dialog.current?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button")?.focus(); }, [open]);
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
  const restore = async (revision: number, done = "Earlier layout restored.") => {
    setMessage("");
    if (await arrangement.restore(revision)) { setDraft(null); setMessage(done); }
  };
  return (
    <ArrangeDeskView dialogRef={dialog} ready={arrangement.ready} saving={arrangement.saving} message={message} stored={stored} current={current} history={arrangement.history} office={arrangement.office} layout={<WorkspaceLayout />}
      stale={draft !== null && draft.base !== arrangement.revision}
      onChange={next => { setMessage(""); setDraft({ sections: current.sections, shell: current.shell, ...next, base: draft ? draft.base : arrangement.revision }); }}
      onSave={() => void save()} onRestore={revision => void restore(revision)} onUndo={revision => void restore(revision, "Last change undone.")} onReopen={() => { setDraft(null); setMessage(""); }} onClose={close} />
  );
}


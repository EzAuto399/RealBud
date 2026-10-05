import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, X } from "lucide-react";
import {
  DESK_SECTION_LABELS, SHELL_PANEL_LABELS, defaultDeskSections, defaultShellLayout, deskSectionsOrDefault,
  sameDeskSections, type DeskSection, type DeskSectionId, type ShellLayout, type ShellPanelId,
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
  const save = useCallback(async (nextSections: DeskSection[], nextShell: ShellLayout) => {
    if (!state) { dispatch({ type: "error", message: tabs.error || "Your Desk layout is still loading. Try again in a moment." }); return false; }
    try { await tabs.saveDesk(nextSections, state.revision, nextShell); return true; }
    catch (cause) {
      dispatch({ type: "error", message: (cause as { status?: number }).status === 409 ? LAYOUT_CONFLICT : cause instanceof Error ? cause.message : "The layout change could not be confirmed. Refresh before retrying." });
      return false;
    }
  }, [dispatch, state, tabs]);
  return {
    ready: Boolean(state), saving: tabs.saving, sections, shell, save,
    setSection: (id: DeskSectionId, visible: boolean) => save(withDeskSection(sections, id, visible), shell),
    setPanel: (id: ShellPanelId, visible: boolean) => save(sections, withShellPanel(shell, id, visible)),
  };
}

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

/** The one Arrange Desk sheet: a checklist of Desk cards and side panels with
 *  Reset to recommended. Locked items are shown checked and cannot change. */
export function ArrangeDeskSheet() {
  const arrangement = useDeskArrangement();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ sections: DeskSection[]; shell: ShellLayout } | null>(null);
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
  const current = draft ?? { sections: arrangement.sections, shell: arrangement.shell };
  const recommended = { sections: defaultDeskSections(), shell: { ...defaultShellLayout(), panelWidth: current.shell.panelWidth } };
  const unchanged = sameDeskSections(current.sections, arrangement.sections) && JSON.stringify(current.shell) === JSON.stringify(arrangement.shell);
  const isRecommended = sameDeskSections(current.sections, recommended.sections) && JSON.stringify(current.shell) === JSON.stringify(recommended.shell);
  const row = (key: string, label: string, checked: boolean, locked: boolean, toggle: () => void) => (
    <li key={key}>
      <label className={cn("flex min-h-11 items-center gap-2.5 text-[14px] text-ink", locked && "text-ink-secondary")}>
        <input type="checkbox" className="size-4 accent-agency" checked={checked} disabled={locked || arrangement.saving} aria-label={locked ? `${label} always shows` : `Show ${label} on my Desk`} onChange={toggle} />
        <span className="min-w-0 flex-1">{label}</span>
        {locked ? <span className="text-[12px] text-ink-muted">Always shown</span> : null}
      </label>
    </li>
  );
  const save = async () => {
    setMessage("");
    if (await arrangement.save(current.sections, current.shell)) {
      setDraft(null); setMessage("Desk arrangement saved.");
      dialog.current?.querySelector<HTMLElement>('[aria-label="Close Arrange Desk"]')?.focus();
    }
  };
  return (
    <div className="rb-arrange-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="rb-arrange-title" className="rb-arrange-sheet"
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); close(); return; }
          if (event.key !== "Tab") return;
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")];
          const first = items[0], last = items.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="rb-arrange-title" className="text-[16px] font-semibold text-ink">Arrange Desk</h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">Choose what shows for you. This changes only your view, not records or permissions. Ask Bud for bigger changes.</p>
          </div>
          <button type="button" className={control} aria-label="Close Arrange Desk" onClick={close}><X size={16} aria-hidden /></button>
        </div>
        {!arrangement.ready ? <p role="status" className="mt-3 text-[13px] text-ink-secondary">Loading your Desk layout…</p> : <>
          <fieldset className="mt-3">
            <legend className="text-[13px] font-medium text-ink">Desk cards</legend>
            <ul className="mt-1 divide-y divide-line">
              {current.sections.map(section => row(section.id, DESK_SECTION_LABELS[section.id], section.visible, deskSectionLocked(section.id),
                () => setDraft({ ...current, sections: withDeskSection(current.sections, section.id, !section.visible) })))}
            </ul>
          </fieldset>
          <fieldset className="mt-3">
            <legend className="text-[13px] font-medium text-ink">Side panel</legend>
            <ul className="mt-1 divide-y divide-line">
              {current.shell.panels.map(panel => row(panel.id, SHELL_PANEL_LABELS[panel.id], panel.visible, shellPanelLocked(panel.id),
                () => setDraft({ ...current, shell: withShellPanel(current.shell, panel.id, !panel.visible) })))}
            </ul>
          </fieldset>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={cn(control, "border-agency bg-agency text-white hover:bg-agency-hover")} disabled={arrangement.saving || unchanged} onClick={() => void save()}>{arrangement.saving ? "Saving…" : "Save"}</button>
            <button type="button" className={control} disabled={arrangement.saving || isRecommended} onClick={() => setDraft(recommended)}>Reset to recommended</button>
          </div>
        </>}
        <p role="status" className="mt-2 min-h-5 text-[13px] text-ink-secondary">{message}</p>
      </div>
    </div>
  );
}

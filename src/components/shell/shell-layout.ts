import {
  LOCKED_DESK_SECTIONS, LOCKED_SHELL_PANELS, SHELL_PANEL_WIDTH, defaultShellLayout, parseShellLayout,
  type DeskSection, type DeskSectionId, type ShellLayout, type ShellPanelId,
} from "@shared/workspace-tabs";
import { isObservedStale } from "@/lib/observed-stale";
import type { DeskSnapshot } from "@/lib/desk";
import type { Loop } from "@/lib/routines";

/** Opens the one Arrange Desk sheet from any card, panel or sidebar menu. */
export const ARRANGE_DESK_EVENT = "realbud:arrange-desk";
export const openArrangeDesk = () => window.dispatchEvent(new Event(ARRANGE_DESK_EVENT));
export const LAYOUT_CONFLICT = "This card changed — open it again";

export const deskSectionLocked = (id: DeskSectionId) => LOCKED_DESK_SECTIONS.includes(id);
export const shellPanelLocked = (id: ShellPanelId) => LOCKED_SHELL_PANELS.includes(id);

/** An absent or invalid stored layout renders the recommended panels. */
export function shellOrDefault(value: unknown): ShellLayout {
  try { return parseShellLayout(value); } catch { return defaultShellLayout(); }
}
/** Locked sections never change; the server refuses the same write. */
export function withDeskSection(sections: readonly DeskSection[], id: DeskSectionId, visible: boolean): DeskSection[] {
  return sections.map(section => section.id === id && !deskSectionLocked(id) ? { ...section, visible } : { ...section });
}
export function withShellPanel(shell: ShellLayout, id: ShellPanelId, visible: boolean): ShellLayout {
  return { ...shell, panels: shell.panels.map(panel => panel.id === id && !shellPanelLocked(id) ? { ...panel, visible } : { ...panel }) };
}
export function clampPanelWidth(width: number): number {
  return Math.round(Math.min(SHELL_PANEL_WIDTH.max, Math.max(SHELL_PANEL_WIDTH.min, width)));
}

const ago = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

/** The last Desk check, worded so a sample, missing or stale check never reads as live. */
export function deskRunStatus(desk: DeskSnapshot | null, now = Date.now()): { label: string; tone: "muted" | "hold" | "agency" } {
  if (!desk) return { label: "Desk loading", tone: "muted" };
  const sample = Boolean(desk.demo || desk.mode === "demo");
  if (desk.lastRunAt == null) return { label: sample ? "Sample book · not checked yet" : "Desk not checked yet", tone: "hold" };
  const when = `checked ${ago(now - desk.lastRunAt)}`;
  if (isObservedStale(desk.lastRunAt, now)) return { label: `${sample ? "Sample book" : "Desk"} · stale, ${when}`, tone: "hold" };
  return sample ? { label: `Sample book · ${when}`, tone: "muted" } : { label: `Desk ${when}`, tone: "agency" };
}

/** The soonest enabled loop that is actually scheduled; a paused clock is not a next run. */
export function nextLoopLine(loops: readonly Loop[], now = Date.now()): string {
  const next = loops
    .filter(loop => loop.available && loop.enabled && !loop.timezonePaused && typeof loop.nextRunAt === "number" && loop.nextRunAt >= now - 60_000)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
  if (!next) return "No loop scheduled";
  const at = new Date(next.nextRunAt!);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const time = at.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  return `Next: ${next.name} ${sameDay ? time : `${at.toLocaleDateString("en-AU", { weekday: "short" })} ${time}`}`;
}

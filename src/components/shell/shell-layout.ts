import {
  LOCKED_DESK_SECTIONS, LOCKED_SHELL_PANELS, SHELL_PANEL_WIDTH, defaultShellLayout, parseShellLayout,
  type DeskSection, type DeskSectionId, type ShellLayout, type ShellPanelId,
} from "@shared/workspace-tabs";
import { isObservedStale } from "@/lib/observed-stale";
import type { DeskSnapshot } from "@/lib/desk";
import type { Loop } from "@/lib/routines";
import type { WebsiteLinkRead } from "@/lib/setup-sequence";
import { useOfficeLinkStatus } from "@/lib/use-office-link";
import { useStore } from "@/state/store";

/** Opens the one Arrange Desk sheet from any card, panel or sidebar menu. */
export const ARRANGE_DESK_EVENT = "realbud:arrange-desk";
export const openArrangeDesk = () => window.dispatchEvent(new Event(ARRANGE_DESK_EVENT));
export const LAYOUT_CONFLICT = "This card changed — open it again";
/** Opens Schedule on one loop's detail drawer: Schedule reads `#job-<id>` once mounted
 *  (or on hashchange when already open), then clears it. */
export function openScheduleLoop(loopId: string, showSchedule: () => void) {
  location.hash = `job-${loopId}`;
  showSchedule();
}

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

/** Desk data is live only while this computer reaches its office and the last check is fresh.
 *  Otherwise `notice` names which, so empty lists never read as a completed live check.
 *  An unread link is not live, but is not called disconnected either. */
export function deskDataStatus(desk: DeskSnapshot | null, office: { connected: boolean; link: WebsiteLinkRead; officeInactive: boolean }, now = Date.now()): { live: boolean; notice: string | null } {
  const disconnected = !office.connected || office.link === "not-linked" || office.link === "unavailable" || (office.link === "linked" && office.officeInactive);
  const last = desk?.lastRunAt ?? null;
  const stale = isObservedStale(last, now);
  const live = !disconnected && office.link === "linked" && !stale;
  const notice = !desk ? null
    : disconnected ? `Office disconnected · ${last == null ? "Desk not checked yet" : `Last Desk check ${ago(now - last)}`}`
    : stale ? `Desk check is stale · Last checked ${ago(now - last!)}`
    : null;
  return { live, notice };
}
export function useDeskDataStatus() {
  const { state } = useStore();
  const { link, officeInactive } = useOfficeLinkStatus(state.connected);
  return deskDataStatus(state.desk, { connected: state.connected, link, officeInactive });
}

/** The soonest enabled loop that is actually scheduled; a paused clock is not a next run. */
export function nextLoop(loops: readonly Loop[], now = Date.now()): Loop | null {
  return loops
    .filter(loop => loop.available && loop.enabled && !loop.timezonePaused && typeof loop.nextRunAt === "number" && loop.nextRunAt >= now - 60_000)
    .sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0] ?? null;
}
export function nextLoopLine(loops: readonly Loop[], now = Date.now()): string {
  const next = nextLoop(loops, now);
  if (!next) return "No loop scheduled";
  const at = new Date(next.nextRunAt!);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const time = at.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  return `Next: ${next.name} ${sameDay ? time : `${at.toLocaleDateString("en-AU", { weekday: "short" })} ${time}`}`;
}

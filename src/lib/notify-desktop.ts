import type { DeskSnapshot } from "./desk";
import { morningBrief, type MorningBrief } from "./morning-brief";

export type NotifyPermission = NotificationPermission | "unavailable";

export const SHOW_DESK_EVENT = "realbud:show-desk";

let lastNeedsYou: number | null = null;
let lastHeadline: string | null = null;
let skipForever = false;

export function resetNotifyDesktop(): void {
  lastNeedsYou = null;
  lastHeadline = null;
  skipForever = false;
}

export function briefCountsLine(brief: Pick<MorningBrief, "checkedCount" | "needsYou" | "licensee">): string {
  const bits = [`${brief.checkedCount} checked`];
  if (brief.needsYou) bits.push(brief.needsYou === 1 ? "1 needs you" : `${brief.needsYou} need you`);
  if (brief.licensee) bits.push(brief.licensee === 1 ? "1 for the licensee" : `${brief.licensee} for the licensee`);
  return bits.join(" · ");
}

export function notifyBody(brief: MorningBrief): string {
  if (brief.headline.startsWith("Recheck missed")) return "Recheck missed — facts held. Open Desk.";
  return briefCountsLine(brief);
}

export function shouldNotifyNeedsYou(
  previous: number | null,
  next: number,
  permission: NotifyPermission,
): boolean {
  if (permission === "denied" || permission === "unavailable") return false;
  return next > (previous ?? 0);
}

export function shouldNotifyMiss(
  previousHeadline: string | null,
  next: MorningBrief,
  permission: NotifyPermission,
): boolean {
  if (permission === "denied" || permission === "unavailable") return false;
  if (!next.headline.startsWith("Recheck missed")) return false;
  return previousHeadline !== next.headline;
}

export function notifyDeskNeedsYou(snapshot: DeskSnapshot): void {
  const brief = morningBrief(snapshot);
  const previous = lastNeedsYou;
  const previousHeadline = lastHeadline;
  lastNeedsYou = brief.needsYou;
  lastHeadline = brief.headline;
  if (skipForever) return;
  const permission = currentPermission();
  if (permission === "unavailable") {
    skipForever = true;
    return;
  }
  const needsYouRise = shouldNotifyNeedsYou(previous, brief.needsYou, permission);
  const missRise = shouldNotifyMiss(previousHeadline, brief, permission);
  if (!needsYouRise && !missRise) {
    if (permission === "denied") skipForever = true;
    return;
  }
  void requestAndNotify(brief);
}

function currentPermission(): NotifyPermission {
  if (typeof Notification === "undefined") return "unavailable";
  return Notification.permission;
}

async function requestAndNotify(brief: MorningBrief): Promise<void> {
  try {
    if (typeof Notification === "undefined") {
      skipForever = true;
      return;
    }
    if (Notification.permission === "default") {
      const result = await Notification.requestPermission();
      if (result !== "granted") {
        skipForever = true;
        return;
      }
    }
    if (Notification.permission !== "granted") {
      skipForever = true;
      return;
    }
    const note = new Notification("RealBud", {
      body: notifyBody(brief),
      tag: "realbud-desk-digest",
    });
    note.onclick = () => {
      try {
        window.focus();
        window.dispatchEvent(new Event(SHOW_DESK_EVENT));
      } catch {
        /* ignore */
      }
    };
  } catch {
    skipForever = true;
  }
}

import type { DeskSnapshot } from "./desk";
import { morningBrief, type MorningBrief } from "./morning-brief";

export type NotifyPermission = NotificationPermission | "unavailable";

let lastNeedsYou: number | null = null;
let skipForever = false;

export function resetNotifyDesktop(): void {
  lastNeedsYou = null;
  skipForever = false;
}

export function briefCountsLine(brief: Pick<MorningBrief, "checkedCount" | "needsYou" | "licensee">): string {
  const bits = [`${brief.checkedCount} checked`];
  if (brief.needsYou) bits.push(brief.needsYou === 1 ? "1 needs you" : `${brief.needsYou} need you`);
  if (brief.licensee) bits.push(brief.licensee === 1 ? "1 for the licensee" : `${brief.licensee} for the licensee`);
  return bits.join(" · ");
}

export function shouldNotifyNeedsYou(
  previous: number | null,
  next: number,
  permission: NotifyPermission,
): boolean {
  if (permission === "denied" || permission === "unavailable") return false;
  return next > (previous ?? 0);
}

export function notifyDeskNeedsYou(snapshot: DeskSnapshot): void {
  const brief = morningBrief(snapshot);
  const previous = lastNeedsYou;
  lastNeedsYou = brief.needsYou;
  if (skipForever) return;
  const permission = currentPermission();
  if (permission === "unavailable") {
    skipForever = true;
    return;
  }
  if (!shouldNotifyNeedsYou(previous, brief.needsYou, permission)) {
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
    new Notification("RealBud", { body: briefCountsLine(brief) });
  } catch {
    skipForever = true;
  }
}

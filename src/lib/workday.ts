import type { DeskSnapshot } from "../../shared/contracts.ts";

import { isDemoWorkerMiss, morningBrief } from "./morning-brief";

export type WorkdayPhase =
  | "offline"
  | "loading"
  | "recovery"
  | "empty"
  | "unchecked"
  | "worker-miss"
  | "licensee"
  | "review"
  | "waiting"
  | "clear";

export type WorkdayAction = "desk" | "you" | "practice" | "recheck" | null;
export type WorkdayTone = "agency" | "hold" | "danger" | "muted";

export interface WorkdayGuide {
  phase: WorkdayPhase;
  tone: WorkdayTone;
  eyebrow: string;
  title: string;
  detail: string;
  action: WorkdayAction;
  actionLabel: string | null;
  bookLabel: string;
  budLabel: string;
}

function labels(desk: DeskSnapshot | null, workerReady: boolean) {
  return {
    bookLabel: !desk ? "Book loading" : desk.demo || desk.mode === "demo" ? "Sample book" : "Office book",
    budLabel: workerReady ? "Bud ready" : "Bud setup open",
  };
}

/**
 * One truthful next step for the whole workday. The guide deliberately
 * derives from durable Desk state; it never invents inbox or portal status.
 */
export function workdayGuide(input: {
  connected: boolean;
  desk: DeskSnapshot | null;
  workerReady: boolean;
}): WorkdayGuide {
  const meta = labels(input.desk, input.workerReady);

  if (!input.connected) {
    return {
      phase: "offline",
      tone: "hold",
      eyebrow: "Local service",
      title: "Reconnecting",
      detail: "New checks and saves are paused. Your existing book stays on this Mac.",
      action: null,
      actionLabel: null,
      ...meta,
    };
  }

  const desk = input.desk;
  if (!desk) {
    return {
      phase: "loading",
      tone: "muted",
      eyebrow: "Today",
      title: "Loading your desk",
      detail: "RealBud is reading the book and its latest check.",
      action: null,
      actionLabel: null,
      ...meta,
    };
  }

  if (desk.recovery.active) {
    return {
      phase: "recovery",
      tone: "danger",
      eyebrow: "Book protected",
      title: "Unlock this book",
      detail: "Writes and routines stay paused until the recovery key opens the preserved book.",
      action: "you",
      actionLabel: "Open recovery",
      ...meta,
    };
  }

  if (desk.properties.length === 0) {
    return {
      phase: "empty",
      tone: "muted",
      eyebrow: "Start here",
      title: "Bring in your book",
      detail: "Open Desk, review an export, then add only the rows you approve.",
      action: "desk",
      actionLabel: "Open Desk",
      ...meta,
    };
  }

  const brief = morningBrief(desk);
  if (desk.lastRunAt == null) {
    if (desk.demo || desk.mode === "demo") {
      return {
        phase: "unchecked",
        tone: "agency",
        eyebrow: "Practice safely",
        title: "Run the sample morning",
        detail: "Use labelled training facts to learn the full Desk flow. Nothing touches a PMS or leaves this Mac.",
        action: "practice",
        actionLabel: "Recheck",
        ...meta,
      };
    }
    return {
      phase: "unchecked",
      tone: "agency",
      eyebrow: "Today",
      title: "Run the morning check",
      detail: input.workerReady
        ? `Bud will check ${desk.properties.length} ${desk.properties.length === 1 ? "address" : "addresses"} and put exceptions on Desk.`
        : "Recheck remains available. Any Bud miss stays clearly labelled and nothing is sent.",
      action: "recheck",
      actionLabel: "Recheck",
      ...meta,
    };
  }

  if (isDemoWorkerMiss(desk.hands, desk.handsDetail)) {
    if (desk.demo || desk.mode === "demo") {
      return {
        phase: "worker-miss",
        tone: "hold",
        eyebrow: "Live check missed",
        title: "Facts stay held",
        // The button replays labelled training facts, so it must not be called
        // Recheck: a live Recheck would miss again until the model is fixed.
        detail: "Bud did not return live facts. Fix the model connection on You, or keep practising on the sample morning.",
        action: "practice",
        actionLabel: "Run the sample morning",
        ...meta,
      };
    }
    return {
      phase: "worker-miss",
      tone: "hold",
      eyebrow: "Check incomplete",
      title: "Bud needs attention",
      detail: "The last check did not return live facts. The sample book was not treated as current.",
      action: "you",
      actionLabel: "Check Bud",
      ...meta,
    };
  }

  if (brief.licensee > 0) {
    return {
      phase: "licensee",
      tone: "danger",
      eyebrow: "Decision queue",
      title: brief.licensee === 1 ? "1 item needs the licensee" : `${brief.licensee} items need the licensee`,
      detail: "Open Desk to review the evidence. Bud cannot make the licensed decision.",
      action: "desk",
      actionLabel: "Review on Desk",
      ...meta,
    };
  }

  if (brief.needsYou > 0) {
    return {
      phase: "review",
      tone: "agency",
      eyebrow: "Decision queue",
      title: brief.needsYou === 1 ? "1 item is ready for you" : `${brief.needsYou} items are ready for you`,
      detail: "Evidence and prepared wording are waiting together on Desk.",
      action: "desk",
      actionLabel: "Review on Desk",
      ...meta,
    };
  }

  if (brief.held > 0) {
    return {
      phase: "waiting",
      tone: "hold",
      eyebrow: "Waiting",
      title: brief.held === 1 ? "1 item needs evidence" : `${brief.held} items need evidence`,
      detail: "Open Desk to see what is missing and what can safely happen next.",
      action: "desk",
      actionLabel: "Open Desk",
      ...meta,
    };
  }

  return {
    phase: "clear",
    tone: "agency",
    eyebrow: "Today",
    title: "You are clear for now",
    detail: `${brief.checkedCount} ${brief.checkedCount === 1 ? "address is" : "addresses are"} checked with nothing waiting.`,
    action: "desk",
    actionLabel: "View Desk",
    ...meta,
  };
}

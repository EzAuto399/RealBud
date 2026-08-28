import { matchAskConnectionSpeech } from "@shared/ask-connections";

import type { DeskSnapshot } from "./desk";
import type { Loop, LoopRun } from "./routines";
import { buildDeskQueue, type DeskQueueItem } from "./desk-queue";

export type AskActivityStatus = "working" | "done" | "failed";
export type AskActivityKind = "intake" | "evidence" | "connection" | "handoff" | "general" | "suppressed";

export interface AskActivityPresentation {
  kind: AskActivityKind;
  status: AskActivityStatus;
  title: string;
  detail: string;
}

function activityStatus(ok: boolean | undefined): AskActivityStatus {
  return ok === undefined ? "working" : ok ? "done" : "failed";
}

function statusTitle(status: AskActivityStatus, titles: Record<AskActivityStatus, string>): string {
  return titles[status];
}

/**
 * Product Ask never exposes provider tool identifiers. They are useful in
 * diagnostics, but in the transcript a PM needs the purpose, scope and
 * outcome of the step. This is deliberately a closed presentation map: an
 * unknown title degrades to a generic check instead of becoming UI copy.
 */
function isHostProbeActivity(raw: string): boolean {
  return /^(?:python|bash|zsh|sh|shell)\b|\bpython:\s*import\b|^import\s+os\b/.test(raw);
}

export function presentAskActivity(name: string, ok?: boolean): AskActivityPresentation {
  const raw = String(name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().toLowerCase();
  const status = activityStatus(ok);

  if (isHostProbeActivity(raw)) {
    return {
      kind: "suppressed",
      status,
      title: "Background check",
      detail: "This step stays out of the Ask thread.",
    };
  }

  if (/intake-properties|property intake/.test(raw)) {
    return {
      kind: "intake",
      status,
      title: statusTitle(status, {
        working: "Applying the property intake rules",
        done: "Property intake rules checked",
        failed: "Property intake check could not finish",
      }),
      detail: "Only the files and details you selected are in scope.",
    };
  }

  if (/morning-arrears|morning money/.test(raw)) {
    return {
      kind: "general",
      status,
      title: statusTitle(status, {
        working: "Checking the morning money rules",
        done: "Morning money rules checked",
        failed: "Morning money rules could not be checked",
      }),
      detail: "Desk still owns Recheck and Allow.",
    };
  }

  if (/owner-letter|friday owner/.test(raw)) {
    return {
      kind: "general",
      status,
      title: statusTitle(status, {
        working: "Checking the owner letter rules",
        done: "Owner letter rules checked",
        failed: "Owner letter rules could not be checked",
      }),
      detail: "Copy-only drafts. Desk still owns Allow.",
    };
  }

  if (/spreadsheet|document|pdf|image|photo|attachment|\bread\b|\bfile\b/.test(raw)) {
    return {
      kind: "evidence",
      status,
      title: statusTitle(status, {
        working: "Reviewing selected evidence",
        done: "Selected evidence reviewed",
        failed: "Selected evidence could not be read",
      }),
      detail: "Unreadable or conflicting details stay unverified.",
    };
  }

  if (/composio|gmail|outlook|mail|connector|integration/.test(raw)) {
    return {
      kind: "connection",
      status,
      title: statusTitle(status, {
        working: "Checking an approved source connection",
        done: "Source connection check completed",
        failed: "Source connection needs attention",
      }),
      detail: "RealBud verifies connection state separately from Bud's wording.",
    };
  }

  if (/computer|screenshot|click|type_text|press_key|scroll|open_url|portal/.test(raw)) {
    return {
      kind: "handoff",
      status,
      title: statusTitle(status, {
        working: "Preparing the bounded handoff",
        done: "Bounded handoff step prepared",
        failed: "Bounded handoff step stopped",
      }),
      detail: "Bud cannot submit, send or pay.",
    };
  }

  return {
    kind: "general",
    status,
    title: statusTitle(status, {
      working: "Bud is checking the request",
      done: "Background check completed",
      failed: "A background check could not finish",
    }),
    detail: status === "failed" ? "The request stays unchanged." : "No change is applied from this activity row.",
  };
}

export type AskSuggestionAction = { kind: "ask"; prompt: string };

export interface AskSuggestion {
  id: string;
  label: string;
  detail: string;
  action: AskSuggestionAction;
}

export interface AskSuggestionContext {
  composioConfigured?: boolean;
  userTexts?: readonly string[];
  connecting?: boolean;
}

function normalizeAskText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A card the PM already sent in this thread is spent. It does not come back until the book changes. */
export function isAskSuggestionSpent(
  suggestion: AskSuggestion,
  userTexts: readonly string[] = [],
): boolean {
  if (userTexts.length === 0) return false;
  const label = normalizeAskText(suggestion.label);
  const prompt = normalizeAskText(suggestion.action.prompt);
  const promptHead = prompt.slice(0, 48);
  return userTexts.some((raw) => {
    const text = normalizeAskText(raw);
    if (!text) return false;
    if (text === prompt || (promptHead.length >= 24 && text.includes(promptHead))) return true;
    return label.length >= 12 && text.includes(label);
  });
}

function recentConnectSpeech(userTexts: readonly string[]): boolean {
  return userTexts.slice(-6).some((text) => matchAskConnectionSpeech(text).kind !== "none");
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function shortAddress(address: string): string {
  const head = address.split(",")[0]?.trim() ?? address;
  return head.slice(0, 42);
}

function sameLocalDay(left: number, right: number): boolean {
  const start = new Date(right);
  start.setHours(0, 0, 0, 0);
  return left >= start.getTime() && left < start.getTime() + 86_400_000;
}

function startOfCurrentFriday(now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 7 - 5) % 7));
  return start.getTime();
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function formatClock(hhmm: string): string {
  const [hourRaw, minuteRaw] = hhmm.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return hhmm;
  }
  const meridian = hour >= 12 ? "pm" : "am";
  const twelve = hour % 12 || 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${meridian}`;
}

export function loopClockLabel(loop: Pick<Loop, "schedule">): string {
  const days = [...loop.schedule.weekdays].sort((left, right) => left - right);
  const time = formatClock(loop.schedule.time);
  if (days.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) return `Weekdays at ${time}`;
  if (days.length === 1) return `${WEEKDAY_NAMES[days[0]!]} at ${time}`;
  if (days.length === 7) return `Daily at ${time}`;
  return `${days.map((day) => WEEKDAY_NAMES[day]).join(", ")} at ${time}`;
}

function currentBookSource(desk: DeskSnapshot): string | null {
  const labelled = desk.sources.find((source) => source.label.trim())?.label.trim();
  if (labelled) return labelled.slice(0, 80);
  if (desk.mode === "demo") return "the practice book";
  if (desk.hands === "csv") return "the current PMS export";
  return null;
}

function suggestionPlace(rows: DeskQueueItem[]): string | null {
  const unique = [...new Set(rows.map((row) => row.address).filter(Boolean))];
  if (unique.length !== 1) return null;
  const address = unique[0]!;
  if (rows.every((row) => address === row.propertyId || address === row.id)) return null;
  return shortAddress(address);
}

/**
 * Evidence-backed next steps from live Desk and Schedule state. Each card
 * starts an ordinary Ask turn. Bud may propose Desk work; nothing executes
 * until the PM Allows.
 */
export function deriveAskSuggestions(
  desk: DeskSnapshot | null,
  loops: readonly Loop[],
  runs: readonly LoopRun[],
  extras: AskSuggestionContext = {},
): AskSuggestion[] {
  if (!desk) return [];
  const suggestions: AskSuggestion[] = [];

  if (desk.recovery.active) {
    suggestions.push({
      id: "recovery",
      label: "Ask about recovery",
      detail: "Writes and routines are paused.",
      action: {
        kind: "ask",
        prompt: "The book is in recovery. Tell me the exact next safe step and what is paused. Do not write to the book or start a routine.",
      },
    });
  }

  const unseenFailures = runs.filter(
    (run) => !run.seenAt && ["failed", "missed", "interrupted"].includes(run.status),
  );
  if (unseenFailures.length) {
    const names = unseenFailures.slice(0, 2).map((run) => run.loopName).join(", ");
    suggestions.push({
      id: "routine-attention",
      label: `Ask about ${countLabel(unseenFailures.length, "routine")}`,
      detail: names || "A run failed, was missed, or was interrupted.",
      action: {
        kind: "ask",
        prompt: `Review the ${countLabel(unseenFailures.length, "routine run")} that needs attention (${names || "failed, missed, or interrupted"}). Explain what happened and the next safe step. Do not rerun anything or send a message.`,
      },
    });
  }

  const morning = loops.find((item) => item.id === "morning-arrears");
  const ownerLetter = loops.find((item) => item.id === "owner-letter");
  const now = Date.now();
  const source = currentBookSource(desk);
  const sourceClause = source ? ` Uses ${source}.` : "";
  const morningAlreadyRan = Boolean(desk.lastRunAt && sameLocalDay(desk.lastRunAt, now))
    || runs.some((run) =>
      run.loopId === "morning-arrears"
      && run.status === "completed"
      && sameLocalDay(run.scheduledFor ?? run.createdAt, now),
    );
  const ownerLetterAlreadyThisWeek = runs.some((run) =>
    run.loopId === "owner-letter"
    && run.status === "completed"
    && (run.scheduledFor ?? run.createdAt) >= startOfCurrentFriday(now),
  );
  if (!desk.recovery.active && morningAlreadyRan) {
    suggestions.push({
      id: "review-morning-landed",
      label: "Review this morning's exceptions",
      detail: "The clock already pressed Recheck. Ask Bud what still needs Allow.",
      action: {
        kind: "ask",
        prompt: "Review this morning's exceptions. The clock already ran Recheck. Summarise what still needs Allow and the next safe step for each. Do not send or pay.",
      },
    });
  }
  if (!desk.recovery.active && morning?.available && !morning.enabled) {
    suggestions.push({
      id: "enable-morning-money",
      label: `Turn on ${morning.name}`,
      detail: `${loopClockLabel(morning)}.${sourceClause} Set the clock to how you already check money.`,
      action: {
        kind: "ask",
        prompt: `Turn on ${morning.name} at its current clock (${loopClockLabel(morning)}). Do not run it yet. Do not send or pay.`,
      },
    });
  }
  if (!desk.recovery.active && morning?.available && morning.enabled && !morningAlreadyRan) {
    suggestions.push({
      id: "run-morning-money",
      label: `Run ${morning.name}`,
      detail: `${loopClockLabel(morning)}.${sourceClause} You Allow. Nothing sends.`,
      action: {
        kind: "ask",
        prompt: `Run the ${morning.name} now.`,
      },
    });
  }
  if (!desk.recovery.active && ownerLetter?.available && !ownerLetter.enabled) {
    suggestions.push({
      id: "enable-owner-letter",
      label: `Turn on ${ownerLetter.name}`,
      detail: `${loopClockLabel(ownerLetter)}.${sourceClause} Set the day and time to how you already write owner updates.`,
      action: {
        kind: "ask",
        prompt: `Turn on ${ownerLetter.name} at its current clock (${loopClockLabel(ownerLetter)}). Do not run it yet. Do not send or pay.`,
      },
    });
  }
  if (!desk.recovery.active && ownerLetter?.available && ownerLetter.enabled && !ownerLetterAlreadyThisWeek) {
    suggestions.push({
      id: "run-owner-letter",
      label: `Run ${ownerLetter.name}`,
      detail: `${loopClockLabel(ownerLetter)}.${sourceClause} Copy-only drafts. You Allow. Nothing sends.`,
      action: {
        kind: "ask",
        prompt: `Run the ${ownerLetter.name} now.`,
      },
    });
  }

  const queue = buildDeskQueue(desk);
  const heldItems = queue.filter((row) => row.bucket === "held");
  if (heldItems.length) {
    const place = suggestionPlace(heldItems);
    suggestions.push({
      id: "held-work",
      label: place
        ? `Resolve ${countLabel(heldItems.length, "hold")} at ${place}`
        : `Resolve ${countLabel(heldItems.length, "hold")}`,
      detail: place
        ? "Ask Bud to name the missing evidence or match."
        : "Ask Bud to name missing evidence or matching.",
      action: {
        kind: "ask",
        prompt: `Resolve the ${countLabel(heldItems.length, "held case")} on Desk${place ? ` at ${place}` : ""}. For each hold, say what evidence or property match is missing and propose the next safe Desk step. Do not send, pay, or dispatch.`,
      },
    });
  }

  const pendingDrafts = queue.filter((row) => row.bucket === "needs-you");
  if (pendingDrafts.length) {
    const place = suggestionPlace(pendingDrafts);
    suggestions.push({
      id: "pending-decisions",
      label: place
        ? `Review ${countLabel(pendingDrafts.length, "draft")} at ${place}`
        : `Review ${countLabel(pendingDrafts.length, "draft")}`,
      detail: "Ask Bud to summarise what Allow would approve.",
      action: {
        kind: "ask",
        prompt: `Review the ${countLabel(pendingDrafts.length, "pending draft")} on Desk${place ? ` at ${place}` : ""}. Summarise each card and what Allow would approve. Do not send, pay, or treat Allow as already given.`,
      },
    });
  }

  const licensee = queue.filter((row) => row.bucket === "licensee");
  if (licensee.length) {
    suggestions.push({
      id: "licensee",
      label: `Ask about ${countLabel(licensee.length, "licensee hold")}`,
      detail: "Bud can explain the hold. Desk still owns the next step.",
      action: {
        kind: "ask",
        prompt: `Explain the ${countLabel(licensee.length, "licensee hold")} on Desk. Say what I must do next. Do not draft wording or send a message.`,
      },
    });
  }

  const connecting = extras.connecting || recentConnectSpeech(extras.userTexts ?? []);
  if (!desk.recovery.active && !connecting) {
    suggestions.push({
      id: "connect-office-sources",
      label: "Connect this office's sources",
      detail: "PMS, inbox or portal you already use. Bud opens the picker here.",
      action: {
        kind: "ask",
        prompt: "Set up connections",
      },
    });
  }

  if (desk.mode === "demo") {
    suggestions.push({
      id: "verify-book",
      label: "Verify the live book",
      detail: "Ask Bud how to stage a current PMS export.",
      action: {
        kind: "ask",
        prompt: "This is still the practice book. Help me verify live balances with the PMS export or files this office already uses. Explain the route from the current book source, then wait for my review. Do not mark the book live or name a vendor we have not confirmed.",
      },
    });
  }

  if (suggestions.length === 0 && loops.some((loop) => loop.available && loop.enabled)) {
    suggestions.push({
      id: "ask-needs-me",
      label: "Ask what needs me",
      detail: "Bud reads Desk and Schedule without changing them.",
      action: {
        kind: "ask",
        prompt: "What needs my attention next on Desk and Schedule? Name the spine pages if useful. Separate verified facts from missing evidence. Answer in ordinary prose. Do not run a routine or change the book.",
      },
    });
  }

  return suggestions
    .filter((suggestion) => !isAskSuggestionSpent(suggestion, extras.userTexts ?? []))
    .slice(0, 3);
}

export interface RoutineReminder {
  runId: string;
  kind: "failed" | "held";
}

/** OS reminders are deliberately narrow and privacy-preserving. The caller
 * sends only this closed kind and opaque run id to Electron; no property,
 * tenant, balance or model-written detail reaches the lock screen. */
export function deriveRoutineReminders(
  runs: readonly LoopRun[],
  desk: DeskSnapshot | null,
): RoutineReminder[] {
  const heldRunIds = new Set(
    (desk?.workItems ?? [])
      .filter((item) => item.state === "held" && item.origin?.runId)
      .map((item) => item.origin!.runId),
  );
  const reminders: RoutineReminder[] = [];
  const seen = new Set<string>();

  for (const run of [...runs].sort((a, b) => b.scheduledFor - a.scheduledFor)) {
    if (seen.has(run.id) || run.seenAt || run.notifiedAt) continue;
    const failed = ["failed", "missed", "interrupted"].includes(run.status);
    const held = heldRunIds.has(run.id) && run.status === "completed";
    if (!failed && !held) continue;
    seen.add(run.id);
    reminders.push({ runId: run.id, kind: failed ? "failed" : "held" });
    if (reminders.length === 3) break;
  }

  return reminders;
}

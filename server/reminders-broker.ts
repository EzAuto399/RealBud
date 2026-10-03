// Bud's `set_reminder`: a private, one-off reminder on the member's own Desk,
// created through `reminders.createFromBud` for the current member and thread.
// No card: it sends nothing and changes no shared record. RealBud's clock only
// marks it due; nothing starts or sends on its own (owner decision
// 2026-10-02-bud-office-pa-access). Mounted per ACP session as a loopback MCP server.
import { instantFromWall, reminderNote, reminderTitle, validTimeZone } from "../shared/reminders.ts";
import { startLoopbackToolServer, toolError, type LoopbackToolServer } from "./web-research-broker.ts";

export const REMINDERS_SERVER = "reminders";
export const MAX_REMINDERS_PER_TURN = 10;

/** The current turn's reminder capability, bound by the host to one member and thread. */
export interface BudReminders {
  create(input: { title: string; note?: string; dueAt: number }): Promise<{ id: string; dueAt: number }>;
  /** The office time zone saved in Agency setup, or null when none is saved. */
  timeZone(): Promise<string | null>;
}
export interface ReminderReceipt { tool: "set_reminder"; outcome: "succeeded" | "failed" | "refused"; reminderId?: string }

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

/** An ISO date-time; without an offset it is read as office wall time. */
export function reminderInstant(value: unknown, timeZone: string | null): number | null {
  const match = typeof value === "string" ? ISO.exec(value.trim()) : null;
  if (!match) return null;
  const [, y, mo, d, h, mi, s, offset] = match;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || Number(s ?? 0) > 59) return null;
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
  const at = offset ? Date.parse(value as string) : instantFromWall(timeZone, year, month, day, hour, minute);
  return Number.isFinite(at) ? Math.floor(at) : null;
}

export function formatReminderTime(at: number, timeZone: string | null): string {
  const text = new Intl.DateTimeFormat("en-AU", { ...(timeZone ? { timeZone } : {}), weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
  return timeZone ? `${text} (${timeZone})` : `${text} (this computer's time; no office time zone is saved)`;
}

export async function startRemindersBroker(options: {
  /** The current turn's id while it may still act, else null. */
  turnId(): string | null;
  /** The current turn's reminders, else undefined. */
  reminders(): BudReminders | undefined;
  now?: () => number;
  maxPerTurn?: number;
  receipt?: (receipt: ReminderReceipt) => void;
}): Promise<LoopbackToolServer> {
  const now = options.now ?? Date.now, max = options.maxPerTurn ?? MAX_REMINDERS_PER_TURN;
  let counted: { turn: string; count: number } | null = null;
  const note = (receipt: ReminderReceipt) => { try { options.receipt?.(receipt); } catch { /* receipts never change the outcome */ } };
  return startLoopbackToolServer({
    name: REMINDERS_SERVER,
    serverName: "Bud reminders",
    tools: [{
      name: "set_reminder",
      description: "Set a private one-off reminder for the person on their RealBud Desk. It only reminds them when due; nothing is sent or started. dueAt is ISO 8601; without an offset it is read as the office's local time. At most 10 per request.",
      inputSchema: { type: "object", additionalProperties: false, required: ["title", "dueAt"], properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        note: { type: "string", maxLength: 1000 },
        dueAt: { type: "string", maxLength: 40, description: "e.g. 2026-10-03T09:00 (office time) or 2026-10-03T09:00:00+10:00" },
      } },
    }],
    isActive: () => options.turnId() !== null && options.reminders() !== undefined,
    async call(_name, args, _signal) {
      const turn = options.turnId(), reminders = options.reminders();
      if (!turn || !reminders) return toolError("Bud is no longer working on this request. Nothing new was started.");
      if (Object.keys(args).some(key => !["title", "note", "dueAt"].includes(key))) return toolError("set_reminder takes title, an optional note and dueAt.");
      let title: string, text: string;
      try { title = reminderTitle(args.title); text = reminderNote(args.note); }
      catch (error) { return toolError(error instanceof Error ? error.message : "Check the reminder details."); }
      let zone: string | null;
      try { const value = await reminders.timeZone(); zone = validTimeZone(value) ? value : null; } catch { zone = null; }
      const dueAt = reminderInstant(args.dueAt, zone);
      if (dueAt === null) return toolError("Give dueAt as an ISO 8601 date and time, for example 2026-10-03T09:00 (office time) or 2026-10-03T09:00:00+10:00.");
      if (dueAt <= now()) return toolError("That time has already passed. Choose a later time for the reminder.");
      if (counted?.turn !== turn) counted = { turn, count: 0 };
      if (counted.count >= max) { note({ tool: "set_reminder", outcome: "refused" }); return toolError(`Bud has set ${max} reminders in this request. Ask the person before adding more.`); }
      counted.count++;
      try {
        const created = await reminders.create({ title, ...(text ? { note: text } : {}), dueAt });
        note({ tool: "set_reminder", outcome: "succeeded", reminderId: created.id });
        return {
          content: [{ type: "text", text: `Reminder set on the person's Desk: ${JSON.stringify(title)}, due ${formatReminderTime(created.dueAt, zone)}. Reminder id: ${created.id}.` }],
          structuredContent: { reminderId: created.id, dueAt: new Date(created.dueAt).toISOString(), timeZone: zone },
        };
      } catch (error) {
        note({ tool: "set_reminder", outcome: "failed" });
        const known = error instanceof Error && typeof (error as { code?: unknown }).code === "string";
        return toolError(known ? (error as Error).message : "The reminder could not be saved. Nothing was created.");
      }
    },
  });
}

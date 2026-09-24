import { readFileSync, statSync } from "node:fs";
import type { LoopRun } from "../shared/contracts.ts";
import { MANUAL_JOB_REQUEST_ID } from "../shared/manual-job-request.ts";

export interface LoopsFile {
  version: 3;
  timezone: string;
  state: Record<string, { enabled: boolean; handledThrough: number; schedule?: { time: string; weekdays: number[]; timezone?: string }; revision?: number }>;
  runs: LoopRun[];
}

export function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && /^[\w-]+$/.test(value);
const statuses = new Set(["queued", "running", "completed", "partial", "awaiting-approval", "failed", "missed", "interrupted"]);
function invalid(): never { throw new Error("Invalid saved schedule"); }

/** Existing files are never treated as first-run data unless absent. Version
 * 1 is the historical timezone-less format; versions 2/3 require a real zone. */
export function readLoopsFile(file: string, fallbackTimezone: string): LoopsFile {
  if (statSync(file).size > 8 * 1024 * 1024) invalid();
  return parseLoopsFile(JSON.parse(readFileSync(file, "utf8")), fallbackTimezone);
}

export function parseLoopsFile(raw: unknown, fallbackTimezone: string): LoopsFile {
  if (!record(raw) || ![1, 2, 3].includes(Number(raw.version)) || typeof raw.version !== "number" || !record(raw.state) || !Array.isArray(raw.runs)) invalid();
  const timezone = raw.version === 1 && raw.timezone === undefined ? fallbackTimezone : raw.timezone;
  if (!validTimezone(timezone) || Object.keys(raw.state).length > 5_000 || raw.runs.length > 10_000) invalid();
  const state: LoopsFile["state"] = {};
  for (const [id, value] of Object.entries(raw.state)) {
    if (!identifier(id) || !record(value) || typeof value.enabled !== "boolean" || !timestamp(value.handledThrough)) invalid();
    if (value.revision !== undefined && !positiveInteger(value.revision)) invalid();
    let schedule: { time: string; weekdays: number[]; timezone?: string } | undefined;
    if (value.schedule !== undefined) {
      const clock = value.schedule;
      if (!record(clock) || typeof clock.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock.time) ||
        !Array.isArray(clock.weekdays) || !clock.weekdays.length || clock.weekdays.length > 7 ||
        clock.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) invalid();
      if (clock.timezone !== undefined && !validTimezone(clock.timezone)) invalid();
      schedule = { time: clock.time, weekdays: [...new Set(clock.weekdays as number[])].sort((a, b) => a - b), ...(typeof clock.timezone === 'string' ? { timezone: clock.timezone } : {}) };
    }
    state[id] = { enabled: value.enabled, handledThrough: value.handledThrough, ...(schedule ? { schedule } : {}), ...(value.revision === undefined ? {} : { revision: Number(value.revision) }) };
  }
  const ids = new Set<string>();
  const requests = new Set<string>();
  const runs = raw.runs.map((row: unknown): LoopRun => {
    if (!record(row) || !identifier(row.id) || ids.has(row.id) || !identifier(row.loopId) ||
      typeof row.loopName !== "string" || row.loopName.length > 500 || !timestamp(row.scheduledFor) ||
      !timestamp(row.createdAt) || typeof row.status !== "string" || !statuses.has(row.status) || typeof row.manual !== "boolean") invalid();
    for (const field of ["startedAt", "finishedAt", "seenAt"]) if (row[field] !== undefined && !timestamp(row[field])) invalid();
    if (row.detail !== undefined && (typeof row.detail !== "string" || row.detail.length > 20_000)) invalid();
    if (row.jobRunId !== undefined && !identifier(row.jobRunId)) invalid();
    if (row.loopRevision !== undefined && !positiveInteger(row.loopRevision)) invalid();
    if (row.requestId !== undefined) {
      if (!row.manual || typeof row.requestId !== "string" || !MANUAL_JOB_REQUEST_ID.test(row.requestId) || !positiveInteger(row.loopRevision)) invalid();
      const requestId = row.requestId.toLowerCase();
      if (requests.has(requestId)) invalid();
      requests.add(requestId);
      row.requestId = requestId;
    }
    ids.add(row.id);
    return { ...row } as unknown as LoopRun;
  });
  return { version: 3, timezone, state, runs };
}

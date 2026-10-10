// Scheduled REI sign-in waits (owner decision, 6 October 2026): a loop run of
// the W1 bank import or the Supplier list check that finds REI Cloud signed
// out keeps REI's sign-in page open in the work browser until the end of the
// office day (18:00 office time), says so once in Schedule (which notifies),
// reminds once at midday, and saves the wait so a service restart reopens the
// page and keeps waiting with the same deadline. Nothing here touches the
// browser or a grant: the caller's sign-in handover and account check do.
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { isActive, serializeFile, W1StateStore } from "./w1-state.ts";

export type ReiWaitLoop = "bank-references" | "rei-supplier-check";
const LOOPS: readonly ReiWaitLoop[] = ["bank-references", "rei-supplier-check"];
export const OFFICE_DAY_END = "18:00";
export const MIDDAY_REMINDER = "12:00";
/** A wait that starts near or after the end of the office day still lasts this long (the attended handover's limit). */
const MIN_WAIT_MS = 15 * 60_000;

export interface ReiSignInWait { loop: ReiWaitLoop; runId: string; startedAt: number; until: number; reminderAt: number; reminded: boolean }
export interface ReiWaitCopy { first: string; reminder: string }

/** Today's HH:MM in the office timezone, as epoch ms.
 * ponytail: assumes no DST change between now and then; changes fall at 02:00–03:00 and waits start from the morning run. */
export function officeTimeToday(now: number, timeZone: string | undefined, hhmm: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  const [hour, minute] = hhmm.split(":").map(Number);
  return now - (now % 1000) + ((hour * 60 + minute) * 60 - (get("hour") * 3600 + get("minute") * 60 + get("second"))) * 1000;
}
/** "6:00 pm on Tue 6 Oct" in the office timezone. Dated, so each day's wait is a new notice and a restart's is not. */
export const officeClock = (at: number, timeZone: string | undefined) =>
  `${new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit" }).format(at)} on ${new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(at)}`;

/** A wait starting now: until the office day's end (never under 15 minutes), reminding at midday unless that has
 * passed (then `reminderAt` is the deadline, so it never reminds). `reminded` is true only once a reminder was said. */
export function newReiWait(loop: ReiWaitLoop, runId: string, now: number, timeZone: string | undefined): ReiSignInWait {
  const until = Math.max(officeTimeToday(now, timeZone, OFFICE_DAY_END), now + MIN_WAIT_MS), midday = officeTimeToday(now, timeZone, MIDDAY_REMINDER);
  return { loop, runId, startedAt: now, until, reminderAt: midday > now ? midday : until, reminded: false };
}

const keys = (v: unknown, expected: string): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === expected;
const time = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const validWait = (w: unknown): w is ReiSignInWait => keys(w, "loop,reminded,reminderAt,runId,startedAt,until") && (LOOPS as readonly unknown[]).includes(w.loop) &&
  typeof w.runId === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(w.runId) && time(w.startedAt) && time(w.until) && time(w.reminderAt) && typeof w.reminded === "boolean";
type WaitFile = { version: 1; kind: "rei-sign-in-waits"; waits: ReiSignInWait[] };

/** Private 0600 JSON beside the W1 runs. A damaged file holds every scheduled wait and is never cleared. */
export function reiSignInWaits(dataDir: string) {
  const path = join(dataDir, "w1", "sign-in-waits.json");
  const read = async (): Promise<WaitFile> => {
    const value = await readPrivateJson(path);
    if (value === undefined) return { version: 1, kind: "rei-sign-in-waits", waits: [] };
    if (!keys(value, "kind,version,waits") || value.version !== 1 || value.kind !== "rei-sign-in-waits" || !Array.isArray(value.waits) || !value.waits.every(validWait))
      throw Object.assign(new Error("The saved REI sign-in wait needs recovery. Nothing was changed."), { status: 503 });
    return value as unknown as WaitFile;
  };
  const change = (edit: (waits: ReiSignInWait[]) => ReiSignInWait[]) => serializeFile(path, async () => { const file = await read(); await writePrivateJson(path, { ...file, waits: edit(file.waits) }); });
  return {
    list: async () => (await serializeFile(path, read)).waits,
    put: (wait: ReiSignInWait) => change(waits => [...waits.filter(item => item.loop !== wait.loop), { ...wait }]),
    drop: (loop: ReiWaitLoop, runId: string) => change(waits => waits.filter(item => !(item.loop === loop && item.runId === runId))),
  };
}
export type ReiSignInWaits = ReturnType<typeof reiSignInWaits>;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); });

/** One scheduled wait around `work` (the sign-in handover and the account check after it). The same loop and run
 * pick up their saved wait while it is inside its deadline (after a restart); otherwise a new one is saved. The
 * saved wait is dropped when `work` ends, however it ends; a crash or restart keeps it. Its lines are notes that
 * wait on the person (`waiting`); `work` calls `signedIn` once the person has signed in, which ends the reminders
 * and says the run works again. */
export async function withReiSignInWait<T>(input: {
  waits: ReiSignInWaits; loop: ReiWaitLoop; runId: string; now: () => number; timeZone: string | undefined;
  note?: (detail: string, waiting?: boolean) => void; copy: (until: string) => ReiWaitCopy; pollMs?: number;
  work: (until: number, signedIn: (detail: string) => void) => Promise<T>;
}): Promise<T> {
  const started = input.now();
  const saved = (await input.waits.list()).find(item => item.loop === input.loop && item.runId === input.runId && item.until > started);
  const wait = saved ?? newReiWait(input.loop, input.runId, started, input.timeZone);
  if (!saved) await input.waits.put(wait);
  const copy = input.copy(officeClock(wait.until, input.timeZone));
  input.note?.(wait.reminded ? copy.reminder : copy.first, true);
  let ended = false;
  void (async () => {
    while (!ended && !wait.reminded && input.now() < wait.until) {
      if (input.now() >= wait.reminderAt) {
        wait.reminded = true;
        await input.waits.put(wait).catch(() => {});
        if (!ended) input.note?.(copy.reminder, true);
        return;
      }
      await sleep(input.pollMs ?? 30_000);
    }
  })();
  const signedIn = (detail: string) => { if (!ended) { ended = true; input.note?.(detail); } };
  try { return await input.work(wait.until, signedIn); }
  finally { ended = true; await input.waits.drop(input.loop, input.runId).catch(() => {}); }
}

/** Startup: the loops whose saved wait is still inside its deadline; a W1 wait only while its run still waits at REI
 * sign-in. Every other saved wait is dropped (its run already shows how it ended). */
export async function resumableReiWaits(dataDir: string, now: number): Promise<ReiWaitLoop[]> {
  const waits = reiSignInWaits(dataDir), runs = new W1StateStore(dataDir), live: ReiWaitLoop[] = [];
  for (const wait of await waits.list()) {
    const atSignIn = wait.loop !== "bank-references" || await runs.get(wait.runId).then(run => isActive(run) && run.step === "sign_in", () => false);
    if (wait.until > now && atSignIn) live.push(wait.loop);
    else await waits.drop(wait.loop, wait.runId);
  }
  return live;
}

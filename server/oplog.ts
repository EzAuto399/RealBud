// One durable operational trail. Without it, a routine that fails at 7:30 while
// nobody is watching leaves nothing to read in the morning — the run detail in
// loops.json is capped at 500 characters and says nothing about the process.
// Lines are JSON so they can be grepped; secrets are masked on the way out.
import { appendFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { createEmptyFileSync, mkdirPrivateSync, restrictNewSync } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";

/** Rotate at 1 MB, keep one previous file. A desk log is for the last few
 * mornings, not forever. */
const MAX_BYTES = 1_000_000;

export type OpEvent = "boot" | "shutdown" | "routine" | "crash" | "rejection" | "seat";

let logPath: string | null = null;

/** Tests point this at a temp dir. */
export function setOpLogPath(path: string): void {
  logPath = path;
}

/** Null under vitest until a test chooses a path, so a suite run never appends
 * to the developer's own book directory. */
function resolvePath(): string | null {
  if (logPath) return logPath;
  if (process.env.VITEST) return null;
  return join(DATA_DIR, "realbud.log");
}

export function opLogPath(): string | null {
  return resolvePath();
}

/** Paths whose first creation Windows refused to protect: never retried in
 * this process, so a broken ACL helper cannot cost a launch per log line. */
const refused = new Set<string>();

/** A log file this process creates (first run, or after a rotation) gets its
 * own protected Windows descriptor before the first line; appends to an
 * existing file never launch anything. */
function ensureLogFile(path: string): void {
  if (refused.has(path)) throw new Error("The operational log is not private.");
  try {
    mkdirPrivateSync(dirname(path));
    if (createEmptyFileSync(path)) restrictNewSync([{ path, kind: "file" }]);
  } catch (error) {
    if ((error as Error | null)?.name === "WindowsFilePrivacyError") refused.add(path);
    throw error;
  }
}

function rotateIfFull(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    /* no file yet, or the rotate lost a race — either way keep appending */
  }
}

export function oplog(event: OpEvent, detail: string, extra?: Record<string, unknown>): void {
  const line = redactSecretsInText(
    JSON.stringify({ at: new Date().toISOString(), event, detail: String(detail).slice(0, 2000), ...extra }),
  );
  const path = resolvePath();
  try {
    if (path) {
      rotateIfFull(path);
      ensureLogFile(path);
      appendFileSync(path, `${line}\n`);
    }
  } catch {
    /* the log must never be the reason the desk stops working */
  }
  // Packaged builds pipe the server's stderr into the app log, so a crash is
  // visible there too without the user finding the data dir.
  if (event === "crash" || event === "rejection") process.stderr.write(`${line}\n`);
}

/** The process must survive a stray async throw. Electron forks this server as
 * a utility process and does not respawn it, so exiting turns one unhandled
 * rejection into a dead app with no way back except quit-and-reopen. The book
 * on disk is written atomically and re-read on boot, so staying up is the
 * safer trade for a single-user desktop desk. */
export function installCrashHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    oplog("rejection", reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
  });
  process.on("uncaughtException", (error) => {
    oplog("crash", error instanceof Error ? (error.stack ?? error.message) : String(error));
  });
}

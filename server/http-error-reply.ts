// The one place a thrown error becomes an HTTP reply body.
//
// A full disk is not damage: the saved files are intact and the same request
// succeeds once space is freed, so every ENOSPC/EDQUOT (raw, or already wrapped
// by a store as `disk_full` / `storage-full`) answers one clear 507. A raw
// system error carries the file path it failed on; that path never leaves the
// process.
import { isDiskFull } from "./private-json.ts";

export const OUT_OF_SPACE_MESSAGE = "Your computer is out of disk space. Free some space; nothing was lost.";
const STORAGE_FAILURE_MESSAGE = "RealBud could not use its saved files. Existing files are preserved; try again.";

export function errorReply(error: unknown): { status: number; body: { error: string; code?: string } } {
  const fault = error as { status?: unknown; code?: unknown; syscall?: unknown } | null;
  const code = typeof fault?.code === "string" ? fault.code : undefined;
  if (isDiskFull(error) || code === "disk_full" || code === "storage-full") {
    return { status: 507, body: { error: OUT_OF_SPACE_MESSAGE, code: code === "storage-full" ? code : "disk_full" } };
  }
  if (typeof fault?.syscall === "string") return { status: 500, body: { error: STORAGE_FAILURE_MESSAGE, code: "storage_unavailable" } };
  const status = typeof fault?.status === "number" ? fault.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  return { status, body: code ? { error: message, code } : { error: message } };
}

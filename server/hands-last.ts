// Last worker ping or Recheck. Desk and You read the same file so the
// GUI and the worker stay on one clock.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export interface HandsLast {
  at: number;
  ok: boolean;
  detail: string;
  kind: "ping" | "recheck";
  workerFingerprint?: string;
}

export function handsLastPath(dir: string): string {
  return join(dir, "hands-last.json");
}

export function readHandsLast(dir: string): HandsLast | null {
  try {
    const raw = JSON.parse(readFileSync(handsLastPath(dir), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.at !== "number" || typeof rec.ok !== "boolean" || typeof rec.detail !== "string") return null;
    if (rec.kind !== "ping" && rec.kind !== "recheck") return null;
    return {
      at: rec.at,
      ok: rec.ok,
      detail: rec.detail,
      kind: rec.kind,
      ...(typeof rec.workerFingerprint === "string" ? { workerFingerprint: rec.workerFingerprint } : {}),
    };
  } catch {
    return null;
  }
}

export function writeHandsLast(dir: string, record: HandsLast): void {
  writeFileAtomic(handsLastPath(dir), JSON.stringify(record));
}

/** Last Test-hands ping only. Recheck overwrites hands-last.json and must not
 * clear a successful ping used for `ready`. */
export function handsPingPath(dir: string): string {
  return join(dir, "hands-ping.json");
}

export function readHandsPing(dir: string): HandsLast | null {
  try {
    const raw = JSON.parse(readFileSync(handsPingPath(dir), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.at !== "number" || typeof rec.ok !== "boolean" || typeof rec.detail !== "string") return null;
    if (rec.kind !== "ping") return null;
    return {
      at: rec.at,
      ok: rec.ok,
      detail: rec.detail,
      kind: "ping",
      ...(typeof rec.workerFingerprint === "string" ? { workerFingerprint: rec.workerFingerprint } : {}),
    };
  } catch {
    return null;
  }
}

export function writeHandsPing(dir: string, record: HandsLast): void {
  // Remember a pass before a setup change overwrites it with a failing receipt.
  if (record.ok || readHandsPing(dir)?.ok) markBudReadyOnce(dir);
  writeFileAtomic(handsPingPath(dir), JSON.stringify({ ...record, kind: "ping" }));
}

/** Bud passed its readiness check on this computer at least once. Survives the
 * failing receipt every reinstall or repair writes, so only a first setup is
 * treated as one. A computer set up before this marker existed counts through
 * a passing ping or Desk Recheck receipt. */
export function budReadyOncePath(dir: string): string {
  return join(dir, "hands-ready-once.json");
}

export function budReadyOnce(dir: string): boolean {
  return existsSync(budReadyOncePath(dir)) || readHandsPing(dir)?.ok === true || readHandsLast(dir)?.ok === true;
}

function markBudReadyOnce(dir: string): void {
  if (!existsSync(budReadyOncePath(dir))) writeFileAtomic(budReadyOncePath(dir), JSON.stringify({ at: Date.now() }));
}

// Quiet book restore: when the current key still opens a quarantined desk.json,
// put it back without asking the PM to paste a recovery key.
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import { decryptJson } from "./desk-crypto.ts";

export function listDeskQuarantines(deskFile: string): string[] {
  const dir = dirname(deskFile);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("desk.json.quarantine-"))
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path))
    .sort()
    .reverse();
}

/** Newest quarantine the key can decrypt, or null. */
export function findRestorableQuarantine(key: Buffer, deskFile: string, extra: string[] = []): string | null {
  const seen = new Set<string>();
  for (const candidate of [...extra, ...listDeskQuarantines(deskFile)]) {
    if (seen.has(candidate) || !existsSync(candidate)) continue;
    seen.add(candidate);
    try {
      const envelope = JSON.parse(readFileSync(candidate, "utf8"));
      decryptJson(key, envelope);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Rename a verified quarantine back to desk.json. Caller must have decrypted it. */
export function restoreQuarantineToDesk(candidate: string, deskFile: string): void {
  if (existsSync(deskFile)) {
    renameSync(deskFile, `${deskFile}.replaced-${Date.now()}`);
  }
  renameSync(candidate, deskFile);
}

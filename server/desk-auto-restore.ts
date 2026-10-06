// Quiet book restore: when the current key still opens a quarantined desk.json,
// put it back without asking the PM to paste a recovery key. When no quarantine
// opens, fall back to the newest rotating backup in desk-backups/ that does.
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

import { readPrivateFileSync, writeFileAtomic } from "./atomic.ts";
import { decryptJson } from "./desk-crypto.ts";

/** Exact rotating-backup name; anything else in desk-backups/ is left alone. */
export const DESK_BACKUP_NAME = /^desk-(\d+)\.json$/;

export function deskBackupDir(deskFile: string): string {
  return join(dirname(deskFile), "desk-backups");
}

/** Plain backup files (never links), newest revision first by number. */
export function listDeskBackups(backupDir: string): { path: string; revision: number }[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .flatMap((name) => {
      const match = DESK_BACKUP_NAME.exec(name);
      if (!match) return [];
      const path = join(backupDir, name);
      try {
        return lstatSync(path).isFile() ? [{ path, revision: Number(match[1]) }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.revision - a.revision);
}

/** Newest backup the key can decrypt, or null. Damaged ones are skipped and kept. */
export function findRestorableBackup(key: Buffer, deskFile: string): string | null {
  for (const { path } of listDeskBackups(deskBackupDir(deskFile))) {
    try {
      const text = readPrivateFileSync(path);
      if (text === null) continue;
      decryptJson(key, JSON.parse(text));
      return path;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Copy a verified backup to desk.json; the backup stays as evidence and any
 * current desk.json is set aside, never cleared. Caller must have decrypted it. */
export function restoreBackupToDesk(candidate: string, deskFile: string): void {
  const text = readPrivateFileSync(candidate);
  if (text === null) throw new Error("backup disappeared before restore");
  if (existsSync(deskFile)) renameSync(deskFile, `${deskFile}.replaced-${Date.now()}`);
  writeFileAtomic(deskFile, text, 0o600);
}

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

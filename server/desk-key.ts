// Desk / artifact encryption key. Production Electron wraps this with
// safeStorage and passes the unwrapped key to the server child. Source
// runs generate a 0600 development key and stay labelled non-production.
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { assertOwnPrivate, fsyncDir, mkdirPrivateSync, openPrivateFileSync, restrictNewSync } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { windowsFilePrivacySync } from "./windows-file-privacy.ts";

const KEY_FILE = "desk.key";
const recovery = () => new Error("The saved workspace encryption key needs recovery. No replacement key was created.");

function savedKey(path: string): Buffer | null {
  let fd: number;
  try { fd = openPrivateFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw recovery(); }
  try {
    const stat = fstatSync(fd);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw recovery();
    if (stat.size !== 32 && stat.size !== 64) throw recovery();
    windowsFilePrivacySync(path, "file");
    const raw = readFileSync(fd);
    if (raw.length === 32) return raw;
    if (raw.length === 64 && /^[0-9a-fA-F]{64}$/.test(raw.toString("utf8"))) return Buffer.from(raw.toString("utf8"), "hex");
    throw recovery();
  } catch { throw recovery(); }
  finally { closeSync(fd); }
}

function hasSavedEncryptedState(dir: string): boolean {
  const names = readdirSync(dir);
  if (names.some(name => /^(desk\.json|desk\.key|workflow-state\.sqlite|private-workspace-restore)/.test(name))) return true;
  for (const name of ["artifacts", "desk-backups"]) {
    const savedDir = join(dir, name);
    try {
      assertOwnPrivate(lstatSync(savedDir), "directory");
      if (readdirSync(savedDir).length) return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw recovery(); }
  }
  const company = join(dir, "company-installation");
  try {
    assertOwnPrivate(lstatSync(company), "directory");
    const privateDir = join(company, "private");
    assertOwnPrivate(lstatSync(privateDir), "directory");
    return readdirSync(privateDir).length > 0;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw recovery(); }
}

export interface DeskKey {
  key: Buffer;
  source: "env" | "file" | "generated" | "inline";
  production: boolean;
}

export function loadDeskKey(opts?: { dir?: string; key?: Buffer }): DeskKey {
  if (opts?.key !== undefined) {
    if (!Buffer.isBuffer(opts.key) || opts.key.length !== 32) throw recovery();
    return { key: opts.key, source: "inline", production: process.env.REALBUD_PRODUCTION === "1" };
  }
  const hex = process.env.REALBUD_DESK_KEY;
  if (hex && !/^[0-9a-fA-F]{64}$/.test(hex)) throw recovery();
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    // Electron unwraps safeStorage and passes the key. Do not write desk.key.
    return { key: Buffer.from(hex, "hex"), source: "env", production: process.env.REALBUD_PRODUCTION === "1" };
  }
  const dir = opts?.dir ?? DATA_DIR;
  mkdirPrivateSync(dir, 0o700);
  try { assertOwnPrivate(lstatSync(dir), "directory"); } catch { throw recovery(); }
  const path = join(dir, KEY_FILE);
  const existing = savedKey(path);
  if (existing) return { key: existing, source: "file", production: process.env.REALBUD_PRODUCTION === "1" };
  if (hasSavedEncryptedState(dir)) throw recovery();
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw recovery();
    // Another start won creation. Never replace its key (including an
    // interrupted, empty file): a retry can load a completed key safely.
    const winner = savedKey(path);
    if (!winner) throw recovery();
    return { key: winner, source: "file", production: process.env.REALBUD_PRODUCTION === "1" };
  }
  try {
    restrictNewSync([{ path, kind: "file" }]);
    const key = randomBytes(32);
    writeFileSync(fd, key);
    fsyncSync(fd);
    if (process.platform !== "win32") fsyncDir(dir);
    return { key, source: "generated", production: false };
  } catch { throw recovery(); }
  finally { closeSync(fd); }
}

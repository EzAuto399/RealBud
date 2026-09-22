// Desk / artifact encryption key. Production Electron wraps this with
// safeStorage and passes the unwrapped key to the server child. Source
// runs generate a 0600 development key and stay labelled non-production.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { mkdirPrivateSync, writeFilePrivateSync } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const KEY_FILE = "desk.key";

export interface DeskKey {
  key: Buffer;
  source: "env" | "file" | "generated" | "inline";
  production: boolean;
}

export function loadDeskKey(opts?: { dir?: string; key?: Buffer }): DeskKey {
  if (opts?.key && opts.key.length === 32) {
    return { key: opts.key, source: "inline", production: process.env.REALBUD_PRODUCTION === "1" };
  }
  const hex = process.env.REALBUD_DESK_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    // Electron unwraps safeStorage and passes the key. Do not write desk.key.
    return { key: Buffer.from(hex, "hex"), source: "env", production: process.env.REALBUD_PRODUCTION === "1" };
  }
  const dir = opts?.dir ?? DATA_DIR;
  mkdirPrivateSync(dir);
  const path = join(dir, KEY_FILE);
  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length === 32) return { key: raw, source: "file", production: process.env.REALBUD_PRODUCTION === "1" };
    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw.toString("utf8").trim())) {
      return { key: Buffer.from(raw.toString("utf8").trim(), "hex"), source: "file", production: process.env.REALBUD_PRODUCTION === "1" };
    }
  }
  const key = randomBytes(32);
  // A new key file is restricted on Windows before the key is written.
  writeFilePrivateSync(path, key, 0o600);
  return { key, source: "generated", production: false };
}

export function isNonProductionKey(info: DeskKey): boolean {
  return !info.production;
}

// Desk / artifact encryption key. Production Electron wraps this with
// safeStorage and passes the unwrapped key to the server child. Source
// runs generate a 0600 development key and stay labelled non-production.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { DATA_DIR } from "./config.ts";

const KEY_FILE = "desk.key";

export interface DeskKey {
  key: Buffer;
  source: "env" | "file" | "generated" | "inline";
  production: boolean;
}

export function loadDeskKey(opts?: { dir?: string; key?: Buffer }): DeskKey {
  const production = process.env.REALBUD_PRODUCTION === "1";
  if (opts?.key && opts.key.length === 32) {
    return { key: opts.key, source: "inline", production };
  }
  const hex = process.env.REALBUD_DESK_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    return { key: Buffer.from(hex, "hex"), source: "env", production };
  }
  if (production) throw new Error("production desk key is unavailable");
  const dir = opts?.dir ?? DATA_DIR;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, KEY_FILE);
  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length === 32) return { key: raw, source: "file", production };
    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw.toString("utf8").trim())) {
      return { key: Buffer.from(raw.toString("utf8").trim(), "hex"), source: "file", production };
    }
  }
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return { key, source: "generated", production: false };
}

export function isNonProductionKey(info: DeskKey): boolean {
  return !info.production;
}

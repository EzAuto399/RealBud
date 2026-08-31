import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileFsynced } from "./atomic.ts";

export const ASK_ATTACH_MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXT = /\.(pdf|png|jpe?g|gif|webp|txt|csv|json|md)$/i;

export function isAskAttachName(name: string): boolean {
  return ALLOWED_EXT.test(name.trim());
}

export function safeAskAttachName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() || "file";
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 80);
  return isAskAttachName(cleaned) ? cleaned : `${cleaned}.txt`;
}

export function saveAskAttachment(
  dataDir: string,
  input: { name?: string; contentBase64?: string; size?: number },
): { path: string; name: string; size: number } {
  const original = String(input.name ?? "").split(/[/\\]/).pop()?.trim() || "";
  if (!isAskAttachName(original)) {
    throw Object.assign(new Error("that file type cannot be attached"), { status: 400 });
  }
  const name = safeAskAttachName(original);
  const raw = String(input.contentBase64 ?? "").replace(/\s+/g, "");
  if (!raw) throw Object.assign(new Error("file content required"), { status: 400 });
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64");
  } catch {
    throw Object.assign(new Error("file content was not readable"), { status: 400 });
  }
  if (!bytes.length) throw Object.assign(new Error("file content required"), { status: 400 });
  if (bytes.length > ASK_ATTACH_MAX_BYTES) {
    throw Object.assign(new Error("that file is too large (8 MB)"), { status: 413 });
  }
  if (typeof input.size === "number" && input.size > 0 && Math.abs(input.size - bytes.length) > 4) {
    throw Object.assign(new Error("file size did not match the upload"), { status: 400 });
  }
  const dir = join(dataDir, "ask-uploads");
  mkdirSync(dir, { recursive: true });
  const stored = `${Date.now()}-${randomBytes(4).toString("hex")}-${name}`;
  const path = join(dir, stored);
  writeFileFsynced(path, bytes);
  return { path, name, size: bytes.length };
}

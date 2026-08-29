import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { DATA_DIR } from "./config.ts";
import {
  MAX_TURN_ATTACHMENT_BYTES,
  isAllowedTurnAttachmentName,
  mimeTypeForPath,
} from "./turn-attachments.ts";

const INBOX_TTL_MS = 24 * 60 * 60 * 1000;

export function composerInboxRoot(root?: string): string {
  return join(root ?? DATA_DIR, "workspaces", "composer-inbox");
}

function inboxError(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function safeInboxName(name: string): string {
  const base = basename(name)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .trim();
  const extension = extname(base).slice(0, 20);
  const stem = (extension ? base.slice(0, -extension.length) : base).slice(0, 90).trim() || "selected-file";
  return `${stem}${extension}`;
}

function sweepInbox(directory: string, now = Date.now()): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const stamp = Number.parseInt(entry.name.slice(0, 13), 10);
    if (!Number.isFinite(stamp) || now - stamp < INBOX_TTL_MS) continue;
    try {
      unlinkSync(join(directory, entry.name));
    } catch {
      // A locked file stays until the next sweep.
    }
  }
}

/** Write one PM-selected file into a private inbox. Never scans the device. */
export async function stageComposerInboxFile(input: {
  filename: string;
  body: Readable;
  maxBytes?: number;
  root?: string;
  now?: number;
}): Promise<{ path: string; name: string; size: number; mimeType: string }> {
  const rawName = input.filename.trim();
  if (!rawName || rawName.length > 200 || /[\\/]/.test(rawName)) {
    throw inboxError("that file name is not usable");
  }
  if (!isAllowedTurnAttachmentName(rawName)) {
    throw inboxError("RealBud can review a PDF, image, spreadsheet or text export. That type stays out.");
  }

  const maxBytes = input.maxBytes ?? MAX_TURN_ATTACHMENT_BYTES;
  const directory = composerInboxRoot(input.root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  sweepInbox(directory, input.now);

  const safe = safeInboxName(rawName);
  const dest = join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
  let size = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(inboxError(`each attached file must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(input.body, limit, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    try {
      unlinkSync(dest);
    } catch {
      // Partial file is best-effort cleanup.
    }
    throw error;
  }

  if (size < 1) {
    try {
      unlinkSync(dest);
    } catch {
      // empty
    }
    throw inboxError("that file was empty");
  }

  return {
    path: dest,
    name: safe,
    size,
    mimeType: mimeTypeForPath(dest),
  };
}

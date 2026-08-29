import { realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";

import type { TurnAttachment } from "./contracts.ts";

export const MAX_TURN_ATTACHMENTS = 10;
export const MAX_TURN_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

export function mimeTypeForPath(filePath: string): string {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function isAllowedTurnAttachmentName(name: string): boolean {
  return Object.hasOwn(MIME_BY_EXTENSION, extname(name).toLowerCase());
}

/** Resolve only paths the renderer supplied through the structured file
 * field. Size/name from the renderer are deliberately ignored. */
export function decodeTurnAttachments(value: unknown): TurnAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badRequest("attachments must be an array");
  if (value.length > MAX_TURN_ATTACHMENTS) {
    throw badRequest(`attach no more than ${MAX_TURN_ATTACHMENTS} files at once`);
  }

  const seen = new Set<string>();
  const attachments: TurnAttachment[] = [];
  for (const raw of value) {
    const suppliedPath =
      raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).path === "string"
        ? (raw as Record<string, unknown>).path as string
        : "";
    if (!suppliedPath || !isAbsolute(suppliedPath)) throw badRequest("each attachment needs an absolute file path");

    let filePath: string;
    let stat: ReturnType<typeof statSync>;
    try {
      filePath = realpathSync(suppliedPath);
      stat = statSync(filePath);
    } catch {
      throw badRequest("an attached file is no longer available");
    }
    if (!stat.isFile()) throw badRequest("attachments must be regular files");
    if (stat.size > MAX_TURN_ATTACHMENT_BYTES) {
      throw badRequest(`each attached file must be ${MAX_TURN_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller`);
    }
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    attachments.push({
      path: filePath,
      name: basename(filePath),
      size: stat.size,
      mimeType: mimeTypeForPath(filePath),
    });
  }
  return attachments;
}

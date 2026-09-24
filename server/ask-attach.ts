import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ASK_ATTACH_MAX_BYTES, isAskAttachName, safeAskAttachName } from "../shared/ask-attachments.ts";
import { windowsFilePrivacySync } from "./windows-file-privacy.ts";
export { ASK_ATTACH_MAX_BYTES, isAskAttachName, safeAskAttachName } from "../shared/ask-attachments.ts";

const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };

function privateDirectory(path: string, requirePrivate = true): void {
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" &&
    ((requirePrivate && (info.mode & 0o077) !== 0) || info.uid !== process.getuid?.()))) {
    fail("The private attachment folder needs service attention. The original file is unchanged.", 409);
  }
  try {
    // Mode bits do not protect Windows files. Restrict only a directory we
    // created, while still empty; legacy objects must pass verify-only.
    windowsFilePrivacySync(resolve(path), "directory", created);
  } catch {
    if (created) {
      try { rmdirSync(path); } catch { /* never remove a nonempty directory */ }
    }
    fail("The private attachment folder needs service attention. The original file is unchanged.", 409);
  }
}

/** Copies only the explicitly selected bytes into this desktop's workroom.
 * Never accepts a source path or grants access to the source's parent folder.
 * Existing attachment paths are retained; new copies are local to the vault.
 */
export function saveAskAttachment(dataDir: string, input: unknown): { path: string; name: string; size: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("Check the selected file and try again.");
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => !["name", "contentBase64", "size"].includes(key)) ||
    typeof data.name !== "string" || data.name.length > 1024 || typeof data.contentBase64 !== "string") {
    return fail("Check the selected file and try again.");
  }
  const original = data.name.split(/[/\\]/).pop()?.trim() || "";
  if (!isAskAttachName(original)) return fail("that file type cannot be attached");
  const name = safeAskAttachName(original);
  const raw = data.contentBase64;
  if (raw.length > Math.ceil(ASK_ATTACH_MAX_BYTES / 3) * 4) return fail("that file is too large (8 MB)", 413);
  // Buffer.from silently discards invalid base64. Require canonical bytes so
  // truncation and malformed data cannot masquerade as a successful upload.
  const bytes = Buffer.from(raw, "base64");
  if (bytes.toString("base64") !== raw) return fail("file content was not readable");
  if (bytes.length > ASK_ATTACH_MAX_BYTES) return fail("that file is too large (8 MB)", 413);
  if (data.size !== undefined && (!Number.isSafeInteger(data.size) || data.size !== bytes.length)) return fail("file size did not match the upload");
  // Older installations created the application root with mode 755. The
  // selected bytes are protected by the private vault below it; do not make
  // those existing installations fail on their first attachment.
  privateDirectory(dataDir, false);
  const root = realpathSync(dataDir);
  const workroom = join(root, "vault");
  privateDirectory(workroom);
  const dir = join(workroom, "ask-uploads");
  privateDirectory(dir);
  if (realpathSync(dir) !== dir) return fail("The private attachment folder needs service attention.", 409);
  const path = join(dir, `${randomUUID()}-${name}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  let saved = false;
  try {
    // The exclusive file is still empty. A refused Windows descriptor must
    // stop the copy before any selected bytes reach disk.
    windowsFilePrivacySync(path, "file", true);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    saved = true;
  } catch {
    // Report a safe error after closing and cleaning the incomplete copy.
  } finally {
    closeSync(fd);
    if (!saved) {
      // This is a new unique upload owned by this call, never an original file.
      // Close first so Windows can remove an incomplete copy too.
      try { unlinkSync(path); } catch { /* preserve original failure */ }
    }
  }
  if (!saved) return fail("The file copy could not be saved. The original file is unchanged.", 503);
  return { path, name, size: bytes.length };
}

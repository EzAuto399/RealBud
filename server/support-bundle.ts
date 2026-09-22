// Help and support: one plain-text report a person can attach to a message.
//
// It carries only what support needs to see why the office misbehaved: the
// version, the system type, how long the office service has run, and the newest
// lines of RealBud's own logs. Nothing here opens the book, the vault, mail or
// any business record. Every line passes the same redactor as everything else
// RealBud persists or shows, and the whole report is capped.
//
// The desktop app's own log (server.log, in the OS log directory) is written by
// the Electron main process, which cannot run this TypeScript redactor. Main
// therefore posts its log tail here and saves what comes back, so both logs are
// masked by one implementation.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { release } from "node:os";

import { appVersion } from "./app-version.ts";
import { opLogPath } from "./oplog.ts";
import { redactSecretsInText } from "./redact.ts";

export const SUPPORT_BUNDLE_MAX_BYTES = 512 * 1024;
/** Raw bytes taken from the end of each log before masking. */
export const SUPPORT_LOG_TAIL_BYTES = 200 * 1024;
/** Masked bytes kept per log section; a mask can be longer than what it hides. */
const SECTION_MAX_BYTES = 248 * 1024;
/** Longer lines are cut: the redactor's cost grows with line length. */
const LINE_MAX_CHARS = 4_000;
const CAP_NOTE = "\n[This support file reached its 512 KB limit here.]\n";
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;

export interface SupportBundleInput {
  /** realbud.log; defaults to the office service's own operational log. */
  logPath?: string | null;
  /** The desktop app's log tail, supplied by the Electron main process. */
  desktopLog?: string;
  now?: Date;
  uptimeSeconds?: number;
}

const invalid = () => Object.assign(new Error("Check the support file request."), { status: 400 });

/** The only body the desktop app may send: its own log tail as text. */
export function supportBundleRequest(body: unknown): { desktopLog?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  if (Object.keys(body).some((key) => key !== "desktopLog")) throw invalid();
  const { desktopLog } = body as { desktopLog?: unknown };
  if (desktopLog === undefined) return {};
  if (typeof desktopLog !== "string") throw invalid();
  return { desktopLog };
}

export async function buildSupportBundle(input: SupportBundleInput = {}): Promise<string> {
  const now = input.now ?? new Date();
  const runtime = process.versions.electron
    ? `Node ${process.versions.node} (Electron ${process.versions.electron})`
    : `Node ${process.versions.node}`;
  const header = [
    "RealBud support file",
    `Created: ${now.toISOString()}`,
    `RealBud version: ${appVersion()}`,
    `System: ${process.platform} ${process.arch} ${release()}`,
    `Runtime: ${runtime}`,
    `Office service running for: ${duration(input.uptimeSeconds ?? process.uptime())}`,
    "",
    "Contains: RealBud's version, this computer's system type, how long the office service has run, and the newest lines of RealBud's own logs. Keys and passwords are masked. Documents, mail, saved credentials and business records are never read for this file.",
  ];
  const sections = [
    section("Office service log (realbud.log)", await officeLog(input.logPath === undefined ? opLogPath() : input.logPath)),
  ];
  if (input.desktopLog !== undefined) {
    sections.push(section("Desktop app log (server.log)", { text: tailOfText(input.desktopLog, SUPPORT_LOG_TAIL_BYTES) }));
  }
  return capped([...header.map(redactSecretsInText), "", ...sections].join("\n"));
}

type LogRead = { text: string; note?: string };
type Tail = { kind: "missing" } | { kind: "refused" } | { kind: "read"; text: string; bytes: number; whole: boolean };

/** The current log plus, when it is short, the newest part of the rotated one. */
async function officeLog(path: string | null): Promise<LogRead> {
  if (!path) return { text: "", note: "This run keeps no office log." };
  const current = await readTail(path, SUPPORT_LOG_TAIL_BYTES);
  if (current.kind === "missing") return { text: "", note: "No office log has been written yet." };
  if (current.kind === "refused") return { text: "", note: "The office log was left out: it is not a plain log file RealBud can read." };
  const remaining = SUPPORT_LOG_TAIL_BYTES - current.bytes;
  const previous = current.whole && remaining > 0 ? await readTail(`${path}.1`, remaining) : { kind: "missing" as const };
  return { text: previous.kind === "read" ? previous.text + current.text : current.text };
}

/** Reads a regular, single-link file only; a link could point anywhere. */
async function readTail(path: string, maxBytes: number): Promise<Tail> {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "refused" }; }
  if (!stat.isFile() || stat.nlink !== 1) return { kind: "refused" };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const size = (await handle.stat()).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return { kind: "read", text: length < size ? afterFirstLine(text) : text, bytes: length, whole: length === size };
  } catch {
    return { kind: "refused" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** A tail that starts mid-line may start mid-secret, where no pattern can
 * recognise it any more, so the partial first line is always dropped. */
function afterFirstLine(text: string): string {
  const cut = text.indexOf("\n");
  return cut === -1 ? "" : text.slice(cut + 1);
}

function tailOfText(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : afterFirstLine(bytes.subarray(bytes.length - maxBytes).toString("utf8"));
}

function section(title: string, log: LogRead): string {
  const lines = maskLines(log.text);
  const kept = newest(lines, SECTION_MAX_BYTES);
  return [
    `== ${title} ==`,
    ...(log.note ? [log.note] : []),
    ...(kept.dropped ? [`[${kept.dropped} older lines were left out to keep this file small.]`] : []),
    ...kept.lines,
    "",
  ].join("\n");
}

/** Every line passes the redactor. Private key blocks span lines, so their
 * bodies are hidden here until the closing marker; an unclosed block hides
 * the rest of the section rather than guess where the key ends. */
function maskLines(text: string): string[] {
  const out: string[] = [];
  let hidden = -1;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const line = cutLine(raw);
    if (hidden >= 0) {
      if (PEM_END.test(line)) { out.push(`«redacted private key, ${hidden + 1} lines»`); hidden = -1; } else hidden++;
      continue;
    }
    let begin: RegExpExecArray | null = null;
    for (const match of line.matchAll(PEM_BEGIN)) begin = match;
    if (begin && !PEM_END.test(line.slice(begin.index))) {
      out.push(`${redactSecretsInText(line.slice(0, begin.index))}${begin[0]}`);
      hidden = 0;
      continue;
    }
    out.push(redactSecretsInText(line));
  }
  if (hidden >= 0) out.push(`«redacted private key, ${hidden} lines»`);
  return out;
}

/** A cut must not leave the first half of a secret behind, so the trailing
 * token is dropped with it. */
function cutLine(line: string): string {
  if (line.length <= LINE_MAX_CHARS) return line;
  return `${line.slice(0, LINE_MAX_CHARS).replace(/[A-Za-z0-9._~+/=-]+$/, "")} [line cut]`;
}

function newest(lines: string[], maxBytes: number): { lines: string[]; dropped: number } {
  let bytes = 0;
  let start = lines.length;
  while (start > 0) {
    const size = Buffer.byteLength(lines[start - 1]!, "utf8") + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    start--;
  }
  return { lines: lines.slice(start), dropped: start };
}

/** Section budgets keep a report well under the cap; this is the backstop. */
function capped(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= SUPPORT_BUNDLE_MAX_BYTES) return text;
  const room = SUPPORT_BUNDLE_MAX_BYTES - Buffer.byteLength(CAP_NOTE, "utf8");
  const head = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  const cut = head.lastIndexOf("\n");
  return `${cut > 0 ? head.slice(0, cut) : ""}${CAP_NOTE}`;
}

function duration(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return [days ? `${days} d` : "", hours ? `${hours} h` : "", `${minutes % 60} min`].filter(Boolean).join(" ");
}

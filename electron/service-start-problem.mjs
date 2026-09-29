// Startup failures whose cause is known and which no automatic retry will fix.
// The generic "Waiting for the office service" page promises a recovery the log
// has already ruled out, so these get a page naming the cause and the one thing
// to do. Pure apart from reading the tail of our own service output file, so it
// is testable without Electron. Output text is only classified, never shown: it
// can contain anything the service printed.
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/** @typedef {"disk-full" | "no-access" | "ports-taken"} StartProblem */

const DISK_FULL_CODES = new Set(["ENOSPC", "EDQUOT", "storage-full"]);
const NO_ACCESS_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

/** Classify an error thrown while starting the service. Unknown → null. */
export function classifyStartError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (DISK_FULL_CODES.has(code)) return "disk-full";
  if (NO_ACCESS_CODES.has(code)) return "no-access";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return classifyServiceOutput(message);
}

const START_MARKER = "office service starting";

/** Classify what the service printed in its most recent start. Unknown → null. */
export function classifyServiceOutput(text) {
  const all = String(text ?? "");
  const at = all.lastIndexOf(START_MARKER);
  const latest = at === -1 ? all : all.slice(at);
  if (/\bstorage-full\b|\bENOSPC\b|\bEDQUOT\b|out of space|no space left on device/i.test(latest)) return "disk-full";
  if (/\bEACCES\b|\bEPERM\b|\bEROFS\b|permission denied|read-only file system/i.test(latest)) return "no-access";
  return null;
}

/** Last `bytes` of office-service/stdout-stderr.log, or "" when it cannot be read. */
export function readServiceOutputTail(logDirectory, bytes = 16 * 1024) {
  let fd = null;
  try {
    const file = join(logDirectory, "office-service", "stdout-stderr.log");
    if (!lstatSync(file).isFile()) return "";
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(fd, buffer, 0, length, size - length)).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Title and paragraphs for a known cause. */
export function startProblemCopy(problem, { dataDirectory, ports, platform = process.platform }) {
  const computer = platform === "darwin" ? "this Mac" : "this computer";
  if (problem === "disk-full") {
    return {
      title: `${platform === "darwin" ? "This Mac" : "This computer"} is out of space`,
      paragraphs: [
        "The office service cannot start because the disk is full. Nothing was lost; the last good book is kept.",
        "Free up some space, then reopen RealBud.",
      ],
    };
  }
  if (problem === "no-access") {
    return {
      title: "RealBud cannot use its data folder",
      paragraphs: [
        `The office service cannot start because this account is not allowed to write to ${dataDirectory}.`,
        "Give this account read and write access to that folder, or ask your administrator to, then reopen RealBud. Keep the files in it: they are what the office is restored from.",
      ],
    };
  }
  if (problem === "ports-taken") {
    return {
      title: "Another app is using RealBud’s connection",
      paragraphs: [
        `The office service needs one of these local ports on ${computer}, and all of them are in use: ${ports.join(", ")}.`,
        `Quit the app that is using them, or restart ${computer}, then reopen RealBud.`,
      ],
    };
  }
  return null;
}

/** A data: URL page for a known cause, styled like the other service pages. */
export function startProblemPage(problem, options) {
  const copy = startProblemCopy(problem, options);
  if (!copy) return null;
  const paragraphs = copy.paragraphs.map((text) => `<p style="color:#fcfcfc99;line-height:1.5">${escapeHtml(text)}</p>`).join("");
  return "data:text/html;charset=utf-8," + encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:420px;padding:0 16px"><div style="font-size:40px">🏠</div><h2 style="font-weight:600;margin:12px 0 6px">${escapeHtml(copy.title)}</h2>${paragraphs}</div></body>`,
  );
}

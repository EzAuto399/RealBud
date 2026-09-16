// Speech helper lifecycle, main-process side.
// macOS: Swift recognizer runs as RealBud Speech.app (LaunchServices + Info.plist).
// Windows: RealBud Speech.exe uses System.Speech with the same NDJSON contract.
// Compiled lazily in development on each platform; packaged builds ship the binary.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

import {
  buildSpeechHelper,
  speechHelperBinary,
  speechHelperBundle,
} from "./build-speech-helper.mjs";
import {
  buildWindowsSpeechHelper,
  windowsSpeechHelperExe,
} from "./build-speech-helper-win.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "resources", "speech-helper.swift");
const INFO = path.join(__dirname, "resources", "speech-helper-Info.plist");
const WIN_SRC = path.join(__dirname, "resources", "speech-helper-win.cs");

const macBundle = app.isPackaged
  ? path.join(process.resourcesPath, "RealBud Speech.app")
  : speechHelperBundle;
const macBin = app.isPackaged
  ? path.join(macBundle, "Contents", "MacOS", "speech-helper")
  : speechHelperBinary;
const winBin = app.isPackaged
  ? path.join(process.resourcesPath, "RealBud Speech.exe")
  : windowsSpeechHelperExe;

let child = null;

function speechSupported() {
  return process.platform === "darwin" || process.platform === "win32";
}

function ensureBuilt() {
  if (app.isPackaged) return;
  if (process.platform === "darwin") {
    const binaryMtime = existsSync(macBin) ? statSync(macBin).mtimeMs : 0;
    const stale = binaryMtime < Math.max(statSync(SRC).mtimeMs, statSync(INFO).mtimeMs);
    if (!stale) return;
    buildSpeechHelper();
    return;
  }
  if (process.platform === "win32") {
    const binaryMtime = existsSync(winBin) ? statSync(winBin).mtimeMs : 0;
    const stale = !existsSync(winBin) || binaryMtime < statSync(WIN_SRC).mtimeMs;
    if (!stale) return;
    buildWindowsSpeechHelper();
  }
}

function sendEnd(win, info) {
  if (!win.isDestroyed()) win.webContents.send("speech:end", info);
}

function attachNdjsonSession(win, speechSession, { onChunk, watchPath = null, useStdout = false }) {
  let buf = "";
  let offset = 0;
  let reportedError = null;
  let completed = false;

  const consume = (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.error === "string") reportedError = parsed.error;
        if (parsed.partial === false && typeof parsed.text === "string") completed = true;
        if (child === speechSession && !win.isDestroyed()) {
          win.webContents.send("speech:transcript", parsed);
        }
        onChunk?.(parsed);
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  };

  const drainFile = () => {
    if (!watchPath) return;
    let content;
    try {
      content = readFileSync(watchPath, "utf8");
    } catch {
      return;
    }
    if (content.length <= offset) return;
    const slice = content.slice(offset);
    offset = content.length;
    consume(slice);
  };

  if (watchPath) watchFile(watchPath, { interval: 50, persistent: false }, drainFile);
  if (useStdout && speechSession.proc.stdout) {
    speechSession.proc.stdout.setEncoding("utf8");
    speechSession.proc.stdout.on("data", (chunk) => consume(chunk));
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (watchPath) unwatchFile(watchPath, drainFile);
    rmSync(speechSession.sessionDir, { recursive: true, force: true });
  };

  speechSession.proc.on("close", (code) => {
    if (watchPath) drainFile();
    cleanup();
    // stopSpeech() clears child before creating the stop marker. Suppressing
    // that close event is essential in call mode: intentional TTS muting must
    // not look like the natural end of a spoken turn.
    if (child !== speechSession) return;
    child = null;
    if (reportedError) {
      sendEnd(win, { code: 1, reason: reportedError });
    } else if (completed && code === 0) {
      sendEnd(win, { code: 0, reason: "completed" });
    } else {
      sendEnd(win, { code: 1, reason: "helper-exited" });
    }
  });
  speechSession.proc.on("error", () => {
    cleanup();
    if (child !== speechSession) return;
    child = null;
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
  });
}

/**
 * Start one recognition session. `endpointMs` is call-mode-only: composer
 * dictation deliberately keeps listening until its mic button is pressed.
 */
export function startSpeech(win, options = {}) {
  stopSpeech();
  if (!speechSupported()) {
    sendEnd(win, { code: 2, reason: "unsupported-platform" });
    return;
  }
  const requested = Number(options?.endpointMs);
  const endpointMs = Number.isFinite(requested) && requested > 0
    ? Math.min(5_000, Math.max(250, Math.round(requested)))
    : 0;
  const args = endpointMs ? ["--endpoint-ms", String(endpointMs)] : [];

  try {
    ensureBuilt();
  } catch {
    sendEnd(win, { code: 1, reason: "helper-build-failed" });
    return;
  }

  const sessionDir = mkdtempSync(path.join(app.getPath("temp"), "realbud-speech-"));
  const stopPath = path.join(sessionDir, "stop");
  const finishPath = path.join(sessionDir, "finish");
  const helperArgs = [...args, "--stop-file", stopPath, "--finish-file", finishPath];

  if (process.platform === "win32") {
    if (!existsSync(winBin)) {
      rmSync(sessionDir, { recursive: true, force: true });
      sendEnd(win, { code: 1, reason: "helper-build-failed" });
      return;
    }
    let proc;
    try {
      proc = spawn(winBin, helperArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rmSync(sessionDir, { recursive: true, force: true });
      sendEnd(win, { code: 1, reason: "helper-start-failed" });
      return;
    }
    const speechSession = { proc, stopPath, finishPath, sessionDir };
    child = speechSession;
    attachNdjsonSession(win, speechSession, { useStdout: true });
    return;
  }

  // A direct spawn of Contents/MacOS/speech-helper loses the app-bundle
  // identity and TCC kills it for lacking a usage description. LaunchServices
  // preserves that identity. `open` redirects its stdout/stderr to files,
  // which we tail to retain the helper's NDJSON streaming contract.
  const outputPath = path.join(sessionDir, "stdout.ndjson");
  const errorPath = path.join(sessionDir, "stderr.log");
  writeFileSync(outputPath, "");
  writeFileSync(errorPath, "");

  let proc;
  try {
    proc = spawn(
      "/usr/bin/open",
      [
        "-n",
        "-g",
        "-W",
        "-o",
        outputPath,
        "--stderr",
        errorPath,
        macBundle,
        "--args",
        ...helperArgs,
      ],
      { stdio: "ignore" },
    );
  } catch {
    rmSync(sessionDir, { recursive: true, force: true });
    sendEnd(win, { code: 1, reason: "helper-start-failed" });
    return;
  }

  const speechSession = { proc, outputPath, errorPath, stopPath, finishPath, sessionDir };
  child = speechSession;
  attachNdjsonSession(win, speechSession, { watchPath: outputPath });
}

export function stopSpeech() {
  if (!child) return;
  const speechSession = child;
  child = null;
  try {
    writeFileSync(speechSession.stopPath, "stop");
  } catch {}
}

/** Finalize the active request and keep it owned until the recognizer emits
 * its final transcript. Used by push-to-talk key release. */
export function finishSpeech() {
  if (!child) return;
  try {
    writeFileSync(child.finishPath, "finish");
  } catch {}
}

export { speechSupported };

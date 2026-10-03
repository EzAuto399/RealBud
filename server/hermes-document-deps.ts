// Reviewed, hash-pinned libraries for Hermes' bundled xlsx, docx, pdf and powerpoint
// skills. They go only into a RealBud-owned runtime venv, installed by that
// venv's own Python from a verified pip wheel. Never the system pip or Python,
// never a personal Hermes, and never a lazy install: the profile keeps
// `allow_lazy_installs: false`. Readiness is always the live import check;
// nothing records "ready", so an interrupted install reads as needing Repair.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { sandboxedLaunch } from "./worker-network-sandbox.ts";
import { restrictNewSync } from "./atomic.ts";
import { augmentedPath } from "./env-path.ts";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";
import { windowsHermesRuntimeEnv } from "./hermes-runtime-env.ts";
import { readRuntimeSelection, releaseHome } from "./hermes-runtime-selection.ts";
import { execFileCli } from "./procs.ts";

export const DOCUMENT_TOOLS_NEED_REPAIR = "Document tools need Repair.";
export const DOCUMENT_TOOLS_READY = "Document tools are ready.";
export const DOCUMENT_TOOLS_UNSUPPORTED = "Document tools are not available on this computer yet.";
export class DocumentDepsError extends Error {}

export type LockedWheel = { filename: string; url: string; sha256: string; size: number; targets: string[] };
export type LockedPackage = { name: string; version: string; import: string; license: string; wheels: LockedWheel[] };
export type ProvidedPackage = { name: string; import: string; minimum: string; license: string };
export interface DocumentDepsLock {
  version: 1; purpose: "realbud-hermes-document-deps"; pythons: string[]; targets: string[];
  installer: { name: "pip"; version: string; license: string; wheel: LockedWheel };
  packages: LockedPackage[]; runtimeProvided: ProvidedPackage[];
}

const MAX_WHEEL_BYTES = 32 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_ATTEMPTS = 3;
const WHEEL_HOST = "files.pythonhosted.org";
const DOWNLOAD_FAILED = "Couldn’t download document tools. Check your connection, then choose Repair again.";
const MISMATCH = "A document tools download didn’t match the reviewed version. Nothing from it was installed.";

function assertWheel(wheel: LockedWheel): void {
  const url = new URL(wheel.url);
  if (url.protocol !== "https:" || url.hostname !== WHEEL_HOST || !url.pathname.endsWith(`/${wheel.filename}`) ||
    !/^[A-Za-z0-9_.+-]+\.whl$/.test(wheel.filename) || !/^[a-f0-9]{64}$/.test(wheel.sha256) ||
    !Number.isInteger(wheel.size) || wheel.size <= 0 || wheel.size > MAX_WHEEL_BYTES ||
    !Array.isArray(wheel.targets) || !wheel.targets.length) throw new Error();
}

/** Validates shape and provenance; a damaged lock never reaches pip. */
export function parseDocumentDepsLock(value: unknown): DocumentDepsLock {
  try {
    const lock = value as DocumentDepsLock;
    if (lock.version !== 1 || lock.purpose !== "realbud-hermes-document-deps" || lock.installer.name !== "pip") throw new Error();
    assertWheel(lock.installer.wheel);
    const token = /^[A-Za-z0-9][A-Za-z0-9._-]*$/, module = /^[A-Za-z_][A-Za-z0-9_.]*$/;
    for (const item of lock.packages) {
      if (!token.test(item.name) || !/^\d[0-9A-Za-z.+-]*$/.test(item.version) || !module.test(item.import) || !item.wheels.length) throw new Error();
      item.wheels.forEach(assertWheel);
    }
    for (const item of lock.runtimeProvided) if (!token.test(item.name) || !module.test(item.import) || !/^\d+(?:\.\d+)*$/.test(item.minimum)) throw new Error();
    return lock;
  } catch { throw new DocumentDepsError("The reviewed list of document tools could not be read. Reinstall RealBud."); }
}

let cachedLock: DocumentDepsLock | undefined;
export function documentDepsLock(): DocumentDepsLock {
  cachedLock ??= parseDocumentDepsLock(JSON.parse(readFileSync(new URL("./hermes-document-deps.lock.json", import.meta.url), "utf8")));
  return cachedLock;
}

export function runtimePython(runtimeHome: string, platform: NodeJS.Platform = process.platform): string {
  return join(runtimeHome, "hermes-agent", "venv", platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python");
}

/** The runtime Repair may add libraries to: RealBud's selected private
 * runtime, or its legacy owned one. A custom or personal Hermes is never
 * changed. */
export function ownedRuntimeHome(home = hermesHome()): string | null {
  if (process.env.REALBUD_HERMES_CLI?.trim()) return null;
  const selected = readRuntimeSelection(home).selected;
  if (selected) return releaseHome(home, selected);
  return existsSync(runtimeCli(home)) ? home : null;
}

export type PythonRun = (python: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; cwd: string; writable?: string[] }) => Promise<string>;

/** Scratch for RealBud's own helper runs: a host-private folder under the
 * data directory, which no worker may read or write, never the shared temp
 * folder (a worker that could replace the probe script would run as RealBud). */
export function hostScratch(prefix: string): string {
  const base = join(DATA_DIR, "host-scratch");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(base, prefix));
}

/** The runtime home a venv Python belongs to (`<home>/hermes-agent/venv/bin/python`). */
const runtimeHomeOf = (python: string) => dirname(dirname(dirname(dirname(python))));

/** The venv's Python under the worker sandbox: no network, writes only to
 * its scratch folder (and, for an install, the venv), reads of RealBud's
 * data only for its own runtime and scratch. A refusing sandbox fails the run. */
const runPython: PythonRun = (python, args, options) => new Promise((resolve, reject) => {
  const env = { ...options.env };
  let launch: ReturnType<typeof sandboxedLaunch>;
  try {
    launch = sandboxedLaunch(python, args, env, { loopbackPorts: [], writable: [options.cwd, ...(options.writable ?? [])],
      reads: [["deny", DATA_DIR], ["allow", runtimeHomeOf(python)], ["allow", options.cwd]] });
  } catch (error) { reject(error); return; }
  execFileCli(launch.command, launch.args, { env, cwd: options.cwd, timeout: options.timeoutMs, signal: options.signal, maxBuffer: 1024 * 1024, encoding: "utf8" },
    (error, stdout) => { launch.release(); error ? reject(error) : resolve(stdout); });
});

export interface DocumentDepsOptions {
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  /** Test seams. Production downloads with fetch and runs the venv's Python. */
  request?: typeof fetch;
  run?: PythonRun;
  lock?: DocumentDepsLock;
}

type Probe = {
  implementation: string; python: string; platform: string; machine: string; venv: boolean;
  packages: Record<string, { version: string | null; imports: boolean }>;
  provided: Record<string, { version: string | null; imports: boolean }>;
};

// Run from a private file with plain `name:module` arguments, so Windows argv
// quoting never carries code.
const PROBE = [
  "import importlib, importlib.metadata as m, json, platform, sys",
  "def check(items):",
  "    out = {}",
  "    for item in items:",
  "        name, module = item.split(':', 1)",
  "        try: version = m.version(name)",
  "        except Exception: version = None",
  "        try: importlib.import_module(module); ok = True",
  "        except Exception: ok = False",
  "        out[name] = {'version': version, 'imports': ok}",
  "    return out",
  "split = sys.argv.index('--provided')",
  "print(json.dumps({'implementation': sys.implementation.name, 'python': 'cp%d%d' % sys.version_info[:2], 'platform': sys.platform, 'machine': platform.machine(), 'venv': sys.prefix != sys.base_prefix, 'packages': check(sys.argv[1:split]), 'provided': check(sys.argv[split + 1:])}))",
].join("\n");

function childEnv(runtimeHome: string, scratch: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: augmentedPath(), HOME: scratch, PYTHONNOUSERSITE: "1",
    ...(platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: scratch, TMP: scratch, USERPROFILE: scratch } : { TMPDIR: scratch }),
  };
  return platform === "win32" ? windowsHermesRuntimeEnv(runtimeHome, env) : env;
}

async function probe(python: string, lock: DocumentDepsLock, run: PythonRun, env: NodeJS.ProcessEnv, scratch: string, signal?: AbortSignal): Promise<Probe> {
  let text: string;
  try {
    const script = join(scratch, "realbud_document_probe.py");
    if (!existsSync(script)) writeFileSync(script, PROBE, { mode: 0o600 });
    text = await run(python, ["-I", script, ...lock.packages.map(item => `${item.name}:${item.import}`), "--provided", ...lock.runtimeProvided.map(item => `${item.name}:${item.import}`)],
      { env, timeoutMs: PROBE_TIMEOUT_MS, signal, cwd: scratch });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DocumentDepsError("Bud’s runtime Python could not be checked. Choose Repair again; if this repeats, reinstall Bud.");
  }
  try {
    const value = JSON.parse(text.trim().split("\n").pop() ?? "") as Probe;
    if (typeof value.python !== "string" || typeof value.platform !== "string" || typeof value.machine !== "string" || !value.packages || !value.provided) throw new Error();
    return value;
  } catch { throw new DocumentDepsError("Bud’s runtime Python gave an unexpected answer. Choose Repair again; if this repeats, reinstall Bud."); }
}

const atLeast = (version: string | null, minimum: string) => {
  if (!version) return false;
  const have = (version.match(/^\d+(?:\.\d+)*/)?.[0] ?? "").split(".").map(Number), want = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(have.length, want.length); i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
};
const lockedReady = (state: Probe, lock: DocumentDepsLock) => lock.packages.every(item => state.packages[item.name]?.version === item.version && state.packages[item.name]?.imports);
const providedMissing = (state: Probe, lock: DocumentDepsLock) => lock.runtimeProvided.filter(item => !atLeast(state.provided[item.name]?.version ?? null, item.minimum) || !state.provided[item.name]?.imports);

/** `darwin-arm64-cp311`-style key from the interpreter's own view, or null. */
export function documentDepsTarget(state: Pick<Probe, "implementation" | "python" | "platform" | "machine">): string | null {
  if (state.implementation !== "cpython") return null;
  const machine = state.machine.toLowerCase();
  const arch = machine === "arm64" || machine === "aarch64" ? "arm64" : machine === "x86_64" || machine === "amd64" ? "x64" : null;
  const os = state.platform === "darwin" ? "darwin" : state.platform === "win32" ? "win32" : null;
  return os && arch ? `${os}-${arch}-${state.python}` : null;
}

export function selectDocumentWheels(lock: DocumentDepsLock, target: string): { name: string; version: string; wheel: LockedWheel }[] | null {
  const chosen = lock.packages.map(item => ({ name: item.name, version: item.version, wheel: item.wheels.find(wheel => wheel.targets.includes(target)) ?? item.wheels.find(wheel => wheel.targets.includes("any")) }));
  return chosen.every(item => item.wheel) ? chosen as { name: string; version: string; wheel: LockedWheel }[] : null;
}

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const stop = () => { clearTimeout(timer); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  signal?.addEventListener("abort", stop, { once: true });
});

class RetryableDownload extends DocumentDepsError {}

async function downloadOnce(wheel: LockedWheel, request: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try { response = await request(wheel.url, { signal: bounded, redirect: "error" }); }
  catch { if (signal?.aborted) signal.throwIfAborted(); throw new RetryableDownload(DOWNLOAD_FAILED); }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw [429, 500, 502, 503, 504].includes(response.status) ? new RetryableDownload(DOWNLOAD_FAILED) : new DocumentDepsError(DOWNLOAD_FAILED);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > wheel.size) throw new DocumentDepsError(MISMATCH);
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DocumentDepsError) throw error;
    if (signal?.aborted) signal.throwIfAborted();
    throw new RetryableDownload(DOWNLOAD_FAILED);
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== wheel.size || createHash("sha256").update(bytes).digest("hex") !== wheel.sha256) throw new DocumentDepsError(MISMATCH);
  return bytes;
}

async function download(wheel: LockedWheel, request: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try { return await downloadOnce(wheel, request, signal); }
    catch (error) {
      if (!(error instanceof RetryableDownload) || attempt >= DOWNLOAD_ATTEMPTS) throw error;
      await pause(2_000 * attempt, signal);
    }
  }
}

export type DocumentDepsResult =
  | { state: "ready"; installed: boolean; target: string }
  | { state: "unsupported"; detail: string };

const inFlight = new Map<string, Promise<DocumentDepsResult>>();

/** Installs the locked libraries into one RealBud-owned runtime venv, or
 * confirms they are already there. Throws DocumentDepsError on any failure. */
export function ensureDocumentDeps(runtimeHome: string, options: DocumentDepsOptions = {}): Promise<DocumentDepsResult> {
  if (process.env.VITEST && !options.run) return Promise.reject(new DocumentDepsError("Real installation is disabled in automated tests."));
  const python = runtimePython(runtimeHome, options.platform);
  const running = inFlight.get(python);
  if (running) return running;
  const job = installDocumentDeps(runtimeHome, python, options).finally(() => inFlight.delete(python));
  inFlight.set(python, job);
  return job;
}

async function installDocumentDeps(runtimeHome: string, python: string, options: DocumentDepsOptions): Promise<DocumentDepsResult> {
  const lock = options.lock ?? documentDepsLock();
  const run = options.run ?? runPython;
  const platform = options.platform ?? process.platform;
  const scratch = hostScratch("document-tools-");
  try {
    // Wheels wait here between verification and pip; keep the folder private.
    if (process.platform === "win32") {
      try { restrictNewSync([{ path: scratch, kind: "directory" }]); }
      catch { throw new DocumentDepsError("Bud could not prepare a private folder for document tools. Check folder permissions, then choose Repair again."); }
    }
    const env = childEnv(runtimeHome, scratch, platform);
    const before = await probe(python, lock, run, env, scratch, options.signal);
    if (!before.venv) throw new DocumentDepsError("Bud’s runtime is not a private environment, so document tools were not added. Reinstall Bud.");
    const target = documentDepsTarget(before);
    const wheels = target ? selectDocumentWheels(lock, target) : null;
    if (!target || !wheels) return { state: "unsupported", detail: DOCUMENT_TOOLS_UNSUPPORTED };
    if (providedMissing(before, lock).length) throw new DocumentDepsError("Bud’s runtime is missing parts document tools rely on. Reinstall Bud.");
    if (lockedReady(before, lock)) return { state: "ready", installed: false, target };

    // Every byte is verified before pip sees any of it.
    const wheelDir = join(scratch, "wheels");
    const request = options.request ?? fetch;
    const files: { filename: string; bytes: Buffer }[] = [];
    for (const wheel of [lock.installer.wheel, ...wheels.map(item => item.wheel)]) {
      options.signal?.throwIfAborted();
      files.push({ filename: wheel.filename, bytes: await download(wheel, request, options.signal) });
    }
    mkdirSync(wheelDir, { mode: 0o700 });
    for (const file of files) writeFileSync(join(wheelDir, file.filename), file.bytes, { mode: 0o600, flag: "wx" });
    const requirements = join(scratch, "requirements.txt");
    writeFileSync(requirements, wheels.map(item => `${item.name}==${item.version} --hash=sha256:${item.wheel.sha256}\n`).join(""), { mode: 0o600, flag: "wx" });

    options.signal?.throwIfAborted();
    try {
      await run(python, ["-I", join(wheelDir, lock.installer.wheel.filename, "pip"), "install", "--isolated", "--no-index", "--no-deps", "--require-hashes",
        "--only-binary=:all:", "--no-cache-dir", "--disable-pip-version-check", "--no-input", "--no-warn-script-location", "--quiet",
        "--find-links", wheelDir, "-r", requirements], { env, timeoutMs: INSTALL_TIMEOUT_MS, signal: options.signal, cwd: scratch, writable: [join(runtimeHome, "hermes-agent", "venv")] });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new DocumentDepsError("Document tools could not be installed. Check available space, then choose Repair again.");
    }
    const after = await probe(python, lock, run, env, scratch, options.signal);
    if (!lockedReady(after, lock)) throw new DocumentDepsError("Document tools did not finish installing. Choose Repair again.");
    return { state: "ready", installed: true, target };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export type DocumentToolsStatus = { ready: boolean; detail: string };

/** Readiness only: never installs and never throws. */
export async function documentToolsStatus(runtimeHome: string, options: Pick<DocumentDepsOptions, "platform" | "run" | "lock" | "signal"> = {}): Promise<DocumentToolsStatus> {
  if (process.env.VITEST && !options.run) return { ready: false, detail: DOCUMENT_TOOLS_NEED_REPAIR };
  const platform = options.platform ?? process.platform;
  const scratch = hostScratch("document-check-");
  try {
    const lock = options.lock ?? documentDepsLock();
    const state = await probe(runtimePython(runtimeHome, platform), lock, options.run ?? runPython, childEnv(runtimeHome, scratch, platform), scratch, options.signal);
    const target = documentDepsTarget(state);
    if (!target || !selectDocumentWheels(lock, target)) return { ready: false, detail: DOCUMENT_TOOLS_UNSUPPORTED };
    return lockedReady(state, lock) && !providedMissing(state, lock).length ? { ready: true, detail: DOCUMENT_TOOLS_READY } : { ready: false, detail: DOCUMENT_TOOLS_NEED_REPAIR };
  } catch { return { ready: false, detail: DOCUMENT_TOOLS_NEED_REPAIR }; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Repair's step: null when the owned runtime has its document tools (or
 * there is no owned runtime to change), otherwise one sentence to show. */
export async function repairDocumentDeps(root?: string, ensure: typeof ensureDocumentDeps = ensureDocumentDeps): Promise<string | null> {
  let runtime: string | null;
  try { runtime = ownedRuntimeHome(hermesHome(root)); } catch { return DOCUMENT_TOOLS_NEED_REPAIR; }
  if (!runtime) return null;
  try {
    const result = await ensure(runtime);
    return result.state === "ready" ? null : result.detail;
  } catch (error) {
    return error instanceof DocumentDepsError ? `${DOCUMENT_TOOLS_NEED_REPAIR} ${error.message}` : DOCUMENT_TOOLS_NEED_REPAIR;
  }
}

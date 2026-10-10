// Host-side transport for the same pinned agent-browser engine Hermes uses.
// This is deliberately not a worker tool or a connection endpoint. The host
// supplies its owned browser endpoint; every user action still needs the
// existing BrowserBroker's grant, current account and approval checks.
import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { privateDirectory, writePrivateJson } from "./private-json.ts";

export const HERMES_BROWSER_ENGINE_VERSION = "0.26.0";
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const failed = (message: string) => new Error(message);
export type HermesEngineState = "new" | "active" | "stopping" | "released" | "recovery_required";
export type HermesEngineStep =
  | { kind: "tabs" }
  /** `scroll`: a lazy grid's own scroll container, declared by a workflow pack (never a model); the read scrolls it until every row has loaded. */
  | { kind: "read"; tab: number; scroll?: string }
  | { kind: "navigate"; tab: number; url: string }
  | { kind: "click"; tab: number; ref: string }
  | { kind: "fill"; tab: number; ref: string; value: string }
  | { kind: "press"; tab: number; ref: string; key: string }
  | { kind: "select"; tab: number; ref: string; values: string[] }
  | { kind: "download" | "upload"; tab: number; ref: string; path: string };
export interface HermesEngineBundle { executable: string; sha256: string }
export type HermesEngineExec = (executable: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; signal?: AbortSignal }) => Promise<Json>;

/** Null when the path (or a folder on it) is absent; every other error is rethrown unchanged. */
const unlessMissing = <T>(pending: Promise<T>): Promise<T | null> => pending.catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return null;
  throw error;
});
/** JSON.parse never yields undefined, so undefined marks a damaged manifest. */
const parsed = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
/** Admit an exact build-staged binary. Never PATH, npx, floating downloads or
 * a binary whose bytes changed since its packaging manifest was written. */
export async function admitHermesEngine(folder: string): Promise<HermesEngineBundle> {
  const manifestFile = join(folder, "runtime.json");
  // A missing, quarantined or unreadable-as-JSON bundle needs repair; it is not a
  // saved-files problem. Any other I/O error (EACCES, EIO...) still surfaces as one.
  const stat = await unlessMissing(lstat(manifestFile));
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw failed("The work browser bundle needs repair.");
  const text = await unlessMissing(readFile(manifestFile, "utf8"));
  const raw = text === null ? undefined : parsed(text);
  if (raw === undefined) throw failed("The work browser bundle needs repair.");
  if (!record(raw) || raw.engine !== "hermes-agent-browser" || raw.version !== HERMES_BROWSER_ENGINE_VERSION || raw.platform !== process.platform || raw.arch !== process.arch || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw failed("The work browser bundle is not compatible with this build.");
  const executable = join(folder, process.platform === "win32" ? "agent-browser.exe" : "agent-browser");
  const mismatch = "The work browser executable does not match its reviewed bundle.";
  const binary = await unlessMissing(lstat(executable));
  if (!binary?.isFile() || binary.isSymbolicLink() || binary.nlink !== 1 || binary.size > 100_000_000) throw failed(mismatch);
  const bytes = await unlessMissing(readFile(executable));
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== raw.sha256) throw failed(mismatch);
  return { executable, sha256: raw.sha256 };
}

export function ownedBrowserEndpoint(value: string): string {
  const at = new URL(value);
  if (!["http:", "ws:"].includes(at.protocol) || !["127.0.0.1", "[::1]"].includes(at.hostname) || !at.port || at.username || at.password || at.search || at.hash ||
    (at.protocol === "http:" ? at.pathname !== "/" : !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(at.pathname))) throw failed("Choose the work browser opened by this installation.");
  return at.href;
}

const execute: HermesEngineExec = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, args, { ...options, windowsHide: true, timeout: 45_000, maxBuffer: 1_000_000 }, (error, stdout) => {
    // Never propagate CLI diagnostics or page values into status errors.
    if (error) return reject(failed("The work browser did not confirm this step. Its result may be unknown."));
    try {
      const result: unknown = JSON.parse(stdout);
      if (!record(result) || result.success !== true || !record(result.data)) throw failed("invalid");
      resolve(result.data);
    } catch { reject(failed("The work browser did not return a confirmed result.")); }
  });
});

/** A pack-declared CSS selector for a grid's scroll container. Never starts with "-", so it cannot pass as a CLI flag. */
export const GRID_SCROLL = /^[.#a-zA-Z][.#a-zA-Z0-9_\- >]{0,99}$/;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Rows in an accessibility snapshot: the engine's `- row` lines, or a VOM `row` line. */
export const snapshotRows = (text: string) => text.split("\n").filter(line => /^\s*(?:- )?row\b/.test(line)).length;
/** Loads a lazy grid (read-only): scroll its own container, wait, read again, until the row count stops growing.
 * Returns the last read. The grid is not virtual, so earlier rows stay rendered. `scroll` answers false when the
 * page has no such container: scrolling ends and the page is read as it stands (a short read is the caller's to judge). */
export async function readLazyGrid<T>(scroll: () => Promise<boolean>, read: () => Promise<T>, rows: (result: T) => number, waitMs = 800, rounds = 15): Promise<T> {
  let last = -1;
  for (let round = 1; ; round++) {
    const moved = await scroll();
    if (moved) await sleep(waitMs);
    const result = await read(), count = rows(result);
    if (!moved || count <= last || round >= rounds) return result;
    last = count;
  }
}

const keys: Record<HermesEngineStep["kind"], readonly string[]> = { tabs: ["kind"], read: ["kind", "tab"], navigate: ["kind", "tab", "url"], click: ["kind", "tab", "ref"], fill: ["kind", "tab", "ref", "value"], press: ["kind", "tab", "ref", "key"], select: ["kind", "tab", "ref", "values"], download: ['kind', 'tab', 'ref', 'path'], upload: ['kind', 'tab', 'ref', 'path'] };
function checkedStep(raw: HermesEngineStep): HermesEngineStep {
  if (!record(raw) || typeof raw.kind !== "string" || !Object.hasOwn(keys, raw.kind)) throw failed("This browser operation is unavailable.");
  const expected = keys[raw.kind as HermesEngineStep["kind"]];
  const allowed = raw.kind === "read" ? [...expected, "scroll"] : expected;
  if (expected.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => !allowed.includes(key))) throw failed("This browser operation has unexpected fields.");
  if (raw.kind === "read" && "scroll" in raw && (typeof raw.scroll !== "string" || !GRID_SCROLL.test(raw.scroll))) throw failed("This list cannot be scrolled safely.");
  if (raw.kind !== "tabs" && (!Number.isSafeInteger(raw.tab) || Number(raw.tab) < 1)) throw failed("Choose a current browser tab.");
  if ("ref" in raw && (typeof raw.ref !== "string" || !/^@e[1-9]\d*$/.test(raw.ref))) throw failed("Use a fresh observed browser control.");
  if (raw.kind === "navigate") {
    const url = new URL(raw.url);
    if (url.protocol !== "https:" || url.username || url.password) throw failed("Use an authorised HTTPS website.");
  }
  if (raw.kind === "fill" && (typeof raw.value !== "string" || raw.value.length > 2000 || raw.value.startsWith("-"))) throw failed("This value cannot be passed safely to the work browser.");
  if (raw.kind === "press" && (typeof raw.key !== "string" || !/^(?:(?:Control|Alt|Shift|Meta)\+)*(?:Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Backspace|Delete|Space|[a-zA-Z0-9])$/.test(raw.key))) throw failed("Use one supported browser key.");
  if (raw.kind === "select" && (!Array.isArray(raw.values) || raw.values.length < 1 || raw.values.length > 20 || raw.values.some(value => typeof value !== "string" || value.length > 200 || value.startsWith("-")))) throw failed("Choose observed dropdown options.");
  // This path is supplied only by the host's hash-bound task-file broker.
  // The worker's tool accepts a granted file name, never a filesystem path.
  if ((raw.kind === 'download' || raw.kind === 'upload') && (typeof raw.path !== 'string' || raw.path.length > 4096 ||
      !isAbsolute(raw.path) || (process.platform === 'win32' && !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(raw.path)) ||
      /[\u0000-\u001f\u007f]/.test(raw.path) || raw.path.split(/[\\/]/).includes('..'))) throw failed('Use a file staged by this browser task.');
  return structuredClone(raw);
}

/** One task's controller. Stop revokes synchronously, waits for any already
 * dispatched native command, and detaches before it reports release. A timeout
 * or unconfirmed detach holds recovery; it never silently reopens the lease.
 * The visible browser is externally owned, so native `close` disconnects it
 * rather than closing the person's window. Do not use a profile/auto-connect
 * flag here, or allow the engine to launch a second browser behind the host. */
export class HermesBrowserTransport {
  readonly session = `realbud-${randomUUID()}`;
  private phase: HermesEngineState = "new";
  private serial: Promise<unknown> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private attempted = false;
  private endpoint: string;
  private env: NodeJS.ProcessEnv = {};
  private run: HermesEngineExec;
  private options: { root: string; bundle: HermesEngineBundle; endpoint: string; exec?: HermesEngineExec; scrollWaitMs?: number };
  constructor(options: { root: string; bundle: HermesEngineBundle; endpoint: string; exec?: HermesEngineExec; scrollWaitMs?: number }) {
    this.options = { ...options, bundle: { ...options.bundle } };
    this.endpoint = ownedBrowserEndpoint(options.endpoint);
    this.run = options.exec ?? execute;
  }
  get state(): HermesEngineState { return this.phase; }
  private async command(args: string[]): Promise<Json> {
    return this.run(this.options.bundle.executable, ["--session", this.session, "--config", join(this.options.root, "engine.json"), "--cdp", this.endpoint, ...args, "--json"], { env: this.env, cwd: this.options.root });
  }
  async start(): Promise<void> {
    if (this.phase !== "new") throw failed("This browser controller cannot be started again.");
    // Claim startup before crossing storage/process boundaries. A concurrent
    // Stop can revoke it while startup is still preparing the engine.
    this.phase = "active";
    const opening = (async () => {
      await privateDirectory(this.options.root);
      const home = join(this.options.root, "home"); await privateDirectory(home);
      await writePrivateJson(join(this.options.root, "engine.json"), {});
      this.env = { HOME: home, USERPROFILE: home, AGENT_BROWSER_SOCKET_DIR: this.options.root,
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000", AGENT_BROWSER_NO_AUTO_DIALOG: "1" };
      for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) this.env[key] = process.env[key];
      if (this.phase !== "active") return;
      this.attempted = true;
      await this.command(["tab", "list"]);
    })();
    this.serial = opening.catch(() => {});
    try { await opening; if (this.phase !== "active") throw failed("The browser request stopped during startup."); }
    catch (error) { if (this.phase === "active") this.phase = "recovery_required"; throw error; }
  }
  step(raw: HermesEngineStep, signal?: AbortSignal): Promise<Json> {
    let step: HermesEngineStep;
    try { step = checkedStep(raw); } catch (error) { return Promise.reject(error); }
    if (this.phase !== "active" || signal?.aborted) return Promise.reject(failed("This browser controller is stopped."));
    const cancelled = () => { void this.stop().catch(() => {}); };
    signal?.addEventListener("abort", cancelled, { once: true });
    const action = this.serial.then(async () => {
      if (this.phase !== "active" || signal?.aborted) throw failed("This browser controller is stopped.");
      const listed = await this.command(["tab", "list"]);
      if (this.phase !== "active" || signal?.aborted) throw failed("This browser controller is stopped.");
      if (step.kind === "tabs") return listed;
      // A native tab switch clears the reference map, even if selecting the
      // same tab. Never switch between observing a control and acting on it.
      // Inspect native active state first; a ref cannot cross a tab boundary.
      if (!Array.isArray(listed.tabs) || !listed.tabs.some(tab => record(tab) && tab.tabId === `t${step.tab}`)) throw failed("The selected browser tab is unavailable. Read the work browser again.");
      const active = listed.tabs.filter(tab => record(tab) && tab.active === true);
      if (active.length !== 1) throw failed("The work browser did not confirm its active tab.");
      if (active[0].tabId !== `t${step.tab}`) {
        if ("ref" in step) throw failed("The active browser tab changed. Read the selected tab again before using a control.");
        await this.command(["tab", `t${step.tab}`]);
        if (this.phase !== "active" || signal?.aborted) throw failed("This browser controller is stopped.");
      }
      const args = step.kind === "read" ? ["snapshot"] : step.kind === "navigate" ? ["open", step.url]
        : step.kind === "click" ? ["click", step.ref] : step.kind === "fill" ? ["fill", step.ref, step.value]
          : step.kind === "select" ? ["select", step.ref, ...step.values]
            : step.kind === 'download' || step.kind === 'upload' ? [step.kind, step.ref, step.path] : null;
      if (step.kind === "read" && step.scroll) {
        // Scrolling is read-only, so a scroll the engine does not confirm (no such container on this page) holds
        // nothing: the page is read as it stands. Stop is honoured between every engine command.
        const live = () => { if (this.phase !== "active" || signal?.aborted) throw failed("This browser controller is stopped."); };
        const selector = step.scroll;
        return readLazyGrid(async () => { live(); try { await this.command(["scroll", "down", "100000", "--selector", selector]); return true; } catch { return false; } },
          async () => { live(); const read = await this.command(["snapshot"]); live(); return read; },
          read => snapshotRows(typeof read.snapshot === "string" ? read.snapshot : ""), this.options.scrollWaitMs);
      }
      if (step.kind === "press") {
        await this.command(["focus", step.ref]);
        if (this.phase !== "active" || signal?.aborted) throw failed("This browser controller is stopped.");
      }
      const result = await this.command(args ?? ["press", (step as Extract<HermesEngineStep, { kind: "press" }>).key]);
      if (this.phase !== "active" || signal?.aborted) throw failed("This step ended after Stop. Review its result before starting again.");
      return result;
    }).catch(error => {
      // A failed native command can have partially completed. Hold this
      // controller instead of allowing a queued action or an implicit retry.
      if (this.phase === "active") this.phase = "recovery_required";
      throw error;
    }).finally(() => { signal?.removeEventListener("abort", cancelled); });
    this.serial = action.catch(() => {});
    return action;
  }
  stop(): Promise<void> {
    if (this.phase === "new") { this.phase = "released"; return Promise.resolve(); }
    if (this.phase === "released") return Promise.resolve();
    if (this.stopping) return this.stopping;
    this.phase = "stopping"; // Synchronous revocation, before waiting.
    this.stopping = (async () => {
      await this.serial;
      if (!this.attempted) { this.phase = "released"; this.stopping = null; return; }
      try { await this.command(["close"]); this.phase = "released"; }
      catch { this.phase = "recovery_required"; throw failed("Browser release is unconfirmed. Keep this task stopped and check the work browser."); }
      finally { this.stopping = null; }
    })();
    return this.stopping;
  }
}

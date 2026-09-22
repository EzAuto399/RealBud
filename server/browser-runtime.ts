import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.ts";
import { randomUUID } from "node:crypto";
import { privateDirectory, readPrivateJson, writePrivateJson } from "./private-json.ts";
import type { BrowserStatus, BrowserConnection } from "../shared/browser.ts";

export const BROWSER_VERSION = "0.3.0";
export const BROWSER_PORT = 52800;
export type BrowserJson = Record<string, unknown>;
export type BrowserCommand = (args: string[], signal?: AbortSignal) => Promise<BrowserJson>;
type Lease = { owner: string; sessionId: string | null; browserId: string; phase: "starting" | "active" | "stopping" | "unknown" };
type Saved = { version: 1; enabled: boolean; browserId: string | null; lease: Lease | null };
const fail = (message: string) => Object.assign(new Error(message), { status: 409 });
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const record = (v: unknown): v is BrowserJson => Boolean(v && typeof v === "object" && !Array.isArray(v));
export function browserStepFailure(value: unknown): Error {
  if (record(value) && record(value.data) && value.data.reason === "confirmation_ui_unavailable") return fail("The browser could not show its confirmation. Select the job's website tab in your chosen browser, then stop this attempt and start a new reviewed step. Keep tab confirmation enabled.");
  return fail("The browser did not confirm this step. Check the page before trying again; it may already have happened.");
}

/** Only the app's bundled helper is admitted; never PATH or a personal install. */
export async function browserExecutable(): Promise<string | null> {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const root = resources ? join(resources, "browser") : join(dirname(fileURLToPath(import.meta.url)), "..", "dist-browser");
  // The packaged server lives in Resources/server; Electron's child may omit resourcesPath.
  const candidates = [root, join(dirname(fileURLToPath(import.meta.url)), "..", "browser"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist-browser")];
  for (const dir of candidates) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, "runtime.json"), "utf8"));
      if (manifest.version !== BROWSER_VERSION || manifest.platform !== process.platform || manifest.arch !== process.arch) continue;
      const binary = join(dir, process.platform === "win32" ? "bsk.exe" : "bsk");
      const stat = await lstat(binary);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      return binary;
    } catch { /* An absent bundle is shown as unavailable, never downloaded at runtime. */ }
  }
  return null;
}

export class BrowserRuntime {
  readonly root: string;
  readonly command: BrowserCommand;
  private state?: Saved;
  private serial: Promise<unknown> = Promise.resolve();
  private daemon: ChildProcess | null = null;
  private currentOwner: string | null = null;
  private revoked = new Set<string>();
  private executable: () => Promise<string | null>;
  private startDaemon: () => Promise<void>;
  constructor(options: { root?: string; command?: BrowserCommand; executable?: () => Promise<string | null>; startDaemon?: () => Promise<void> } = {}) {
    this.root = options.root ?? join(DATA_DIR, "browser");
    this.executable = options.executable ?? browserExecutable;
    this.command = options.command ?? ((args, signal) => this.execute(args, signal));
    this.startDaemon = options.startDaemon ?? (() => this.launch());
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn, fn); this.serial = result.catch(() => {}); return result;
  }
  private async saved(): Promise<Saved> {
    if (this.state) return this.state;
    const raw = await readPrivateJson(join(this.root, "connection.json"));
    if (raw === undefined) return this.state = { version: 1, enabled: false, browserId: null, lease: null };
    if (!record(raw) || raw.version !== 1 || typeof raw.enabled !== "boolean" || !(raw.browserId === null || id(raw.browserId)) ||
      !(raw.lease === null || (record(raw.lease) && id(raw.lease.owner) && id(raw.lease.browserId) &&
        (raw.lease.sessionId === null || id(raw.lease.sessionId)) && ["starting", "active", "stopping", "unknown"].includes(String(raw.lease.phase))))) throw fail("Browser settings need recovery. No browser work will start.");
    return this.state = raw as unknown as Saved;
  }
  private async save(next: Saved): Promise<void> {
    await writePrivateJson(join(this.root, "connection.json"), next); this.state = next;
  }
  private env(): NodeJS.ProcessEnv {
    // Page data stays out of diagnostic logs; keys from the model/service never reach bsk.
    const env: NodeJS.ProcessEnv = { BSK_HOME: join(this.root, "bridge"), BSK_AUTO_START: "0", BSK_BROWSER_WAIT_MS: "0" };
    for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "PATH"]) if (process.env[key]) env[key] = process.env[key];
    return env;
  }
  private async execute(args: string[], signal?: AbortSignal): Promise<BrowserJson> {
    const binary = await this.executable();
    if (!binary) throw fail("The browser helper is missing from this RealBud build.");
    return new Promise((resolve, reject) => {
      execFile(binary, [...args, "--json"], { env: this.env(), windowsHide: true, timeout: 75_000, maxBuffer: 600_000, signal }, (error, stdout) => {
        let value: unknown;
        try { value = JSON.parse(stdout); } catch { /* Never echo CLI stderr or page/account content into status errors. */ }
        if (error || !record(value) || value.ok === false || value.error) return reject(browserStepFailure(value));
        resolve(value);
      });
    });
  }
  private async launch(): Promise<void> {
    try { const s = await this.command(["status"]); if (s.daemon_version === BROWSER_VERSION) return; throw fail("The browser helper needs an update."); }
    catch (error) { if ((error as Error).message.includes("update")) throw error; }
    if (this.daemon) throw fail("The browser helper is still starting. Check the connection again.");
    const binary = await this.executable(); if (!binary) throw fail("The browser helper is missing from this RealBud build.");
    await privateDirectory(join(this.root, "bridge"));
    const child = spawn(binary, ["daemon", "start", "--foreground", "--port", String(BROWSER_PORT), "--session-idle", "5m", "--daemon-idle", "24h"], { env: this.env(), stdio: "ignore", windowsHide: true });
    this.daemon = child;
    child.once("error", () => { if (this.daemon === child) this.daemon = null; });
    child.once("exit", () => { if (this.daemon === child) this.daemon = null; });
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      try { if ((await this.command(["status"])).daemon_version === BROWSER_VERSION) return; } catch { /* bounded startup */ }
      if (child.exitCode !== null) break;
    }
    child.kill(); throw fail("The browser helper could not start. Close other browser helpers using this connection, then try again.");
  }
  async status(): Promise<BrowserStatus> {
    const base: BrowserStatus = { state: "off", enabled: false, detail: "Connect your browser to use saved website jobs.", browsers: [], selectedBrowserId: null, active: false, checkedAt: Date.now(), version: BROWSER_VERSION, port: BROWSER_PORT };
    try {
      const saved = await this.saved(); Object.assign(base, { enabled: saved.enabled, selectedBrowserId: saved.browserId, active: !!saved.lease });
      if (saved.lease && (saved.lease.phase !== "active" || this.currentOwner !== saved.lease.owner)) return { ...base, state: "recovery_required", detail: "The last browser session needs to be released. Review any unfinished work before starting it again." };
      if (!await this.executable()) return { ...base, state: "not_installed", detail: "This RealBud build does not include the browser helper. Install a complete build to connect your browser." };
      if (!saved.enabled) return base;
      let raw: BrowserJson;
      try { raw = await this.command(["status"]); } catch { return { ...base, state: "disconnected", detail: "The browser helper is disconnected. Reconnect it before running a website job." }; }
      if (raw.daemon_version !== BROWSER_VERSION || raw.protocol_version !== "1.3") return { ...base, state: "needs_update", detail: "The browser helper needs a compatible update. Browser work is paused." };
      const browsers: BrowserConnection[] = (Array.isArray(raw.browsers) ? raw.browsers : []).filter(record).filter(b => id(b.instance_id)).map(b => ({
        id: String(b.instance_id), name: String(b.browser_name ?? "Browser").slice(0, 60), label: String(b.label ?? "").slice(0, 80),
        compatible: b.extension_protocol_version === "1.3" && b.extension_version === BROWSER_VERSION,
      }));
      base.browsers = browsers;
      const chosen = browsers.find(b => b.id === saved.browserId);
      if (chosen && !chosen.compatible) return { ...base, state: "needs_update", detail: "Update the browser extension, then check the connection again." };
      if (chosen) return { ...base, state: "ready", detail: saved.lease ? "Bud is using the browser for your current saved job." : "Connected on this computer. Choose a saved website job to start work." };
      if (saved.browserId) return { ...base, state: "disconnected", detail: "Your selected browser is not connected. Open it and enable the extension, or choose another browser." };
      return { ...base, state: browsers.length ? "choose_browser" : "extension_needed", detail: browsers.length ? "Choose the browser profile Bud should use on this computer." : "Add the browser extension, then open it and enable its local connection." };
    } catch { return { ...base, state: "recovery_required", detail: "Browser settings could not be read safely. Browser work is paused until the saved settings are recovered." }; }
  }
  async connect(): Promise<BrowserStatus> {
    await this.exclusive(async () => { const saved = await this.saved(); if (saved.lease) throw fail("Release the previous browser session first."); await this.save({ ...saved, enabled: true }); await this.startDaemon(); });
    return this.status();
  }
  async select(browserId: string): Promise<BrowserStatus> {
    await this.exclusive(async () => {
      const saved = await this.saved(); if (saved.lease) throw fail("Stop browser work before changing browsers.");
      const status = await this.status(); if (!saved.enabled || !status.browsers.some(b => b.id === browserId && b.compatible)) throw fail("Choose a connected, compatible browser from this computer.");
      await this.save({ ...saved, browserId });
    }); return this.status();
  }
  async acquire(owner: string): Promise<string> {
    return this.exclusive(async () => {
      if (!id(owner) || this.revoked.has(owner)) throw fail("This browser request has stopped.");
      const saved = await this.saved(); if (saved.lease) throw fail("Another browser session is active or needs recovery. Stop it before starting more work.");
      if ((await this.status()).state !== "ready" || !saved.browserId) throw fail("Connect your browser in You → Browser before running this job.");
      const lease: Lease = { owner, browserId: saved.browserId, sessionId: null, phase: "starting" };
      await this.save({ ...saved, lease });
      try {
        const started = await this.command(["session", "start", "--browser", saved.browserId, "--name", "RealBud saved job", "--no-focus"]);
        if (!id(started.session_id) || started.browser_instance_id !== saved.browserId) throw fail("The browser session identity could not be confirmed.");
        lease.sessionId = started.session_id;
        const interaction = record(started.interaction) ? started.interaction : {};
        if (interaction.borrow_confirmation !== "always" || interaction.request_help !== "enabled" || this.revoked.has(owner)) {
          await this.save({ ...saved, lease: { ...lease, phase: "stopping" } }); await this.stopLease();
          throw fail("Turn on tab confirmation and requests for help in the browser extension before starting a job.");
        }
        await this.save({ ...saved, lease: { ...lease, phase: "active" } }); this.currentOwner = owner;
        return started.session_id;
      } catch (error) {
        const current = await this.saved();
        if (current.lease) await this.save({ ...current, lease: { ...current.lease, phase: "unknown" } });
        throw error;
      }
    });
  }
  isOwner(owner: string): boolean { return this.currentOwner === owner && !this.revoked.has(owner) && this.state?.lease?.phase === "active"; }
  async checkSession(owner: string): Promise<void> {
    if (!this.isOwner(owner)) throw fail("This browser request has stopped.");
    const status = await this.command(["status"]);
    const session = (Array.isArray(status.sessions) ? status.sessions : []).find(s => record(s) && s.session_id === this.state?.lease?.sessionId);
    if (!record(session) || session.browser_instance_id !== this.state?.lease?.browserId || !record(session.interaction) ||
      session.interaction.borrow_confirmation !== "always" || session.interaction.request_help !== "enabled" || !this.isOwner(owner)) throw fail("The browser session or its confirmation settings changed. Stop and check the connection before continuing.");
  }
  async release(owner: string): Promise<void> {
    this.revoked.add(owner);
    await this.exclusive(async () => { if ((await this.saved()).lease?.owner === owner) await this.stopLease(); });
  }
  private async stopLease(): Promise<void> {
    const saved = await this.saved(); const lease = saved.lease; if (!lease) return;
    this.currentOwner = null;
    await this.save({ ...saved, lease: { ...lease, phase: "stopping" } });
    if (!lease.sessionId) {
      // A lost start reply may have opened an unknown session in our private daemon.
      // Stop only this installation's daemon, never a personal/global bsk process.
      const status = await this.command(["status"]);
      if (!Array.isArray(status.sessions)) throw fail("The previous session could not be identified. Browser recovery is still required.");
      for (const session of status.sessions) {
        if (!record(session) || !id(session.session_id)) throw fail("Browser recovery needs attention.");
        const result = await this.command(["session", "stop", session.session_id]);
        if (!Array.isArray(result.stopped) || !result.stopped.includes(session.session_id) || (Array.isArray(result.failed) && result.failed.length) || (Array.isArray(result.return_failures) && result.return_failures.length)) throw fail("Browser release is unconfirmed. Close the agent window and retry release.");
      }
    } else {
      const status = await this.command(["status"]);
      if (!Array.isArray(status.sessions)) throw fail("Browser release could not be checked.");
      // A repeated Stop or the daemon's idle cleanup may have already released it.
      if (!status.sessions.some(s => record(s) && s.session_id === lease.sessionId)) { await this.save({ ...saved, lease: null }); return; }
      const stopped = await this.command(["session", "stop", lease.sessionId]);
      if (!Array.isArray(stopped.stopped) || !stopped.stopped.includes(lease.sessionId) ||
        (Array.isArray(stopped.failed) && stopped.failed.length) || (Array.isArray(stopped.return_failures) && stopped.return_failures.length)) throw fail("Browser release is unconfirmed. Close the agent window before entering private details, then retry release.");
    }
    await this.save({ ...saved, lease: null });
  }
  /** Explicit UI sign-in calibration. No page reads and no tab borrowing. */
  async chooseLoginTabs(origins: string[]): Promise<Array<{ tabId: number; origin: string; title: string; browserId: string }>> {
    const owner = `login-tabs:${randomUUID()}`;
    try {
      const session = await this.acquire(owner);
      const result = await this.command(["tab", "list", "--scope", "user", "--session", session]);
      return (Array.isArray(result.tabs) ? result.tabs : []).filter(record).flatMap(tab => {
        try {
          const url = new URL(String(tab.url));
          if (url.protocol !== "https:" || url.username || url.password || !Number.isSafeInteger(tab.tab_id) || !origins.some(o => new URL(o.includes("://") ? o : `https://${o}`).origin === url.origin)) return [];
          return [{ tabId: Number(tab.tab_id), origin: url.origin, title: String(tab.title ?? url.hostname).slice(0, 100), browserId: this.state!.browserId! }];
        } catch { return []; }
      });
    } finally { await this.release(owner); }
  }
  /** Fresh read-only sign-in check. Never retain the observed page contents. */
  async verifyLogin(binding: { browserId: string; tabId: number; origin: string; accountMarker: string; readyMarker: string }): Promise<boolean> {
    const owner = `login-check:${randomUUID()}`;
    try {
      if ((await this.saved()).browserId !== binding.browserId) return false;
      const session = await this.acquire(owner);
      const exactTab = async (borrowed = false) => {
        await this.checkSession(owner);
        const result = await this.command(["tab", "list", "--scope", "all", "--session", session]);
        return (Array.isArray(result.tabs) ? result.tabs : []).some(tab => {
          try { return record(tab) && tab.tab_id === binding.tabId && (!borrowed || tab.scope === "agent") && new URL(String(tab.url)).origin === binding.origin; } catch { return false; }
        });
      };
      if (!await exactTab()) return false;
      await this.command(["tab", "borrow", String(binding.tabId), "--session", session, "--timeout", "60s"]);
      if (!this.isOwner(owner) || !await exactTab(true)) return false;
      const data = await this.command(["observe", "--session", session, "--tab-id", String(binding.tabId), "--max-tokens", "6000"]);
      if (!this.isOwner(owner) || data.tab_id !== binding.tabId || typeof data.text !== "string" || !await exactTab(true)) return false;
      return data.text.includes(binding.accountMarker) && data.text.includes(binding.readyMarker)
        && !data.text.split("\n").some(line => /input|textbox|password/i.test(line) && /password|passcode|verification code|\botp\b/i.test(line));
    } finally { await this.release(owner); }
  }
  async resumeConnection(): Promise<void> {
    const saved = await this.saved(); if (saved.enabled && !saved.lease) await this.startDaemon();
  }
  async stop(disconnect = false): Promise<BrowserStatus> {
    if (this.state?.lease) this.revoked.add(this.state.lease.owner);
    await this.exclusive(async () => {
      const saved = await this.saved();
      if (disconnect) await this.save({ ...saved, enabled: false });
      await this.stopLease();
      if (disconnect) { this.daemon?.kill(); this.daemon = null; }
    }); return this.status();
  }
  async shutdown(): Promise<void> { try { await this.stop(); } finally { this.daemon?.kill(); this.daemon = null; } }
}
export const browserRuntime = new BrowserRuntime();

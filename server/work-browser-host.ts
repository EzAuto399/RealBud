// RealBud owns this browser process and a dedicated persistent work profile.
// No personal browser/profile discovery, cookie copying, extensions or saved
// PID adoption. The broker owns task authority; this module only owns a host.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { admitHermesEngine, ownedBrowserEndpoint, type HermesEngineBundle } from "./hermes-browser-transport.ts";
import { privateDirectory, readPrivateJson, removePrivateJson, writePrivateJson } from "./private-json.ts";

export interface WorkBrowserStatus {
  state: "ready" | "not_installed" | "disconnected" | "recovery_required";
  profileId: string;
  detail: string;
}
export interface WorkBrowserConnection { profileId: string; endpoint: string; bundle: HermesEngineBundle }
interface Owner { version: 1; purpose: "realbud-work-browser-owner"; profileId: string; pid: number; endpoint: string | null }
interface HostDependencies {
  findBrowser: () => Promise<string | null>;
  launch: (executable: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  versionEndpoint: (endpoint: string) => Promise<string>;
  closeBrowser: (endpoint: string) => Promise<void>;
  isAlive: (pid: number) => boolean;
  admit: typeof admitHermesEngine;
  /** One CDP command on the owned browser endpoint: Target domain, or with `targetId` one command in that tab. */
  cdp: (endpoint: string, method: string, params: Record<string, unknown>, targetId?: string) => Promise<Record<string, unknown>>;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
}
const fail = (message = "The work browser needs recovery. Close its window and try connecting again.") => new Error(message);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
const live = (child: ChildProcess) => child.exitCode === null && child.signalCode === null && !!child.pid;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };

/** Fixed product browser locations only. Never execute a worker-supplied path
 * or search PATH. The installed browser keeps its normal OS credential store. */
async function findBrowser(): Promise<string | null> {
  const candidates = process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : process.platform === "win32" ? [
    ...[process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter((value): value is string => !!value)
      .flatMap(base => [join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe")]),
  ] : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge"];
  for (const candidate of candidates) {
    try { const stat = await lstat(candidate); if (stat.isFile() && !stat.isSymbolicLink()) return candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return null;
}
function browserEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // No keys, proxy overrides, shell configuration or worker control variables.
  for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "LANG"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function versionEndpoint(endpoint: string): Promise<string> {
  const ws = new URL(ownedBrowserEndpoint(endpoint));
  const response = await fetch(`http://${ws.host}/json/version`, { redirect: "error", signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw fail();
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw fail();
  for await (const chunk of response.body) { size += chunk.length; if (size > 16_384) throw fail(); chunks.push(chunk); }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!record(raw) || typeof raw.webSocketDebuggerUrl !== "string") throw fail();
  return ownedBrowserEndpoint(raw.webSocketDebuggerUrl);
}
async function closeBrowser(endpoint: string): Promise<void> {
  // Browser.close flushes the persistent profile. Signals remain a fallback
  // for a failed startup/handshake, never a signal sent using a saved PID.
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(ownedBrowserEndpoint(endpoint));
    let sent = false;
    const timer = setTimeout(() => finish(fail()), 2000);
    const finish = (error?: Error) => { clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(); };
    socket.addEventListener("open", () => { sent = true; socket.send(JSON.stringify({ id: 1, method: "Browser.close" })); }, { once: true });
    socket.addEventListener("message", () => finish(), { once: true });
    socket.addEventListener("close", () => finish(sent ? undefined : fail()), { once: true });
    socket.addEventListener("error", () => finish(fail()), { once: true });
  });
}
/** One Target-domain command over the owned endpoint; answered by id, bounded. With `targetId`, the command runs
 * in that tab through a flat session that ends when the socket closes. */
async function cdp(endpoint: string, method: string, params: Record<string, unknown>, targetId?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(ownedBrowserEndpoint(endpoint));
    const timer = setTimeout(() => finish(fail("The work browser did not answer in time.")), 5000);
    const finish = (error: Error | null, result?: Record<string, unknown>) => { clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(result!); };
    const last = targetId ? 2 : 1;
    socket.addEventListener("open", () => socket.send(JSON.stringify(targetId ? { id: 1, method: "Target.attachToTarget", params: { targetId, flatten: true } } : { id: 1, method, params })), { once: true });
    socket.addEventListener("message", event => {
      let reply: unknown; try { reply = JSON.parse(String(event.data)); } catch { return finish(fail()); }
      if (!record(reply) || reply.id !== 1 && reply.id !== last) return;
      if (!record(reply.result)) return finish(fail());
      if (reply.id === last) return finish(null, reply.result);
      if (typeof reply.result.sessionId !== "string") return finish(fail());
      socket.send(JSON.stringify({ id: 2, sessionId: reply.result.sessionId, method, params }));
    });
    socket.addEventListener("error", () => finish(fail()), { once: true });
  });
}
async function portEndpoint(profile: string): Promise<string | null> {
  const file = join(profile, "DevToolsActivePort");
  let stat;
  try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512 || (process.platform !== "win32" && stat.uid !== process.getuid?.())) throw fail();
  const parts = (await readFile(file, "utf8")).trim().split(/\r?\n/);
  if (parts.length !== 2 || !/^[1-9]\d{0,4}$/.test(parts[0]) || Number(parts[0]) > 65535) throw fail();
  return ownedBrowserEndpoint(`ws://127.0.0.1:${parts[0]}${parts[1]}`);
}
function ownerRecord(raw: unknown, profileId: string): Owner {
  if (!record(raw) || Object.keys(raw).sort().join() !== "endpoint,pid,profileId,purpose,version" || raw.version !== 1 || raw.purpose !== "realbud-work-browser-owner" || raw.profileId !== profileId || !Number.isSafeInteger(raw.pid) || Number(raw.pid) <= 0 || (raw.endpoint !== null && typeof raw.endpoint !== "string")) throw fail();
  if (typeof raw.endpoint === "string" && !raw.endpoint.startsWith("ws://")) throw fail();
  if (typeof raw.endpoint === "string") ownedBrowserEndpoint(raw.endpoint);
  return raw as unknown as Owner;
}

export class WorkBrowserHost {
  private deps: HostDependencies;
  private profileId = "";
  private phase: "disconnected" | "starting" | "ready" | "stopping" | "recovery_required" = "disconnected";
  private child: ChildProcess | null = null;
  private connection: WorkBrowserConnection | null = null;
  private initialized: Promise<void> | null = null;
  private opening: Promise<WorkBrowserConnection> | null = null;
  private stopping: Promise<void> | null = null;
  private directoryIdentity = "";
  private generation = 0;
  readonly profile: string;
  private ownerFile: string;
  private options: { root: string; bundleRoot: string };
  constructor(options: { root: string; bundleRoot: string }, dependencies: Partial<HostDependencies> = {}) {
    this.options = { ...options };
    this.profile = join(options.root, "profile"); this.ownerFile = join(options.root, "owner.json");
    this.deps = { findBrowser, launch: (executable, args, env) => spawn(executable, args, { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: false }), versionEndpoint, closeBrowser, isAlive: alive, admit: admitHermesEngine, cdp, startupTimeoutMs: 15_000, stopTimeoutMs: 5000, ...dependencies };
  }
  private initialize(): Promise<void> {
    if (this.initialized) return this.initialized;
    const initializing = (async () => {
      await privateDirectory(this.options.root); await privateDirectory(this.profile);
      const markerFile = join(this.options.root, "profile.json");
      let marker = await readPrivateJson(markerFile, 1024);
      if (marker === undefined) { marker = { version: 1, purpose: "realbud-work-browser-profile", id: randomUUID() }; await writePrivateJson(markerFile, marker); }
      if (!record(marker) || Object.keys(marker).sort().join() !== "id,purpose,version" || marker.version !== 1 || marker.purpose !== "realbud-work-browser-profile" || typeof marker.id !== "string" || !/^[a-f0-9-]{36}$/.test(marker.id)) throw fail();
      this.profileId = marker.id;
      const stat = await lstat(this.profile); this.directoryIdentity = `${stat.dev}:${stat.ino}`;
      const prior = await readPrivateJson(this.ownerFile, 2048);
      if (prior !== undefined) {
        const owner = ownerRecord(prior, this.profileId);
        // A PID is only a negative liveness check. Never signal or attach to it.
        if (this.deps.isAlive(owner.pid)) throw fail("A previous work browser is still open. Close that work browser window before reconnecting.");
        const endpoint = await portEndpoint(this.profile);
        if (endpoint !== null && endpoint !== owner.endpoint) throw fail();
        if (endpoint !== null) await unlink(join(this.profile, "DevToolsActivePort"));
        await removePrivateJson(this.ownerFile);
      } else if (await exists(join(this.profile, "DevToolsActivePort"))) throw fail();
      if (!this.child && this.phase === "recovery_required") this.phase = "disconnected";
    })();
    this.initialized = initializing;
    void initializing.catch(() => {
      if (this.initialized === initializing) this.initialized = null;
      this.phase = "recovery_required";
    });
    return initializing;
  }
  private async checkDirectory(): Promise<void> {
    await privateDirectory(this.profile);
    const stat = await lstat(this.profile);
    if (`${stat.dev}:${stat.ino}` !== this.directoryIdentity) throw fail();
  }
  private async verify(connection: WorkBrowserConnection): Promise<void> {
    const child = this.child;
    if (!child || !live(child)) throw fail("The work browser has closed. Connect it again before continuing.");
    await this.checkDirectory();
    if (await portEndpoint(this.profile) !== connection.endpoint || await this.deps.versionEndpoint(connection.endpoint) !== connection.endpoint || this.child !== child || !live(child)) throw fail();
  }
  async status(): Promise<WorkBrowserStatus> {
    try {
      await this.initialize();
      if (this.phase === "ready" && this.connection) { await this.verify(this.connection); return { state: "ready", profileId: this.profileId, detail: "The work browser is open. Sign in there when the website asks." }; }
      if (this.phase === "recovery_required") throw fail();
      if (!await this.deps.findBrowser()) return { state: "not_installed", profileId: this.profileId, detail: "Install Google Chrome or Microsoft Edge to open the work browser." };
      return { state: "disconnected", profileId: this.profileId, detail: "Open the work browser to continue. Saved website sign-ins stay in its private profile." };
    } catch { this.phase = "recovery_required"; return { state: "recovery_required", profileId: this.profileId, detail: "Close the previous work browser window and reconnect. Its saved sign-ins are preserved." }; }
  }
  ensureOpen(): Promise<WorkBrowserConnection> {
    if (this.opening) return this.opening;
    if (this.phase === "stopping" || (this.phase === "recovery_required" && this.child)) return Promise.reject(fail());
    const generation = this.generation;
    this.opening = (async () => {
      await this.initialize();
      if (generation !== this.generation) throw fail("Opening the work browser was stopped.");
      if (this.phase === "recovery_required") throw fail();
      if (this.connection && this.phase === "ready") { await this.verify(this.connection); return { ...this.connection }; }
      const executable = await this.deps.findBrowser();
      if (!executable) throw fail("Install Google Chrome or Microsoft Edge to open the work browser.");
      const bundle = await this.deps.admit(this.options.bundleRoot);
      await this.checkDirectory();
      if (generation !== this.generation) throw fail("Opening the work browser was stopped.");
      if (await exists(join(this.profile, "DevToolsActivePort"))) throw fail();
      this.phase = "starting";
      const child = this.deps.launch(executable, [
        `--user-data-dir=${this.profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--new-window", "about:blank",
      ], browserEnvironment());
      this.child = child;
      const announced = new Promise<string>((resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => finish(fail("The work browser did not open in time.")), this.deps.startupTimeoutMs);
        const onError = () => finish(fail("The work browser could not be started."));
        const onExit = () => finish(fail("The work browser closed before it was ready."));
        const onData = (bytes: Buffer) => {
          text = (text + bytes.toString("utf8")).slice(-4096);
          const found = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)(?:\s|$)/);
          if (found) finish(null, found[1]);
        };
        const finish = (error: Error | null, endpoint?: string) => {
          clearTimeout(timer); child.off("error", onError); child.off("exit", onExit); child.stderr?.off("data", onData);
          if (error) reject(error); else resolve(ownedBrowserEndpoint(endpoint!));
        };
        child.once("error", onError); child.once("exit", onExit); child.stderr?.on("data", onData);
      });
      // Attach a rejection observer while durable ownership is recorded.
      void announced.catch(() => {});
      child.on("error", () => { this.phase = "recovery_required"; });
      if (!child.pid) throw fail("The work browser could not be started.");
      const owner: Owner = { version: 1, purpose: "realbud-work-browser-owner", profileId: this.profileId, pid: child.pid, endpoint: null };
      await writePrivateJson(this.ownerFile, owner);
      const endpoint = await announced;
      // The fresh endpoint came from our own child's stderr. Save it before
      // probing, so a failed probe can still cleanly close that owned process.
      await writePrivateJson(this.ownerFile, { ...owner, endpoint });
      if (generation !== this.generation || this.phase !== "starting") throw fail("Opening the work browser was stopped.");
      const connection = { profileId: this.profileId, endpoint, bundle };
      await this.verify(connection);
      if (generation !== this.generation || !live(child)) throw fail("Opening the work browser was stopped.");
      this.connection = connection; this.phase = "ready";
      return { ...connection };
    })().catch(error => { if (this.child) this.phase = "recovery_required"; throw error; }).finally(() => { this.opening = null; });
    return this.opening;
  }
  /** Opens a new tab at an HTTPS address in the owned work browser (launching
   * it if needed) and brings it forward. The caller decides the address. */
  async openTab(url: string): Promise<string> {
    if (new URL(url).protocol !== "https:") throw fail("Only an HTTPS address can be opened for sign-in.");
    const { endpoint } = await this.ensureOpen();
    const created = await this.deps.cdp(endpoint, "Target.createTarget", { url });
    if (typeof created.targetId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(created.targetId)) throw fail();
    await this.deps.cdp(endpoint, "Target.activateTarget", { targetId: created.targetId });
    return created.targetId;
  }
  /** Loads an HTTPS address in this already-open tab, in place: no new tab, not brought forward and nothing read
   * from the page (a long sign-in wait refreshing the site's sign-in page). The caller decides the address. */
  async navigateTab(targetId: string, url: string): Promise<void> {
    if (new URL(url).protocol !== "https:") throw fail("Only an HTTPS address can be opened for sign-in.");
    if (!/^[A-Za-z0-9]{1,64}$/.test(targetId)) throw fail();
    if (this.phase !== "ready" || !this.connection) throw fail("The work browser has closed. Connect it again before continuing.");
    await this.verify(this.connection);
    await this.deps.cdp(this.connection.endpoint, "Page.navigate", { url }, targetId);
  }
  /** The tab's current address, or null when it closed or the browser is not ready. Read-only. */
  async tabUrl(targetId: string): Promise<string | null> {
    if (this.phase !== "ready" || !this.connection) return null;
    await this.verify(this.connection);
    const listed = await this.deps.cdp(this.connection.endpoint, "Target.getTargets", {});
    const found = Array.isArray(listed.targetInfos) ? listed.targetInfos.find(info => record(info) && info.targetId === targetId) : undefined;
    return record(found) && typeof found.url === "string" ? found.url : null;
  }
  disconnect(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.generation++; this.phase = "stopping";
    this.stopping = (async () => {
      // An in-flight launch is revoked above; wait until it owns a handle.
      await this.opening?.catch(() => {});
      const child = this.child;
      if (child && live(child)) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { child.off("exit", exited); reject(fail("The work browser has not confirmed it closed. Close its window before reconnecting.")); }, this.deps.stopTimeoutMs);
          const exited = () => { clearTimeout(timer); resolve(); };
          child.once("exit", exited);
          void (async () => {
            try {
              if (!this.connection) throw fail();
              await this.verify(this.connection);
              await this.deps.closeBrowser(this.connection.endpoint);
            } catch {
              if (!live(child)) return;
              if (!child.kill("SIGTERM")) { clearTimeout(timer); child.off("exit", exited); reject(fail()); }
            }
          })();
        });
      }
      await this.initialize();
      const owner = await readPrivateJson(this.ownerFile, 2048);
      if (owner !== undefined) {
        const saved = ownerRecord(owner, this.profileId);
        if (!child || child.pid !== saved.pid || live(child)) throw fail();
        const endpoint = await portEndpoint(this.profile);
        if (endpoint !== null && endpoint !== saved.endpoint) throw fail();
        if (endpoint !== null) await unlink(join(this.profile, "DevToolsActivePort"));
        await removePrivateJson(this.ownerFile);
      }
      this.child = null; this.connection = null; this.phase = "disconnected";
    })().catch(error => { this.phase = "recovery_required"; throw error; }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
}

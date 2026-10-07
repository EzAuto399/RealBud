import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.ts";
import { privateDirectory, readPrivateJson, writePrivateJson } from "./private-json.ts";
import { windowsFilePrivacy } from "./windows-file-privacy.ts";
import { HermesBrowserTransport, HERMES_BROWSER_ENGINE_VERSION, type HermesEngineBundle, type HermesEngineStep } from "./hermes-browser-transport.ts";
import { nativeBrowserObservation } from "./native-browser-observation.ts";
import { WorkBrowserHost } from "./work-browser-host.ts";
import { accountMarkerShown, browserLoginFields } from "./browser-authority.ts";
import type { BrowserStatus } from "../shared/browser.ts";
import type { BrowserSessionRuntime, BrowserSessionAction, BrowserSessionTab, BrowserSessionObservation, BrowserHelpOutcome, BrowserJson } from "./browser-session.ts";

export interface NativeWorkBrowserHost {
  status(): Promise<{ state: "ready" | "not_installed" | "disconnected" | "recovery_required"; profileId: string; detail: string }>;
  ensureOpen(): Promise<{ profileId: string; endpoint: string; bundle: HermesEngineBundle }>;
  disconnect(): Promise<void>;
  openTab?(url: string): Promise<string>;
  tabUrl?(targetId: string): Promise<string | null>;
  navigateTab?(targetId: string, url: string): Promise<void>;
  showTab?(targetId: string): Promise<boolean>;
  pageTabs?(): Promise<Array<{ targetId: string; url: string }>>;
}
type Controller = Pick<HermesBrowserTransport, "session" | "state" | "start" | "step" | "stop">;
type Lease = { owner: string; sessionId: string; phase: "starting" | "active" | "stopping" | "unknown" };
type Saved = { version: 1; enabled: boolean; browserId: string | null; lease: Lease | null };
const record = (value: unknown): value is BrowserJson => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const fail = (message: string) => Object.assign(new Error(message), { status: 409 });

/** A task controller is temporary; the headed work browser and its cookies
 * belong to this installation's persistent private profile.
 *
 * Full browser actions (owner decision 2026-09-23): this runtime dispatches any
 * step the broker has authorised. It is not itself a permission boundary:
 * browser-broker.ts and browser-authority.ts decide each step (task scope,
 * account, per-instance approval for pay/sign/send/notice, Stop), and RealBud
 * chooses every download and upload path. */
export class NativeBrowserRuntime implements BrowserSessionRuntime {
  readonly root: string;
  readonly supportedActions = ["read", "navigate", "fill", "click", "keys", "submit", "download", "upload"] as const;
  readonly readOnly = false;
  /** Tabs live in RealBud's own work-browser profile, never a borrowed personal
   * browser, so a bounded task may carry its task-local routine authority. */
  readonly ownsProfile = true;
  private host?: NativeWorkBrowserHost;
  private state?: Saved;
  private serial: Promise<unknown> = Promise.resolve();
  private controller: Controller | null = null;
  private controllerRoot: string | null = null;
  private owner: string | null = null;
  private revoked = new Set<string>();
  private claimed = new Set<number>();
  private learning: () => boolean = () => false;
  private makeController: (options: { root: string; endpoint: string; bundle: HermesEngineBundle }) => Controller;
  constructor(options: { root?: string; host?: NativeWorkBrowserHost; controller?: NativeBrowserRuntime["makeController"] } = {}) {
    this.root = options.root ?? join(DATA_DIR, "browser");
    this.host = options.host;
    this.makeController = options.controller ?? (settings => new HermesBrowserTransport(settings));
  }
  private async browserHost(): Promise<NativeWorkBrowserHost> {
    if (this.host) return this.host;
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const folder = dirname(fileURLToPath(import.meta.url));
    const candidates = [resources ? join(resources, "browser", "hermes-native") : join(folder, "..", "dist-browser", "hermes-native"), join(folder, "..", "browser", "hermes-native"), join(folder, "..", "..", "dist-browser", "hermes-native")];
    let bundleRoot = candidates[0];
    for (const candidate of candidates) { try { if ((await lstat(join(candidate, "runtime.json"))).isFile()) { bundleRoot = candidate; break; } } catch { /* Missing bundle is shown in status. */ } }
    return this.host ??= new WorkBrowserHost({ root: join(this.root, "work-browser"), bundleRoot });
  }
  /** Watch and learn (server/learn-recorder.ts): while a recording watches a tab, no task may take the browser. */
  setLearning(isRecording: () => boolean): void { this.learning = isRecording; }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> { const next = this.serial.then(fn, fn); this.serial = next.catch(() => {}); return next; }
  private async saved(): Promise<Saved> {
    if (this.state) return this.state;
    const raw = await readPrivateJson(join(this.root, "native-connection.json"));
    if (raw === undefined) return this.state = { version: 1, enabled: false, browserId: null, lease: null };
    if (!record(raw) || raw.version !== 1 || typeof raw.enabled !== "boolean" || !(raw.browserId === null || id(raw.browserId)) ||
      !(raw.lease === null || record(raw.lease) && id(raw.lease.owner) && id(raw.lease.sessionId) && ["starting", "active", "stopping", "unknown"].includes(String(raw.lease.phase)))) throw fail("Work browser settings need recovery.");
    return this.state = raw as unknown as Saved;
  }
  private async save(next: Saved): Promise<void> { await writePrivateJson(join(this.root, "native-connection.json"), next); this.state = next; }
  async status(): Promise<BrowserStatus> {
    const base: BrowserStatus = { state: "off", enabled: false, detail: "Open the work browser to sign in and run website jobs.", browsers: [], selectedBrowserId: null, active: false, checkedAt: Date.now(), version: HERMES_BROWSER_ENGINE_VERSION, port: 0 };
    try {
      const saved = await this.saved(); Object.assign(base, { enabled: saved.enabled, selectedBrowserId: saved.browserId, active: !!saved.lease });
      if (saved.lease && (!this.isOwner(saved.lease.owner) || this.controller?.state !== "active")) return { ...base, state: "recovery_required", detail: "The earlier browser task needs recovery. Review unfinished work and release it before continuing." };
      const host = await (await this.browserHost()).status();
      if (!saved.enabled) return host.state === "recovery_required" ? { ...base, state: "recovery_required", detail: host.detail } : base;
      if (host.state !== "ready") return { ...base, state: host.state, detail: host.detail };
      if (saved.browserId !== host.profileId) return { ...base, state: "recovery_required", detail: "The work browser profile changed. Reconnect it before starting a job." };
      return { ...base, state: "ready", detail: saved.lease ? "Bud is using the work browser for this task." : "Work browser ready. Sign in on the website if needed; Bud works within each task's permissions and asks before paying, signing, sending or uploading.", browsers: [{ id: host.profileId, name: "Work browser", label: "This RealBud installation", compatible: true }] };
    } catch { return { ...base, state: "recovery_required", detail: "Work browser settings or its connection need recovery. No browser work has started." }; }
  }
  async connect(): Promise<BrowserStatus> {
    await this.exclusive(() => this.connectNow()); return this.status();
  }
  private async connectNow(): Promise<void> {
    const saved = await this.saved(); if (saved.lease) throw fail("Release the previous browser task first.");
    const host = await this.browserHost();
    let opened: Awaited<ReturnType<NativeWorkBrowserHost["ensureOpen"]>>;
    try { opened = await host.ensureOpen(); }
    catch (error) { await host.disconnect().catch(() => {}); throw error; }
    if (!id(opened.profileId)) throw fail("The work browser profile could not be confirmed.");
    await this.save({ ...saved, enabled: true, browserId: opened.profileId });
  }
  async select(browserId: string): Promise<BrowserStatus> {
    const saved = await this.saved(); const status = await this.status();
    if (saved.lease || status.state !== "ready" || browserId !== saved.browserId) throw fail("Use the work browser opened by this RealBud installation.");
    return status;
  }
  async acquire(owner: string): Promise<string> {
    return this.exclusive(async () => {
      if (!id(owner) || this.revoked.has(owner)) throw fail("This browser request has stopped.");
      if (this.learning()) throw fail("Finish or discard the recording in Show Bud first.");
      const saved = await this.saved(); if (saved.lease) throw fail("Another browser task is active or needs recovery.");
      if ((await this.status()).state !== "ready") throw fail("The work browser is not open. Bud opens it on the site's sign-in page when it needs you to sign in.");
      // Only a host already verified ready may supply its endpoint here.
      const opened = await (await this.browserHost()).ensureOpen();
      if (opened.profileId !== saved.browserId || this.revoked.has(owner)) throw fail("The selected work browser changed or this request stopped.");
      // macOS Unix sockets cannot fit under a long application-data path plus
      // the engine's session filename. mkdtemp gives us a private short root;
      // it contains control files only, never the persistent login profile.
      const controllerRoot = await realpath(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "rb-browser-")));
      let controller: Controller;
      try {
        await windowsFilePrivacy(controllerRoot, "directory", true);
        await privateDirectory(controllerRoot);
        controller = this.makeController({ root: controllerRoot, endpoint: opened.endpoint, bundle: opened.bundle });
        await this.save({ ...saved, lease: { owner, sessionId: controller.session, phase: "starting" } });
      } catch (error) { await rm(controllerRoot, { recursive: true }).catch(() => {}); throw error; }
      this.controllerRoot = controllerRoot;
      const lease: Lease = { owner, sessionId: controller.session, phase: "starting" };
      this.controller = controller; this.owner = owner;
      try {
        if (this.revoked.has(owner)) throw fail("This browser request has stopped.");
        await controller.start();
        if (this.revoked.has(owner)) throw fail("This browser request stopped during startup.");
        await this.save({ ...saved, lease: { ...lease, phase: "active" } });
        return controller.session;
      } catch (error) { await this.save({ ...saved, lease: { ...lease, phase: "unknown" } }); throw error; }
    });
  }
  isOwner(owner: string): boolean { return this.owner === owner && !this.revoked.has(owner) && this.state?.lease?.owner === owner && this.state.lease.phase === "active" && this.controller?.state === "active"; }
  async checkSession(owner: string): Promise<void> {
    if (!this.isOwner(owner)) throw fail("This browser request has stopped.");
    const host = await (await this.browserHost()).status();
    if (host.state !== "ready" || host.profileId !== this.state?.browserId || !this.isOwner(owner)) throw fail("The work browser session changed. Stop and check it before continuing.");
  }
  private async step(owner: string, step: HermesEngineStep, signal?: AbortSignal): Promise<BrowserJson> {
    await this.checkSession(owner); if (signal?.aborted) throw fail("This browser request has stopped.");
    const result = await this.controller!.step(step, signal);
    if (!this.isOwner(owner) || signal?.aborted) throw fail("This browser step ended after Stop; review its result before continuing.");
    return result;
  }
  async listTabs(owner: string, signal?: AbortSignal): Promise<BrowserSessionTab[]> {
    const result = await this.step(owner, { kind: "tabs" }, signal);
    if (!Array.isArray(result.tabs)) throw fail("The work browser did not confirm its tabs.");
    const ids = new Set<number>();
    return result.tabs.map(raw => {
      if (!record(raw) || typeof raw.tabId !== "string" || !/^t[1-9]\d*$/.test(raw.tabId) || typeof raw.url !== "string") throw fail("The work browser returned an unsupported tab identity.");
      const tabId = Number(raw.tabId.slice(1));
      if (!Number.isSafeInteger(tabId) || ids.has(tabId)) throw fail("The work browser returned a repeated tab identity."); ids.add(tabId);
      return { id: tabId, url: raw.url, title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "", browserId: this.state!.browserId!, claimed: this.claimed.has(tabId) };
    });
  }
  async claimTab(owner: string, tabId: number, signal?: AbortSignal): Promise<void> {
    if (!(await this.listTabs(owner, signal)).some(tab => tab.id === tabId)) throw fail("Choose a current work-browser tab.");
    // A claim scopes this task to a tab in our own profile. It never borrows a
    // personal tab or pretends an extension confirmation occurred.
    this.claimed.add(tabId);
  }
  async observeTab(owner: string, tabId: number, signal?: AbortSignal, scroll?: string): Promise<BrowserSessionObservation> {
    if (!this.claimed.has(tabId)) throw fail("Choose this work-browser tab for the task first.");
    const result = await this.step(owner, { kind: "read", tab: tabId, ...(scroll ? { scroll } : {}) }, signal);
    if (result.truncated === true || result.next_cursor) throw fail("The work browser returned an incomplete accessibility observation. This step is held.");
    return { tabId, text: nativeBrowserObservation(result.snapshot), truncated: false };
  }
  async perform(owner: string, action: BrowserSessionAction, signal?: AbortSignal): Promise<BrowserJson> {
    if (!this.claimed.has(action.tabId)) throw fail("Choose this work-browser tab for the task first.");
    const { tabId, ...rest } = action;
    const step = { ...rest, tab: tabId } as HermesEngineStep;
    if (step.kind === "press") step.key = step.key.replace(/\bCtrl\b/g, "Control");
    return this.step(owner, step, signal);
  }
  async requestHelp(owner: string, _input: { tabId: number; title: string; prompt: string }, _signal?: AbortSignal): Promise<BrowserHelpOutcome> {
    await this.release(owner); // Detach before the durable sign-in card invites typing.
    return "disabled";
  }
  async release(owner: string): Promise<void> {
    this.revoked.add(owner);
    if (this.owner === owner) void this.controller?.stop().catch(() => {});
    await this.exclusive(async () => { if ((await this.saved()).lease?.owner === owner) await this.stopLease(); });
  }
  private async stopLease(): Promise<void> {
    const saved = await this.saved(); if (!saved.lease) return;
    this.owner = null; this.claimed.clear();
    await this.save({ ...saved, lease: { ...saved.lease, phase: "stopping" } });
    if (this.controller) await this.controller.stop();
    else await (await this.browserHost()).disconnect(); // Restart: close the owned browser before clearing an orphaned controller lease.
    this.controller = null;
    if (this.controllerRoot) { await rm(this.controllerRoot, { recursive: true }); this.controllerRoot = null; }
    await this.save({ ...saved, lease: null });
  }
  async stop(disconnect = false): Promise<BrowserStatus> {
    if (this.state?.lease) this.revoked.add(this.state.lease.owner);
    void this.controller?.stop().catch(() => {});
    await this.exclusive(async () => {
      await this.stopLease();
      if (!this.controller && (await (await this.browserHost()).status()).state === "recovery_required") await (await this.browserHost()).disconnect();
      if (disconnect) { const saved = await this.saved(); await this.save({ ...saved, enabled: false }); await (await this.browserHost()).disconnect(); }
    }); return this.status();
  }
  /** Sign-in handover (server/browser-sign-in.ts): launches the work browser
   * when it is not running and opens the sign-in page in a new tab, brought
   * forward. No task lease and no page access: Bud acts in no tab here. */
  async openSignInTab(url: string): Promise<string> {
    const host = await this.browserHost();
    if (!host.openTab) throw fail("This work browser cannot open a sign-in page.");
    if ((await this.status()).state !== "ready") await this.connect();
    return host.openTab(url);
  }
  /** The sign-in tab's address only, for detecting the person finished. Read-only. */
  async signInTabUrl(targetId: string): Promise<string | null> {
    const host = await this.browserHost();
    return host.tabUrl ? host.tabUrl(targetId) : null;
  }
  /** A long sign-in wait refreshes the sign-in page in the same tab (REI's sign-in journey goes stale when left
   * open). No new tab, no task lease and no page read. */
  async reloadSignInTab(targetId: string, url: string): Promise<void> {
    const host = await this.browserHost();
    if (!host.navigateTab) throw fail("This work browser cannot refresh a sign-in page.");
    await host.navigateTab(targetId, url);
  }
  /** Brings an open sign-in tab forward; false once it has closed. No task lease and no page read. */
  async showSignInTab(targetId: string): Promise<boolean> {
    const host = await this.browserHost();
    return host.showTab ? host.showTab(targetId) : false;
  }
  /** The work browser's open tabs by address (none while it is not running), so a sign-in reuses a site's tab. No task lease and no page read. */
  async signInTabs(): Promise<Array<{ targetId: string; url: string }>> {
    const host = await this.browserHost();
    return host.pageTabs ? host.pageTabs() : [];
  }
  /** Watch and learn (server/learn-recorder.ts): opens the portal in a new
   * work-browser tab and hands the recorder the owned endpoint and that tab.
   * Refused while a task holds the browser, so a recording never watches Bud. */
  async learnTarget(url: string): Promise<{ endpoint: string; targetId: string }> {
    // Serialised with acquire, so a task can't take the lease between this check and the new tab.
    return this.exclusive(async () => {
      if ((await this.saved()).lease) throw fail("Bud is using the work browser for a task. Let it finish or stop it, then show Bud the task.");
      const host = await this.browserHost();
      if (!host.openTab) throw fail("This work browser cannot open a page to record.");
      if ((await this.status()).state !== "ready") await this.connectNow();
      const { endpoint } = await host.ensureOpen();
      return { endpoint, targetId: await host.openTab(url) };
    });
  }
  /** No window at RealBud start: a browser task or a sign-in handover opens
   * the work browser when it is actually needed (an empty window otherwise). */
  async resumeConnection(): Promise<void> {}
  async shutdown(): Promise<void> { await this.stop(); await (await this.browserHost()).disconnect(); }
  async chooseLoginTabs(origins: string[]): Promise<Array<{ tabId: number; origin: string; title: string; browserId: string }>> {
    const owner = `login-tabs:${randomUUID()}`;
    try { await this.acquire(owner); return (await this.listTabs(owner)).flatMap(tab => {
      try { const url = new URL(tab.url); return url.protocol === "https:" && !url.username && !url.password && origins.some(origin => new URL(origin.includes("://") ? origin : `https://${origin}`).origin === url.origin) ? [{ tabId: tab.id, origin: url.origin, title: tab.title || url.hostname, browserId: tab.browserId }] : []; } catch { return []; }
    }); } finally { await this.release(owner); }
  }
  async verifyLogin(binding: { browserId: string; tabId: number; origin: string; accountMarker: string; readyMarker: string }): Promise<boolean> {
    const owner = `login-check:${randomUUID()}`;
    try {
      if ((await this.saved()).browserId !== binding.browserId) return false;
      await this.acquire(owner);
      const exact = async () => (await this.listTabs(owner)).some(tab => tab.id === binding.tabId && new URL(tab.url).origin === binding.origin && tab.browserId === binding.browserId);
      if (!await exact()) return false;
      await this.claimTab(owner, binding.tabId);
      const observed = await this.observeTab(owner, binding.tabId);
      return await exact() && !browserLoginFields(observed.text) && accountMarkerShown(observed.text, binding.accountMarker) && accountMarkerShown(observed.text, binding.readyMarker);
    } finally { await this.release(owner); }
  }
}

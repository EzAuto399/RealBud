import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeBrowserRuntime, type NativeWorkBrowserHost } from "./native-browser-runtime.ts";
import type { HermesBrowserTransport, HermesEngineState, HermesEngineStep } from "./hermes-browser-transport.ts";
import type { BrowserJson } from "./browser-session.ts";
import { readPrivateJson } from "./private-json.ts";
import { privateTempRoot, windowsAdmissionTimeout } from "./testing/private-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const snapshot = '- banner:\n  - text: Fictional Agency\n- main:\n  - heading "Invoice list" [level=1]\n  - searchbox "Search" [ref=e1]\n  - text: Fictional invoice 001';
const tab = { tabId: "t1", url: "https://portal.fictional.example/invoices", title: "Fictional invoices", active: true };
type Controller = Pick<HermesBrowserTransport, "session" | "state" | "start" | "step" | "stop">;

function fixture() {
  const root = privateTempRoot(join(tmpdir(), "rb-native-runtime-")); roots.push(root);
  let profileId = "fictional-work-profile";
  let hostState: "ready" | "disconnected" | "recovery_required" = "disconnected";
  const host = {
    status: vi.fn(async () => ({ state: hostState, profileId, detail: "Fictional browser status" })),
    ensureOpen: vi.fn(async () => {
      hostState = "ready";
      return { profileId, endpoint: "ws://127.0.0.1:49231/devtools/browser/fictional-runtime",
        bundle: { executable: "/synthetic/agent-browser", sha256: "a".repeat(64) } };
    }),
    disconnect: vi.fn(async () => { hostState = "disconnected"; }),
  } satisfies NativeWorkBrowserHost;
  const controllers: Controller[] = [];
  const steps: HermesEngineStep[] = [];
  const controllerRoots: string[] = [];
  const replies = {
    tabs: [tab],
    read: async (): Promise<BrowserJson> => ({ snapshot }),
  };
  const makeController = vi.fn((settings: { root: string }) => {
    controllerRoots.push(settings.root); roots.push(settings.root);
    let phase: HermesEngineState = "new";
    let pending: Promise<BrowserJson> = Promise.resolve({});
    const controller: Controller = {
      session: `fictional-native-session-${controllers.length + 1}`,
      get state() { return phase; },
      start: vi.fn(async () => { phase = "active"; }),
      step: vi.fn((step: HermesEngineStep) => {
        steps.push(structuredClone(step));
        pending = step.kind === "tabs" ? Promise.resolve({ tabs: replies.tabs })
          : step.kind === "read" ? replies.read() : Promise.resolve({});
        return pending;
      }),
      stop: vi.fn(async () => {
        phase = "stopping";
        await pending.catch(() => {});
        phase = "released";
      }),
    };
    controllers.push(controller);
    return controller;
  });
  const options = { root, host, controller: makeController };
  return {
    root, options, runtime: new NativeBrowserRuntime(options), host, controllers, controllerRoots, steps, replies,
    setProfile: (value: string) => { profileId = value; },
    setHostState: (value: typeof hostState) => { hostState = value; },
    saved: () => readPrivateJson(join(root, "native-connection.json")),
    makeControllerCalls: () => makeController.mock.calls.length,
  };
}

describe("native browser task lifecycle", () => {
  it("releases a failed first launch and permits a fresh connection", windowsAdmissionTimeout(20), async () => {
    const f = fixture();
    f.host.ensureOpen.mockImplementationOnce(async () => { f.setHostState("recovery_required"); throw new Error("Fictional endpoint check failed"); });
    await expect(f.runtime.connect()).rejects.toThrow("Fictional endpoint check failed");
    expect(f.host.disconnect).toHaveBeenCalledTimes(1);
    expect(await f.runtime.status()).toMatchObject({ state: "off", enabled: false });
    expect(await f.runtime.connect()).toMatchObject({ state: "ready", enabled: true, active: false });
  });

  it("exposes and releases host recovery even before browser access was enabled", windowsAdmissionTimeout(20), async () => {
    const f = fixture(); f.setHostState("recovery_required");
    expect(await f.runtime.status()).toMatchObject({ state: "recovery_required", enabled: false, active: false });
    expect(await f.runtime.stop()).toMatchObject({ state: "off", enabled: false, active: false });
    expect(f.host.disconnect).toHaveBeenCalledTimes(1);
    expect(await f.runtime.connect()).toMatchObject({ state: "ready" });
  });

  it("connects, claims and reads a tab, then releases only the temporary controller", windowsAdmissionTimeout(30), async () => {
    const f = fixture();
    expect(await f.runtime.status()).toMatchObject({ state: "off", enabled: false, active: false });
    expect(await f.runtime.connect()).toMatchObject({ state: "ready", selectedBrowserId: "fictional-work-profile", active: false });
    await f.runtime.acquire("fictional-job");
    expect(f.runtime.isOwner("fictional-job")).toBe(true);
    expect(await f.runtime.listTabs("fictional-job")).toEqual([
      { id: 1, url: tab.url, title: tab.title, browserId: "fictional-work-profile", claimed: false },
    ]);
    await expect(f.runtime.observeTab("fictional-job", 1)).rejects.toThrow(/Choose this work-browser tab/);
    await f.runtime.claimTab("fictional-job", 1);
    expect((await f.runtime.listTabs("fictional-job"))[0].claimed).toBe(true);
    const read = await f.runtime.observeTab("fictional-job", 1);
    expect(read).toMatchObject({ tabId: 1, truncated: false });
    expect(read.text).toContain('@e1 searchbox "Search"');
    expect(read.text).toContain('statictext "Fictional invoice 001"');
    await f.runtime.release("fictional-job");
    expect(f.host.disconnect).not.toHaveBeenCalled();
    expect(f.controllers[0].state).toBe("released");
    await expect(access(f.controllerRoots[0])).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.saved()).toMatchObject({ enabled: true, browserId: "fictional-work-profile", lease: null });
    expect(await f.runtime.status()).toMatchObject({ state: "ready", active: false });
    await expect(f.runtime.acquire("fictional-job")).rejects.toThrow(/stopped/);
    await f.runtime.acquire("fictional-next-job");
    await f.runtime.release("fictional-next-job");
    expect(f.controllers).toHaveLength(2);
    expect(f.host.disconnect).not.toHaveBeenCalled();
  });

  it("revokes pending work immediately and withholds its late observation after Stop", windowsAdmissionTimeout(20), async () => {
    const f = fixture(); await f.runtime.connect(); await f.runtime.acquire("fictional-job");
    await f.runtime.claimTab("fictional-job", 1);
    const started = deferred<void>(); const result = deferred<BrowserJson>();
    f.replies.read = () => { started.resolve(); return result.promise; };
    const pending = f.runtime.observeTab("fictional-job", 1);
    const rejected = expect(pending).rejects.toThrow(/after Stop/);
    await started.promise;
    const stopping = f.runtime.stop();
    expect(f.runtime.isOwner("fictional-job")).toBe(false);
    const count = f.steps.length;
    await expect(f.runtime.listTabs("fictional-job")).rejects.toThrow(/stopped/);
    expect(f.steps).toHaveLength(count);
    result.resolve({ snapshot });
    await rejected;
    expect(await stopping).toMatchObject({ state: "ready", active: false });
    expect(f.host.disconnect).not.toHaveBeenCalled();
    expect(await f.saved()).toMatchObject({ lease: null });
  });

  it("dispatches broker-authorised submits and broker-staged file transfers to the native transport", windowsAdmissionTimeout(20), async () => {
    const f = fixture();
    // The runtime is not the permission boundary: the broker and authority decide each step.
    expect(f.runtime.readOnly).toBe(false);
    expect(f.runtime.ownsProfile).toBe(true);
    expect(f.runtime.supportedActions).toEqual(["read", "navigate", "fill", "click", "keys", "submit", "download", "upload"]);
    await f.runtime.connect(); await f.runtime.acquire("fictional-job"); await f.runtime.claimTab("fictional-job", 1);
    const count = f.steps.length;
    await f.runtime.perform("fictional-job", { kind: "click", tabId: 1, ref: "@e1" });
    for (const kind of ["download", "upload"] as const) {
      await f.runtime.perform("fictional-job", { kind, tabId: 1, ref: "@e1", path: "/synthetic/invoice.csv" });
    }
    expect(f.steps.slice(count)).toEqual([{ kind: "click", tab: 1, ref: "@e1" },
      { kind: "download", tab: 1, ref: "@e1", path: "/synthetic/invoice.csv" }, { kind: "upload", tab: 1, ref: "@e1", path: "/synthetic/invoice.csv" }]);
    // An unclaimed tab is refused before anything is dispatched.
    await expect(f.runtime.perform("fictional-job", { kind: "click", tabId: 2, ref: "@e1" })).rejects.toThrow(/Choose this work-browser tab/);
    expect(f.steps).toHaveLength(count + 3);
    await f.runtime.release("fictional-job");
  });

  it.each(["download", "click"] as const)("Stop during a pending %s withholds its result and dispatches nothing more", windowsAdmissionTimeout(20), async (kind) => {
    const f = fixture(); await f.runtime.connect(); await f.runtime.acquire("fictional-job"); await f.runtime.claimTab("fictional-job", 1);
    const started = deferred<void>(); const result = deferred<BrowserJson>();
    const step = vi.mocked(f.controllers[0].step);
    const original = step.getMockImplementation()!;
    step.mockImplementation((raw, signal) => raw.kind === kind ? (f.steps.push(structuredClone(raw)), started.resolve(), result.promise) : original(raw, signal));
    const pending = f.runtime.perform("fictional-job", kind === "download" ? { kind, tabId: 1, ref: "@e1", path: "/synthetic/statement.part" } : { kind, tabId: 1, ref: "@e1" });
    const rejected = expect(pending).rejects.toThrow(/after Stop/);
    await started.promise;
    const stopping = f.runtime.stop();
    expect(f.runtime.isOwner("fictional-job")).toBe(false);
    const count = f.steps.length;
    await expect(f.runtime.perform("fictional-job", { kind: "click", tabId: 1, ref: "@e1" })).rejects.toThrow(/stopped|Choose this work-browser tab/);
    expect(f.steps).toHaveLength(count);
    result.resolve({ suggested_filename: "Fictional statement.pdf" });
    await rejected;
    expect(await stopping).toMatchObject({ state: "ready", active: false });
    expect(await f.saved()).toMatchObject({ lease: null });
  });

  it("holds a changed host profile before dispatching another read", windowsAdmissionTimeout(20), async () => {
    const f = fixture(); await f.runtime.connect(); await f.runtime.acquire("fictional-job"); await f.runtime.claimTab("fictional-job", 1);
    const count = f.steps.length;
    f.setProfile("fictional-other-profile");
    expect(await f.runtime.status()).toMatchObject({ state: "recovery_required" });
    await expect(f.runtime.observeTab("fictional-job", 1)).rejects.toThrow(/session changed/);
    expect(f.steps).toHaveLength(count);
    await f.runtime.release("fictional-job");
  });

  it("keeps a persisted lease held after restart until explicit recovery closes the old host", windowsAdmissionTimeout(40), async () => {
    const f = fixture(); await f.runtime.connect(); await f.runtime.acquire("fictional-interrupted-job");
    const restarted = new NativeBrowserRuntime(f.options);
    expect(await restarted.status()).toMatchObject({ state: "recovery_required", active: true });
    expect(restarted.isOwner("fictional-interrupted-job")).toBe(false);
    await expect(restarted.acquire("fictional-next-job")).rejects.toThrow(/active or needs recovery/);
    const openings = f.host.ensureOpen.mock.calls.length;
    await restarted.resumeConnection();
    expect(f.host.ensureOpen).toHaveBeenCalledTimes(openings);
    expect(f.controllers).toHaveLength(1);
    expect(await restarted.stop()).toMatchObject({ state: "disconnected", active: false });
    expect(f.host.disconnect).toHaveBeenCalledTimes(1);
    expect(await f.saved()).toMatchObject({ enabled: true, lease: null });
    await restarted.connect(); await restarted.acquire("fictional-next-job");
    await restarted.release("fictional-next-job");
    expect(f.controllers).toHaveLength(2);
  });

  it("never opens a window when RealBud starts, even after an earlier connection", windowsAdmissionTimeout(20), async () => {
    const f = fixture(); await f.runtime.connect(); await f.runtime.stop();
    const restarted = new NativeBrowserRuntime(f.options);
    const openings = f.host.ensureOpen.mock.calls.length;
    await restarted.resumeConnection();
    expect(f.host.ensureOpen).toHaveBeenCalledTimes(openings);
  });

  it("releases the controller before asking the person to sign in, retaining the open host", windowsAdmissionTimeout(20), async () => {
    const f = fixture(); await f.runtime.connect(); await f.runtime.acquire("fictional-job");
    expect(await f.runtime.requestHelp("fictional-job", { tabId: 1, title: "Sign in", prompt: "Finish sign-in yourself." })).toBe("disabled");
    expect(f.runtime.isOwner("fictional-job")).toBe(false);
    expect(f.controllers[0].state).toBe("released");
    expect(f.host.disconnect).not.toHaveBeenCalled();
    expect(await f.saved()).toMatchObject({ lease: null });
  });

  it.each([{ truncated: true }, { next_cursor: "fictional-more" }])("withholds incomplete observations (%j)", windowsAdmissionTimeout(20), async (incomplete) => {
    const f = fixture(); await f.runtime.connect(); await f.runtime.acquire("fictional-job"); await f.runtime.claimTab("fictional-job", 1);
    f.replies.read = async () => ({ snapshot, ...incomplete });
    await expect(f.runtime.observeTab("fictional-job", 1)).rejects.toThrow(/incomplete accessibility observation/);
    await f.runtime.release("fictional-job");
  });
  it("launches the work browser when it is not running before opening a sign-in tab", async () => {
    const f = fixture();
    const opened: string[] = [];
    Object.assign(f.host, { openTab: vi.fn(async (url: string) => { opened.push(url); return "FICTIONALTARGET"; }), tabUrl: vi.fn(async () => "https://portal.fictional.example/home") });
    expect((await f.runtime.status()).state).not.toBe("ready");
    expect(await f.runtime.openSignInTab("https://portal.fictional.example/")).toBe("FICTIONALTARGET");
    expect(f.host.ensureOpen).toHaveBeenCalledTimes(1);
    expect((await f.runtime.status()).state).toBe("ready");
    expect(opened).toEqual(["https://portal.fictional.example/"]);
    // Already running: no second launch, and the tab's address is read without a task lease.
    await f.runtime.openSignInTab("https://portal.fictional.example/");
    expect(f.host.ensureOpen).toHaveBeenCalledTimes(1);
    expect(await f.runtime.signInTabUrl("FICTIONALTARGET")).toBe("https://portal.fictional.example/home");
    // A long wait's refresh loads the page again in that tab: no new tab and no task lease.
    const navigateTab = vi.fn(async () => {}); Object.assign(f.host, { navigateTab });
    await f.runtime.reloadSignInTab("FICTIONALTARGET", "https://portal.fictional.example/");
    expect(navigateTab).toHaveBeenCalledWith("FICTIONALTARGET", "https://portal.fictional.example/");
    expect(opened).toHaveLength(2);
    expect(f.makeControllerCalls()).toBe(0);
  });
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  HERMIOS_HOME_URL,
  HERMIOS_PARTITION,
  clampViewBounds,
  hermiosNavigationAction,
  isAllowedHermiosNavigation,
  isGrantedHermiosPermission,
  isHermiosUrl,
  isWindowRenderer,
  parseViewBounds,
  registerHermiosView,
} from "./hermios-view.mjs";

describe("Hermios navigation allowlist", () => {
  const table = [
    ["https://app.hermios.app", "allow"],
    ["https://app.hermios.app/sign-in?next=%2F", "allow"],
    ["https://acme.hermios.app/objects/people", "allow"],
    ["https://api.hermios.app/auth/google", "allow"],
    ["https://docs.hermios.app/", "allow"],
    ["https://hermios.app/", "allow"],
    ["https://APP.Hermios.APP/", "allow"],
    ["https://accounts.google.com/o/oauth2/v2/auth?client_id=x", "allow"],
    ["https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "allow"],
    ["https://login.live.com/oauth20_authorize.srf", "allow"],
    // Look-alikes and other sites leave for the default browser.
    ["https://hermios.app.evil.com/", "external"],
    ["https://evilhermios.app/", "external"],
    ["https://app.hermios.app.evil.com/sign-in", "external"],
    ["https://hermios.application.com/", "external"],
    ["https://app.hermios.app%2eevil.com/", "external"],
    ["https://.hermios.app/", "external"],
    ["https://app.hermios.app./", "external"],
    ["https://accounts.google.com.evil.com/", "external"],
    ["https://mail.google.com/", "external"],
    ["https://example.com/", "external"],
    // An explicit port is not the Hermios site.
    ["https://app.hermios.app:8443/", "external"],
    // Not plain https, or carrying credentials: dropped.
    ["http://app.hermios.app/", "ignore"],
    ["javascript:alert(1)", "ignore"],
    ["file:///etc/passwd", "ignore"],
    ["data:text/html,<p>hi</p>", "ignore"],
    ["about:blank", "ignore"],
    ["realbud://open", "ignore"],
    ["https://user:pass@app.hermios.app/", "ignore"],
    ["https://app.hermios.app@evil.com/", "ignore"],
    ["", "ignore"],
    ["not a url", "ignore"],
    [`https://app.hermios.app/${"a".repeat(9000)}`, "ignore"],
    [null, "ignore"],
    [42, "ignore"],
  ];

  it.each(table)("%s → %s", (url, expected) => {
    expect(hermiosNavigationAction(url)).toBe(expected);
    expect(isAllowedHermiosNavigation(url)).toBe(expected === "allow");
  });

  it("treats only Hermios pages, not sign-in providers, as Hermios", () => {
    expect(isHermiosUrl("https://acme.hermios.app/objects/companies")).toBe(true);
    expect(isHermiosUrl("https://accounts.google.com/")).toBe(false);
    expect(isHermiosUrl("https://evilhermios.app/")).toBe(false);
    expect(isHermiosUrl("chrome-error://chromewebdata/")).toBe(false);
  });

  it("grants only sanitized clipboard writes and fullscreen", () => {
    expect(isGrantedHermiosPermission("clipboard-sanitized-write")).toBe(true);
    expect(isGrantedHermiosPermission("fullscreen")).toBe(true);
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "display-capture", "openExternal", "hid", "usb", "serial", "unknown"]) {
      expect(isGrantedHermiosPermission(permission)).toBe(false);
    }
  });
});

describe("Hermios view IPC payloads", () => {
  it("accepts finite non-negative bounds and keeps only the four fields", () => {
    expect(parseViewBounds({ x: 0, y: 64.5, width: 900, height: 600, extra: "x" })).toEqual({ x: 0, y: 64.5, width: 900, height: 600 });
  });

  it.each([
    undefined,
    null,
    "0,0,10,10",
    [0, 0, 10, 10],
    {},
    { x: 0, y: 0, width: 10 },
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: Number.NaN, height: 10 },
    { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
    { x: "0", y: 0, width: 10, height: 10 },
  ])("rejects %j", (payload) => {
    expect(parseViewBounds(payload)).toBeNull();
  });

  it("clamps to the window content and applies page zoom", () => {
    expect(clampViewBounds({ x: 200, y: 100, width: 5000, height: 5000 }, { width: 1200, height: 800 })).toEqual({ x: 200, y: 100, width: 1000, height: 700 });
    expect(clampViewBounds({ x: 5000, y: 5000, width: 10, height: 10 }, { width: 1200, height: 800 })).toEqual({ x: 1200, y: 800, width: 0, height: 0 });
    expect(clampViewBounds({ x: 100.4, y: 50.6, width: 300, height: 200 }, { width: 1200, height: 800 }, 1.5)).toEqual({ x: 151, y: 76, width: 450, height: 300 });
    expect(clampViewBounds({ x: 10, y: 10, width: 10, height: 10 }, { width: 100, height: 100 }, Number.NaN)).toEqual({ x: 10, y: 10, width: 10, height: 10 });
  });

  it("accepts only the window's own top frame as the sender", () => {
    const top = { parent: null };
    const win = { webContents: {}, isDestroyed: () => false };
    expect(isWindowRenderer({ sender: win.webContents, senderFrame: top }, win)).toBe(true);
    expect(isWindowRenderer({ sender: win.webContents, senderFrame: { parent: top } }, win)).toBe(false);
    expect(isWindowRenderer({ sender: {}, senderFrame: top }, win)).toBe(false);
    expect(isWindowRenderer({ sender: win.webContents, senderFrame: null }, win)).toBe(false);
    expect(isWindowRenderer({ sender: win.webContents, senderFrame: top }, null)).toBe(false);
    expect(isWindowRenderer({ sender: win.webContents, senderFrame: top }, { ...win, isDestroyed: () => true })).toBe(false);
  });
});

/** Just enough of Electron to drive the controller. */
function fakeElectron() {
  const handlers = new Map();
  const views = [];
  const partitions = [];
  const external = [];
  const ses = {
    request: null,
    check: null,
    setPermissionRequestHandler: vi.fn((fn) => { ses.request = fn; }),
    setPermissionCheckHandler: vi.fn((fn) => { ses.check = fn; }),
    setDevicePermissionHandler: vi.fn(),
    clearStorageData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
  };
  class FakeContents extends EventEmitter {
    constructor() {
      super();
      this.url = "";
      this.loads = [];
      this.focused = false;
      this.closed = false;
      this.reload = vi.fn();
      this.navigationHistory = { canGoBack: vi.fn(() => true), goBack: vi.fn(), clear: vi.fn() };
    }
    loadURL(url) { this.loads.push(url); this.url = url; return Promise.resolve(); }
    getURL() { return this.url; }
    isDestroyed() { return this.closed; }
    isFocused() { return this.focused; }
    focus() { this.focused = true; }
    close() { this.closed = true; }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    getZoomFactor() { return 1; }
  }
  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeContents();
      this.visible = true;
      this.bounds = null;
      views.push(this);
    }
    setVisible(visible) { this.visible = visible; }
    setBounds(bounds) { this.bounds = bounds; }
  }
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new FakeContents();
      this.children = [];
      this.contentView = { addChildView: (view) => this.children.push(view) };
      this.destroyed = false;
    }
    isDestroyed() { return this.destroyed; }
    getContentSize() { return [1200, 800]; }
  }
  const windows = [];
  const electron = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    BrowserWindow: { fromWebContents: (contents) => windows.find((win) => win.webContents === contents || win.children.some((view) => view.webContents === contents)) ?? null },
    WebContentsView,
    session: { fromPartition: (name) => { partitions.push(name); return ses; } },
    shell: { openExternal: vi.fn(async (url) => { external.push(url); }) },
  };
  const newWindow = () => { const win = new FakeWindow(); windows.push(win); return win; };
  const fromWindow = (win) => ({ sender: win.webContents, senderFrame: { parent: null } });
  const invoke = (channel, event, payload) => handlers.get(channel)(event, payload);
  return { electron, handlers, views, partitions, external, ses, newWindow, fromWindow, invoke };
}

describe("Hermios view controller", () => {
  const bounds = { x: 240, y: 180, width: 900, height: 560 };

  it("registers exactly the six Hermios channels", () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    expect([...fake.handlers.keys()].sort()).toEqual([
      "hermios-view:back",
      "hermios-view:hide",
      "hermios-view:open-external",
      "hermios-view:reload",
      "hermios-view:show",
      "hermios-view:sign-out",
    ]);
  });

  it("creates one sandboxed view lazily, loads sign-in once and keeps the page across tab switches", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    expect(fake.views).toHaveLength(0);
    expect(await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds)).toBe(true);
    expect(fake.views).toHaveLength(1);
    const [view] = fake.views;
    expect(view.options.webPreferences).toMatchObject({ partition: HERMIOS_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
    expect(view.options.webPreferences.preload).toBeUndefined();
    expect(fake.partitions.every((name) => name === "persist:hermios")).toBe(true);
    expect(win.children).toEqual([view]);
    expect(view.bounds).toEqual(bounds);
    expect(view.visible).toBe(true);
    expect(view.webContents.loads).toEqual([HERMIOS_HOME_URL]);

    expect(await fake.invoke("hermios-view:hide", fake.fromWindow(win))).toBe(true);
    expect(view.visible).toBe(false);
    view.webContents.url = "https://acme.hermios.app/objects/people";
    expect(await fake.invoke("hermios-view:show", fake.fromWindow(win), { ...bounds, height: 400 })).toBe(true);
    expect(fake.views).toHaveLength(1);
    expect(view.webContents.loads).toEqual([HERMIOS_HOME_URL]);
    expect(view.bounds).toEqual({ ...bounds, height: 400 });
  });

  it("refuses senders other than the window's own top frame and malformed payloads", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    expect(await fake.invoke("hermios-view:show", { sender: win.webContents, senderFrame: { parent: { parent: null } } }, bounds)).toBe(false);
    expect(await fake.invoke("hermios-view:show", { sender: {}, senderFrame: { parent: null } }, bounds)).toBe(false);
    expect(await fake.invoke("hermios-view:show", fake.fromWindow(win), { x: -1, y: 0, width: 10, height: 10 })).toBe(false);
    expect(fake.views).toHaveLength(0);

    await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds);
    const view = fake.views[0];
    // The Hermios page itself can never drive its own view.
    const fromView = { sender: view.webContents, senderFrame: { parent: null } };
    expect(await fake.invoke("hermios-view:hide", fromView)).toBe(false);
    expect(await fake.invoke("hermios-view:sign-out", fromView)).toBe(false);
    expect(view.visible).toBe(true);
    // Argument-free channels refuse a payload.
    expect(await fake.invoke("hermios-view:hide", fake.fromWindow(win), { now: true })).toBe(false);
    expect(await fake.invoke("hermios-view:reload", fake.fromWindow(win), "x")).toBe(false);
    expect(view.webContents.reload).not.toHaveBeenCalled();
  });

  it("hides instead of showing an empty rectangle and hands focus back to the window", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds);
    const view = fake.views[0];
    view.webContents.focused = true;
    expect(await fake.invoke("hermios-view:show", fake.fromWindow(win), { x: 5000, y: 0, width: 100, height: 100 })).toBe(false);
    expect(view.visible).toBe(false);
    expect(win.webContents.focused).toBe(true);
  });

  it("keeps navigation on Hermios and sign-in hosts, sends other https out, and never opens a popup", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds);
    const contents = fake.views[0].webContents;
    const navigate = (channel, url, isMainFrame = true) => {
      const event = { url, isMainFrame, preventDefault: vi.fn() };
      contents.emit(channel, event);
      return event.preventDefault.mock.calls.length > 0;
    };
    vi.useFakeTimers();
    try {
      expect(navigate("will-navigate", "https://accounts.google.com/o/oauth2/v2/auth")).toBe(false);
      expect(navigate("will-redirect", "https://acme.hermios.app/verify")).toBe(false);
      expect(navigate("will-navigate", "https://hermios.app.evil.com/")).toBe(true);
      expect(fake.external).toEqual(["https://hermios.app.evil.com/"]);
      vi.advanceTimersByTime(1_500);
      expect(navigate("will-redirect", "http://acme.hermios.app/")).toBe(true);
      expect(navigate("will-navigate", "file:///etc/passwd")).toBe(true);
      expect(fake.external).toEqual(["https://hermios.app.evil.com/"]);
      // An embedded frame's redirect stays inside its frame.
      expect(navigate("will-redirect", "https://challenges.example.com/", false)).toBe(false);
      // A page cannot flood the default browser.
      expect(navigate("will-navigate", "https://example.com/a")).toBe(true);
      expect(navigate("will-navigate", "https://example.com/b")).toBe(true);
      expect(fake.external).toEqual(["https://hermios.app.evil.com/", "https://example.com/a"]);

      vi.advanceTimersByTime(1_500);
      expect(contents.openHandler({ url: "https://acme.hermios.app/objects/companies" })).toEqual({ action: "deny" });
      expect(contents.loads.at(-1)).toBe("https://acme.hermios.app/objects/companies");
      expect(contents.openHandler({ url: "https://example.org/" })).toEqual({ action: "deny" });
      expect(fake.external.at(-1)).toBe("https://example.org/");
      expect(contents.openHandler({ url: "javascript:void 0" })).toEqual({ action: "deny" });
      expect(fake.external.at(-1)).toBe("https://example.org/");
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies every permission on the partition except clipboard writes and fullscreen", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds);
    const answer = (permission) => { let granted; fake.ses.request(null, permission, (value) => { granted = value; }); return granted; };
    expect(answer("media")).toBe(false);
    expect(answer("notifications")).toBe(false);
    expect(answer("clipboard-sanitized-write")).toBe(true);
    expect(answer("fullscreen")).toBe(true);
    expect(fake.ses.check(null, "clipboard-read")).toBe(false);
    expect(fake.ses.check(null, "fullscreen")).toBe(true);
    expect(fake.ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });

  it("goes back and reloads only a loaded view", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    expect(await fake.invoke("hermios-view:back", fake.fromWindow(win))).toBe(false);
    expect(await fake.invoke("hermios-view:reload", fake.fromWindow(win))).toBe(false);
    await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds);
    const contents = fake.views[0].webContents;
    expect(await fake.invoke("hermios-view:back", fake.fromWindow(win))).toBe(true);
    expect(contents.navigationHistory.goBack).toHaveBeenCalledTimes(1);
    contents.navigationHistory.canGoBack.mockReturnValue(false);
    expect(await fake.invoke("hermios-view:back", fake.fromWindow(win))).toBe(false);
    expect(await fake.invoke("hermios-view:reload", fake.fromWindow(win))).toBe(true);
    expect(contents.reload).toHaveBeenCalledTimes(1);
  });

  it("signs out by clearing only the Hermios partition, then shows sign-in", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds);
    const contents = fake.views[0].webContents;
    contents.url = "https://acme.hermios.app/objects/people";
    expect(await fake.invoke("hermios-view:sign-out", fake.fromWindow(win))).toBe(true);
    expect(fake.ses.clearStorageData).toHaveBeenCalledTimes(1);
    expect(fake.ses.clearCache).toHaveBeenCalledTimes(1);
    expect(fake.partitions.every((name) => name === HERMIOS_PARTITION)).toBe(true);
    expect(contents.navigationHistory.clear).toHaveBeenCalledTimes(1);
    expect(contents.loads.at(-1)).toBe(HERMIOS_HOME_URL);
  });

  it("opens the current Hermios page externally, or sign-in when the page is anything else", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    expect(await fake.invoke("hermios-view:open-external", fake.fromWindow(win))).toBe(true);
    expect(fake.external.at(-1)).toBe(HERMIOS_HOME_URL);
    await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds);
    const contents = fake.views[0].webContents;
    contents.url = "https://acme.hermios.app/objects/people/1";
    await fake.invoke("hermios-view:open-external", fake.fromWindow(win));
    expect(fake.external.at(-1)).toBe("https://acme.hermios.app/objects/people/1");
    contents.url = "https://accounts.google.com/signin/challenge";
    await fake.invoke("hermios-view:open-external", fake.fromWindow(win));
    expect(fake.external.at(-1)).toBe(HERMIOS_HOME_URL);
  });

  it("hides the view when the window's page navigates away or crashes, and closes it with the window", async () => {
    const fake = fakeElectron();
    registerHermiosView(fake.electron);
    const win = fake.newWindow();
    await fake.invoke("hermios-view:show", fake.fromWindow(win), bounds);
    const view = fake.views[0];
    win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(view.visible).toBe(true);
    win.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(view.visible).toBe(false);
    view.visible = true;
    win.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(view.visible).toBe(false);
    win.emit("closed");
    expect(view.webContents.closed).toBe(true);
  });
});

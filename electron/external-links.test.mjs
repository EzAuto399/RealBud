import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { externalHttpsUrl, guardOfficeWindow, onAppOrigin, openExternalHttps } from "./external-links.mjs";

const UNSAFE = [
  "file:///etc/passwd",
  "file://server/share/payload.exe",
  "smb://attacker.example/share",
  "http://example.com/",
  "javascript:alert(1)",
  "data:text/html,<script>1</script>",
  "mailto:tenant@example.com",
  "vscode://file/etc/passwd",
  "ms-msdt:/id PCWDiagnostic",
  "x-apple.systempreferences:com.apple.preference.security",
  "https://user:pass@example.com/",
  "https://bank.example@evil.example/",
  "not a url",
  "",
  undefined,
  null,
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeContents() {
  const handlers = {};
  return {
    handlers,
    openHandler: null,
    on(name, fn) { handlers[name] = fn; },
    setWindowOpenHandler(fn) { this.openHandler = fn; },
  };
}

function navigation(url, isMainFrame = true) {
  return { url, isMainFrame, preventDefault: vi.fn() };
}

function guarded(appUrl = () => "http://127.0.0.1:8799") {
  const contents = fakeContents();
  const shell = { openExternal: vi.fn(async () => {}) };
  const log = vi.fn();
  guardOfficeWindow(contents, { appUrl, shell, log });
  return { contents, shell, log };
}

describe("external https links", () => {
  it("lets only plain https leave the app", () => {
    expect(externalHttpsUrl("https://realbud.app/account")).toBe("https://realbud.app/account");
    expect(externalHttpsUrl("HTTPS://Example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    for (const raw of UNSAFE) expect(externalHttpsUrl(raw), String(raw)).toBeNull();
  });

  it("hands the OS https only, and reports a refused or failed open as false", async () => {
    const shell = { openExternal: vi.fn(async () => {}) };
    expect(await openExternalHttps(shell, "https://example.com/x")).toBe(true);
    for (const raw of UNSAFE) expect(await openExternalHttps(shell, raw)).toBe(false);
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/x");
    const failing = { openExternal: vi.fn(async () => { throw new Error("no handler"); }) };
    expect(await openExternalHttps(failing, "https://example.com/")).toBe(false);
  });
});

describe("app origin", () => {
  it("matches the office origin exactly", () => {
    expect(onAppOrigin("http://127.0.0.1:8799/desk?x=1", "http://127.0.0.1:8799")).toBe(true);
    expect(onAppOrigin("http://127.0.0.1:8799/", "http://127.0.0.1:5199/some/path")).toBe(false);
    expect(onAppOrigin("http://localhost:8799/", "http://127.0.0.1:8799")).toBe(false);
    expect(onAppOrigin("https://127.0.0.1:8799/", "http://127.0.0.1:8799")).toBe(false);
    expect(onAppOrigin("blob:http://127.0.0.1:8799/0b4c", "http://127.0.0.1:8799")).toBe(true);
  });

  it("never treats an opaque origin as the app", () => {
    for (const app of ["data:text/html,waiting", "file:///Applications/RealBud.app/index.html", "about:blank", "nonsense"]) {
      for (const target of ["data:text/html,x", "file:///etc/passwd", "about:blank", app]) {
        expect(onAppOrigin(target, app), `${target} on ${app}`).toBe(false);
      }
    }
  });
});

describe("office window guard", () => {
  it("denies every popup and opens only https ones in the browser", async () => {
    const { contents, shell, log } = guarded();
    for (const url of ["https://example.com/a", "file:///etc/passwd", "smb://host/share", "http://127.0.0.1:8799/x"]) {
      expect(contents.openHandler({ url })).toEqual({ action: "deny" });
    }
    await flush();
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/a");
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "kept a file: link inside the desk",
      "kept a smb: link inside the desk",
      "kept a http: link inside the desk",
    ]);
  });

  it("lets the desk move within its origin and stops everything else", async () => {
    const { contents, shell } = guarded();
    const inside = navigation("http://127.0.0.1:8799/desk");
    contents.handlers["will-navigate"](inside);
    expect(inside.preventDefault).not.toHaveBeenCalled();

    const away = navigation("https://example.com/phish");
    contents.handlers["will-navigate"](away);
    expect(away.preventDefault).toHaveBeenCalledOnce();

    const local = navigation("file:///Users/someone/Desktop/run.command");
    contents.handlers["will-navigate"](local);
    expect(local.preventDefault).toHaveBeenCalledOnce();

    await flush();
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/phish");
  });

  it("follows the office port when it changes under a live window", () => {
    let port = 8799;
    const { contents } = guarded(() => `http://127.0.0.1:${port}`);
    port = 18799;
    const moved = navigation("http://127.0.0.1:18799/");
    contents.handlers["will-navigate"](moved);
    expect(moved.preventDefault).not.toHaveBeenCalled();
    const stale = navigation("http://127.0.0.1:8799/");
    contents.handlers["will-navigate"](stale);
    expect(stale.preventDefault).toHaveBeenCalledOnce();
  });

  it("stops a main-frame redirect off the origin but leaves subframes alone", async () => {
    const { contents, shell } = guarded();
    const redirect = navigation("https://elsewhere.example/");
    contents.handlers["will-redirect"](redirect);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
    const frame = navigation("https://embed.example/", false);
    contents.handlers["will-redirect"](frame);
    expect(frame.preventDefault).not.toHaveBeenCalled();
    await flush();
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("https://elsewhere.example/");
  });

  it("reads the deprecated url argument when the details carry none", () => {
    const { contents } = guarded();
    const event = { preventDefault: vi.fn() };
    contents.handlers["will-navigate"](event, "smb://host/share");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("stops everything while the window shows a fallback page", () => {
    const { contents } = guarded(() => "data:text/html,waiting");
    const event = navigation("data:text/html,other");
    contents.handlers["will-navigate"](event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("main process wiring", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

  it("guards the office window and keeps its renderer sandboxed", () => {
    expect(main).toMatch(/guardOfficeWindow\(win\.webContents,/);
    expect(main).not.toMatch(/win\.webContents\.(setWindowOpenHandler\(|on\("will-(navigate|redirect)")/);
    expect(main).toMatch(/webPreferences:\s*\{[^}]*sandbox:\s*true/);
    expect(main).toMatch(/ipcMain\.handle\("external:open",\s*\(_event, rawUrl\)\s*=>\s*openExternalHttps\(shell, rawUrl\)\)/);
  });
});

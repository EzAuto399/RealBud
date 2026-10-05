import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkBrowserHost } from "./work-browser-host.ts";
import { privateTempRoot } from "./testing/private-fixture.ts";
import { writePrivateJson } from "./private-json.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const endpoint = "ws://127.0.0.1:49321/devtools/browser/fictional-browser";
const portText = "49321\n/devtools/browser/fictional-browser\n";
const bundle = { executable: "/synthetic/agent-browser", sha256: "a".repeat(64) };
class BrowserChild extends EventEmitter {
  pid = 876543; exitCode: number | null = null; signalCode: string | null = null;
  stderr = new PassThrough(); signals: string[] = []; ignoresStop = false;
  kill(signal: string) { this.signals.push(signal); if (!this.ignoresStop) queueMicrotask(() => { this.signalCode = signal; this.emit("exit", null, signal); }); return true; }
}
// disconnect() re-verifies the private profile before closing; on Windows each
// ACL admission launches PowerShell, so 30 ms cannot cover the confirmed close.
async function fixture({ announce = true, version = endpoint, stopTimeoutMs = process.platform === "win32" ? 5000 : 30 } = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-work-host-")); roots.push(root);
  let reportedVersion = version; let launches = 0; const children: BrowserChild[] = [];
  const calls: { executable: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const dependencies = {
    findBrowser: async () => "/synthetic/Google Chrome",
    launch: (executable: string, args: string[], env: NodeJS.ProcessEnv) => {
      launches++; calls.push({ executable, args, env }); const child = new BrowserChild(); children.push(child);
      if (announce) void writeFile(join(root, "profile", "DevToolsActivePort"), portText).then(() => { child.stderr.write(`DevTools listening on ${endpoint}\n`); });
      return child as unknown as ChildProcess;
    },
    versionEndpoint: async () => reportedVersion,
    closeBrowser: async () => { children.at(-1)!.kill("BROWSER_CLOSE"); },
    isAlive: () => false,
    admit: async () => bundle,
    startupTimeoutMs: 60,
    stopTimeoutMs,
  };
  const host = new WorkBrowserHost({ root, bundleRoot: "/synthetic/bundle" }, dependencies);
  return { host, root, calls, children, dependencies, launches: () => launches, setVersion: (value: string) => { reportedVersion = value; } };
}

describe("dedicated work browser host", () => {
  it("opens only a headed dedicated profile, keeps its login data across launches, and never inherits provider keys", async () => {
    const f = await fixture(); const first = await f.host.ensureOpen();
    expect(first.endpoint).toBe(endpoint); expect((await f.host.status()).state).toBe("ready");
    expect(f.calls[0].args).toContain(`--user-data-dir=${join(f.root, "profile")}`);
    expect(f.calls[0].args).toContain("--remote-debugging-address=127.0.0.1");
    expect(f.calls[0].args).not.toContain("--headless");
    expect(f.calls[0].args.join(" ")).not.toMatch(/auto-connect|use-real|disable-web-security|no-sandbox|remote-allow-origins/);
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HTTP_PROXY", "NODE_OPTIONS", "AGENT_BROWSER_PROFILE", "REALBUD_WORKSPACE_KEY"]) expect(f.calls[0].env).not.toHaveProperty(key);
    await writeFile(join(f.root, "profile", "fictional-login-state"), "fictional session", { mode: 0o600 });
    await f.host.disconnect(); expect(f.children[0].signals).toEqual(["BROWSER_CLOSE"]);
    expect((await f.host.status()).state).toBe("disconnected");
    expect(await readFile(join(f.root, "profile", "fictional-login-state"), "utf8")).toBe("fictional session");
    const second = await f.host.ensureOpen(); expect(second.profileId).toBe(first.profileId);
    expect(f.launches()).toBe(2); await f.host.disconnect();
    if (process.platform !== "win32") expect((await lstat(join(f.root, "profile"))).mode & 0o077).toBe(0);
  });
  it("deduplicates concurrent opens and withholds connection endpoints from public status", async () => {
    const f = await fixture(); const [a, b] = await Promise.all([f.host.ensureOpen(), f.host.ensureOpen()]);
    expect(a.profileId).toBe(b.profileId); expect(f.launches()).toBe(1);
    expect(await f.host.status()).not.toHaveProperty("endpoint"); await f.host.disconnect();
  });
  it("rejects a loopback responder with a different browser identity", async () => {
    const f = await fixture({ version: "ws://127.0.0.1:49321/devtools/browser/fictional-other" });
    await expect(f.host.ensureOpen()).rejects.toThrow(/recovery/);
    expect((await f.host.status()).state).toBe("recovery_required");
    // Own child's fresh announcement permits safe cleanup, but never attach.
    await f.host.disconnect();
    expect(f.children[0].signals).toEqual(["SIGTERM"]);
  });
  it("does not launch or attach to a stale endpoint without an ownership receipt", async () => {
    const f = await fixture(); await f.host.status();
    await writeFile(join(f.root, "profile", "DevToolsActivePort"), portText);
    await expect(f.host.ensureOpen()).rejects.toThrow(/recovery/); expect(f.launches()).toBe(0);
  });
  it("never adopts or signals a prior live PID, even if its CDP file matches", async () => {
    const f = await fixture(); const ready = await f.host.ensureOpen();
    const other = new WorkBrowserHost({ root: f.root, bundleRoot: "/synthetic/bundle" }, { ...f.dependencies, isAlive: () => true });
    expect((await other.status()).state).toBe("recovery_required");
    await expect(other.ensureOpen()).rejects.toThrow(/still open/);
    expect(f.launches()).toBe(1); expect(f.children[0].signals).toEqual([]);
    expect(ready.endpoint).toBe(endpoint); await f.host.disconnect();
  });
  it("allows reconnect on the same host after the previous process is closed by the person", async () => {
    const f = await fixture(); await f.host.ensureOpen();
    let priorAlive = true;
    const other = new WorkBrowserHost({ root: f.root, bundleRoot: "/synthetic/bundle" }, { ...f.dependencies, isAlive: () => priorAlive });
    expect((await other.status()).state).toBe("recovery_required");
    f.children[0].signalCode = "SIGTERM"; priorAlive = false;
    expect((await other.status()).state).toBe("disconnected");
    await other.ensureOpen(); expect(f.launches()).toBe(2); await other.disconnect();
  });
  it("cleans only the exact receipt of an already exited prior process and preserves the profile", async () => {
    const f = await fixture(); const ready = await f.host.ensureOpen();
    f.children[0].signalCode = "SIGTERM";
    const replacement = new WorkBrowserHost({ root: f.root, bundleRoot: "/synthetic/bundle" }, f.dependencies);
    expect((await replacement.status()).state).toBe("disconnected");
    expect((await replacement.ensureOpen()).profileId).toBe(ready.profileId);
    await replacement.disconnect();
  });
  it("refuses linked profile directories and altered identity files", async () => {
    const f = await fixture(); await f.host.status();
    const outside = join(f.root, "fictional-other-profile"); await mkdir(outside, { mode: 0o700 });
    await rm(join(f.root, "profile"), { recursive: true }); await symlink(outside, join(f.root, "profile"), "dir");
    await expect(f.host.ensureOpen()).rejects.toThrow(); expect(f.launches()).toBe(0);
    const g = await fixture(); await g.host.status();
    await writePrivateJson(join(g.root, "profile.json"), { version: 1, purpose: "unrelated", id: "fictional" });
    const other = new WorkBrowserHost({ root: g.root, bundleRoot: "/synthetic/bundle" }, g.dependencies);
    expect((await other.status()).state).toBe("recovery_required"); expect(g.launches()).toBe(0);
  });
  it("holds recovery after the endpoint changes while a browser is open", async () => {
    const f = await fixture(); await f.host.ensureOpen(); f.setVersion("ws://127.0.0.1:49321/devtools/browser/fictional-replaced");
    expect((await f.host.status()).state).toBe("recovery_required");
    await expect(f.host.ensureOpen()).rejects.toThrow(/recovery/); await f.host.disconnect();
  });
  it("revokes opening on disconnect without reporting late readiness", async () => {
    const f = await fixture({ announce: false }); const opening = f.host.ensureOpen();
    const rejected = expect(opening).rejects.toThrow(/stopped/);
    await f.host.disconnect(); await rejected;
    expect(f.launches()).toBe(0); expect((await f.host.status()).state).toBe("disconnected");
  });
  it("keeps an unconfirmed stop in recovery and cannot relaunch over it", async () => {
    const f = await fixture(); await f.host.ensureOpen(); f.children[0].ignoresStop = true;
    await expect(f.host.disconnect()).rejects.toThrow(/not confirmed/);
    expect((await f.host.status()).state).toBe("recovery_required");
    await expect(f.host.ensureOpen()).rejects.toThrow(/recovery/); expect(f.launches()).toBe(1);
    f.children[0].ignoresStop = false; await f.host.disconnect();
  });
  it("opens an HTTPS sign-in tab through its own CDP endpoint, brings it forward and reads only its address", async () => {
    const f = await fixture();
    const sent: Array<{ endpoint: string; method: string; params: Record<string, unknown>; targetId?: string }> = [];
    const cdp = async (at: string, method: string, params: Record<string, unknown>, targetId?: string) => {
      sent.push({ endpoint: at, method, params, ...(targetId ? { targetId } : {}) });
      return method === "Target.createTarget" ? { targetId: "FICTIONALTARGET1" }
        : method === "Target.getTargets" ? { targetInfos: [{ targetId: "FICTIONALTARGET1", url: "https://portal.fictional.example/home" }] } : {};
    };
    const host = new WorkBrowserHost({ root: f.root, bundleRoot: "/synthetic/bundle" }, { ...f.dependencies, cdp });
    expect(await host.tabUrl("FICTIONALTARGET1")).toBeNull();
    await expect(host.navigateTab("FICTIONALTARGET1", "https://portal.fictional.example/")).rejects.toThrow(/closed/);
    await expect(host.openTab("http://portal.fictional.example/")).rejects.toThrow(/HTTPS/);
    expect(f.launches()).toBe(0);
    expect(await host.openTab("https://portal.fictional.example/")).toBe("FICTIONALTARGET1");
    expect(f.launches()).toBe(1);
    expect(sent.map(row => [row.endpoint, row.method])).toEqual([[endpoint, "Target.createTarget"], [endpoint, "Target.activateTarget"]]);
    expect(await host.tabUrl("FICTIONALTARGET1")).toBe("https://portal.fictional.example/home");
    expect(await host.tabUrl("FICTIONALOTHER")).toBeNull();
    // A long sign-in wait's refresh: the same tab loads the address again, in place, without coming forward.
    await expect(host.navigateTab("FICTIONALTARGET1", "http://portal.fictional.example/")).rejects.toThrow(/HTTPS/);
    await host.navigateTab("FICTIONALTARGET1", "https://portal.fictional.example/");
    expect(sent.filter(row => row.method !== "Target.getTargets").slice(2)).toEqual([{ endpoint, method: "Page.navigate", params: { url: "https://portal.fictional.example/" }, targetId: "FICTIONALTARGET1" }]);
    await host.disconnect();
  });
});

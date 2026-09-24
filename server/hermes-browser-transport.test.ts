import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { admitHermesEngine, HermesBrowserTransport, ownedBrowserEndpoint, type HermesEngineExec, type HermesEngineStep } from "./hermes-browser-transport.ts";

const deferred = () => { let resolve!: (value: Record<string, unknown>) => void; let reject!: (error: Error) => void; const promise = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const roots: string[] = [];
const tempRoot = async (prefix: string) => { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root; };
const tabs = { tabs: [{ tabId: "t1", active: true }, { tabId: "t2", active: false }] };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(run?: HermesEngineExec) {
  const root = await tempRoot("rb-native-engine-");
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const transport = new HermesBrowserTransport({ root, endpoint: "http://127.0.0.1:9222", bundle: { executable: "/fictional/agent-browser", sha256: "a".repeat(64) }, exec: async (bin, args, options) => { calls.push(args); envs.push(options.env); return run ? run(bin, args, options) : tabs; } });
  return { root, calls, envs, transport };
}
const command = (args: string[]) => args.slice(6, -1);

describe("Hermes native browser transport lifecycle", () => {
  it("does nothing when stopped before startup and cannot be restarted", async () => {
    const f = await fixture(); await f.transport.stop();
    expect(f.transport.state).toBe("released"); expect(f.calls).toEqual([]);
    await expect(f.transport.start()).rejects.toThrow(/cannot be started/);
  });
  it("does not start a daemon when Stop races storage preparation", async () => {
    const f = await fixture(); const starting = f.transport.start();
    const rejected = expect(starting).rejects.toThrow(/stopped during startup/);
    await f.transport.stop(); await rejected; expect(f.calls).toEqual([]);
    expect(f.transport.state).toBe("released");
  });
  it("uses private config, a unique session and stable tab ids", async () => {
    const f = await fixture(); await f.transport.start(); await f.transport.step({ kind: "read", tab: 2 });
    expect(f.calls.map(command)).toEqual([["tab", "list"], ["tab", "list"], ["tab", "t2"], ["snapshot"]]);
    expect(f.envs[0]).toMatchObject({ HOME: join(f.root, "home"), AGENT_BROWSER_SOCKET_DIR: f.root, AGENT_BROWSER_NO_AUTO_DIALOG: "1" });
    for (const key of ["OPENAI_API_KEY", "BROWSER_CDP_URL", "AGENT_BROWSER_PROFILE", "HTTP_PROXY", "NODE_OPTIONS", "PATH"]) expect(f.envs[0]).not.toHaveProperty(key);
    await f.transport.stop(); expect(f.calls.at(-1)).toContain("close");
  });
  it("revokes a queued mutation while selection is still unfinished", async () => {
    const select = deferred();
    const f = await fixture(async (_bin, args) => command(args).join(" ") === "tab t2" ? select.promise : tabs);
    await f.transport.start();
    const action = f.transport.step({ kind: "navigate", tab: 2, url: "https://fictional.example/" });
    // The queued selection has started, then the person presses Stop.
    await new Promise(resolve => setImmediate(resolve));
    const rejected = expect(action).rejects.toThrow(/stopped/);
    const stop = f.transport.stop(); expect(f.transport.state).toBe("stopping");
    await expect(f.transport.step({ kind: "tabs" })).rejects.toThrow(/stopped/);
    select.resolve({}); await rejected; await stop;
    expect(f.calls.map(command)).toEqual([["tab", "list"], ["tab", "list"], ["tab", "t2"], ["close"]]);
    expect(f.transport.state).toBe("released");
  });
  it("waits for an already dispatched effect and marks its late reply uncertain", async () => {
    const clicked = deferred();
    const f = await fixture(async (_bin, args) => command(args)[0] === "click" ? clicked.promise : tabs);
    await f.transport.start(); const action = f.transport.step({ kind: "click", tab: 1, ref: "@e3" });
    await new Promise(resolve => setImmediate(resolve));
    const rejected = expect(action).rejects.toThrow(/ended after Stop/);
    let released = false; const stop = f.transport.stop().then(() => { released = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(released).toBe(false);
    clicked.resolve({}); await rejected; await stop;
    expect(f.calls.map(command).filter(args => args[0] === "click")).toHaveLength(1);
    expect(f.calls.at(-1)).toContain("close");
  });
  it("holds failed release and retries only detachment", async () => {
    let failClose = true;
    const f = await fixture(async (_bin, args) => { if (command(args)[0] === "close" && failClose) throw new Error("fictional lost close reply"); return {}; });
    await f.transport.start(); await expect(f.transport.stop()).rejects.toThrow(/unconfirmed/);
    expect(f.transport.state).toBe("recovery_required"); await expect(f.transport.step({ kind: "tabs" })).rejects.toThrow(/stopped/);
    failClose = false; await f.transport.stop(); expect(f.transport.state).toBe("released");
    expect(f.calls.map(command)).toEqual([["tab", "list"], ["close"], ["close"]]);
  });
  it("does not dispatch a press when Stop occurs after focusing", async () => {
    const focused = deferred(); const f = await fixture(async (_bin, args) => command(args)[0] === "focus" ? focused.promise : tabs);
    await f.transport.start(); const action = f.transport.step({ kind: "press", tab: 1, ref: "@e4", key: "Enter" });
    await new Promise(resolve => setImmediate(resolve)); const rejected = expect(action).rejects.toThrow(/stopped/);
    const stop = f.transport.stop(); focused.resolve({}); await rejected; await stop;
    expect(f.calls.some(args => command(args)[0] === "press")).toBe(false);
  });
  it("honours task cancellation between tab selection and dispatch", async () => {
    const selected = deferred(); const controller = new AbortController();
    let count = 0;
    const f = await fixture(async (_bin, args) => command(args).join(" ") === "tab list" && ++count > 1 ? selected.promise : tabs);
    await f.transport.start(); const action = f.transport.step({ kind: "fill", tab: 1, ref: "@e2", value: "fictional" }, controller.signal);
    await new Promise(resolve => setImmediate(resolve)); const rejected = expect(action).rejects.toThrow(/stopped/);
    controller.abort(); expect(f.transport.state).toBe("stopping"); selected.resolve(tabs); await rejected; await f.transport.stop();
    expect(f.calls.some(args => command(args)[0] === "fill")).toBe(false);
  });
  it("keeps observed refs alive by not reselecting the already active tab", async () => {
    const f = await fixture(); await f.transport.start();
    await f.transport.step({ kind: "read", tab: 1 });
    await f.transport.step({ kind: "click", tab: 1, ref: "@e2" });
    expect(f.calls.map(command)).toEqual([["tab", "list"], ["tab", "list"], ["snapshot"], ["tab", "list"], ["click", "@e2"]]);
    await f.transport.stop();
  });
  it("refuses to switch a ref action onto another tab", async () => {
    const f = await fixture(); await f.transport.start();
    await expect(f.transport.step({ kind: "click", tab: 2, ref: "@e2" })).rejects.toThrow(/active browser tab changed/);
    expect(f.calls.map(command)).toEqual([["tab", "list"], ["tab", "list"]]);
    expect(f.transport.state).toBe("recovery_required"); await f.transport.stop();
  });
  it("withholds a tabs response returned after Stop", async () => {
    const listed = deferred(); let count = 0;
    const f = await fixture(async (_bin, args) => command(args).join(" ") === "tab list" && ++count > 1 ? listed.promise : tabs);
    await f.transport.start(); const action = f.transport.step({ kind: "tabs" });
    await new Promise(resolve => setImmediate(resolve)); const rejected = expect(action).rejects.toThrow(/stopped/);
    const stopping = f.transport.stop(); listed.resolve(tabs); await rejected; await stopping;
  });
  it("holds uncertain native failures and prevents a queued action or retry", async () => {
    const f = await fixture(async (_bin, args) => { if (command(args)[0] === "click") throw new Error("fictional unconfirmed reply"); return tabs; });
    await f.transport.start();
    const first = f.transport.step({ kind: "click", tab: 1, ref: "@e2" });
    const queued = f.transport.step({ kind: "click", tab: 1, ref: "@e2" });
    await expect(first).rejects.toThrow(/unconfirmed/); await expect(queued).rejects.toThrow(/stopped/);
    expect(f.transport.state).toBe("recovery_required");
    expect(f.calls.map(command).filter(args => args[0] === "click")).toHaveLength(1);
    await f.transport.stop();
  });
  it.each([
    { kind: "eval", expression: "document.cookie" },
    { kind: "fill", tab: 1, ref: "#password", value: "fictional" },
    { kind: "fill", tab: 1, ref: "@e1", value: "--cdp=other-host" },
    { kind: "fill", tab: 1, ref: "@e1", value: "-p" },
    { kind: "select", tab: 1, ref: "@e1", values: ["--proxy=other-host"] },
    { kind: "tabs", cookies: true },
  ])("rejects raw selectors, arbitrary commands and CLI flag injection: %j", async step => {
    const f = await fixture(); await f.transport.start();
    await expect(f.transport.step(step as HermesEngineStep)).rejects.toThrow();
    expect(f.calls).toHaveLength(1); await f.transport.stop();
  });
});

describe("admitted native browser bundle and endpoint", () => {
  it.each(["https://example.com/", "http://localhost:9222", "http://127.0.0.1:9222/?token=fictional", "http://fictional:password@127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/page/example", "file:///tmp/browser"])("rejects an unowned endpoint %s", value => expect(() => ownedBrowserEndpoint(value)).toThrow());
  it("accepts only local discovery or browser websocket endpoints", () => {
    expect(ownedBrowserEndpoint("http://127.0.0.1:9222")).toBe("http://127.0.0.1:9222/");
    expect(ownedBrowserEndpoint("ws://127.0.0.1:9222/devtools/browser/fictional-id")).toContain("fictional-id");
  });
  it("rejects changed binary bytes even when the version metadata matches", async () => {
    const root = await tempRoot("rb-native-bundle-");
    const binary = join(root, process.platform === "win32" ? "agent-browser.exe" : "agent-browser");
    await writeFile(binary, "fictional original");
    await writeFile(join(root, "runtime.json"), JSON.stringify({ engine: "hermes-agent-browser", version: "0.26.0", platform: process.platform, arch: process.arch, sha256: createHash("sha256").update("fictional original").digest("hex") }));
    expect((await admitHermesEngine(root)).executable).toBe(binary);
    await writeFile(binary, "fictional replacement"); await expect(admitHermesEngine(root)).rejects.toThrow(/reviewed bundle/);
  });
  it.skipIf(process.platform === "win32")("rejects a symlinked executable", async () => {
    const root = await tempRoot("rb-native-link-"); await mkdir(join(root, "bundle"));
    const binary = join(root, "other"); await writeFile(binary, "fictional");
    await symlink(binary, join(root, "bundle", "agent-browser"));
    await writeFile(join(root, "bundle", "runtime.json"), JSON.stringify({ engine: "hermes-agent-browser", version: "0.26.0", platform: process.platform, arch: process.arch, sha256: createHash("sha256").update("fictional").digest("hex") }));
    await expect(admitHermesEngine(join(root, "bundle"))).rejects.toThrow(/reviewed bundle/);
  });
});

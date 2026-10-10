import { chmod, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { admitHermesEngine, HermesBrowserTransport, ownedBrowserEndpoint, snapshotRows, type HermesEngineExec, type HermesEngineStep } from "./hermes-browser-transport.ts";
import { privateTempRoot } from "./testing/private-fixture.ts";

const deferred = () => { let resolve!: (value: Record<string, unknown>) => void; let reject!: (error: Error) => void; const promise = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const roots: string[] = [];
const tempRoot = async (prefix: string) => { const root = privateTempRoot(join(tmpdir(), prefix)); roots.push(root); return root; };
const tabs = { tabs: [{ tabId: "t1", active: true }, { tabId: "t2", active: false }] };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(run?: HermesEngineExec) {
  const root = await tempRoot("rb-native-engine-");
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const transport = new HermesBrowserTransport({ root, endpoint: "http://127.0.0.1:9222", bundle: { executable: "/fictional/agent-browser", sha256: "a".repeat(64) }, scrollWaitMs: 0, exec: async (bin, args, options) => { calls.push(args); envs.push(options.env); return run ? run(bin, args, options) : tabs; } });
  return { root, calls, envs, transport };
}
const command = (args: string[]) => args.slice(6, -1);

describe("Hermes native browser transport lifecycle", () => {
  it('transfers only host-staged paths with fresh observed controls through the pinned engine', async () => {
    const f = await fixture(); await f.transport.start();
    const path = join(f.root, 'fictional invoice.csv');
    await f.transport.step({ kind: 'download', tab: 1, ref: '@e2', path });
    await f.transport.step({ kind: 'upload', tab: 1, ref: '@e3', path });
    expect(f.calls.map(command)).toContainEqual(['download', '@e2', path]);
    expect(f.calls.map(command)).toContainEqual(['upload', '@e3', path]);
    for (const bad of ['relative.csv', '--profile', join(f.root, 'folder') + '/../escape.csv', path + '\n']) {
      await expect(f.transport.step({ kind: 'upload', tab: 1, ref: '@e3', path: bad })).rejects.toThrow(/staged/);
    }
    expect(f.calls.map(command).filter(args => args[0] === 'upload')).toHaveLength(1);
    await f.transport.stop();
  });
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

describe("reading a lazy grid", () => {
  const SCROLL = ["scroll", "down", "100000", "--selector", ".e-gridcontent .e-content"];
  const grid = (rows: number) => ({ snapshot: ['- grid "Results"', '  - row "Reference Surname"', ...Array.from({ length: rows }, (_, i) => `  - row "FT-${i} Fictional" [ref=e${i + 1}]`), '  - rowgroup "not a row"'].join("\n") });
  it("scrolls only the given container until the row count stops growing, and returns that snapshot", async () => {
    let loaded = 3;
    const f = await fixture(async (_bin, args) => { const step = command(args);
      if (step[0] === "scroll") { loaded = Math.min(loaded + 3, 7); return {}; } return step[0] === "snapshot" ? grid(loaded) : tabs; });
    await f.transport.start();
    const result = await f.transport.step({ kind: "read", tab: 1, scroll: ".e-gridcontent .e-content" });
    expect(snapshotRows(String(result.snapshot))).toBe(8); // the header row and all seven rows
    expect(f.calls.map(command).slice(2)).toEqual([SCROLL, ["snapshot"], SCROLL, ["snapshot"], SCROLL, ["snapshot"]]);
    // Without a container the read is today's single snapshot.
    await f.transport.step({ kind: "read", tab: 1 });
    expect(f.calls.map(command).slice(-2)).toEqual([["tab", "list"], ["snapshot"]]);
    await f.transport.stop();
  });
  it("gives up after fifteen scrolls of a grid that never stops growing", async () => {
    let loaded = 0;
    const f = await fixture(async (_bin, args) => { const step = command(args); if (step[0] === "scroll") { loaded += 1; return {}; } return step[0] === "snapshot" ? grid(loaded) : tabs; });
    await f.transport.start();
    expect(snapshotRows(String((await f.transport.step({ kind: "read", tab: 1, scroll: ".e-content" })).snapshot))).toBe(16);
    expect(f.calls.map(command).filter(step => step[0] === "scroll")).toHaveLength(15);
    await f.transport.stop();
  });
  it("reads the page as it stands when the engine cannot scroll it, and holds nothing", async () => {
    const f = await fixture(async (_bin, args) => { const step = command(args); if (step[0] === "scroll") throw new Error("fictional: no such element"); return step[0] === "snapshot" ? grid(2) : tabs; });
    await f.transport.start();
    expect(snapshotRows(String((await f.transport.step({ kind: "read", tab: 1, scroll: ".e-content" })).snapshot))).toBe(3);
    expect(f.calls.map(command).slice(2)).toEqual([[...SCROLL.slice(0, 4), ".e-content"], ["snapshot"]]);
    expect(f.transport.state).toBe("active");
    await f.transport.stop();
  });
  it("Stop between a scroll and the next read ends the step without another command", async () => {
    const scrolled = deferred();
    const f = await fixture(async (_bin, args) => { const step = command(args); return step[0] === "scroll" ? scrolled.promise : step[0] === "snapshot" ? grid(1) : tabs; });
    await f.transport.start();
    const read = f.transport.step({ kind: "read", tab: 1, scroll: ".e-content" });
    await new Promise(resolve => setImmediate(resolve));
    const rejected = expect(read).rejects.toThrow(/stopped/);
    const stop = f.transport.stop(); scrolled.resolve({}); await rejected; await stop;
    expect(f.calls.map(command).filter(step => step[0] === "snapshot")).toEqual([]);
    expect(f.calls.at(-1)).toContain("close");
  });
  it.each([
    { kind: "read", tab: 1, scroll: "--cdp=ws://other" }, { kind: "read", tab: 1, scroll: "-p" }, { kind: "read", tab: 1, scroll: "div[onclick]" },
    { kind: "read", tab: 1, scroll: ".a;rm" }, { kind: "read", tab: 1, scroll: "" }, { kind: "read", tab: 1, scroll: `.${"a".repeat(100)}` },
    { kind: "read", tab: 1, scroll: 5 }, { kind: "read", tab: 1, scrolls: ".a" }, { kind: "click", tab: 1, ref: "@e1", scroll: ".a" },
  ])("refuses a container that is not a plain selector, or one on another step: %j", async step => {
    const f = await fixture(); await f.transport.start();
    await expect(f.transport.step(step as HermesEngineStep)).rejects.toThrow(/scrolled safely|unexpected fields/);
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
  it("names a missing bundle as needing repair, not as a saved-files failure", async () => {
    const root = await tempRoot("rb-native-missing-");
    // ENOENT carries a syscall, which the HTTP layer would report as "could not use its saved files".
    await expect(admitHermesEngine(join(root, "absent"))).rejects.toThrow("The work browser bundle needs repair.");
    await writeFile(join(root, "runtime.json"), JSON.stringify({ engine: "hermes-agent-browser", version: "0.26.0", platform: process.platform, arch: process.arch, sha256: "a".repeat(64) }));
    await expect(admitHermesEngine(root)).rejects.toThrow(/reviewed bundle/);
    await expect(admitHermesEngine(root)).rejects.not.toHaveProperty("syscall");
    // A file where the bundle folder should be (ENOTDIR) is the same repair.
    await expect(admitHermesEngine(join(root, "runtime.json"))).rejects.toThrow("The work browser bundle needs repair.");
  });
  it("names an unparseable runtime manifest as needing repair, without the parser's text", async () => {
    const root = await tempRoot("rb-native-damaged-");
    await writeFile(join(root, "runtime.json"), "{ fictional damaged");
    const error = await admitHermesEngine(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toBe("The work browser bundle needs repair.");
  });
  // Root reads through a folder or file with no permissions, so the denial cannot be staged.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports a denied bundle read as the I/O error it is, not as needing repair", async () => {
    const root = await tempRoot("rb-native-denied-"); const bundle = join(root, "bundle"); await mkdir(bundle);
    const manifest = join(bundle, "runtime.json");
    await writeFile(manifest, JSON.stringify({ engine: "hermes-agent-browser", version: "0.26.0", platform: process.platform, arch: process.arch, sha256: "a".repeat(64) }));
    try {
      await chmod(bundle, 0o600); // lstat inside a folder without search permission: EACCES
      await expect(admitHermesEngine(bundle)).rejects.toMatchObject({ code: "EACCES", syscall: "lstat" });
      await chmod(bundle, 0o700); await chmod(manifest, 0o000); // lstat succeeds, the read is denied
      await expect(admitHermesEngine(bundle)).rejects.toMatchObject({ code: "EACCES", syscall: "open" });
    } finally { await chmod(bundle, 0o700); await chmod(manifest, 0o600); }
  });
  it.skipIf(process.platform === "win32")("rejects a symlinked executable", async () => {
    const root = await tempRoot("rb-native-link-"); await mkdir(join(root, "bundle"));
    const binary = join(root, "other"); await writeFile(binary, "fictional");
    await symlink(binary, join(root, "bundle", "agent-browser"));
    await writeFile(join(root, "bundle", "runtime.json"), JSON.stringify({ engine: "hermes-agent-browser", version: "0.26.0", platform: process.platform, arch: process.arch, sha256: createHash("sha256").update("fictional").digest("hex") }));
    await expect(admitHermesEngine(join(root, "bundle"))).rejects.toThrow(/reviewed bundle/);
  });
});

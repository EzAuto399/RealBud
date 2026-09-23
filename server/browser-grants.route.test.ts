// Ask one-off browser tasks through the real server with a fake worker and a
// synthetic browser connection: a site request shows a task card (a question
// never does), Start mounts RealBud's browser with exactly the task's grant,
// Stop takes the grant away before the turn ends, and no connected browser
// means no start.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { grantedBrowserTools } from "./attended-run.ts";
import { BROWSER_TASK_OFFER } from "./browser-grants.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "portal.fictional-strata.example";

describe.skipIf(process.platform === "win32")("Ask browser task routes (fake worker)", () => {
  let child: ChildProcess;
  let home = "";
  let session = "";
  let stderr = "";
  let browserReady = "";
  let dump = "";
  let threadId = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (session) headers["x-realbud-session"] = session;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const bud = async () => ((await api("GET", "/api/bots")).body.bots as Array<{ id: string; busy?: boolean; threadId: string; messages?: Array<{ id: string; role: string; kind: string; text?: string }> }>).find(bot => bot.id === "bud")!;
  const tasks = async () => (await api("GET", `/api/browser/tasks?threadId=${encodeURIComponent(threadId)}`)).body;
  const idle = async () => {
    if ((await bud()).busy) await api("POST", "/api/bots/bud/interrupt", {});
    await waitFor(async () => !(await bud()).busy, "Bud to be idle");
  };
  const ask = async (text: string) => {
    const before = (await bud()).messages?.length ?? 0;
    expect((await api("POST", "/api/bots/bud/messages", { text })).status).toBeLessThan(300);
    await waitFor(async () => ((await bud()).messages?.length ?? 0) > before, "the request to be recorded");
  };
  const worker = () => existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) as { promptCount: number; mcpServers?: Array<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> } : null;
  let rpcId = 0;
  const rpc = async (descriptor: { url: string; headers: Array<{ name: string; value: string }> }, method: string, params: Record<string, unknown>) =>
    (await (await fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map(row => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) })).json()) as { result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "realbud-ask-task-"));
    // RealBud keeps its data folder private (0700); task records refuse a looser one.
    mkdirSync(join(home, ".realbud"), { recursive: true, mode: 0o700 });
    browserReady = join(home, "browser-ready");
    writeFileSync(browserReady, "1");
    dump = join(home, "fake-acp-dump.json");
    writeFileSync(join(home, ".realbud", "config.json"), JSON.stringify({
      instances: { hermes: { driver: "hermesAgent", config: { cli: FAKE_CLI }, environment: { FAKE_ACP_MODE: "hang", FAKE_ACP_DUMP: dump } } },
    }));
    // A synthetic browser connection, as in the attended-run route suite; broker and runtime suites exercise the real one.
    const browserFixture = join(home, "browser-fixture.mjs");
    writeFileSync(browserFixture, `import { existsSync } from "node:fs";
import { browserRuntime } from ${JSON.stringify(new URL("./browser-runtime.ts", import.meta.url).href)};
browserRuntime.status = async () => existsSync(${JSON.stringify(browserReady)})
  ? ({ state: "ready", enabled: true, browsers: [{ id: "fictional-browser", name: "Chrome", label: "Fictional profile", compatible: true }], selectedBrowserId: "fictional-browser", active: false, checkedAt: Date.now(), version: "0.3.0", port: 52800, detail: "Synthetic browser connection" })
  : ({ state: "off", enabled: false, browsers: [], selectedBrowserId: null, active: false, checkedAt: Date.now(), version: "0.3.0", port: 52800, detail: "Connect your browser." });
browserRuntime.resumeConnection = async () => {};
`);
    child = spawn(process.execPath, ["--import", browserFixture, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
        VITEST: "true", HOME: home, USERPROFILE: home, OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    session = String(((await (await fetch(`${BASE}/api/session`)).json()) as { token?: string }).token ?? "");
    threadId = (await bud()).threadId;
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("never offers a task for a question", async () => {
    await ask("How do I download invoices from the strata portal?");
    await waitFor(() => (worker()?.promptCount ?? 0) >= 1, "the question to reach the worker");
    expect((await tasks()).tasks).toEqual([]);
    expect((await bud()).messages?.some(message => message.text === BROWSER_TASK_OFFER)).toBe(false);
    await idle();
  }, 45_000);

  it("shows a card, starts with exactly the task's grant, and Stop takes the grant away", async () => {
    await ask("Can you submit this maintenance request on portal.fictional-strata.example?");
    await waitFor(async () => (await bud()).messages?.some(message => message.role === "bot" && message.text === BROWSER_TASK_OFFER) ?? false, "the task card");
    const offered = await tasks();
    expect(offered.browser).toEqual({ ready: true, name: "Chrome" });
    expect(offered.tasks).toHaveLength(1);
    const card = offered.tasks[0];
    expect(card).toMatchObject({ status: "proposed", request: "Submit this maintenance request on portal.fictional-strata.example", sites: [SITE], actions: ["read", "navigate", "fill", "click", "submit"] });
    expect((await bud()).messages?.find(message => message.id === card.messageId)?.text).toBe(BROWSER_TASK_OFFER);
    // Another thread cannot start it.
    expect((await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId: "thread-fictional-other" })).status).toBe(404);

    const started = await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId });
    expect(started.status).toBe(202);
    expect(started.body.task).toMatchObject({ status: "active", sites: [SITE] });
    // Each worker process rewrites the dump; the task's turn is the one with RealBud's browser mounted.
    await waitFor(() => Boolean(worker()?.mcpServers?.some(server => server.name === "browser")) && (worker()?.promptCount ?? 0) >= 1, "the task turn to reach the worker");
    const mounted = worker()!.mcpServers ?? [];
    expect(mounted.map(server => server.name)).toEqual(["browser"]);
    const listing = await rpc(mounted[0], "tools/list", {});
    expect(listing.result.tools!.map(tool => tool.name)).toEqual(grantedBrowserTools({ actions: card.actions, uploads: [] }, true));
    expect((await bud()).messages?.some(message => message.role === "user" && message.text === `Start this task: ${card.request}`)).toBe(true);
    expect((await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId })).status).toBe(409);

    const stopped = await api("POST", `/api/browser/tasks/${card.id}/stop`, { threadId });
    expect(stopped.body.task).toMatchObject({ status: "stopped", endNote: "Stopped by you. Nothing more will be done in your browser for this task." });
    const refused = await rpc(mounted[0], "tools/call", { name: "browser_tabs", arguments: {} });
    expect(refused.result.isError).toBe(true);
    await idle();
    expect((await tasks()).tasks[0].status).toBe("stopped");
    expect((await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId })).status).toBe(409);
  }, 60_000);

  it("does not start without a connected browser, and Not now is final", async () => {
    await ask("Download this month's invoices from portal.fictional-strata.example");
    await waitFor(async () => (await tasks()).tasks.length === 2, "the second card");
    const card = (await tasks()).tasks[1];
    expect(card.actions).toEqual(["read", "navigate", "click", "download"]);
    unlinkSync(browserReady);
    try {
      expect((await tasks()).browser).toEqual({ ready: false, name: null });
      const refused = await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId });
      expect(refused).toMatchObject({ status: 409, body: { error: "Connect your browser before starting this task.", code: "browser_not_connected" } });
      expect((await tasks()).tasks[1].status).toBe("proposed");
    } finally { writeFileSync(browserReady, "1"); }
    expect((await api("POST", `/api/browser/tasks/${card.id}/decline`, { threadId })).body.task.status).toBe("declined");
    expect((await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId })).status).toBe(409);
  }, 45_000);
});

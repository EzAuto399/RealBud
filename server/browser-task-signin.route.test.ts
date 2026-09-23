// Through the real server with a fake worker and a synthetic browser
// connection: a saved job's attended run mounts RealBud's browser with its
// own explicit grant, and an Ask task that reaches a sign-in page pauses like
// an attended job, stays paused over a restart, and continues with the same
// grant after the person signs in.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { grantedBrowserTools } from "./attended-run.ts";
import { BROWSER_TASK_OFFER, BROWSER_TASK_PAUSED_NOTE } from "./browser-grants.ts";
import { legacyBrowserActions } from "../shared/browser-task.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "portal.fictional-strata.example";

describe.skipIf(process.platform === "win32")("browser grants through the server (fake worker)", () => {
  let child: ChildProcess | undefined;
  let home = "";
  let session = "";
  let stderr = "";
  let dump = "";
  let script = "";
  let threadId = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (session) headers["x-realbud-session"] = session;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const writeScript = (value: Record<string, unknown>) => writeFileSync(script, `${JSON.stringify(value)}\n`);
  const bud = async () => ((await api("GET", "/api/bots")).body.bots as Array<{ id: string; busy?: boolean; threadId: string; messages?: Array<{ id: string; role: string; kind: string; text?: string }> }>).find(bot => bot.id === "bud")!;
  const tasks = async () => (await api("GET", `/api/browser/tasks?threadId=${encodeURIComponent(threadId)}`)).body;
  const handoffs = async () => (await api("GET", "/api/human-handoffs")).body.handoffs as Array<{ id: string; revision: number; value: Record<string, any> }>;
  const idle = async () => {
    if ((await bud()).busy) await api("POST", "/api/bots/bud/interrupt", {});
    await waitFor(async () => !(await bud()).busy, "Bud to be idle");
  };
  const worker = () => existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) as { promptCount: number; mcpServers?: Array<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> } : null;
  let rpcId = 0;
  const rpc = async (descriptor: { url: string; headers: Array<{ name: string; value: string }> }, method: string, params: Record<string, unknown>) =>
    (await (await fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map(row => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) })).json()) as { result: { tools?: Array<{ name: string }> } };

  async function boot() {
    stderr = "";
    const browserFixture = join(home, "browser-fixture.mjs");
    child = spawn(process.execPath, ["--import", browserFixture, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
        VITEST: "true", HOME: home, USERPROFILE: home, OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = child;
    started.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (started.exitCode !== null) throw new Error(`server exited ${started.exitCode}. stderr:\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    session = String(((await (await fetch(`${BASE}/api/session`)).json()) as { token?: string }).token ?? "");
    threadId = (await bud()).threadId;
  }
  async function stop() {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null) return;
    await new Promise<void>(resolve => {
      running.on("close", () => resolve());
      running.kill("SIGTERM");
      setTimeout(() => (running.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
  }

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "realbud-browser-signin-"));
    // RealBud keeps its data folder private (0700); task records refuse a looser one.
    mkdirSync(join(home, ".realbud"), { recursive: true, mode: 0o700 });
    dump = join(home, "fake-acp-dump.json");
    script = join(home, "fake-acp-script.json");
    writeScript({ permission: false, reply: "hello from fake acp" });
    writeFileSync(join(home, ".realbud", "config.json"), JSON.stringify({
      instances: { hermes: { driver: "hermesAgent", config: { cli: FAKE_CLI }, environment: { FAKE_ACP_SCRIPT: script, FAKE_ACP_DUMP: dump } } },
    }));
    // A synthetic browser connection and sign-in check; broker and runtime suites exercise the real ones.
    writeFileSync(join(home, "browser-fixture.mjs"), `import { browserRuntime } from ${JSON.stringify(new URL("./browser-runtime.ts", import.meta.url).href)};
browserRuntime.status = async () => ({ state: "ready", enabled: true, browsers: [{ id: "fictional-browser", name: "Chrome", label: "Fictional profile", compatible: true }], selectedBrowserId: "fictional-browser", active: false, checkedAt: Date.now(), version: "0.3.0", port: 52800, detail: "Synthetic browser connection" });
browserRuntime.resumeConnection = async () => {};
browserRuntime.stop = async () => {};
browserRuntime.chooseLoginTabs = async () => [{ tabId: 1, origin: "https://${SITE}", title: "Fictional strata portal", browserId: "fictional-browser" }];
browserRuntime.verifyLogin = async binding => binding.browserId === "fictional-browser" && binding.tabId === 1;
`);
    await boot();
  }, 30_000);

  afterAll(async () => {
    await stop();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("mounts a saved job's browser with its own explicit grant: exactly its earlier tools", async () => {
    const draft = { id: "fictional-levy-check", title: "Fictional levy check", steps: ["Open the portal", "Read the levy"], allowedOrigins: [SITE],
      evidence: "Levy balance", capabilities: ["portal-read", "portal-prefill"], status: "active" };
    expect((await api("POST", "/api/recipes", { draft })).status).toBe(201);
    expect((await api("PATCH", `/api/recipes/${draft.id}`, { planApproved: true })).status).toBe(200);
    expect((await api("PATCH", `/api/recipes/${draft.id}`, { attach: true })).status).toBe(200);
    // The worker waits on a card, so the job's browser stays mounted while it is checked.
    writeScript({ permission: true, tool: "navigate", title: "Open the levy page", rawInput: { url: `https://${SITE}/levy` }, reply: "opening the levy page" });
    const started = await api("POST", `/api/recipes/${draft.id}/attend`, {});
    expect(started.status).toBe(202);
    await waitFor(() => Boolean(worker()?.mcpServers?.some(server => server.name === "browser")), "the job's browser to be mounted");
    const browser = worker()!.mcpServers!.find(server => server.name === "browser")!;
    const listing = await rpc(browser, "tools/list", {});
    expect(listing.result.tools!.map(tool => tool.name)).toEqual(grantedBrowserTools({ actions: legacyBrowserActions(draft.capabilities), uploads: [] }, false));
    await idle();
    await waitFor(async () => (await api("GET", `/api/job-runs?jobId=${draft.id}`)).body.runs[0]?.status !== "running", "the run to settle");
  }, 60_000);

  it("pauses an Ask task at sign-in, keeps it paused over a restart, and continues the same grant after sign-in", async () => {
    writeScript({ permission: false, reply: "The strata portal is showing its login page. Please sign in to the portal, then I can continue." });
    const before = (await bud()).messages?.length ?? 0;
    expect((await api("POST", "/api/bots/bud/messages", { text: `Download this month's invoices from ${SITE}` })).status).toBeLessThan(300);
    await waitFor(async () => (await bud()).messages?.slice(before).some(message => message.role === "bot" && message.text === BROWSER_TASK_OFFER) ?? false, "the task card");
    const card = (await tasks()).tasks.at(-1);
    expect(card).toMatchObject({ status: "proposed", actions: ["read", "navigate", "click", "download"] });
    expect((await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId })).status).toBe(202);

    // The turn ends asking for sign-in: the task is paused, not ended, with its grant and a saved sign-in request.
    await waitFor(async () => (await tasks()).tasks.find((task: { id: string }) => task.id === card.id)?.status === "paused", "the task to pause");
    const paused = (await tasks()).tasks.find((task: { id: string }) => task.id === card.id);
    expect(paused).toMatchObject({ status: "paused", endNote: BROWSER_TASK_PAUSED_NOTE });
    expect(paused.expiresAt).toBeGreaterThan(Date.now());
    await waitFor(async () => (await handoffs()).some(row => row.value.runId === `ask-${card.id}` && row.value.state === "awaiting_login"), "the sign-in request");
    const pause = (await handoffs()).find(row => row.value.runId === `ask-${card.id}`)!;
    expect(pause.value.task).toMatchObject({ context: { grant: { id: card.id, route: "ask", expiresAt: paused.expiresAt, budget: 40 } }, grant: { grantId: card.id, budget: 40 } });
    expect((await bud()).messages?.some(message => message.role === "bot" && message.text === BROWSER_TASK_PAUSED_NOTE)).toBe(true);
    await idle();

    // A restart keeps it paused; Continue still carries on while its grant holds.
    await stop(); await boot();
    expect((await tasks()).tasks.find((task: { id: string }) => task.id === card.id)).toMatchObject({ status: "paused", expiresAt: paused.expiresAt });
    let held = (await handoffs()).find(row => row.id === pause.id)!;
    expect(held.value.state).toBe("awaiting_login");
    const offSite = await api("POST", `/api/human-handoffs/${held.id}/binding`, { revision: held.revision,
      binding: { version: 1, origin: "https://other.fictional.example", accountMarker: "Fictional owner 12", readyMarker: "Invoices", browser: { browserId: "fictional-browser", tabId: 1 } } });
    expect(offSite).toMatchObject({ status: 403, body: { error: "The sign-in check must use a site in this task." } });
    expect((await api("POST", `/api/human-handoffs/${held.id}/tabs`, { revision: held.revision })).body.tabs).toEqual([{ tabId: 1, origin: `https://${SITE}`, title: "Fictional strata portal", browserId: "fictional-browser" }]);
    const bound = await api("POST", `/api/human-handoffs/${held.id}/binding`, { revision: held.revision,
      binding: { version: 1, origin: `https://${SITE}`, accountMarker: "Fictional owner 12", readyMarker: "Invoices", browser: { browserId: "fictional-browser", tabId: 1 } } });
    expect(bound.status).toBe(200);
    held = bound.body;

    writeScript({ permission: false, reply: `I read the invoices page on ${SITE}.` });
    const continued = await api("POST", `/api/human-handoffs/${held.id}/continue`, { revision: held.revision });
    expect(continued.status).toBe(200);
    expect(continued.body.value).toMatchObject({ state: "closed", resumedRunId: `ask-${card.id}` });
    await waitFor(async () => (await tasks()).tasks.find((task: { id: string }) => task.id === card.id)?.status === "finished", "the continued task to finish");
    // The same grant (its expiry unchanged) mounted RealBud's browser for the continued turn.
    expect((await tasks()).tasks.find((task: { id: string }) => task.id === card.id)).toMatchObject({ status: "finished", expiresAt: paused.expiresAt });
    expect((await bud()).messages?.some(message => message.role === "user" && message.text === `Continue this task after my sign-in: ${card.request}`)).toBe(true);
    expect(worker()?.mcpServers?.map(server => server.name)).toEqual(["browser"]);
    await idle();
  }, 90_000);
});

// Desktop app tasks through the real server, a fake worker and the fake cua
// proxy (server/testing/fake-cua-mcp.mjs, pointed at by the descriptor
// override): the window list hides RealBud, browsers, terminals, editors,
// settings and password stores; "in the Mail app" preselects the one open Mail
// window; Start re-reads the window and mounts workdesktop alone; a degraded or
// closed window never starts; Stop ends the driver session; no helper is a 503;
// and a restart marks a running desktop task interrupted. Every value is fictional.
import { readSessionToken } from "./testing/local-session.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DESKTOP_TASK_OFFER } from "./browser-grants.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const FAKE_CUA = join(SERVER_DIR, "testing", "fake-cua-mcp.mjs");
const FIXTURE = JSON.parse(readFileSync(join(SERVER_DIR, "testing", "fixtures", "cua-0.22.1-calculator-window-state.json"), "utf8"));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const row = (pid: number, window_id: number, app_name: string, title: string) => ({ window_id, pid, app_name, title, bounds: { x: 10, y: 10, width: 400, height: 300 }, is_on_screen: true });
const WINDOWS = [
  row(501, 77, "Mail", "Inbox"), row(1001, 2001, "Calculator", "Calculator"), row(501, 78, "Mail", ""),
  row(601, 1, "Google Chrome", "Fictional portal"), row(602, 2, "Safari", "Fictional page"), row(603, 3, "Terminal", "zsh"), row(604, 4, "Code", "index.ts"),
  row(605, 5, "RealBud", "RealBud"), row(606, 6, "1Password", "Vault"), row(607, 7, "System Settings", "Privacy"), row(608, 8, "Keychain Access", "login"),
  row(609, 9, "WindowsTerminal.exe", "PowerShell"),
];

describe.skipIf(process.platform === "win32")("desktop task routes (fake worker, fake cua)", () => {
  let child: ChildProcess;
  let home = "", session = "", stderr = "", dump = "", threadId = "", descriptor = "", calls = "";

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
  const tasks = async () => (await api("GET", `/api/browser/tasks?threadId=${encodeURIComponent(threadId)}`)).body.tasks as Array<Record<string, any>>;
  const idle = async () => {
    if ((await bud()).busy) await api("POST", "/api/bots/bud/interrupt", {});
    await waitFor(async () => !(await bud()).busy, "Bud to be idle");
  };
  const ask = async (text: string) => {
    const before = (await tasks()).length;
    expect((await api("POST", "/api/bots/bud/messages", { text })).status).toBeLessThan(300);
    await waitFor(async () => (await tasks()).length > before, "the task card");
    return (await tasks()).at(-1)!;
  };
  const worker = () => existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) as { promptCount: number; mcpServers?: Array<{ name: string; url: string; headers: Array<{ name: string; value: string }> }> } : null;
  const cuaCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).name as string) : [];
  /** The helper's descriptor: `null` removes it (no helper on this computer). */
  const helper = (env: Record<string, string> | null) => writeFileSync(descriptor, JSON.stringify(env === null ? { mode: "unavailable" }
    : { mode: "embedded", mcpCommand: process.execPath, mcpArgs: [FAKE_CUA], mcpEnv: { FAKE_CUA_WINDOWS: JSON.stringify(WINDOWS), FAKE_CUA_RECORD: calls, ...env } }));
  let rpcId = 0;
  const rpc = async (server: { url: string; headers: Array<{ name: string; value: string }> }, method: string, params: Record<string, unknown>) =>
    (await (await fetch(server.url, { method: "POST", headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) })).json()) as { result: { tools?: Array<{ name: string }>; isError?: boolean } };

  const boot = async () => {
    stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        VITEST: "true", HOME: home, USERPROFILE: home, OMB_PORT: String(PORT),
        REALBUD_CUA_DESCRIPTOR_PATH: descriptor, REALBUD_CUA_TEST_READY: "1",
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
    session = await readSessionToken(join(home, ".realbud"));
    threadId = (await bud()).threadId;
  };
  const shutdown = async () => {
    child?.kill("SIGTERM");
    await new Promise<void>(resolve => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "realbud-desktop-task-"));
    mkdirSync(join(home, ".realbud"), { recursive: true, mode: 0o700 });
    dump = join(home, ".realbud", "vault", "bud-work", "fake-acp-dump.json");
    descriptor = join(home, "cua-connection.json");
    calls = join(home, "cua-calls.jsonl");
    helper({});
    writeFileSync(join(home, ".realbud", "config.json"), JSON.stringify({
      instances: { hermes: { driver: "hermesAgent", config: { cli: FAKE_CLI }, environment: { FAKE_ACP_MODE: "hang", FAKE_ACP_DUMP: dump } } },
    }));
    await boot();
  }, 30_000);

  afterAll(async () => {
    await shutdown();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  afterEach(async () => {
    helper({});
    if (session && child?.exitCode === null) await idle();
  }, 20_000);

  it("lists only other apps' titled windows, and answers 503 without the desktop helper", async () => {
    const listed = await api("GET", "/api/desktop/windows");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ windows: [
      { appName: "Mail", bundleId: "Mail", pid: 501, windowId: 77, title: "Inbox" },
      { appName: "Calculator", bundleId: "Calculator", pid: 1001, windowId: 2001, title: "Calculator" },
    ] });
    helper(null);
    expect(await api("GET", "/api/desktop/windows")).toEqual({ status: 503, body: { error: "Apps on this computer aren't available here." } });
  });

  it("preselects the named app's window, starts with workdesktop alone, and Stop ends the driver session", async () => {
    const card = await ask("Open the inbox in the Mail app");
    expect((await bud()).messages?.find(message => message.id === card.messageId)?.text).toBe(DESKTOP_TASK_OFFER);
    expect(card).toMatchObject({ status: "proposed", sites: [], siteSource: "none", actions: ["read", "click"],
      desktop: { appName: "Mail", bundleId: "Mail", pid: 501, windowId: 77, title: "Inbox" } });

    writeFileSync(calls, "");
    const started = await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId });
    expect(started.status).toBe(202);
    expect(started.body.task).toMatchObject({ status: "active", sites: [], desktop: { appName: "Mail", windowId: 77 } });
    // Start listed and read the window before saving the grant.
    expect(cuaCalls().slice(0, 2)).toEqual(["list_windows", "get_window_state"]);
    await waitFor(() => Boolean(worker()?.mcpServers?.some(server => server.name === "workdesktop")) && (worker()?.promptCount ?? 0) >= 1, "the task turn to reach the worker");
    const mounted = worker()!.mcpServers ?? [];
    expect(mounted.map(server => server.name)).toEqual(["workdesktop"]);
    // The person's own Start, but Jev is not ready here (no office model grant): no pick_control.
    const listing = await rpc(mounted[0], "tools/list", {});
    expect(listing.result.tools!.map(tool => tool.name)).not.toContain("pick_control");
    expect((await api("POST", `/api/browser/tasks/${card.id}/start`, { threadId })).status).toBe(409);
    expect((await rpc(mounted[0], "tools/call", { name: "get_window_state", arguments: {} })).result.isError).toBeFalsy();

    const stopped = await api("POST", `/api/browser/tasks/${card.id}/stop`, { threadId });
    expect(stopped.body.task).toMatchObject({ status: "stopped", endNote: "Stopped by you. Nothing more will be done in Mail for this task." });
    await waitFor(() => cuaCalls().includes("end_session"), "the driver session to end");
    expect((await rpc(mounted[0], "tools/call", { name: "get_window_state", arguments: {} }).catch(() => ({ result: { isError: true } }))).result.isError).toBe(true);
  }, 60_000);

  it("refuses a closed window, a malformed choice, a degraded window and a missing helper, and starts once the window reads", async () => {
    const card = await ask("Print the report on my computer");
    expect(card).toMatchObject({ status: "proposed", sites: [] });
    expect(card.desktop).toBeUndefined();
    const start = (window: unknown) => api("POST", `/api/browser/tasks/${card.id}/start`, { threadId, window });
    expect(await start({ pid: 999, windowId: 999 })).toMatchObject({ status: 409, body: { error: "That window is no longer open, or Bud does not work in that app. Choose the window again." } });
    expect(await start({ pid: 603, windowId: 3 })).toMatchObject({ status: 409 });
    expect((await start({ pid: 1001, windowId: 2001, title: "x" })).status).toBe(400);
    const degraded = join(home, "degraded.json");
    writeFileSync(degraded, JSON.stringify({ ...FIXTURE, degraded_reason: "ax_timeout" }));
    helper({ FAKE_CUA_FIXTURE: degraded });
    expect(await start({ pid: 1001, windowId: 2001 })).toMatchObject({ status: 409, body: { error: "RealBud could not read the controls in that window, so the task did not start. Bring the window to the front and press Start again." } });
    helper(null);
    expect((await start({ pid: 1001, windowId: 2001 })).status).toBe(503);
    expect((await tasks()).find(task => task.id === card.id)!.status).toBe("proposed");
    helper({});
    const started = await start({ pid: 1001, windowId: 2001 });
    expect(started.status).toBe(202);
    expect(started.body.task).toMatchObject({ status: "active", desktop: { appName: "Calculator", pid: 1001, windowId: 2001 } });

    // A restart while it runs: the task is interrupted, never resumed from its saved grant.
    await shutdown();
    await boot();
    expect((await tasks()).find(task => task.id === card.id)).toMatchObject({ status: "interrupted",
      endNote: "RealBud restarted before this task finished. Nothing more will be done in Calculator; ask again to continue." });
  }, 90_000);
});

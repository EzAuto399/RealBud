// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
/** stands in for the box provider so config saving never touches the network */
let boxStub: Server;
let boxStubPort = 0;
/** stands in for api.telegram.org so channel connect never leaves the box */
let telegramStub: Server;
let telegramStubPort = 0;
/** stands in for discord.com so channel connect never leaves the box */
let discordStub: Server;
let discordStubPort = 0;
/** stands in for slack.com so channel connect never leaves the box */
let slackStub: Server;
let slackStubPort = 0;
let composioStub: Server;
let composioStubPort = 0;
const composioCalls: string[] = [];
/** When a slug is in this set, list-status answers as already connected. */
const composioForceConnected = new Set<string>();
let composioStatusFailure = false;
let home: string;
let staticDir: string;
let stderr = "";
let session = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-api-test-"));
  staticDir = join(home, "static");
  const workerCli = join(home, "hermes.mjs");
  writeFileSync(workerCli, `#!${process.execPath}\nconsole.log("Hermes Agent v0.21.0 (2026.8.31)");\n`);
  chmodSync(workerCli, 0o755);
  // a fleet of exactly one unknown driver: no CLI probes, no network
  mkdirSync(join(home, ".realbud"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Packaged RealBud</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body { color: white; }");
  writeFileSync(
    join(home, ".realbud", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );

  boxStub = createServer((req, res) => {
    const ok = req.headers.authorization === "Bearer box_good";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, boxes: [] } : { ok: false, code: "unauthorized" }));
  });
  await new Promise<void>((r) => boxStub.listen(0, "127.0.0.1", r));
  boxStubPort = (boxStub.address() as { port: number }).port;

  telegramStub = createServer((req, res) => {
    const match = /^\/bot([^/]+)\/(\w+)/.exec(req.url ?? "");
    const token = match?.[1] ?? "";
    const method = match?.[2] ?? "";
    res.setHeader("content-type", "application/json");
    if (method === "getMe" && token === "999001:TestTelegramTokenAlpha") {
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, username: "realbud_bot" } }));
    }
    if (method === "getMe") {
      res.writeHead(401);
      return res.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
    }
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, result: [] }));
  });
  await new Promise<void>((r) => telegramStub.listen(0, "127.0.0.1", r));
  telegramStubPort = (telegramStub.address() as { port: number }).port;

  discordStub = createServer((req, res) => {
    const url = req.url ?? "";
    const auth = String(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/api/v10/users/@me")) {
      if (auth === "Bot TestDiscordTokenAlpha") {
        res.writeHead(200);
        return res.end(JSON.stringify({ id: "1", username: "realbud", bot: true }));
      }
      res.writeHead(401);
      return res.end(JSON.stringify({ message: "401: Unauthorized", code: 0 }));
    }
    if (url.startsWith("/api/v10/gateway")) {
      res.writeHead(200);
      return res.end(JSON.stringify({ url: "wss://127.0.0.1:1" }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ message: "404" }));
  });
  await new Promise<void>((r) => discordStub.listen(0, "127.0.0.1", r));
  discordStubPort = (discordStub.address() as { port: number }).port;

  slackStub = createServer((req, res) => {
    const url = req.url ?? "";
    const auth = String(req.headers.authorization ?? "");
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/api/auth.test")) {
      if (auth === "Bearer xoxb-TestSlackTokenAlpha") {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, user: "realbud", user_id: "U_BOT" }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: false, error: "invalid_auth" }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: "unknown_method" }));
  });
  await new Promise<void>((r) => slackStub.listen(0, "127.0.0.1", r));
  slackStubPort = (slackStub.address() as { port: number }).port;

  composioStub = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      composioCalls.push(body);
      const message = JSON.parse(body);
      if (String(req.headers["x-consumer-api-key"]).includes("rejected")) { res.writeHead(401).end(); return; }
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      if (message.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Fixture apps", version: "1" },
        } })); return;
      }
      if (message.method === "tools/list") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [
          "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_MANAGE_CONNECTIONS",
        ].map(name => ({ name, inputSchema: { type: "object", properties: name === "COMPOSIO_MANAGE_CONNECTIONS" ? {
          toolkits: { type: "array", items: { type: "object", properties: { name: { type: "string" }, action: { enum: ["list", "add"] } } } },
        } : {} } })) } })); return;
      }
      let action = "add";
      let slug = "gmail";
      try {
        const parsed = JSON.parse(body) as {
          params?: { arguments?: { toolkits?: Array<{ name?: string; action?: string }> } };
        };
        const toolkit = parsed.params?.arguments?.toolkits?.[0];
        action = toolkit?.action ?? "add";
        slug = String(toolkit?.name ?? "gmail").toLowerCase();
      } catch {
        /* keep defaults */
      }
      if (action === "list") {
        if (composioStatusFailure) {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Private provider failure" } })); return;
        }
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    data: {
                      results: Object.fromEntries(message.params.arguments.toolkits.map((toolkit: { name: string }) => [toolkit.name, {
                        status: composioForceConnected.has(toolkit.name) ? "ACTIVE" : "unknown",
                        accounts: composioForceConnected.has(toolkit.name) ? [{ id: "acct-1", status: "ACTIVE" }] : [],
                      }])) ,
                    },
                  }),
                },
              ],
            },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ authorization_url: `https://auth.example/connect/${slug}` }) },
            ],
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => composioStub.listen(0, "127.0.0.1", r));
  composioStubPort = (composioStub.address() as { port: number }).port;

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      // child-process coverage: the v8 provider measures the spawned server
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      // The worker handshake is covered at its own boundary. Keep this HTTP
      // suite deterministic and offline while still exercising its receipt.
      VITEST: "true",
      REALBUD_HERMES_CLI: workerCli,
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_BOX_API: `http://127.0.0.1:${boxStubPort}`,
      REALBUD_TELEGRAM_API: `http://127.0.0.1:${telegramStubPort}`,
      REALBUD_DISCORD_API: `http://127.0.0.1:${discordStubPort}`,
      REALBUD_SLACK_API: `http://127.0.0.1:${slackStubPort}`,
      OMB_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const boot = await fetch(`${BASE}/api/session`);
  session = String(((await boot.json()) as { token?: string }).token ?? "");
}, 30_000);

afterAll(async () => {
  boxStub?.close();
  telegramStub?.close();
  discordStub?.close();
  slackStub?.close();
  composioStub?.close();
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe("harness HTTP API", () => {
  it("requires authenticated, current-revision rent settings and never updates payment facts", async () => {
    const before = (await api("GET", "/api/desk")).body;
    const office = { rentWorkflow: { receiptChannels: ["whatsapp", "email"], verificationMethod: "bank-allocation", checkingSteps: "Match the unit and period." } };
    const unauthorized = await fetch(`${BASE}/api/desk/agency`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ office, expectedRevision: before.revision }) });
    expect(unauthorized.status).toBe(401);
    expect((await api("PATCH", "/api/desk/agency", { office })).status).toBe(400);
    expect((await api("PATCH", "/api/desk/agency", { office, expectedRevision: String(before.revision) })).status).toBe(400);
    const saved = await api("PATCH", "/api/desk/agency", { office, expectedRevision: before.revision });
    expect(saved.status).toBe(200);
    expect(saved.body.book.office.rentWorkflow).toEqual(office.rentWorkflow);
    expect(saved.body.ledger).toEqual(before.ledger);
    expect((await api("PATCH", "/api/desk/agency", { name: "Stale overwrite", office, expectedRevision: before.revision })).status).toBe(409);
    expect((await api("PATCH", "/api/desk/agency", { office: { rentWorkflow: { ...office.rentWorkflow, verificationMethod: "receipt-is-paid" } }, expectedRevision: saved.body.revision })).status).toBe(400);
    const after = (await api("GET", "/api/desk")).body;
    expect(after.revision).toBe(saved.body.revision);
    expect(after.book.agency).toEqual(before.book.agency);
  });

  it("protects batch history and validates bounded, idempotent preparation through HTTP", async () => {
    const unauthorized = await fetch(`${BASE}/api/desk/batches`);
    expect(unauthorized.status).toBe(401);
    const unauthorizedWrite = await fetch(`${BASE}/api/desk/batches`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthorizedWrite.status).toBe(401);
    const snapshot = (await api("GET", "/api/desk")).body;
    const input = { task: "maintenance-brief", propertyIds: [snapshot.properties[0].id], instruction: "Draft only", requestKey: "http-batch-0001", expectedRevision: snapshot.revision };
    expect((await api("POST", "/api/desk/batches", { ...input, expectedRevision: -1 })).status).toBe(409);
    expect((await api("POST", "/api/desk/batches", { ...input, task: "send" })).status).toBe(400);
    const created = await api("POST", "/api/desk/batches", input);
    expect(created.status).toBe(202);
    const duplicate = await api("POST", "/api/desk/batches", input);
    expect(duplicate.body.batch.id).toBe(created.body.batch.id);
    const history = await api("GET", "/api/desk/batches");
    expect(history.body.batches).toHaveLength(1);
    expect(history.body.batches[0]).not.toHaveProperty("items");
    const detail = (await api("GET", `/api/desk/batches/${created.body.batch.id}`)).body.batch;
    expect((await api("PATCH", `/api/desk/batches/${detail.id}`, { action: "send", expectedRevision: detail.revision })).status).toBe(400);
    expect((await api("PATCH", `/api/desk/batches/${detail.id}`, { action: "pause", expectedRevision: -1 })).status).toBe(409);
    expect(detail.items.every((item: { source: string }) => item.source === "")).toBe(true);
    expect((await api("GET", `/api/desk/batches/${detail.id}?revision=bad`)).status).toBe(400);
    expect((await api("GET", "/api/desk")).body.revision).toBe(snapshot.revision);
  });
  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("realbud");
    expect(typeof body.pid).toBe("number");
    expect(body.static).toBe(true);
  });

  it("serves packaged UI assets and preserves API 404s", async () => {
    const root = await fetch(`${BASE}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html");
    expect(await root.text()).toContain("Packaged RealBud");

    const asset = await fetch(`${BASE}/assets/smoke.css`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/css");
    expect(await asset.text()).toContain("color: white");

    const spa = await fetch(`${BASE}/settings/desktop`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toBe("text/html");
    expect(await spa.text()).toContain("Packaged RealBud");

    const unknownApi = await api("GET", "/api/not-a-real-route");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.body.error).toContain("/api/not-a-real-route");
  });

  it("rejects malformed and oversized JSON bodies without hanging", async () => {
    const malformed = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-realbud-session": session },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

    const oversized = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-realbud-session": session },
      body: JSON.stringify({ profile: { name: "x".repeat(1_000_001) } }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "body too large" });

    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
  });

  it("seeds the canonical Bud thread and refuses extra bots", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots).toHaveLength(1);
    expect(body.bots[0]).toMatchObject({ id: "bud", name: "Bud", computer: "off" });
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(403);
    expect(String(created.body.error)).toMatch(/one Bud thread/i);
  });

  it("lists the named loops and refuses to run a planned one", async () => {
    const { status, body } = await api("GET", "/api/loops");
    expect(status).toBe(200);
    expect(body.loops.filter((loop: { id: string }) => !String(loop.id).startsWith("recipe-")).map((loop: { id: string }) => loop.id)).toEqual([
      "morning-arrears",
      "owner-letter",
      "inbound-triage",
    ]);
    const morning = body.loops.find((loop: { id: string }) => loop.id === "morning-arrears");
    expect(morning).toMatchObject({ available: true, enabled: true });
    const ownerLetter = body.loops.find((loop: { id: string }) => loop.id === "owner-letter");
    expect(ownerLetter).toMatchObject({ available: true, enabled: true });
    const planned = body.loops.find((loop: { id: string }) => loop.id === "inbound-triage");
    expect(planned).toMatchObject({ available: false, enabled: false });
    expect(planned).not.toHaveProperty("prompt");

    const run = await api("POST", "/api/loops/inbound-triage/run", {});
    expect(run.status).toBe(409);

    // owner-letter v0 runs: it drafts Copy-only cards on Desk
    const letter = await api("POST", "/api/loops/owner-letter/run", {});
    expect(letter.status).toBe(201);
    const deskSnap = (await api("GET", "/api/desk")).body;
    const letters = deskSnap.drafts.filter((d: { kind: string }) => d.kind === "owner-letter");
    expect(letters.length).toBeGreaterThan(0);
    for (const draft of letters) {
      expect(draft.status).toBe("pending");
      expect(draft.channel).toBe("desk");
      expect(draft.body).toMatch(/Prepared from the RealBud Desk book/);
    }

    const patch = await api("PATCH", "/api/loops/morning-arrears", { enabled: false });
    expect(patch.status).toBe(200);
    expect(patch.body.loop.enabled).toBe(false);
    expect(patch.body.loop.revision).toBeGreaterThanOrEqual(1);
    await api("PATCH", "/api/loops/morning-arrears", { enabled: true });
  });

  it("retunes a loop's clock over the API and rejects malformed patches", async () => {
    const retune = await api("PATCH", "/api/loops/morning-arrears", { time: "08:15", weekdays: [1, 2, 3, 4, 5] });
    expect(retune.status).toBe(200);
    expect(retune.body.loop).toMatchObject({ schedule: { time: "08:15" }, revision: expect.any(Number) });

    const planned = await api("PATCH", "/api/loops/inbound-triage", { time: "09:15" });
    expect(planned.status).toBe(200);
    const enablePlanned = await api("PATCH", "/api/loops/inbound-triage", { enabled: true });
    expect(enablePlanned.status).toBe(400);
    expect(String(enablePlanned.body.error)).toMatch(/not built yet/);

    const empty = await api("PATCH", "/api/loops/morning-arrears", {});
    expect(empty.status).toBe(400);
    const badTime = await api("PATCH", "/api/loops/morning-arrears", { time: "7:77" });
    expect(badTime.status).toBe(400);
    const badDays = await api("PATCH", "/api/loops/morning-arrears", { weekdays: [0, 9] });
    expect(badDays.status).toBe(400);

    // put the clock back for the rest of the suite
    await api("PATCH", "/api/loops/morning-arrears", { time: "07:30" });
    await api("PATCH", "/api/loops/inbound-triage", { time: "09:00" });
  });

  it("refuses to run setup for an engine with no installer", async () => {
    const setup = await api("POST", "/api/instances/ghost/setup", {});
    expect(setup.status).toBe(400);
    expect(String(setup.body.error)).toMatch(/no setup command/i);
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0]).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(body.instances[0].snapshot.reason).toContain("not-a-real-driver");
  });

  it("reports the pinned Hermes worker status", async () => {
    const { status, body } = await api("GET", "/api/hermes");
    expect(status).toBe(200);
    expect(body.pin).toMatchObject({ product: "0.20.3", profile: "property" });
    expect(body.cli).toMatchObject({ installed: expect.any(Boolean), matchesPin: expect.any(Boolean) });
    expect(body.pack).toMatchObject({ installed: true, approvalsManual: true, workroomReady: true });
    expect(typeof body.detail).toBe("string");
    if (process.platform !== "win32") {
      expect(body.installCommand).toContain("--force-commit");
    } else {
      expect(body.installCommand).toBeNull();
    }
    expect(body).toHaveProperty("lastPing");
    expect(body.ready).toBe(false);
    expect(body.model).toEqual({
      attached: expect.any(Boolean),
      provider: body.model.provider ?? null,
      model: body.model.model ?? null,
    });
    expect(body.model).not.toHaveProperty("keyHint");
    expect(JSON.stringify(body.model)).not.toMatch(/keyHint/);

    const providers = await api("GET", "/api/hermes/providers");
    expect(providers.status).toBe(200);
    const ids = providers.body.providers.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "deepseek", "moonshotai", "google", "xai"]));
    expect(ids).not.toContain("kimi-for-coding");
  });

  it("applies the property pack on demand and rejects non-JSON calls", async () => {
    const noJson = await api("POST", "/api/hermes/apply-pack");
    expect(noJson.status).toBe(415);

    const applied = await api("POST", "/api/hermes/apply-pack", {});
    expect(applied.status).toBe(200);
    expect(applied.body.pack.installed).toBe(true);
    expect(applied.body.pack.workroomReady).toBe(true);
    expect(applied.body.pin.product).toBe("0.20.3");
    expect(applied.body.lastPing).toMatchObject({
      ok: false,
      detail: "Property safeguards changed. Run the private readiness check again.",
      kind: "ping",
    });
    expect(applied.body.ready).toBe(false);
  });

  it("tests hands with the same content-type gate as other actions", async () => {
    const noJson = await api("POST", "/api/hermes/test");
    expect(noJson.status).toBe(415);
  });

  it("gates worker repair and remove like the other hermes actions", async () => {
    const noCancel = await api("POST", "/api/hermes/install/cancel");
    expect(noCancel.status).toBe(415);
    expect((await api("POST", "/api/hermes/install/cancel", {})).status).toBe(202);
    const noRepair = await api("POST", "/api/hermes/repair");
    expect(noRepair.status).toBe(415);
    const noRemove = await api("POST", "/api/hermes/uninstall");
    expect(noRemove.status).toBe(415);

    const repaired = await api("POST", "/api/hermes/repair", {});
    expect(repaired.status).toBe(200);
    expect(repaired.body.install.state).toBe("done");
    expect(repaired.body.hermes.cli).toMatchObject({ compatible: true, matchesPin: false });

    const removed = await api("POST", "/api/hermes/uninstall", {});
    expect(removed.status).toBe(200);
    expect(removed.body.pack.installed).toBe(false);
    expect(removed.body.ready).toBe(false);
    expect(removed.body.lastPing).toBeNull();

    const restored = await api("POST", "/api/hermes/apply-pack", {});
    expect(restored.status).toBe(200);
    expect(restored.body.pack.installed).toBe(true);
  });

  it("persists the model connection hands check across a status reload", async () => {
    const noJson = await api("POST", "/api/hermes/model");
    expect(noJson.status).toBe(415);

    const connected = await api("POST", "/api/hermes/model", {
      providerId: "deepseek",
      apiKey: "test-only-key",
      model: "deepseek-test",
    });
    expect(connected.status).toBe(200);
    expect(connected.body.model).toMatchObject({ provider: "deepseek", model: "deepseek-test", keyPresent: true });
    expect(connected.body.model.keyHint).not.toContain("test-only-key");
    expect(connected.body.ping).toMatchObject({ ok: false, detail: "tests do not ping the live worker" });

    const reloaded = await api("GET", "/api/hermes");
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.model).toEqual({ attached: true, provider: "deepseek", model: "deepseek-test" });
    expect(reloaded.body.model).not.toHaveProperty("keyHint");
    expect(reloaded.body.lastPing).toMatchObject({
      ok: false,
      detail: "tests do not ping the live worker",
      kind: "ping",
      at: expect.any(Number),
    });
    expect(reloaded.body.ready).toBe(false);
  });

  it("adds, patches, and removes a property with its facts", async () => {
    const before = await api("GET", "/api/desk");
    const count = before.body.properties.length;

    const added = await api("POST", "/api/desk/properties", {
      address: "9 Wattle Ct, O'Connor ACT",
      tenantName: "Morgan Lee",
      tenantPhone: "0411 222 333",
      weeklyRentCents: 61_000,
    });
    expect(added.status).toBe(201);
    expect(added.body.properties).toHaveLength(count + 1);
    const property = added.body.properties.find((p: { address: string }) => p.address.startsWith("9 Wattle"));
    expect(property).toMatchObject({ tenantName: "Morgan Lee" });
    expect(added.body.ledger.find((r: { propertyId: string }) => r.propertyId === property.id)).toMatchObject({
      daysSinceDue: 0,
      rentLanded: false,
    });

    const patched = await api("PATCH", `/api/desk/properties/${property.id}`, { notifyChannel: "portal" });
    expect(patched.status).toBe(200);
    expect(patched.body.property.options.notifyChannel).toBe("portal");
    expect(patched.body.property.options.never).toEqual(["statutory-send", "trust-pay"]);

    const removed = await api("DELETE", `/api/desk/properties/${property.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.properties.some((p: { id: string }) => p.id === property.id)).toBe(false);

    const bad = await api("POST", "/api/desk/properties", { address: "", tenantName: "X", weeklyRentCents: 10 });
    expect(bad.status).toBe(400);
  });

  it("never sends a desk draft — the send route is always 403", async () => {
    const miss = await api("POST", "/api/desk/check", {});
    expect(miss.status).toBe(200);
    let snap = miss.body.drafts?.some((d: { status: string }) => d.status === "pending")
      ? miss
      : await api("POST", "/api/desk/practice", {});
    const draft = snap.body.drafts.find((d: { status: string }) => d.status === "pending");
    expect(draft).toBeTruthy();
    const send = await api("POST", `/api/desk/drafts/${draft.id}/send`, {});
    expect(send.status).toBe(403);
    expect(String(send.body.error)).toMatch(/never sends/i);
  });

  it("refuses rooms, connectors, and raw computer screenshots in product mode", async () => {
    expect((await api("POST", "/api/groups", { memberIds: ["bud"] })).status).toBe(403);
    expect((await api("GET", "/api/connectors")).status).toBe(403);
    expect((await api("POST", "/api/local-computer/screenshot", {})).status).toBe(403);
    expect((await api("POST", "/api/bots/bud/computer", {})).status).toBe(403);
  });

  it("round-trips standing rules and rejects bad writes", async () => {
    const empty = await api("GET", "/api/rules");
    expect(empty.status).toBe(200);
    expect(empty.body.rules).toEqual([]);

    const created = await api("POST", "/api/rules", { key: "Bash:git", decision: "allow" });
    expect(created.status).toBe(201);
    expect(created.body.rules).toHaveLength(1);
    expect(created.body.rules[0]).toMatchObject({
      key: "Bash:git",
      decision: "allow",
      label: "Run git commands",
    });
    expect(typeof created.body.rules[0].id).toBe("string");

    const listed = await api("GET", "/api/rules");
    expect(listed.status).toBe(200);
    expect(listed.body.rules).toHaveLength(1);
    expect(listed.body.rules[0].id).toBe(created.body.rules[0].id);

    expect((await api("POST", "/api/rules", { key: "", decision: "allow" })).status).toBe(400);
    expect((await api("POST", "/api/rules", { key: "x".repeat(121), decision: "allow" })).status).toBe(400);
    expect((await api("POST", "/api/rules", { key: "Read", decision: "maybe" })).status).toBe(400);
    expect((await api("POST", "/api/rules", { key: "Read", decision: "allow", label: "x".repeat(81) })).status).toBe(400);

    const gone = await api("DELETE", `/api/rules/${created.body.rules[0].id}`);
    expect(gone.status).toBe(200);
    expect(gone.body.rules).toEqual([]);

    const miss = await api("DELETE", "/api/rules/no-such-rule");
    expect(miss.status).toBe(404);
  });

  it("round-trips law-watch schedule and stays honest when the worker is away", async () => {
    const empty = await api("GET", "/api/law-watch");
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ lastCheckedAt: 0, drift: [], checkedSources: [], scheduled: false });

    const on = await api("POST", "/api/law-watch/schedule", { on: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ scheduled: true });
    expect((await api("GET", "/api/law-watch")).body.scheduled).toBe(true);

    const check = await api("POST", "/api/law-watch/check");
    expect(check.status).toBe(503);
    expect(String(check.body.error)).toMatch(/shop reference/);

    const apply = await api("POST", "/api/law-watch/apply", { index: 0 });
    expect(apply.status).toBe(400);

    const off = await api("POST", "/api/law-watch/schedule", { on: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ scheduled: false });
  });

  it("connects Telegram without echoing the token and disconnects", async () => {
    const token = "999001:TestTelegramTokenAlpha";
    const empty = await api("GET", "/api/channels");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      telegram: { connected: false },
      discord: { connected: false },
      slack: { connected: false },
    });

    const bare = await fetch(`${BASE}/api/channels`);
    expect(bare.status).toBe(401);

    const bad = await api("POST", "/api/channels/telegram", { botToken: "999001:TestTelegramTokenNope" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/BotFather/);
    expect(JSON.stringify(bad.body)).not.toContain("TestTelegramTokenNope");

    const ok = await api("POST", "/api/channels/telegram", { botToken: token });
    expect(ok.status).toBe(200);
    expect(ok.body.telegram).toMatchObject({
      connected: true,
      botUsername: "realbud_bot",
      paired: false,
      pairedName: null,
    });
    expect(ok.body.telegram).not.toHaveProperty("botToken");
    expect(ok.body.telegram).not.toHaveProperty("pairedChatId");
    expect(JSON.stringify(ok.body)).not.toContain(token);

    expect((await fetch(`${BASE}/api/channels/telegram/pair`, { method: "POST" })).status).toBe(401);
    const pair = await api("POST", "/api/channels/telegram/pair", {});
    expect(pair.status).toBe(200);
    expect(pair.body.command).toMatch(/^\/pair [A-F0-9]{16}$/);
    expect(pair.body.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify((await api("GET", "/api/channels")).body)).not.toContain(pair.body.command);
    expect((await api("POST", "/api/channels/slack/pair", {})).status).toBe(409);

    const listed = await api("GET", "/api/channels");
    expect(listed.status).toBe(200);
    expect(listed.body.telegram).toMatchObject({ connected: true, botUsername: "realbud_bot", paired: false });
    expect(JSON.stringify(listed.body)).not.toContain(token);

    const gone = await api("DELETE", "/api/channels/telegram");
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({
      telegram: { connected: false },
      discord: { connected: false },
      slack: { connected: false },
    });
    expect((await api("GET", "/api/channels")).body).toEqual({
      telegram: { connected: false },
      discord: { connected: false },
      slack: { connected: false },
    });
  });

  it("connects Discord and Slack without echoing tokens and 404s an unknown platform", async () => {
    const token = "TestDiscordTokenAlpha";
    const listed = await api("GET", "/api/channels");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      telegram: { connected: false },
      discord: { connected: false },
      slack: { connected: false },
    });

    const bad = await api("POST", "/api/channels/discord", { botToken: "TestDiscordTokenNope" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/developer portal/);
    expect(JSON.stringify(bad.body)).not.toContain("TestDiscordTokenNope");

    const unknown = await api("POST", "/api/channels/whatsapp", { botToken: token });
    expect(unknown.status).toBe(404);

    const ok = await api("POST", "/api/channels/discord", { botToken: token });
    expect(ok.status).toBe(200);
    expect(ok.body.discord).toMatchObject({
      connected: true,
      botUsername: "realbud",
      paired: false,
      pairedName: null,
    });
    expect(ok.body.telegram).toEqual({ connected: false });
    expect(ok.body.slack).toEqual({ connected: false });
    expect(ok.body.discord).not.toHaveProperty("botToken");
    expect(ok.body.discord).not.toHaveProperty("pairedChannelId");
    expect(JSON.stringify(ok.body)).not.toContain(token);

    const gone = await api("DELETE", "/api/channels/discord");
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({
      telegram: { connected: false },
      discord: { connected: false },
      slack: { connected: false },
    });

    const slackBad = await api("POST", "/api/channels/slack", { botToken: "xoxb-Nope" });
    expect(slackBad.status).toBe(400);
    expect(String(slackBad.body.error)).toMatch(/Slack app settings|did not answer/i);

    const slackOk = await api("POST", "/api/channels/slack", { botToken: "xoxb-TestSlackTokenAlpha" });
    expect(slackOk.status).toBe(200);
    expect(slackOk.body.slack).toMatchObject({
      connected: true,
      botUsername: "realbud",
      paired: false,
      pairedName: null,
    });
    expect(JSON.stringify(slackOk.body)).not.toContain("xoxb-TestSlackTokenAlpha");

    const slackGone = await api("DELETE", "/api/channels/slack");
    expect(slackGone.status).toBe(200);
    expect(slackGone.body.slack).toEqual({ connected: false });
  });

  it("round-trips recipes and keeps shadow runs honest when the worker is away", async () => {
    expect((await api("GET", "/api/recipes")).body.recipes).toEqual([]);
    const draftFail = await api("POST", "/api/recipes/draft", { text: "Every Friday check arrears on PropertyMe." });
    expect(draftFail.status).toBe(503);
    expect(String(draftFail.body.error)).toMatch(/could not shape that job/i);

    const created = await api("POST", "/api/recipes", {
      draft: {
        id: "rec-shadow-1",
        title: "Friday arrears",
        steps: ["Open the arrears report"],
        allowedOrigins: ["https://www.PropertyMe.com.au/report"],
        evidence: "arrears rows",
        status: "shadow",
        createdAt: 1,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.recipes[0]).toMatchObject({
      id: "rec-shadow-1",
      allowedOrigins: ["propertyme.com.au"],
      status: "shadow",
      revision: 1,
      approvedRevision: null,
      capabilities: ["read-book", "analyse", "draft"],
      limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    });

    const patched = await api("PATCH", "/api/recipes/rec-shadow-1", { status: "active" });
    expect(patched.status).toBe(200);
    expect(patched.body.recipes[0].status).toBe("active");
    expect(patched.body.recipes[0].planApprovedAt).toBeNull();
    const prepareHeld = await api("POST", "/api/recipes/rec-shadow-1/prepare", {});
    expect(prepareHeld.status).toBe(409);
    expect(String(prepareHeld.body.error)).toMatch(/approve the current plan/i);

    const approved = await api("PATCH", "/api/recipes/rec-shadow-1", { planApproved: true });
    expect(approved.status).toBe(200);
    expect(typeof approved.body.recipes[0].planApprovedAt).toBe("number");

    const run = await api("POST", "/api/recipes/rec-shadow-1/run", {});
    expect(run.status).toBe(200);
    expect(run.body.session).toMatchObject({
      recipeId: "rec-shadow-1",
      state: "unknown",
      shadow: true,
      allowedOrigins: ["propertyme.com.au"],
    });
    expect(run.body.run).toMatchObject({
      jobId: "rec-shadow-1",
      jobRevision: 1,
      mode: "shadow",
      status: "failed",
      legacySessionId: run.body.session.id,
    });
    expect(String(run.body.session.detail)).toMatch(/tests do not use the live worker/i);

    const prepare = await api("POST", "/api/recipes/rec-shadow-1/prepare", {});
    expect(prepare.status).toBe(200);
    expect(prepare.body.run).toMatchObject({
      jobId: "rec-shadow-1",
      mode: "prepare",
      status: "failed",
    });
    expect(String(prepare.body.run.detail)).toMatch(/tests do not use the live worker/i);

    const jobRuns = await api("GET", "/api/job-runs?jobId=rec-shadow-1");
    expect(jobRuns.status).toBe(200);
    expect(jobRuns.body.runs).toHaveLength(2);
    expect(jobRuns.body.runs.every((row: { jobRevision: number }) => row.jobRevision === 1)).toBe(true);
    const seen = await api("POST", `/api/job-runs/${jobRuns.body.runs[0].id}/seen`, {});
    expect(seen.status).toBe(200);
    expect(typeof seen.body.run.seenAt).toBe("number");

    const sessions = await api("GET", "/api/portal-sessions");
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toHaveLength(1);
    expect(sessions.body.sessions[0].id).toBe(run.body.session.id);

    const lease = await api("POST", `/api/portal-sessions/${run.body.session.id}/lease`, {
      origin: "propertyme.com.au",
    });
    expect(lease.status).toBe(409);

    const gone = await api("DELETE", "/api/recipes/rec-shadow-1");
    expect(gone.status).toBe(200);
    expect(gone.body.recipes).toEqual([]);

    expect((await api("GET", "/api/computer-history")).body.entries).toEqual([]);
    const distillCard = await api("POST", "/api/recipes", {
      draft: {
        id: "rec-distill-http",
        title: "Friday arrears",
        steps: ["Open the arrears report"],
        allowedOrigins: ["propertyme.com.au"],
        evidence: "arrears rows",
        status: "shadow",
        createdAt: 2,
      },
    });
    expect(distillCard.status).toBe(201);
    const distilled = await api("POST", "/api/recipes/rec-distill-http/distill", {});
    expect(distilled.status).toBe(503);
    expect(String(distilled.body.error)).toMatch(/could not tighten those steps/i);
    const still = await api("GET", "/api/recipes");
    expect(still.body.recipes[0].steps).toEqual(["Open the arrears report"]);
    expect(still.body.recipes[0].allowedOrigins).toEqual(["propertyme.com.au"]);
    expect(still.body.recipes[0].evidence).toBe("arrears rows");
    await api("DELETE", "/api/recipes/rec-distill-http");
  });

  it("reuses manual job receipts after response loss and admits a deliberate new request", async () => {
    const id = "manual-retry-http";
    const requestId = "11111111-1111-4111-8111-111111111111";
    const nextId = "22222222-2222-4222-8222-222222222222";
    const created = await api("POST", "/api/recipes", { draft: {
      id, title: "Owner report", description: "Fictional supplied owner notes",
      steps: ["Prepare a private review draft"], allowedOrigins: [], evidence: "Complete draft",
      capabilities: ["analyse", "draft"], status: "shadow", expectedRevision: 0,
    } });
    expect(created.status).toBe(201);
    try {
      expect((await api("PATCH", `/api/recipes/${id}`, { planApproved: true, expectedRevision: 1 })).status).toBe(200);
      for (const mode of ["run", "prepare"]) {
        expect((await api("POST", `/api/recipes/${id}/${mode}`, { requestId: "invalid", expectedRevision: 1 })).status).toBe(400);
        expect((await api("POST", `/api/recipes/${id}/${mode}`, { requestId })).status).toBe(400);
        const input = { requestId, expectedRevision: 1 };
        const first = await api("POST", `/api/recipes/${id}/${mode}`, input);
        expect(first.status).toBe(200);
        const retry = await api("POST", `/api/recipes/${id}/${mode}`, input);
        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({ reused: true, run: { id: first.body.run.id } });
        const deliberate = await api("POST", `/api/recipes/${id}/${mode}`, { requestId: nextId, expectedRevision: 1 });
        expect(deliberate.status).toBe(200);
        expect(deliberate.body.run.id).not.toBe(first.body.run.id);
      }
      expect((await api("GET", `/api/job-runs?jobId=${id}`)).body.runs).toHaveLength(4);
      await api("PATCH", `/api/recipes/${id}`, { status: "paused", expectedRevision: 1 });
      const pausedRetry = await api("POST", `/api/recipes/${id}/prepare`, { requestId, expectedRevision: 1 });
      expect(pausedRetry.status).toBe(200);
      expect(pausedRetry.body.reused).toBe(true);
      const firstPlan = created.body.recipes.find((row: { id: string }) => row.id === id);
      const edited = await api("POST", "/api/recipes", { draft: { ...firstPlan, description: "New source inputs", expectedRevision: 1 } });
      expect(edited.status).toBe(201);
      // A known old request can recover its receipt after an edit; an unknown
      // old request must not run against the replacement plan.
      expect((await api("POST", `/api/recipes/${id}/prepare`, { requestId, expectedRevision: 1 })).body.reused).toBe(true);
      expect((await api("POST", `/api/recipes/${id}/run`, {
        requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: 1,
      })).status).toBe(409);
      expect((await api("GET", `/api/job-runs?jobId=${id}`)).body.runs).toHaveLength(4);
    } finally {
      await api("DELETE", `/api/recipes/${id}`);
    }
  });

  it("cancels a queued attended run whose approved plan changed before it could start", async () => {
    const id = "queued-stale-http";
    const created = await api("POST", "/api/recipes", { draft: {
      id, title: "Review a portal", description: "Read only for the demo",
      steps: ["Read the selected report"], allowedOrigins: ["portal.example.com"], evidence: "Observed rows",
      capabilities: ["portal-read"], status: "shadow", expectedRevision: 0,
      schedule: { time: "16:00", weekdays: [5] },
    } });
    expect(created.status).toBe(201);
    try {
      const approved = await api("PATCH", `/api/recipes/${id}`, { planApproved: true, attach: true, expectedRevision: 1 });
      expect(approved.status).toBe(200);
      expect((await api("POST", `/api/loops/recipe-${id}/run`, {})).status).toBe(201);
      let queued: { id: string; status: string } | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        queued = (await api("GET", `/api/job-runs?jobId=${id}`)).body.runs[0];
        if (queued) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(queued?.status).toBe("queued");
      const saved = approved.body.recipes.find((row: { id: string }) => row.id === id);
      expect((await api("POST", "/api/recipes", { draft: {
        ...saved, steps: ["Read a different report"], expectedRevision: 1,
      } })).status).toBe(201);
      const result = await api("POST", `/api/recipes/${id}/attend`, { runId: queued!.id });
      expect(result.status).toBe(409);
      expect(result.body.error).toMatch(/older queued run was cancelled/i);
      expect((await api("GET", `/api/job-runs?jobId=${id}`)).body.runs[0]).toMatchObject({
        id: queued!.id, status: "cancelled", jobRevision: 1,
      });
    } finally {
      await api("DELETE", `/api/recipes/${id}`);
    }
  });

  it("keeps the edited plan, approval and effective clock on one version", async () => {
    const id = "journey-review";
    try {
      const created = await api("POST", "/api/recipes", { draft: {
        id, title: "Owner review", steps: ["Read the current book"], allowedOrigins: [], evidence: "Source date",
        schedule: { time: "16:00", weekdays: [5] }, expectedRevision: 0,
      } });
      expect(created.status).toBe(201);
      const first = created.body.recipes.find((recipe: { id: string }) => recipe.id === id);
      expect((await api("PATCH", `/api/recipes/${id}`, { planApproved: true, expectedRevision: 1 })).status).toBe(200);
      await api("PATCH", `/api/loops/recipe-${id}`, { time: "17:00", enabled: false });

      const edited = await api("POST", "/api/recipes", { draft: { ...first, schedule: { time: "15:30", weekdays: [4] }, expectedRevision: 1 } });
      expect(edited.status).toBe(201);
      const second = edited.body.recipes.find((recipe: { id: string }) => recipe.id === id);
      expect(second).toMatchObject({ revision: 2, approvedRevision: null });
      expect((await api("POST", "/api/recipes", { draft: { ...first, expectedRevision: 1 } })).status).toBe(409);
      expect((await api("PATCH", `/api/recipes/${id}`, { planApproved: true, expectedRevision: 1 })).status).toBe(409);
      expect((await api("POST", `/api/recipes/${id}/run`, { expectedRevision: 1 })).status).toBe(409);
      expect((await api("PATCH", `/api/recipes/${id}`, { planApproved: true, expectedRevision: 2 })).status).toBe(200);
      expect((await api("POST", `/api/recipes/${id}/prepare`, { expectedRevision: 1 })).status).toBe(409);
      const clock = (await api("GET", "/api/loops")).body.loops.find((loop: { id: string }) => loop.id === `recipe-${id}`);
      expect(clock).toMatchObject({ enabled: true, waitingForPlan: false, schedule: { time: "15:30", weekdays: [4] } });

      const manual = await api("POST", "/api/recipes", { draft: { ...second, schedule: null, expectedRevision: 2 } });
      expect(manual.status).toBe(201);
      expect((await api("GET", "/api/loops")).body.loops.some((loop: { id: string }) => loop.id === `recipe-${id}`)).toBe(false);
    } finally {
      await api("DELETE", `/api/recipes/${id}`);
    }
  });

  it("holds a scheduled job for one plan approval before admitting it onto the RealBud clock", async () => {
    const created = await api("POST", "/api/recipes", {
      draft: {
        id: "rec-clock-1",
        title: "Friday arrears",
        steps: ["Open the arrears report"],
        allowedOrigins: ["propertyme.com.au"],
        evidence: "arrears rows",
        status: "shadow",
        createdAt: 3,
        schedule: { time: "16:00", weekdays: [5] },
      },
    });
    expect(created.status).toBe(201);

    const listed = await api("GET", "/api/loops");
    const job = listed.body.loops.find((loop: { id: string }) => loop.id === "recipe-rec-clock-1");
    expect(job).toMatchObject({
      name: "Friday arrears",
      available: true,
      enabled: false,
      waitingForPlan: true,
      evaluatorId: "recipe",
      schedule: { type: "daily", time: "16:00", weekdays: [5] },
    });

    const approved = await api("PATCH", "/api/recipes/rec-clock-1", { planApproved: true });
    expect(approved.status).toBe(200);
    const admitted = (await api("GET", "/api/loops")).body.loops.find(
      (loop: { id: string }) => loop.id === "recipe-rec-clock-1",
    );
    expect(admitted).toMatchObject({ enabled: true, waitingForPlan: false });

    const paused = await api("PATCH", "/api/loops/recipe-rec-clock-1", { enabled: false });
    expect(paused.status).toBe(200);
    expect(paused.body.loop.enabled).toBe(false);
    expect((await api("GET", "/api/recipes")).body.recipes.find((row: { id: string }) => row.id === "rec-clock-1")?.status).toBe(
      "paused",
    );

    await api("PATCH", "/api/loops/recipe-rec-clock-1", { enabled: true });
    const run = await api("POST", "/api/loops/recipe-rec-clock-1/run", {});
    expect(run.status).toBe(201);
    expect(run.body.run.loopId).toBe("recipe-rec-clock-1");

    await api("DELETE", "/api/recipes/rec-clock-1");
    const after = await api("GET", "/api/loops");
    expect(after.body.loops.some((loop: { id: string }) => loop.id === "recipe-rec-clock-1")).toBe(false);
  });

  it("keeps the one worker unsupervisable-by-API and undeletable", async () => {
    const auto = await api("PATCH", "/api/bots/bud", { autoApprove: true });
    expect(auto.status).toBe(403);
    expect(String(auto.body.error)).toMatch(/unattended/i);

    const always = await api("PATCH", "/api/bots/bud", { alwaysAllow: ["Bash"] });
    expect(always.status).toBe(403);

    const chief = await api("PATCH", "/api/bots/bud", { chiefOfStaff: true });
    expect(chief.status).toBe(403);

    const rename = await api("PATCH", "/api/bots/bud", { name: "Not Bud" });
    expect(rename.status).toBe(403);

    // a cosmetic patch that flips nothing still works
    const cosmetic = await api("PATCH", "/api/bots/bud", { pinned: false });
    expect(cosmetic.status).toBe(200);

    const del = await api("DELETE", "/api/bots/bud");
    expect(del.status).toBe(403);
    expect(String(del.body.error)).toMatch(/one Bud thread/i);

    const after = (await api("GET", "/api/bots")).body.bots;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: "bud", name: "Bud" });
    expect(after[0].autoApprove ?? false).toBe(false);
    expect(after[0].alwaysAllow ?? []).toEqual([]);
  });

  async function workshopBot() {
    const listed = await api("GET", "/api/bots");
    const bot = listed.body.bots.find((b: { id: string }) => b.id === "bud");
    expect(bot).toBeTruthy();
    return bot;
  }

  it("keeps Bud as the only visible thread", async () => {
    const bot = await workshopBot();
    expect(bot.name).toBe("Bud");
    expect(bot.messages.some((m: { kind: string }) => m.kind === "text")).toBe(true);
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const bot = await workshopBot();

    const empty = await api("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    const hello = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(hello.status).toBe(202);
    const afterHello = await api("GET", "/api/bots");
    const helloBot = afterHello.body.bots.find((b: { id: string }) => b.id === "bud");
    expect(helloBot.messages.at(-1).text).toMatch(/I'm Bud/);

    // An explicit connection instruction is brokered directly even though
    // the model instance is unavailable. No shell turn or extra permission
    // is involved; without the broker key, Bud points to its write-only row.
    const connect = await api("POST", `/api/bots/${bot.id}/messages`, { text: "connect me to notion" });
    expect(connect.status).toBe(202);
    const afterConnect = await api("GET", "/api/bots");
    const connectedBot = afterConnect.body.bots.find((b: { id: string }) => b.id === "bud");
    expect(connectedBot.busy).toBe(false);
    expect(connectedBot.messages.at(-1).text).toMatch(/Save Connected apps key/i);

    // a free-form turn still fails loudly when the worker instance is a ghost
    const send = await api("POST", `/api/bots/${bot.id}/messages`, { text: "write a sonnet about trust accounts" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
  });

  it("opens provider sign-in directly for an explicit connection instruction", async () => {
    composioForceConnected.clear();
    const saved = await api("PUT", "/api/config", {
      composio: { key: `ck_${"brokersecret".repeat(3)}`, url: `http://127.0.0.1:${composioStubPort}` },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.composio).toMatchObject({ configured: true });
    if (process.platform !== "win32") expect(statSync(join(home, ".realbud", "config.json")).mode & 0o777).toBe(0o600);

    const sent = await api("POST", "/api/bots/bud/messages", { text: "connect Gmail" });
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 3_000;
    let bot: any;
    do {
      bot = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === "bud");
      if (!bot.busy && /auth\.example/.test(bot.messages.at(-1)?.text ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);

    expect(bot.busy).toBe(false);
    expect(bot.messages.at(-1).text).toMatch(/I opened Gmail sign-in/i);
    expect(bot.messages.at(-1).text).toContain("https://auth.example/connect/gmail");
    expect(composioCalls.some((body) => body.includes("COMPOSIO_MANAGE_CONNECTIONS") && body.includes("gmail"))).toBe(true);
    expect(JSON.stringify(bot.messages)).not.toContain("brokersecret");
  });

  it("does not re-open sign-in when the app is already connected", async () => {
    composioForceConnected.clear();
    composioForceConnected.add("gmail");
    const saved = await api("PUT", "/api/config", {
      composio: { key: `ck_${"alreadyconnected".repeat(2)}`, url: `http://127.0.0.1:${composioStubPort}` },
    });
    expect(saved.status).toBe(200);

    const beforeCalls = composioCalls.length;
    const sent = await api("POST", "/api/bots/bud/messages", { text: "connect me to gmail" });
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 3_000;
    let bot: any;
    do {
      bot = (await api("GET", "/api/bots")).body.bots.find((candidate: { id: string }) => candidate.id === "bud");
      if (!bot.busy && /already connected/i.test(bot.messages.at(-1)?.text ?? "")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);

    expect(bot.busy).toBe(false);
    expect(bot.messages.at(-1).text).toMatch(/Gmail is already connected/i);
    expect(bot.messages.at(-1).text).not.toMatch(/auth\.example/);
    const newCalls = composioCalls.slice(beforeCalls);
    expect(newCalls.some((body) => body.includes('"action":"list"') || body.includes('"action": "list"'))).toBe(true);
    expect(newCalls.every((body) => !body.includes('"action":"add"') && !body.includes('"action": "add"'))).toBe(true);
    composioForceConnected.clear();
  });

  it("checks connection completion without starting a new OAuth flow", async () => {
    const before = composioCalls.length;
    const response = await api("POST", "/api/bots/bud/messages", { text: "check Gmail connection" });
    expect(response.status).toBe(202);
    let bot: any;
    for (let i = 0; i < 100; i++) {
      bot = (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === "bud");
      if (!bot.busy) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(bot.messages.at(-1).text).toContain("not connected yet");
    expect(composioCalls.slice(before).some(body => body.includes('"action":"add"'))).toBe(false);
  });

  it("a failed connection check does not automatically create another sign-in", async () => {
    composioStatusFailure = true;
    const before = composioCalls.length;
    try {
      expect((await api("POST", "/api/bots/bud/messages", { text: "connect Gmail" })).status).toBe(202);
      let bot: any;
      for (let i = 0; i < 100; i++) {
        bot = (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === "bud");
        if (!bot.busy) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(bot.messages.at(-1).text).toContain("No new sign-in was started");
      expect(composioCalls.slice(before).some(body => body.includes('"action":"add"'))).toBe(false);
    } finally { composioStatusFailure = false; }
  });

  it("exposes authenticated product access checks without claiming an actual mailbox read", async () => {
    expect((await fetch(`${BASE}/api/connected-apps/status`)).status).toBe(401);
    expect((await fetch(`${BASE}/api/config`)).status).toBe(401);
    expect((await api("GET", "/api/connected-apps/status")).body.tools.available).toBe(false);
    composioForceConnected.add("gmail");
    try {
      const checked = await api("POST", "/api/connected-apps/check", {});
      expect(checked.status).toBe(200);
      expect(checked.body).toMatchObject({ configured: true, tools: { available: true }, services: {
        gmail: { connected: true, accounts: [{ id: "acct-1", status: "ACTIVE" }], accountSelectionRequired: false },
      } });
      expect((await api("GET", "/api/connected-apps/operations")).body.operations).toEqual([]);
      expect(JSON.stringify(checked.body)).not.toContain("alreadyconnected");
    } finally { composioForceConnected.clear(); }
  });

  it("shares source state across Ask, settings and removal without a model or mailbox action", async () => {
    composioForceConnected.add("gmail");
    try {
      expect((await api("PUT", "/api/config", { composio: { key: "ck_office_fixture", url: `http://127.0.0.1:${composioStubPort}` } })).status).toBe(200);
      expect((await api("GET", "/api/connected-apps/status")).body.services.gmail.connected).toBe(true);
      const before = composioCalls.length;
      const unauthenticated = await fetch(`${BASE}/api/connected-apps/sources/gmail`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
      expect(unauthenticated.status).toBe(401);
      expect((await api("PATCH", "/api/connected-apps/sources/gmail", { enabled: "no" })).status).toBe(400);
      expect((await api("PATCH", "/api/connected-apps/sources/unknownfixture", { enabled: false })).status).toBe(400);
      expect((await api("PATCH", "/api/connected-apps/sources/gmail", { accountId: "missing" })).status).toBe(409);
      const off = await api("PATCH", "/api/connected-apps/sources/gmail", { enabled: false });
      expect(off.status).toBe(200); expect(off.body.excludedApps).toContain("gmail");
      expect((await api("PATCH", "/api/connected-apps/sources/gmail", { enabled: false })).body.excludedApps).toEqual(["gmail"]);
      expect((await api("POST", "/api/bots/bud/messages", { text: "what are we connected to?" })).status).toBe(202);
      let bot: any;
      for (let attempt = 0; attempt < 100; attempt++) {
        bot = (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === "bud");
        if (!bot.busy) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(bot.messages.at(-1).text).toMatch(/Gmail.*off in Ask/i);
      const restored = await api("PATCH", "/api/connected-apps/sources/gmail", { enabled: true, accountId: "acct-1" });
      expect(restored.body.services.gmail.selectedAccountId).toBe("acct-1");
      expect(restored.body.excludedApps).toEqual([]);
      expect(composioCalls.slice(before).map(body => JSON.parse(body)).filter(row => row.method === "tools/call").every(row =>
        row.params.name === "COMPOSIO_MANAGE_CONNECTIONS" && row.params.arguments.toolkits.every((app: any) => app.action === "list"))).toBe(true);
      expect((await api("POST", "/api/bots/bud/messages", { text: "what is scheduled?" })).status).toBe(202);
      expect((await workshopBot()).messages.at(-1).text).toContain("**Schedule work**");
    } finally { composioForceConnected.clear(); }
  });

  it("keeps the working key when replacement validation fails, and invalidates access on removal", async () => {
    const rejected = await api("PUT", "/api/config", { composio: { key: "ck_rejected_secret" } });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(rejected.body)).not.toContain("rejected_secret");
    expect((await api("GET", "/api/config")).body.composio.configured).toBe(true);
    expect((await api("PUT", "/api/config", { composio: { key: "" } })).status).toBe(200);
    expect((await api("GET", "/api/connected-apps/status")).body).toMatchObject({ configured: false, tools: { available: false } });
  });

  it("refuses to fork a message when the provider is unavailable, without mutating", async () => {
    const bot = await workshopBot();
    const before = bot.messages.length;

    // greeting is a bot message — not editable
    const greeting = bot.messages.find((m: { role: string }) => m.role === "bot");
    const notUser = await api("POST", `/api/bots/${bot.id}/messages/${greeting.id}/edit`, { text: "x" });
    expect(notUser.status).toBe(404);

    const empty = await api("POST", `/api/bots/${bot.id}/messages/${greeting.id}/edit`, { text: "  " });
    expect(empty.status).toBe(400);

    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === "bud").messages.length).toBe(before);
  });

  it("switches the active branch and reports the new leaf", async () => {
    const bot = await workshopBot();
    expect(bot.activeLeafId).toBe(bot.messages.at(-1).id);

    // pointing at the first message descends back to the newest leaf on
    // that (only) branch — a no-op switch, but it exercises the descent
    const res = await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: bot.messages[0].id });
    expect(res.status).toBe(200);
    expect(res.body.activeLeafId).toBe(bot.messages.at(-1).id);

    const missing = await api("POST", `/api/bots/${bot.id}/active-branch`, { messageId: "nope" });
    expect(missing.status).toBe(404);
  });

  it("refuses a box token the provider rejects, at the point of pasting", async () => {
    // the stub answers 401 for anything but the good token
    const bad = await api("PUT", "/api/config", { box: { token: "box_wrong" } });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/rejected/i);
    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: false });
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.box).toEqual({ configured: false });

    const put = await api("PUT", "/api/config", { box: { token: "box_good" } });
    expect(put.status).toBe(200);
    expect(put.body.box).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("box_good");

    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("box_good");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("stores and echoes the user profile (not write-only, unlike keys)", async () => {
    const put = await api("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "Ada@Example.com" });
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });

  it("requires a session for Desk and refuses a foreign Origin", async () => {
    const bare = await fetch(`${BASE}/api/desk`);
    expect(bare.status).toBe(401);
    const foreign = await fetch(`${BASE}/api/desk`, {
      headers: { origin: "https://evil.example", "x-realbud-session": session },
    });
    expect(foreign.status).toBe(403);
    const artifact = await fetch(`${BASE}/api/artifacts/art-missing`);
    expect(artifact.status).toBe(401);
    const jobRuns = await fetch(`${BASE}/api/job-runs`);
    expect(jobRuns.status).toBe(401);
    const ok = await api("GET", "/api/desk");
    expect(ok.status).toBe(200);
    expect(ok.body.properties.length).toBe(6);
    expect(JSON.stringify(ok.body)).not.toMatch(/"ct":/);
  });

  it("runs the Demo desk check and refuses to send", async () => {
    const empty = await api("GET", "/api/desk");
    expect(empty.status).toBe(200);
    expect(empty.body.properties.length).toBe(6);

    const missed = await api("POST", "/api/desk/check", {});
    expect(missed.status).toBe(200);
    expect(["demo", "held", "hermes", "csv"]).toContain(missed.body.hands);

    const checked = missed.body.drafts?.some((d: { kind: string }) => d.kind === "courtesy-rent")
      ? missed
      : await api("POST", "/api/desk/practice", {});
    expect(checked.status).toBe(200);
    const courtesy = checked.body.drafts.find((d: { kind: string }) => d.kind === "courtesy-rent");
    expect(courtesy?.status).toBe("pending");
    expect(checked.body.escalations.length).toBeGreaterThan(0);

    const send = await api("POST", `/api/desk/drafts/${courtesy.id}/send`);
    expect(send.status).toBe(403);
    expect(String(send.body.error)).toMatch(/never sends/i);

    const allowed = await api("POST", `/api/desk/drafts/${courtesy.id}/allow`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.draft.status).toBe("allowed");
    expect(allowed.body.draft.sentAt).toBeUndefined();

    const levy = checked.body.drafts.find((d: { kind: string; status: string }) => d.kind === "levy-from-rent" && d.status === "pending");
    const stale = await api("POST", `/api/desk/drafts/${levy.id}/allow`, { expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(String(stale.body.error)).toMatch(/revision/);
  });

  it("round-trips notes and puts an Ask courtesy on Desk without send", async () => {
    const put = await api("PUT", "/api/desk/properties/prop-oak/notes", {
      body: "Owner wants Friday email. No SMS after 8.",
    });
    expect(put.status).toBe(200);
    expect(put.body.body).toMatch(/Friday email/);
    const got = await api("GET", "/api/desk/properties/prop-oak/notes");
    expect(got.body.body).toMatch(/No SMS after 8/);
    expect(JSON.stringify(got.body)).not.toMatch(/Obsidian|second brain|vault/i);

    const proposed = await api("POST", "/api/desk/propose", { propertyId: "prop-oak", kind: "courtesy-rent" });
    expect(proposed.status).toBe(201);
    const draft = proposed.body.drafts.find(
      (d: { propertyId: string; kind: string; status: string }) =>
        d.propertyId === "prop-oak" && d.kind === "courtesy-rent" && d.status === "pending",
    );
    expect(draft).toBeTruthy();
    const send = await api("POST", `/api/desk/drafts/${draft.id}/send`, {});
    expect(send.status).toBe(403);
  });

  it("imports an address-keyed CSV onto Oak Street", async () => {
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak Street, Dickson ACT",4,false,false\n`;
    const before = await api("GET", "/api/desk");
    const preview = await api("POST", "/api/desk/import/preview", { csv });
    expect(preview.status).toBe(200);
    expect(preview.body.matched).toEqual([{ propertyId: "prop-oak", address: "12 Oak St, Dickson ACT" }]);
    const afterPreview = await api("GET", "/api/desk");
    expect(afterPreview.body.revision).toBe(before.body.revision);
    expect(afterPreview.body.ledger).toEqual(before.body.ledger);
    const snap = await api("POST", "/api/desk/import", {
      csv,
      expectedDigest: preview.body.digest,
      expectedRevision: preview.body.expectedRevision,
      observedAt: preview.body.observedAt,
    });
    expect(snap.status).toBe(200);
    expect(snap.body.hands).toBe("csv");
    const oak = snap.body.ledger.find((r: { propertyId: string }) => r.propertyId === "prop-oak");
    expect(oak.daysSinceDue).toBe(4);
  });

  it("refuses an import or a wording edit that was composed against a stale book", async () => {
    // The clock rewrites the book while the PM has the screen open. Both of
    // these paths used to accept the write and silently clobber the newer state.
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak Street, Dickson ACT",6,false,false\n`;
    const preview = await api("POST", "/api/desk/import/preview", { csv });
    const changedCsv = csv.replace(",6,", ",7,");
    const changed = await api("POST", "/api/desk/import", {
      csv: changedCsv,
      expectedDigest: preview.body.digest,
      expectedRevision: preview.body.expectedRevision,
      observedAt: preview.body.observedAt,
    });
    expect(changed.status).toBe(400);
    expect(String(changed.body.error)).toMatch(/changed after review/);

    const staleImport = await api("POST", "/api/desk/import", {
      csv,
      expectedDigest: preview.body.digest,
      expectedRevision: 0,
      observedAt: preview.body.observedAt,
    });
    expect(staleImport.status).toBe(409);
    expect(String(staleImport.body.error)).toMatch(/revision/);

    const freshPreview = await api("POST", "/api/desk/import/preview", { csv });
    const fresh = await api("POST", "/api/desk/import", {
      csv,
      expectedDigest: freshPreview.body.digest,
      expectedRevision: freshPreview.body.expectedRevision,
      observedAt: freshPreview.body.observedAt,
    });
    expect(fresh.status).toBe(200);

    const pending = fresh.body.drafts.find((d: { status: string }) => d.status === "pending");
    if (pending) {
      const staleEdit = await api("PATCH", `/api/desk/drafts/${pending.id}`, {
        body: "edited under an old rule",
        expectedRevision: 0,
      });
      expect(staleEdit.status).toBe(409);
      expect(String(staleEdit.body.error)).toMatch(/revision/);
    }
  });
});

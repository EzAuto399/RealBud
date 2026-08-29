// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // Hostile legacy fleet state: product mode must canonicalise it to the one
  // private Bud worker instead of loading the persisted unknown driver.
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

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      // child-process coverage: the v8 provider measures the spawned server
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_BOX_API: `http://127.0.0.1:${boxStubPort}`,
      OMB_STATIC_DIR: staticDir,
      REALBUD_BANK_ALLOWED_ORIGIN: "http://127.0.0.1:54321",
      REALBUD_APP_VERSION: "0.1.17",
      REALBUD_BUILD_ID: "http-test-build",
      REALBUD_TOOL_VERIFY: "0",
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
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe("harness HTTP API", () => {
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

  it("reports an honest empty private usage window before any model turn", async () => {
    const { status, body } = await api("GET", "/api/usage");
    expect(status).toBe(200);
    expect(body.usage).toMatchObject({
      period: { kind: "rolling", days: 7 },
      completedTurns: 0,
      tokenReportedTurns: 0,
      costReportedTurns: 0,
      costUsd: null,
      metering: "empty",
      storage: "ok",
    });
    expect(body.usage).not.toHaveProperty("messages");
    expect(body.usage).not.toHaveProperty("prompts");
    expect(body.usage).not.toHaveProperty("properties");
    expect(body.usage).not.toHaveProperty("threadId");
    expect(body.usage).not.toHaveProperty("turnId");
  });

  it("lists the named loops and refuses to run a planned one", async () => {
    const { status, body } = await api("GET", "/api/loops");
    expect(status).toBe(200);
    expect(body.loops.map((loop: { id: string }) => loop.id)).toEqual([
      "morning-arrears",
      "owner-letter",
      "inbound-triage",
    ]);
    const morning = body.loops.find((loop: { id: string }) => loop.id === "morning-arrears");
    expect(morning).toMatchObject({ available: true, enabled: true });
    expect(morning.requirements.map((requirement: { id: string }) => requirement.id)).toEqual([
      "desk-book",
      "current-money-source",
    ]);
    const ownerLetter = body.loops.find((loop: { id: string }) => loop.id === "owner-letter");
    expect(ownerLetter).toMatchObject({ available: true, enabled: false });
    const planned = body.loops.find((loop: { id: string }) => loop.id === "inbound-triage");
    expect(planned).toMatchObject({ available: false, enabled: false });
    expect(planned).not.toHaveProperty("prompt");

    const run = await api("POST", "/api/loops/inbound-triage/run", {});
    expect(run.status).toBe(409);

    const enabled = await api("PATCH", "/api/loops/owner-letter", {
      enabled: true,
      expectedRevision: ownerLetter.revision,
    });
    expect(enabled.status).toBe(200);

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

    type SettledRun = { id: string; status: string; notifiedAt?: number; routineRevision?: number; steps?: Array<{ id: string; status: string }> };
    let settledRun: SettledRun | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const listed = (await api("GET", "/api/loops")).body.runs as SettledRun[];
      settledRun = listed.find((candidate) => candidate.id === letter.body.run.id);
      if (settledRun && !["queued", "running"].includes(settledRun.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(settledRun?.status).toBe("completed");
    expect(settledRun?.routineRevision).toEqual(expect.any(Number));
    expect(settledRun?.steps?.map((step) => [step.id, step.status])).toEqual([
      ["preflight", "completed"],
      ["collect", "completed"],
      ["evaluate", "completed"],
      ["stage-desk", "completed"],
    ]);
    const notified = await api("POST", `/api/loop-runs/${letter.body.run.id}/notified`, {});
    expect(notified.status).toBe(200);
    expect(notified.body.run.notifiedAt).toEqual(expect.any(Number));
    const notifiedReplay = await api("POST", `/api/loop-runs/${letter.body.run.id}/notified`, {});
    expect(notifiedReplay.body.run.notifiedAt).toBe(notified.body.run.notifiedAt);
    expect((await api("POST", "/api/loop-runs/no-such-run/notified", {})).status).toBe(404);

    const beforePatch = (await api("GET", "/api/loops")).body.loops.find((loop: { id: string }) => loop.id === "morning-arrears");
    const patch = await api("PATCH", "/api/loops/morning-arrears", { enabled: false, expectedRevision: beforePatch.revision });
    expect(patch.status).toBe(200);
    expect(patch.body.loop.enabled).toBe(false);
    expect(patch.body.loop.revision).toBeGreaterThanOrEqual(1);
    await api("PATCH", "/api/loops/morning-arrears", { enabled: true, expectedRevision: patch.body.loop.revision });
  });

  it("projects only RealBud-owned source connections and keeps generic connector routes denied", async () => {
    const { status, body } = await api("GET", "/api/source-connections");
    expect(status).toBe(200);
    expect(body.connections.map((connection: { id: string }) => connection.id)).toEqual([
      "property-book",
      "inbound-mail-calendar",
    ]);
    const mail = body.connections.find((connection: { id: string }) => connection.id === "inbound-mail-calendar");
    expect(mail.methods.map((method: { id: string }) => method.id)).toEqual([
      "direct-api",
      "restricted-composio",
      "approved-mcp",
    ]);
    expect(mail.methods.every((method: { state: string }) => method.state === "pilot-gated")).toBe(true);
    expect((await api("GET", "/api/connectors")).status).toBe(403);
    expect((await api("POST", "/api/connectors/gmail/authorize")).status).toBe(403);
    const office = await api("GET", "/api/office-sources?services=gmail");
    expect(office.status).toBe(200);
    expect(office.body.configured).toBe(false);
    expect((await api("POST", "/api/office-sources/slack/authorize")).status).toBe(409);
    expect((await api("POST", "/api/office-sources/gmail/authorize")).status).toBe(409);

    const unauth = await fetch(`${BASE}/api/ask-attachments`, {
      method: "POST",
      headers: { "x-realbud-filename": "note.pdf", "content-type": "application/octet-stream" },
      body: "%PDF-1.4",
    });
    expect(unauth.status).toBe(401);
    const refused = await fetch(`${BASE}/api/ask-attachments`, {
      method: "POST",
      headers: {
        "x-realbud-session": session,
        "x-realbud-filename": "reel.mp4",
        "content-type": "application/octet-stream",
      },
      body: "nope",
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/PDF, image, spreadsheet or text export/i);
    const staged = await fetch(`${BASE}/api/ask-attachments`, {
      method: "POST",
      headers: {
        "x-realbud-session": session,
        "x-realbud-filename": encodeURIComponent("hold card.pdf"),
        "content-type": "application/octet-stream",
      },
      body: "%PDF-1.4 hold",
    });
    expect(staged.status).toBe(201);
    const stagedBody = await staged.json() as { path: string; name: string; mimeType: string };
    expect(stagedBody.name).toBe("hold card.pdf");
    expect(stagedBody.mimeType).toBe("application/pdf");
    expect(stagedBody.path).toContain("composer-inbox");
  });

  it("projects agency-neutral pilot discovery without unlocking operational authority", async () => {
    const { status, body } = await api("GET", "/api/pilot-discovery");
    expect(status).toBe(200);
    expect(body.discovery).toMatchObject({
      kind: "realbud.pilot-discovery.v1",
      office: { agency: null, state: "unconfigured" },
      readiness: { confirmedFields: 0, requiredFields: 8, contractComplete: false, evidence: "pilot-gated" },
      boundaries: {
        externalResearchGrantsAuthority: false,
        manualAllow: true,
        humanSubmit: true,
        sendAvailable: false,
        paymentAvailable: false,
        personalBrowserAccess: false,
        personalHermesAccess: false,
      },
    });
    expect(body.discovery.fields).toHaveLength(8);
    expect(body.discovery.systemFamilies).toHaveLength(7);
    expect((await api("POST", "/api/pilot-discovery", {})).status).toBe(403);

    const noSession = await fetch(`${BASE}/api/pilot-discovery`);
    expect(noSession.status).toBe(401);
  });

  it("projects bounded execution foundations without exposing authority or account material", async () => {
    const { status, body } = await api("GET", "/api/execution-adapters");
    expect(status).toBe(200);
    expect(body.adapters).toHaveLength(9);
    expect(body.adapters.filter((adapter: { state: string }) => adapter.state === "foundation")).toHaveLength(8);
    expect(body.adapters.find((adapter: { id: string }) => adapter.id === "computer-history-recovery")).toMatchObject({
      state: "runtime-unavailable",
      route: null,
      maxConcurrency: 0,
    });
    expect(body.adapters.every((adapter: {
      boundaries: {
        manualAllow: boolean;
        humanSubmit: boolean;
        rawToolsExposed: boolean;
        ambientCredentials: boolean;
        personalBrowserAccess: boolean;
        personalHermesAccess: boolean;
        localFallback: boolean;
      };
    }) => (
      adapter.boundaries.manualAllow
      && adapter.boundaries.humanSubmit
      && adapter.boundaries.rawToolsExposed === false
      && adapter.boundaries.ambientCredentials === false
      && adapter.boundaries.personalBrowserAccess === false
      && adapter.boundaries.personalHermesAccess === false
      && adapter.boundaries.localFallback
    ))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/accountIdentityDigest|policyDigest|cookie|\.hermes|\/Users\/|secret|apiKey/i);
    expect((await api("POST", "/api/execution-adapters", {})).status).toBe(403);
  });

  it("exports categorical support evidence without people, source payloads, credentials or host paths", async () => {
    const sessionResponse = await api("GET", "/api/session");
    expect(sessionResponse.body.release).toMatchObject({
      app: { version: "0.1.17", buildId: "http-test-build", distribution: "source" },
      evidence: { source: "not-recorded", installed: "requires-installed-proof", namedOffice: "pilot-gated" },
    });

    const { status, body } = await api("GET", "/api/support-report");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      kind: "realbud.support-report.v1",
      schemaVersion: 1,
      app: { version: "0.1.17", buildId: "http-test-build", distribution: "source", productMode: true },
      evidence: { source: "not-recorded", installed: "requires-installed-proof", namedOffice: "pilot-gated" },
      worker: { state: "setup-required", modelAttached: false },
      mobile: { state: "pilot-gated", connectedCount: 0 },
    });
    expect(body.desk.properties).toBeGreaterThan(0);
    expect(body.connections).toHaveLength(2);
    expect(body.execution).toHaveLength(9);
    expect(JSON.stringify(body)).not.toMatch(/tenant|phone|address|notes|message|prompt|cookie|credential|api.?key|token|secret|\.hermes|\/Users\/|\\Users\\/i);
  });

  it("projects an honest local-first portfolio route without personal runtime or browser authority", async () => {
    const { status, body } = await api("GET", "/api/work-routing");
    expect(status).toBe(200);
    expect(body.plan).toMatchObject({
      kind: "realbud.work-routing.v1",
      schemaVersion: 1,
      preferenceConfigured: false,
      preferenceRevision: 0,
      requestedMode: "auto",
      selectedMode: "local-standard",
      boundaries: {
        cloudRequired: false,
        maxIsolatedBrowsers: 2,
        maxDesktopCua: 1,
        workerOwnership: "external-pinned-runtime",
        browserOwnership: "realbud-only",
        personalBrowserAccess: false,
        personalHermesAccess: false,
      },
    });
    expect(body.plan.lanes).toContainEqual(expect.objectContaining({
      kind: "structured-batch",
      batchCount: 1,
      concurrency: 1,
      state: "ready",
    }));
    expect(body.plan.estimate).toMatchObject({ basis: "unavailable", minimumSeconds: null, maximumSeconds: null });
    expect(JSON.stringify(body.plan)).not.toMatch(/cookie|credential|\.hermes|\/Users\//i);
    expect((await api("PATCH", "/api/work-routing/preference", {
      preference: "auto",
      expectedPreference: "auto",
      expectedRevision: "0",
    })).status).toBe(400);

    const saved = await api("PATCH", "/api/work-routing/preference", {
      preference: "local-accelerated",
      expectedPreference: "auto",
      expectedRevision: 0,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.plan).toMatchObject({
      preferenceConfigured: true,
      preferenceRevision: 1,
      requestedMode: "local-accelerated",
      selectedMode: "local-standard",
    });
    expect(saved.body.plan.fallbackReasons.join(" ")).toMatch(/local acceleration needs|no ready independent local lane/i);
    expect((await api("GET", "/api/work-routing")).body.plan.requestedMode).toBe("local-accelerated");

    expect((await api("PATCH", "/api/work-routing/preference", {
      preference: "cloud-accelerated",
      expectedPreference: "auto",
      expectedRevision: 0,
    })).status).toBe(409);
    expect((await api("PATCH", "/api/work-routing/preference", {
      preference: "personal-browser",
      expectedPreference: "local-accelerated",
      expectedRevision: 1,
    })).status).toBe(400);
    expect((await api("PATCH", "/api/work-routing/preference", {
      preference: "auto",
      expectedPreference: "local-accelerated",
      expectedRevision: 1,
      rawTool: "browser_exec",
    })).status).toBe(400);

    const reset = await api("PATCH", "/api/work-routing/preference", {
      preference: "auto",
      expectedPreference: "local-accelerated",
      expectedRevision: 1,
    });
    expect(reset.status).toBe(200);
    expect(reset.body.plan).toMatchObject({ preferenceConfigured: true, preferenceRevision: 2, requestedMode: "auto" });
    expect((await api("PATCH", "/api/work-routing/preference", {
      preference: "cloud-accelerated",
      expectedPreference: "auto",
      expectedRevision: 0,
    })).status).toBe(409);
  });

  it("retunes a loop's clock over the API and rejects malformed patches", async () => {
    const listed = (await api("GET", "/api/loops")).body.loops as Array<{ id: string; revision: number }>;
    const morningRevision = listed.find((loop) => loop.id === "morning-arrears")!.revision;
    const inboundRevision = listed.find((loop) => loop.id === "inbound-triage")!.revision;
    const retune = await api("PATCH", "/api/loops/morning-arrears", {
      time: "08:15",
      weekdays: [1, 2, 3, 4, 5],
      expectedRevision: morningRevision,
    });
    expect(retune.status).toBe(200);
    expect(retune.body.loop).toMatchObject({ schedule: { time: "08:15" }, revision: expect.any(Number) });
    const staleRetune = await api("PATCH", "/api/loops/morning-arrears", {
      time: "08:30",
      expectedRevision: morningRevision,
    });
    expect(staleRetune.status).toBe(409);

    const planned = await api("PATCH", "/api/loops/inbound-triage", { time: "09:15", expectedRevision: inboundRevision });
    expect(planned.status).toBe(200);
    const enablePlanned = await api("PATCH", "/api/loops/inbound-triage", { enabled: true, expectedRevision: planned.body.loop.revision });
    expect(enablePlanned.status).toBe(400);
    expect(String(enablePlanned.body.error)).toMatch(/not built yet/);

    const empty = await api("PATCH", "/api/loops/morning-arrears", {});
    expect(empty.status).toBe(400);
    const badTime = await api("PATCH", "/api/loops/morning-arrears", { time: "7:77", expectedRevision: retune.body.loop.revision });
    expect(badTime.status).toBe(400);
    const badDays = await api("PATCH", "/api/loops/morning-arrears", { weekdays: [0, 9], expectedRevision: retune.body.loop.revision });
    expect(badDays.status).toBe(400);

    // put the clock back for the rest of the suite
    await api("PATCH", "/api/loops/morning-arrears", { time: "07:30", expectedRevision: retune.body.loop.revision });
    await api("PATCH", "/api/loops/inbound-triage", { time: "09:00", expectedRevision: planned.body.loop.revision });
  });

  it("refuses generic engine setup in product mode", async () => {
    const setup = await api("POST", "/api/instances/ghost/setup", {});
    expect(setup.status).toBe(403);
    expect(String(setup.body.error)).toMatch(/through You/i);
  });

  it("canonicalises persisted fleet state to the one private Bud worker", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0]).toMatchObject({
      instanceId: "hermes",
      driverKind: "hermesAgent",
      displayName: "Worker",
      snapshot: { state: "unavailable" },
    });
    expect(JSON.stringify(body.instances[0])).not.toContain("ghost");
    expect(JSON.stringify(body.instances[0])).not.toContain("not-a-real-driver");
  });

  it("reports the pinned Hermes worker status", async () => {
    const { status, body } = await api("GET", "/api/hermes");
    expect(status).toBe(200);
    expect(body.pin).toMatchObject({ product: "0.20.3", profile: "property" });
    expect(body.cli).toMatchObject({ installed: expect.any(Boolean), matchesPin: expect.any(Boolean) });
    expect(body.pack).toMatchObject({ installed: true, approvalsManual: true });
    expect(body.model).toMatchObject({ keyPresent: expect.any(Boolean) });
    expect(typeof body.detail).toBe("string");
    expect(body.installCommand).toContain("--force-commit");
  });

  it("applies the property pack on demand and rejects non-JSON calls", async () => {
    const noJson = await api("POST", "/api/hermes/apply-pack");
    expect(noJson.status).toBe(415);

    const applied = await api("POST", "/api/hermes/apply-pack", {});
    expect(applied.status).toBe(200);
    expect(applied.body.pack.installed).toBe(true);
    expect(applied.body.pin.product).toBe("0.20.3");
  });

  it("tests hands with the same content-type gate as other actions", async () => {
    const noJson = await api("POST", "/api/hermes/test");
    expect(noJson.status).toBe(415);
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

  it("allows staged book intake in one revision-bound batch", async () => {
    const before = await api("GET", "/api/desk");
    const staged = await api("POST", "/api/desk/propose-book", {
      items: [
        { address: "71 Batch St, Braddon ACT", tenantName: "Batch Alpha", tenantPhone: "0400 710 001", weeklyRentCents: 57_000 },
        { address: "72 Batch St, Braddon ACT", tenantName: "Batch Beta", tenantPhone: "0400 720 002", weeklyRentCents: 58_000 },
      ],
    });
    expect(staged.status).toBe(200);
    expect(staged.body.created).toBe(2);
    const ids = staged.body.snapshot.book.bookProposals.map((proposal: { id: string }) => proposal.id);

    const noJson = await api("POST", "/api/desk/book-proposals/allow");
    expect(noJson.status).toBe(415);
    const malformed = await api("POST", "/api/desk/book-proposals/allow", { ids: "all" });
    expect(malformed.status).toBe(400);

    const allowed = await api("POST", "/api/desk/book-proposals/allow", {
      ids,
      expectedRevision: staged.body.snapshot.revision,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.revision).toBe(staged.body.snapshot.revision + 1);
    expect(allowed.body.properties).toHaveLength(before.body.properties.length + 2);
    expect(allowed.body.book.bookProposals).toHaveLength(0);

    const replay = await api("POST", "/api/desk/book-proposals/allow", {
      ids,
      expectedRevision: allowed.body.revision,
    });
    expect(replay.status).toBe(404);
    expect((await api("GET", "/api/desk")).body.properties).toHaveLength(before.body.properties.length + 2);

    for (const property of allowed.body.properties.filter((item: { address: string }) => item.address.startsWith("71 Batch") || item.address.startsWith("72 Batch"))) {
      expect((await api("DELETE", `/api/desk/properties/${property.id}`)).status).toBe(200);
    }
  });

  it("never sends a desk draft — the send route is always 403", async () => {
    const snap = await api("POST", "/api/desk/check", {});
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
    expect((await api("GET", "/api/local-computer")).status).toBe(403);
    expect((await api("POST", "/api/local-computer/run", {})).status).toBe(403);
    expect((await api("POST", "/api/bots/bud/computer", {})).status).toBe(403);
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

  it("runs Morning money from Ask speech without a model, then only after Allow", async () => {
    const bot = await workshopBot();
    const asked = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Run the morning money check now." });
    expect(asked.status).toBe(202);
    expect(asked.body.bot.busy ?? false).toBe(false);
    const runCard = asked.body.bot.messages.findLast((message: { kind: string; action?: { kind?: string; loopId?: string } }) =>
      message.kind === "action" && message.action?.kind === "run-routine",
    );
    expect(runCard?.action).toMatchObject({
      status: "pending",
      kind: "run-routine",
      loopId: "morning-arrears",
    });
    if (!runCard) throw new Error("expected a run-routine card");
    const allowedRun = await api("POST", `/api/bots/${bot.id}/actions/${runCard.id}`, { decision: "allow" });
    expect(allowedRun.status).toBe(200);
    expect(allowedRun.body.run.loopId).toBe("morning-arrears");
    expect(allowedRun.body).not.toHaveProperty("sent");
  });

  it("retunes Morning money from Ask speech without a model", async () => {
    const bot = await workshopBot();
    const asked = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Run it at 8" });
    expect(asked.status).toBe(202);
    const card = asked.body.bot.messages.findLast((message: { kind: string; action?: { kind?: string; after?: { time?: string } } }) =>
      message.kind === "action" && message.action?.kind === "change-routine",
    );
    expect(card?.action).toMatchObject({
      status: "pending",
      kind: "change-routine",
      after: expect.objectContaining({ time: "08:00" }),
    });
  });

  it("stages turning on owner letters from Ask speech when that clock is still off", async () => {
    const bot = await workshopBot();
    const listed = await api("GET", "/api/loops");
    const ownerLetter = listed.body.loops.find((loop: { id: string; revision: number }) => loop.id === "owner-letter");
    await api("PATCH", "/api/loops/owner-letter", { enabled: false, expectedRevision: ownerLetter.revision });
    const asked = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Run the Friday owner letter now." });
    expect(asked.status).toBe(202);
    const card = asked.body.bot.messages.findLast((message: { kind: string; action?: { kind?: string; loopId?: string } }) =>
      message.kind === "action" && message.action?.kind === "change-routine",
    );
    expect(card?.action).toMatchObject({
      status: "pending",
      kind: "change-routine",
      loopId: "owner-letter",
      after: expect.objectContaining({ enabled: true }),
    });
  });

  it("opens a closed connection picker from Ask without a model", async () => {
    const bot = await workshopBot();
    const asked = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Set up connections" });
    expect(asked.status).toBe(202);
    const card = asked.body.bot.messages.findLast((message: { kind: string; action?: { kind?: string } }) =>
      message.kind === "action" && message.action?.kind === "choose-connection",
    );
    expect(card?.action?.options?.[0]?.id).toBe("property-book");
    expect(card?.action?.options?.at(-1)?.id).toBe("composio-account");
    if (!card) throw new Error("expected a connection picker");
    const allowed = await api("POST", `/api/bots/${bot.id}/actions/${card.id}`, {
      decision: "allow",
      selection: "property-book",
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.navigation).toBe("connections");
    expect(allowed.body).not.toHaveProperty("connected");
  });

  it("opens Pocket setup from Ask without a model and rejects credentials before persistence", async () => {
    const bot = await workshopBot();
    const beforeCount = bot.messages.length;
    const shortcut = await api("POST", `/api/bots/${bot.id}/messages`, { text: "Connect WhatsApp to Bud" });
    expect(shortcut.status).toBe(202);
    expect(shortcut.body.bot.busy ?? false).toBe(false);

    const userMessage = shortcut.body.bot.messages.findLast((message: { role: string; text?: string }) =>
      message.role === "user" && message.text === "Connect WhatsApp to Bud",
    );
    const actionMessage = shortcut.body.bot.messages.findLast((message: { kind: string; action?: { kind?: string } }) =>
      message.kind === "action" && message.action?.kind === "open-setup",
    );
    expect(userMessage).toBeTruthy();
    expect(actionMessage?.action).toMatchObject({
      status: "allowed",
      target: "connections",
      service: "WhatsApp Business",
    });
    expect(shortcut.body.navigation).toBe("connections");
    expect(shortcut.body.bot.messages).toHaveLength(beforeCount + 2);
    if (!userMessage || !actionMessage) throw new Error("expected the direct setup transcript and action card");
    expect(shortcut.body).not.toHaveProperty("connected");

    const countBeforeCredential = (await workshopBot()).messages.length;
    const credential = "token=placeholder_credential_value_123";
    const blocked = await api("POST", `/api/bots/${bot.id}/messages`, { text: `Connect WhatsApp ${credential}` });
    expect(blocked.status).toBe(400);
    expect(blocked.body).toMatchObject({ code: "CREDENTIAL_IN_ASK" });
    const afterBlocked = await workshopBot();
    expect(afterBlocked.messages).toHaveLength(countBeforeCredential);
    expect(JSON.stringify(afterBlocked.messages)).not.toContain(credential);

    const blockedEdit = await api("POST", `/api/bots/${bot.id}/messages/${userMessage.id}/edit`, { text: credential });
    expect(blockedEdit.status).toBe(400);
    expect(blockedEdit.body).toMatchObject({ code: "CREDENTIAL_IN_ASK" });

    const notionToken = "ntn_g9538deadbeef99";
    const beforeNotion = (await workshopBot()).messages.length;
    const linkedNotion = await api("POST", `/api/bots/${bot.id}/messages`, { text: `connect me to notion ${notionToken}` });
    expect(linkedNotion.status).toBe(202);
    expect(linkedNotion.body.navigation).toBeUndefined();
    expect(linkedNotion.body).toMatchObject({ service: "Notion", connected: true });
    const notionAction = linkedNotion.body.bot.messages.findLast((message: { kind: string; action?: { title?: string } }) =>
      message.kind === "action" && message.action?.title === "Notion connected",
    );
    expect(notionAction?.action).toMatchObject({ title: "Notion connected", service: "Notion" });
    const notionVoice = linkedNotion.body.bot.messages.findLast((message: { role: string; kind?: string; text?: string }) =>
      message.role === "bot" && message.kind === "text",
    );
    expect(notionVoice?.text).toMatch(/on this device/i);
    expect(notionVoice?.text).not.toMatch(/no connection is active/i);
    expect(JSON.stringify((await workshopBot()).messages)).not.toContain(notionToken);
    expect((await workshopBot()).messages.length).toBeGreaterThan(beforeNotion);
    const configAfter = await api("GET", "/api/config");
    expect(configAfter.body.linkedTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "notion", connected: true }),
    ]));
    expect(JSON.stringify(configAfter.body)).not.toContain(notionToken);

    const notionCard = await api("POST", `/api/bots/${bot.id}/messages`, { text: "connect me to notion" });
    expect(notionCard.status).toBe(202);
    expect(notionCard.body.navigation).toBeUndefined();
    expect(notionCard.body).toMatchObject({ service: "Notion" });

    const peek = await api("POST", `/api/bots/${bot.id}/messages`, { text: "what can you see inside of notion" });
    expect(peek.status).toBe(202);
    expect(peek.body.navigation).toBeUndefined();
    const peekVoice = peek.body.bot.messages.findLast((message: { role: string; kind?: string; text?: string }) =>
      message.role === "bot" && message.kind === "text",
    );
    expect(peekVoice?.text).toMatch(/on this device/i);
    expect(peekVoice?.text).not.toMatch(/no connection is active|not read in this build|cannot read pages/i);

    const recheck = await api("POST", "/api/desk/check", {});
    expect(recheck.status).toBe(200);
    const needsMe = await api("POST", `/api/bots/${bot.id}/messages`, { text: "What needs me?" });
    expect(needsMe.status).toBe(202);
    expect(needsMe.body.bot.busy ?? false).toBe(false);
    const deskVoice = needsMe.body.bot.messages.findLast((message: { role: string; kind?: string; text?: string }) =>
      message.role === "bot" && message.kind === "text",
    );
    expect(deskVoice?.text).toMatch(/On Desk now|Desk has no exceptions|Desk is in recovery/i);
    expect(deskVoice?.text).not.toMatch(/cards were not shared|cannot see Desk/i);
    const deskSnap = await api("GET", "/api/desk");
    const heldAddress = deskSnap.body.properties?.find((property: { id?: string }) =>
      deskSnap.body.escalations?.some((item: { propertyId?: string }) => item.propertyId === property.id)
      || deskSnap.body.drafts?.some((item: { propertyId?: string; status?: string }) => item.propertyId === property.id && item.status === "pending"),
    )?.address;
    if (heldAddress) expect(deskVoice?.text).toContain(heldAddress);
  });

  it("deduplicates an acknowledged Ask request and rejects id reuse with different content", async () => {
    const bot = await workshopBot();
    const beforeCount = bot.messages.length;
    const requestId = "ask_retry_12345678";
    const first = await api("POST", `/api/bots/${bot.id}/messages`, {
      requestId,
      text: "Connect WhatsApp to Bud",
    });
    expect(first.status).toBe(202);
    expect(first.body.requestId).toBe(requestId);
    expect(first.body.bot.messages).toHaveLength(beforeCount + 2);
    expect(first.body.bot.messages.find((message: { requestId?: string }) => message.requestId === requestId)).toMatchObject({
      requestState: "settled",
      requestAttachmentCount: 0,
    });

    const duplicate = await api("POST", `/api/bots/${bot.id}/messages`, {
      requestId,
      text: "Connect WhatsApp to Bud",
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ ok: true, duplicate: true, requestId });
    expect(duplicate.body.bot.messages).toHaveLength(beforeCount + 2);

    const conflict = await api("POST", `/api/bots/${bot.id}/messages`, {
      requestId,
      text: "Connect Telegram to Bud",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("request-id-conflict");
    expect((await workshopBot()).messages).toHaveLength(beforeCount + 2);
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const bot = await workshopBot();

    const empty = await api("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    // the seeded bot's selection points at the ghost instance — sending a
    // real message must fail loudly, not 202-and-hang, but the Ask line stays
    const send = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
    expect(send.body.code).toBe("provider-unavailable");
    expect(send.body.bot?.busy).toBeFalsy();
    expect(send.body.bot?.messages?.some((message: { text?: string }) => message.text === "hello?")).toBe(true);
    expect(send.body.bot?.messages?.some((message: { role?: string; text?: string }) => (
      message.role === "bot" && /Prepare Bud|unavailable/i.test(message.text ?? "")
    ))).toBe(true);

    const forged = await api("POST", `/api/bots/${bot.id}/messages`, {
      text: "review it",
      attachments: [{ path: "relative/private.txt" }],
    });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toContain("absolute");

    const selected = join(home, "selected-inspection.jpg");
    writeFileSync(selected, "image bytes");
    const attachmentOnly = await api("POST", `/api/bots/${bot.id}/messages`, {
      attachments: [{ path: selected, name: "forged.exe", size: 1 }],
    });
    expect(attachmentOnly.status).toBe(409);
    expect(attachmentOnly.body.error).toContain("unavailable");
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

  it("keeps Pocket network-silent before a real agency and PM are named", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.pocket).toMatchObject({ configured: false, enabled: false, pilotReady: false, state: "pilot-gated" });
    expect(before.body.pocket.channels).toMatchObject({
      telegram: { configured: false, state: "pilot-gated" },
      whatsappCloud: { configured: false, state: "pilot-gated" },
    });

    // Supplying a valid-looking token must hit the code-owned pilot gate
    // before either verification or persistence, even when enabled is false.
    const attempted = await api("PATCH", "/api/config", {
      pocket: {
        provider: "telegram",
        enabled: false,
        allowedUserId: "12345",
        key: "123456:abcdefghijklmnopqrstuvwxyz_ABCDEFG",
      },
    });
    expect(attempted.status).toBe(409);
    expect(String(attempted.body.error)).toMatch(/pilot contract|agency and PM/i);

    const attemptedWhatsApp = await api("PATCH", "/api/config", {
      pocket: {
        provider: "whatsapp-cloud",
        enabled: false,
        phoneNumberId: "123456789012345",
        allowedUserId: "61412345678",
        accessToken: `EAA${"x".repeat(80)}`,
        appSecret: "a".repeat(32),
        verifyToken: "realbud_verify_token_123456",
      },
    });
    expect(attemptedWhatsApp.status).toBe(409);
    expect(String(attemptedWhatsApp.body.error)).toMatch(/pilot contract|agency and PM/i);

    const after = await api("GET", "/api/config");
    expect(after.body.pocket).toMatchObject({ configured: false, enabled: false, pilotReady: false, state: "pilot-gated" });
  });

  it("stores a validated normalized PM profile through its narrow boundary", async () => {
    const put = await api("PATCH", "/api/profile", { name: "  Ada Lovelace  ", email: "Ada@Example.com" });
    expect(put.status).toBe(200);
    expect(put.body.profile).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("fails profile changes closed without a session or with malformed fields", async () => {
    const noSession = await fetch(`${BASE}/api/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mallory", email: "" }),
    });
    expect(noSession.status).toBe(401);

    const wrongType = await fetch(`${BASE}/api/profile`, {
      method: "PATCH",
      headers: { "x-realbud-session": session },
      body: JSON.stringify({ name: "Mallory", email: "" }),
    });
    expect(wrongType.status).toBe(415);

    for (const profile of [
      { name: "", email: "" },
      { name: "Ada", email: "not-an-email" },
      { name: "Ada\nMallory", email: "" },
      { name: "Ada", email: "", role: "admin" },
    ]) {
      const rejected = await api("PATCH", "/api/profile", profile);
      expect(rejected.status).toBe(400);
    }

    const generic = await api("PUT", "/api/config", { profile: { name: "Mallory", email: "" } });
    expect(generic.status).toBe(400);
    expect(String(generic.body.error)).toMatch(/\/api\/profile/);

    const after = await api("GET", "/api/config");
    expect(after.body.profile).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
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
    const ok = await api("GET", "/api/desk");
    expect(ok.status).toBe(200);
    expect(ok.body.properties.length).toBe(6);
    expect(ok.body.properties.every((property: { notes?: string }) => property.notes === undefined)).toBe(true);
    expect(ok.body.book.contacts).toEqual([]);
    expect(ok.body.book.tenancies).toEqual([]);
    expect(JSON.stringify(ok.body)).not.toMatch(/"ct":/);
  });

  it("runs the Demo desk check and refuses to send", async () => {
    const empty = await api("GET", "/api/desk");
    expect(empty.status).toBe(200);
    expect(empty.body.properties.length).toBe(6);

    const checked = await api("POST", "/api/desk/check", {});
    expect(checked.status).toBe(200);
    const courtesy = checked.body.drafts.find((d: { kind: string }) => d.kind === "courtesy-rent");
    expect(courtesy?.status).toBe("pending");
    expect(checked.body.escalations.length).toBeGreaterThan(0);

    const send = await api("POST", `/api/desk/drafts/${courtesy.id}/send`);
    expect(send.status).toBe(403);
    expect(String(send.body.error)).toMatch(/never sends/i);

    const unsafeEdit = await api("PATCH", `/api/desk/drafts/${courtesy.id}`, {
      body: "FORMAL NOTICE: Pay within 7 days or the tenancy will be terminated.",
    });
    expect(unsafeEdit.status).toBe(409);
    expect(String(unsafeEdit.body.error)).toMatch(/licensed human/i);
    const afterUnsafeEdit = await api("GET", "/api/desk");
    expect(afterUnsafeEdit.body.drafts.find((draft: { id: string }) => draft.id === courtesy.id)?.body).toBe(courtesy.body);

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
    const defaultDesk = await api("GET", "/api/desk");
    expect(defaultDesk.body.properties.find((property: { id: string }) => property.id === "prop-oak")?.notes).toBeUndefined();
    const detail = await api("GET", "/api/desk/properties/prop-oak/detail");
    expect(detail.status).toBe(200);
    expect(detail.body.properties).toHaveLength(1);
    expect(detail.body.properties[0].notes).toMatch(/Friday email/);
    expect(detail.body.book.contacts.every((contact: { propertyId: string }) => contact.propertyId === "prop-oak")).toBe(true);

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

  it("triages the labelled sample inbox, preserves send denial, and records waiting explicitly", async () => {
    const before = await api("GET", "/api/desk");
    const triaged = await api("POST", "/api/desk/inbound/demo", { expectedRevision: before.body.revision });
    expect(triaged.status).toBe(200);
    const work = triaged.body.workItems.find((item: { inbound?: { category?: string } }) => item.inbound?.category === "bdm-lead");
    const draft = triaged.body.drafts.find((item: { id: string }) => item.id === work?.draftId);
    expect(work).toMatchObject({ kind: "inbound-triage", state: "proposed" });
    expect(draft).toMatchObject({ kind: "inbound-reply", channel: "email", status: "pending" });

    const send = await api("POST", `/api/desk/drafts/${draft.id}/send`, {});
    expect(send.status).toBe(403);
    const premature = await api("POST", `/api/desk/cases/${work.id}/waiting`, { expectedRevision: triaged.body.revision });
    expect(premature.status).toBe(409);

    const allowed = await api("POST", `/api/desk/drafts/${draft.id}/allow`, { expectedRevision: triaged.body.revision });
    expect(allowed.status).toBe(200);
    const allowedDesk = await api("GET", "/api/desk");
    const waiting = await api("POST", `/api/desk/cases/${work.id}/waiting`, { expectedRevision: allowedDesk.body.revision });
    expect(waiting.status).toBe(200);
    expect(waiting.body.workItems.find((item: { id: string }) => item.id === work.id)?.state).toBe("waiting");

    const closed = await api("POST", `/api/desk/cases/${work.id}/close`, { expectedRevision: waiting.body.revision });
    expect(closed.status).toBe(200);
    expect(closed.body.workItems.find((item: { id: string }) => item.id === work.id)?.state).toBe("confirmed");

    const replay = await api("POST", "/api/desk/inbound/demo", { expectedRevision: closed.body.revision });
    expect(replay.status).toBe(200);
    expect(replay.body.revision).toBe(closed.body.revision);
  });

  it("imports an address-keyed CSV onto Oak Street", async () => {
    const before = await api("GET", "/api/desk");
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak Street, Dickson ACT",4,false,false\n`;
    const reviewed = await api("POST", "/api/desk/import-preview", { csv, expectedRevision: before.body.revision });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.preview).toMatchObject({
      kind: "realbud.pms-import-preview.v1",
      deskRevision: before.body.revision,
      totalRows: 1,
      matchedProperties: 1,
      rowsNeedingLink: 0,
      willVerifyLiveBook: true,
    });
    expect(JSON.stringify(reviewed.body.preview)).not.toContain("12 Oak Street");
    const snap = await api("POST", "/api/desk/import", {
      csv,
      expectedRevision: before.body.revision,
      observedAt: reviewed.body.preview.observedAt,
      previewDigest: reviewed.body.preview.csvDigest,
    });
    expect(snap.status).toBe(200);
    expect(snap.body.hands).toBe("csv");
    const oak = snap.body.ledger.find((r: { propertyId: string }) => r.propertyId === "prop-oak");
    expect(oak.daysSinceDue).toBe(4);
  });

  it("links an unmatched import row with a durable idempotency receipt", async () => {
    const before = await api("GET", "/api/desk");
    const csv = `address,daysLate,rentLanded,levyPaid\n"99 API Ghost St, Acton ACT",4,false,false\n`;
    const imported = await api("POST", "/api/desk/import", { csv, expectedRevision: before.body.revision });
    expect(imported.status).toBe(200);
    const issue = imported.body.book.importIssues.find((item: { rawIdentity: string }) => item.rawIdentity.includes("API Ghost"));
    expect(issue).toMatchObject({ status: "open", identityKind: "address" });

    const requestId = "api-import-resolution-0001";
    const linked = await api("POST", `/api/desk/import-issues/${issue.id}/link`, {
      expectedRevision: imported.body.revision,
      requestId,
      propertyId: "prop-oak",
    });
    expect(linked.status).toBe(200);
    expect(linked.body.book.importIssues.find((item: { id: string }) => item.id === issue.id)).toMatchObject({
      status: "linked",
      linkedPropertyId: "prop-oak",
      resolutionCount: 1,
    });

    const replay = await api("POST", `/api/desk/import-issues/${issue.id}/link`, {
      expectedRevision: imported.body.revision,
      requestId,
      propertyId: "prop-oak",
    });
    expect(replay.status).toBe(200);
    expect(replay.body.revision).toBe(linked.body.revision);
  });

  it("revision-binds CSV imports before any ledger mutation", async () => {
    const before = await api("GET", "/api/desk");
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak Street, Dickson ACT",8,false,false\n`;
    const changedAfterReview = await api("POST", "/api/desk/import", {
      csv,
      expectedRevision: before.body.revision,
      previewDigest: "0".repeat(64),
    });
    expect(changedAfterReview.status).toBe(409);
    expect(String(changedAfterReview.body.error)).toMatch(/changed after review/i);

    const stale = await api("POST", "/api/desk/import", { csv, expectedRevision: before.body.revision - 1 });
    expect(stale.status).toBe(409);
    expect(String(stale.body.error)).toMatch(/revision/i);

    const after = await api("GET", "/api/desk");
    expect(after.body.revision).toBe(before.body.revision);
    expect(after.body.ledger).toEqual(before.body.ledger);

    const missing = await api("POST", "/api/desk/import", { csv });
    expect(missing.status).toBe(400);
    expect(String(missing.body.error)).toMatch(/expectedRevision/);
  });

  it("accepts only typed read-only bank observations and rejects credential-shaped extras", async () => {
    const before = await api("GET", "/api/desk");
    const batch = {
      kind: "realbud.bank-credit-observation.v1",
      schemaVersion: 1,
      accountFingerprint: "a".repeat(64),
      observedAt: Date.now(),
      credits: [],
    };
    const accepted = await api("POST", "/api/desk/bank-observations", {
      expectedRevision: before.body.revision,
      batch,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.revision).toBe(before.body.revision);

    const rejected = await api("POST", "/api/desk/bank-observations", {
      expectedRevision: before.body.revision,
      batch: { ...batch, password: "must-not-enter-the-adapter" },
    });
    expect(rejected.status).toBe(400);
    expect(String(rejected.body.error)).toMatch(/fields/i);
  });

  it("saves the optional agency name without accepting stale setup state", async () => {
    const before = await api("GET", "/api/desk");
    const saved = await api("PATCH", "/api/desk/agency", {
      name: "Northside Property Co",
      expectedRevision: before.body.revision,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.book.agency.name).toBe("Northside Property Co");

    const stale = await api("PATCH", "/api/desk/agency", {
      name: "Stale Agency",
      expectedRevision: before.body.revision,
    });
    expect(stale.status).toBe(409);
    const after = await api("GET", "/api/desk");
    expect(after.body.book.agency.name).toBe("Northside Property Co");
  });
});

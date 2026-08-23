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
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

    const oversized = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
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
    expect(body.loops.map((loop: { id: string }) => loop.id)).toEqual([
      "morning-arrears",
      "owner-letter",
      "inbound-triage",
    ]);
    const morning = body.loops.find((loop: { id: string }) => loop.id === "morning-arrears");
    expect(morning).toMatchObject({ available: true, enabled: true });
    const planned = body.loops.find((loop: { id: string }) => loop.id === "owner-letter");
    expect(planned).toMatchObject({ available: false, enabled: false });
    expect(planned).not.toHaveProperty("prompt");

    const run = await api("POST", "/api/loops/owner-letter/run", {});
    expect(run.status).toBe(409);

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

    const planned = await api("PATCH", "/api/loops/owner-letter", { time: "15:30" });
    expect(planned.status).toBe(200);
    const enablePlanned = await api("PATCH", "/api/loops/owner-letter", { enabled: true });
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
    await api("PATCH", "/api/loops/owner-letter", { time: "16:00" });
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
    expect(body.pack).toMatchObject({ installed: true, approvalsManual: true });
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

  it("rejects an empty message and explains an unavailable provider", async () => {
    const bot = await workshopBot();

    const empty = await api("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    // the seeded bot's selection points at the ghost instance — sending a
    // real message must fail loudly, not 202-and-hang
    const send = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
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
    const ok = await api("GET", "/api/desk");
    expect(ok.status).toBe(200);
    expect(ok.body.properties.length).toBe(6);
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
    const snap = await api("POST", "/api/desk/import", { csv });
    expect(snap.status).toBe(200);
    expect(snap.body.hands).toBe("csv");
    const oak = snap.body.ledger.find((r: { propertyId: string }) => r.propertyId === "prop-oak");
    expect(oak.daysSinceDue).toBe(4);
  });
});

// The recovery routes through the real server: every one is behind the
// per-boot session, and with it they answer as server/recovery-holds.ts says.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readSessionToken } from "./testing/local-session.ts";
import { HELD_STEP_RECONCILE_PATH, HELD_STEPS_PATH, WORKER_CUSTODY_CHECK_PATH, WORKER_CUSTODY_PATH } from "./recovery-holds.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(process.platform === "win32")("recovery routes (real server)", () => {
  let child: ChildProcess;
  let home = "";
  let session = "";
  let stderr = "";
  const call = async (method: string, path: string, body?: unknown, withSession = true) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (withSession) headers["x-realbud-session"] = session;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "realbud-recovery-route-"));
    mkdirSync(join(home, ".realbud"), { recursive: true, mode: 0o700 });
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), VITEST: "true", HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    session = await readSessionToken(join(home, ".realbud"));
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

  it("refuses every route without the session", async () => {
    for (const [method, path] of [["GET", HELD_STEPS_PATH], ["POST", HELD_STEP_RECONCILE_PATH], ["GET", WORKER_CUSTODY_PATH], ["POST", WORKER_CUSTODY_CHECK_PATH]]) {
      expect((await call(method, path, method === "POST" ? { id: "00000000-0000-4000-8000-000000000000", result: "confirmed" } : undefined, false)).status, path).toBe(401);
    }
  });

  it("answers with the session: nothing held, bad input refused", async () => {
    expect(await call("GET", HELD_STEPS_PATH)).toEqual({ status: 200, body: { steps: [] } });
    expect(await call("GET", WORKER_CUSTODY_PATH)).toEqual({ status: 200, body: { state: "clear" } });
    expect(await call("POST", WORKER_CUSTODY_CHECK_PATH, {})).toEqual({ status: 200, body: { state: "clear" } });
    expect((await call("POST", HELD_STEP_RECONCILE_PATH, { id: "00000000-0000-4000-8000-000000000000", result: "maybe" })).status).toBe(400);
    expect((await call("POST", HELD_STEP_RECONCILE_PATH, { id: "00000000-0000-4000-8000-000000000000", result: "confirmed" })).status).toBe(404);
  });
});

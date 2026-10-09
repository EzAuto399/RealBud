// Who may mark an unconfirmed app outcome checked, through the real HTTP
// server on a computer that belongs to an office member. No office answers
// here, so nobody can prove they own it: the route refuses before reading or
// changing any receipt. The owner's own check is covered by the store and
// recovery tests (connected-app-operations.test.ts, connected-app-recovery.test.ts).
import { readSessionToken } from "./testing/local-session.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUTE = "/api/connected-apps/operations/00000000-0000-4000-8000-000000000001/acknowledge";

describe("marking an unconfirmed app outcome checked", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let sessionToken = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-app-ack-test-"));
    mkdirSync(join(home, ".realbud", "company-installation"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".realbud", "config.json"), JSON.stringify({ instances: {} }), { mode: 0o600 });
    // This private workspace already belongs to a (fictional) office member.
    writeFileSync(join(home, ".realbud", "company-installation", "seat.json"),
      JSON.stringify({ version: 1, memberId: "fictional-member-0001", adoptedAt: "2026-10-07T00:00:00.000Z" }), { mode: 0o600 });
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        VITEST: "true",
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    sessionToken = await readSessionToken(join(home, ".realbud"));
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
    });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const post = (headers: Record<string, string>) => fetch(`${BASE}${ROUTE}`, { method: "POST",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ expectedRevision: 0 }) });

  it("refuses a request without this boot's session", async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ "x-realbud-session": "fictional-wrong-session" })).status).toBe(401);
  });

  it("refuses anyone who cannot prove they own this office, and changes nothing", async () => {
    const asMember: Record<string, string>[] = [{}, { "x-realbud-member-session": "fictional_member_session_000000000000000000" }];
    for (const headers of asMember) {
      const res = await post({ "x-realbud-session": sessionToken, ...headers });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/^Only this office owner or service administrator/);
    }
    expect(existsSync(join(home, ".realbud", "connected-app-operations.json"))).toBe(false);
  });
});

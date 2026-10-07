// The product route denylist, through the real HTTP server. Every route the
// old PRODUCT_MODE denylist covered must still answer its denial now that the
// legacy fleet switch is gone. Requests carry the session token and JSON, so
// only the denylist can be what refuses them.
import { readSessionToken } from "./testing/local-session.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

const ONE_BUD = /RealBud is one desk and one Bud thread/;
const ROOMS = /Rooms are not part of RealBud/;
const CONNECTORS = /Connectors are not part of RealBud/;
const COMPUTERS = /Cloud computers are not part of RealBud/;

// method, path, denial: one row per rule in productDenied (server/product-mode.ts).
const OLD_DENYLIST: Array<[string, string, RegExp]> = [
  ["POST", "/api/bots", ONE_BUD],
  ["POST", "/api/groups", ONE_BUD],
  ["GET", "/api/connectors/catalog", ONE_BUD],
  ["GET", "/api/plugins", ONE_BUD],
  ["POST", "/api/groups/fictional-room", ROOMS],
  ["POST", "/api/groups/fictional-room/messages", ROOMS],
  ["POST", "/api/connectors/fictional", CONNECTORS],
  ["DELETE", "/api/connectors/fictional", CONNECTORS],
  ["GET", "/api/bots/bud/computer", COMPUTERS],
  ["POST", "/api/bots/bud/computer", COMPUTERS],
  ["POST", "/api/bots/bud/computer/screenshot", COMPUTERS],
  ["DELETE", "/api/bots/bud", /Bud cannot be deleted/],
  ["POST", "/api/local-computer/screenshot", /Raw computer screenshots are not available/],
];

describe("product route denylist over HTTP", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let sessionToken = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-denied-test-"));
    mkdirSync(join(home, ".realbud"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".realbud", "config.json"), JSON.stringify({ instances: {} }), { mode: 0o600 });
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
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it.each(OLD_DENYLIST)("%s %s stays denied", async (method, path, denial) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "x-realbud-session": sessionToken, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    const body = (await res.json()) as { error?: string };
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.error).toMatch(denial);
  });

  it("still serves Bud itself", async () => {
    const res = await fetch(`${BASE}/api/bots`, { headers: { "x-realbud-session": sessionToken } });
    expect(res.status).toBe(200);
  });
});

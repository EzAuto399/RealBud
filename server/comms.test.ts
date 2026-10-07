// Agent-to-agent comms. The mention and room-routing units run as before.
// The e2e half boots the real product server with Bud on the Hermes ACP
// driver pointed at the fake ACP CLI in ask-peer mode, beside a second
// visible bot such as an upgraded install may still hold. The product turn
// path never mounts the agents proxy, so the fake has no peer to reach: the
// test pins that, plus the internal endpoints' boot-token seal.
//
// The fake CLI is a shebang script — POSIX-only until resolveCliSpawn
// turned it into `node <script>` on Windows too, so the e2e half now runs
// everywhere alongside the mention-resolution units.
import { readSessionToken } from "./testing/local-session.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mentionedBots, normalizeGroupDefaultResponder, roomResponders } from "./store.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe("mentionedBots", () => {
  const peers = [
    { id: "1", name: "New Bot" },
    { id: "2", name: "New Bot 2" },
    { id: "3", name: "Milind" },
    { id: "4", name: "Ghost", hidden: true },
  ];
  it("matches a tag at a word start, case-insensitively", () => {
    expect(mentionedBots("hey @milind, look", peers).map((b) => b.id)).toEqual(["3"]);
    expect(mentionedBots("@Milind first thing", peers).map((b) => b.id)).toEqual(["3"]);
  });
  it("prefers the longest name so prefixes never half-match", () => {
    expect(mentionedBots("ask @New Bot 2 about it", peers).map((b) => b.id)).toEqual(["2"]);
  });
  it("dedupes repeats and collects multiple bots", () => {
    expect(mentionedBots("@Milind and @New Bot and @Milind", peers).map((b) => b.id)).toEqual(["3", "1"]);
  });
  it("ignores emails, hidden bots, and mid-word @", () => {
    expect(mentionedBots("mail milind@milind.dev please", peers)).toEqual([]);
    expect(mentionedBots("@Ghost around?", peers)).toEqual([]);
  });
  it("requires a word boundary at the end of the name", () => {
    expect(mentionedBots("ask @New Bottle about it", peers)).toEqual([]);
    expect(mentionedBots("@Milindo is someone else", peers)).toEqual([]);
  });
});

describe("roomResponders", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(roomResponders("hello there", members, { kind: "member", botId: "atlas" })).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(roomResponders("@Milind take this", members, { kind: "member", botId: "atlas" })).toEqual([members[1]]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomResponders("hello", members, { kind: "everyone" })).toEqual(members);
    expect(roomResponders("hello", members, { kind: "mentions" })).toEqual([]);
    expect(roomResponders("@everyone hello", members, { kind: "mentions" })).toEqual(members);
  });

  it("keeps bot-to-bot channels on their last-speaker routing", () => {
    expect(normalizeGroupDefaultResponder({ kind: "everyone" }, members.map((member) => member.id), true)).toEqual({
      kind: "mentions",
    });
  });
});

describe("comms e2e (product build, fake ACP CLI)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let sessionToken = "";
  let dump = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "x-realbud-session": sessionToken, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-comms-test-"));
    const data = join(home, ".realbud");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    // The fictional ACP peer obeys the same write fence as the real worker.
    dump = join(data, "vault", "bud-work", "fake-acp-dump.json");
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({
        instances: {
          hermes: {
            driver: "hermesAgent",
            environment: { FAKE_ACP_MODE: "ask-peer", FAKE_ACP_DUMP: dump },
            config: { cli: FAKE_CLI },
          },
        },
      }),
      { mode: 0o600 },
    );
    // Bud plus one more visible bot, as an install from the legacy fleet era may hold.
    const bot = (id: string, name: string) => ({
      id, threadId: `${id}-thread`, name, title: "", description: "", notifications: false, color: "green", unread: false,
      modelSelection: { instanceId: "hermes", model: "default" }, resumeCursors: {}, createdAt: 1,
    });
    writeFileSync(join(data, "bots.json"), JSON.stringify([bot("bud", "Bud"), bot("helper", "Helper")]), { mode: 0o600 });

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        // child-process coverage: the v8 provider measures the spawned server
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
        // without SystemRoot, winsock fails to initialize in the child
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        VITEST: "true",
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
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
    sessionToken = await readSessionToken(join(home, ".realbud"));
    expect(sessionToken).toBeTruthy();
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

  it("seals the internal comms endpoints behind the boot token", async () => {
    const agents = await api("GET", "/api/internal/agents?self=x");
    expect(agents.status).toBe(401);
    const ask = await api("POST", "/api/internal/ask-bot", { toBotId: "x", message: "hi" });
    expect(ask.status).toBe(401);
  });

  it(
    "never hands Bud the peer-agent tools, even beside a second visible bot",
    async () => {
      // The roster cannot grow in the product: extra bots are a route denial.
      expect((await api("POST", "/api/bots", {})).status).toBe(403);
      const roster = (await api("GET", "/api/bots")).body;
      expect(roster.bots.filter((b: any) => !b.hidden).map((b: any) => b.id).sort()).toEqual(["bud", "helper"]);

      const send = await api("POST", "/api/bots/bud/messages", { text: "hey @Helper ping" });
      expect(send.status).toBe(202);

      // Without an agents server the ask-peer fake answers a plain turn.
      const deadline = Date.now() + 25_000;
      let bud: any;
      for (;;) {
        bud = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === "bud");
        const settled = bud.messages.some(
          (m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("hello from fake acp"),
        );
        if (settled && !bud.busy) break;
        if (Date.now() > deadline) {
          throw new Error(`Bud never settled. messages: ${JSON.stringify(bud.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // The worker's session/new carried no agents MCP server.
      const mounted = JSON.parse(readFileSync(dump, "utf8")).mcpServers as Array<{ name?: string }>;
      expect(mounted.map((server) => server.name)).not.toContain("agents");

      // Nothing reached the other bot and no bot⇄bot channel was opened.
      const state = (await api("GET", "/api/bots")).body;
      bud = state.bots.find((b: any) => b.id === "bud");
      expect(bud.messages.some((m: any) => m.text?.includes("peer says:"))).toBe(false);
      expect(bud.messages.some((m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper")).toBe(false);
      const helper = state.bots.find((b: any) => b.id === "helper");
      expect(helper.messages.some((m: any) => m.role === "user")).toBe(false);
      expect(helper.busy).toBeFalsy();
      expect(state.groups.some((g: any) => g.dm)).toBe(false);
    },
    40_000,
  );
});

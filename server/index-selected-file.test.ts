import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workerCli, workerRuntimeDir } from "./config.ts";
import { applyPropertyPack, propertyProfileDir, withYamlBlock } from "./hermes-pack.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 28_000 + Math.floor(Math.random() * 8_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WINDOWS_WRAPPER_UNAVAILABLE = process.platform === "win32";

let child: ChildProcess;
let home: string;
let dataDir: string;
let workerHome: string;
let session = "";
let stderr = "";
let promptDump: string;
let envDump: string;
let personalSentinel: string;

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session) headers["x-realbud-session"] = session;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  if (WINDOWS_WRAPPER_UNAVAILABLE) return;
  home = mkdtempSync(join(tmpdir(), "realbud-index-selected-"));
  dataDir = join(home, ".realbud");
  workerHome = join(dataDir, "worker");
  promptDump = join(home, "selected-prompt.json");
  envDump = join(home, "selected-env.json");
  personalSentinel = join(home, ".hermes", "personal-sentinel.txt");
  mkdirSync(dirname(personalSentinel), { recursive: true });
  writeFileSync(personalSentinel, "personal worker state must stay unchanged");

  applyPropertyPack(workerHome);
  const profileConfig = join(propertyProfileDir(workerHome), "config.yaml");
  writeFileSync(profileConfig, withYamlBlock(
    readFileSync(profileConfig, "utf8"),
    "model",
    "model:\n  default: test-model\n  provider: deepseek\n  base_url: ''\n",
  ));
  // Legacy fixture input is migrated into RealBud's encrypted worker secret
  // store during boot, then scrubbed before the selected-file child starts.
  writeFileSync(join(propertyProfileDir(workerHome), ".env"), "DEEPSEEK_API_KEY=fixture-key-not-live\n", { mode: 0o600 });
  const cli = workerCli(workerHome);
  mkdirSync(dirname(cli), { recursive: true });
  const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  writeFileSync(cli, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_CLI)} "$@"\n`);
  chmodSync(cli, 0o755);
  expect(workerRuntimeDir(workerHome)).toBe(join(workerHome, "runtime"));

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      REALBUD_DATA_DIR: dataDir,
      REALBUD_WORKER_HOME: workerHome,
      FAKE_ACP_MODE: "selected-file",
      FAKE_ACP_PROMPT_DUMP: promptDump,
      FAKE_ACP_DUMP: envDump,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      // Server is still starting.
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const boot = await fetch(`${BASE}/api/session`);
  session = String(((await boot.json()) as { token?: string }).token ?? "");
}, 30_000);

afterAll(async () => {
  if (WINDOWS_WRAPPER_UNAVAILABLE) return;
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(WINDOWS_WRAPPER_UNAVAILABLE)("Ask selected-file broker integration", () => {
  it("projects only validated output to Ask and Desk while preserving personal state", async () => {
    const source = join(home, "selected-properties.txt");
    writeFileSync(source, "77 Test Lane, Braddon ACT | Taylor Test | 0400 123 456 | 575");
    const instances = await api("GET", "/api/instances");
    expect(instances.body.instances).toContainEqual(expect.objectContaining({
      instanceId: "hermes",
      snapshot: expect.objectContaining({ state: "available" }),
    }));
    const bots = await api("GET", "/api/bots");
    const bot = bots.body.bots.find((candidate: { id: string }) => candidate.id === "bud");
    expect(bot?.modelSelection).toMatchObject({ instanceId: "hermes" });

    const sent = await api("POST", "/api/bots/bud/messages", {
      requestId: "ask_selected_e2e_12345678",
      text: "Stage complete property records from this selected file.",
      attachments: [{ path: source }],
    });
    expect(sent.status).toBe(202);

    let settled: any = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const listed = await api("GET", "/api/bots");
      settled = listed.body.bots.find((candidate: { id: string }) => candidate.id === "bud");
      if (settled && !settled.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(settled?.busy ?? false).toBe(false);
    const reply = settled.messages.findLast((message: { role: string; kind: string }) =>
      message.role === "bot" && message.kind === "text",
    );
    expect(reply?.text).toContain("staged 1 property on Desk");
    expect(reply?.text).toContain("Needs your attention");
    expect(settled.messages.find((message: { requestId?: string }) => message.requestId === "ask_selected_e2e_12345678")).toMatchObject({
      requestState: "settled",
      requestAttachmentCount: 1,
    });
    expect(JSON.stringify(settled.messages)).not.toContain("realbud.selected-file-analysis.v1");

    const desk = await api("GET", "/api/desk");
    expect(desk.body.book.bookProposals).toContainEqual(expect.objectContaining({
      address: "77 Test Lane, Braddon ACT",
      tenantName: "Taylor Test",
      weeklyRentCents: 57_500,
    }));
    expect(desk.body.properties.some((property: { address: string }) => property.address === "77 Test Lane, Braddon ACT")).toBe(false);

    const durableBroker = readFileSync(join(dataDir, "work-broker.json"), "utf8");
    expect(durableBroker).toContain('"state": "reconciled"');
    expect(durableBroker).not.toContain("Taylor Test");
    const outputDir = join(dataDir, "work-outputs");
    expect(existsSync(outputDir) ? readdirSync(outputDir) : []).toEqual([]);
    const workspaceRoot = join(dataDir, "workspaces", "selected-files");
    expect(existsSync(workspaceRoot) ? readdirSync(workspaceRoot) : []).toEqual([]);

    const prompt = JSON.parse(readFileSync(promptDump, "utf8"));
    expect(prompt.prompt[0].text).toContain("Return exactly one JSON object");
    expect(prompt.prompt[1]).toMatchObject({ type: "resource_link", name: "selected-properties.txt" });
    expect(prompt.prompt[1].uri).toContain("001-selected-properties.txt");
    const childEnv = JSON.parse(readFileSync(envDump, "utf8")).env as Record<string, string>;
    expect(childEnv.HERMES_HOME).not.toBe(workerHome);
    expect(childEnv.HERMES_HOME).toContain(join("workspaces", "selected-files", "turn-"));
    expect(childEnv.HERMES_HOME).toContain(".worker-home");
    expect(readFileSync(personalSentinel, "utf8")).toBe("personal worker state must stay unchanged");
    expect(stderr).not.toContain("fixture-key-not-live");
  });
});

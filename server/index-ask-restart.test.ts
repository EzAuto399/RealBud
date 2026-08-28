import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workerCli } from "./config.ts";
import { applyPropertyPack, propertyProfileDir, withYamlBlock } from "./hermes-pack.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 36_000 + Math.floor(Math.random() * 4_000);
const BASE = `http://127.0.0.1:${PORT}`;
const WINDOWS_WRAPPER_UNAVAILABLE = process.platform === "win32";

let child: ChildProcess;
let home: string;
let dataDir: string;
let stderr = "";

function transcript(threadId: string, requestId: string, attachmentCount: number) {
  const message = {
    id: `${threadId}-request`,
    role: "user",
    kind: "text",
    text: attachmentCount ? "Review the selected property file." : "What needs me on the book today?",
    requestId,
    requestDigest: `${requestId}-digest`,
    requestState: "dispatching",
    requestAttachmentCount: attachmentCount,
    requestStatusDetail: "Bud was working when RealBud stopped",
    at: Date.now() - 1_000,
    parentId: null,
  };
  writeFileSync(
    join(dataDir, `messages-${threadId}.json`),
    JSON.stringify({ activeLeafId: message.id, messages: [message] }),
  );
}

beforeAll(async () => {
  if (WINDOWS_WRAPPER_UNAVAILABLE) return;
  home = mkdtempSync(join(tmpdir(), "realbud-ask-restart-"));
  dataDir = join(home, ".realbud");
  const workerHome = join(dataDir, "worker");
  mkdirSync(dataDir, { recursive: true });

  applyPropertyPack(workerHome);
  const profileConfig = join(propertyProfileDir(workerHome), "config.yaml");
  writeFileSync(
    profileConfig,
    withYamlBlock(readFileSync(profileConfig, "utf8"), "model", "model:\n  default: test-model\n  provider: deepseek\n  base_url: ''\n"),
  );
  writeFileSync(join(propertyProfileDir(workerHome), ".env"), "DEEPSEEK_API_KEY=fixture-key-not-live\n", { mode: 0o600 });
  const cli = workerCli(workerHome);
  mkdirSync(dirname(cli), { recursive: true });
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  writeFileSync(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_CLI)} "$@"\n`);
  chmodSync(cli, 0o755);

  const now = Date.now();
  writeFileSync(join(dataDir, "bots.json"), JSON.stringify([{
    id: "bud",
    threadId: "attachment-thread",
    tasks: [
      { threadId: "attachment-thread", title: "File review", createdAt: now, resumeCursors: {} },
      { threadId: "text-thread", title: "Daily review", createdAt: now - 1, resumeCursors: {} },
    ],
    name: "Bud",
    title: "Desk assistant",
    description: "Supervised property assistant",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "hermes", model: "default" },
    resumeCursors: {},
    computer: "off",
    createdAt: now,
  }]));
  writeFileSync(join(dataDir, "groups.json"), "[]");
  transcript("attachment-thread", "restart-attachment", 1);
  transcript("text-thread", "restart-text", 0);

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      REALBUD_DATA_DIR: dataDir,
      REALBUD_WORKER_HOME: workerHome,
      FAKE_ACP_MODE: "happy",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      // still starting
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

describe.skipIf(WINDOWS_WRAPPER_UNAVAILABLE)("Ask startup recovery", () => {
  it("resumes a leaf text request once and holds selected files for explicit reselection", async () => {
    const deadline = Date.now() + 10_000;
    let text: any;
    let attachment: any;
    for (;;) {
      text = JSON.parse(readFileSync(join(dataDir, "messages-text-thread.json"), "utf8"));
      attachment = JSON.parse(readFileSync(join(dataDir, "messages-attachment-thread.json"), "utf8"));
      const textRequest = text.messages.find((message: { requestId?: string }) => message.requestId === "restart-text");
      const fileRequest = attachment.messages.find((message: { requestId?: string }) => message.requestId === "restart-attachment");
      if (textRequest?.requestState === "settled" && fileRequest?.requestState === "held") break;
      if (Date.now() > deadline) throw new Error(`Ask recovery did not settle. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(text.messages.filter((message: { requestId?: string }) => message.requestId === "restart-text")).toHaveLength(1);
    expect(text.messages.some((message: { role?: string; text?: string }) => message.role === "bot" && /hello from fake acp/i.test(message.text ?? ""))).toBe(true);
    expect(attachment.messages.filter((message: { requestId?: string }) => message.requestId === "restart-attachment")).toHaveLength(1);
    expect(attachment.messages.some((message: { role?: string; text?: string }) => message.role === "bot" && /select them again/i.test(message.text ?? ""))).toBe(true);
    expect(JSON.stringify(attachment)).not.toContain("/Users/");
  });
});

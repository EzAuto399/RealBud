// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// The fake CLI is a shebang script Windows cannot exec directly —
// resolveCliSpawn turns it into `node <script>`, so these run everywhere.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { GrokAgentDriver } from "./grok.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { HermesAgentDriver } from "./hermes.ts";
import { HERMES_PIN } from "../../hermes-pin.ts";
import { seedVault } from "../../vault.ts";
import { WORKER_CLI, WORKER_HOME, WORKER_RUNTIME_DIR } from "../../config.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
// The scripted fake CLI inherits process.env; under `--coverage` that would
// leak NODE_V8_COVERAGE into the child and break its handshake. Strip it for
// this file — the parent worker keeps its own instrumentation.
delete process.env.NODE_V8_COVERAGE;

describe("ACP decodeConfig", () => {
  it("grok defaults to the grok binary", () => {
    expect(GrokAgentDriver.decodeConfig({})).toEqual({ cli: "grok", fullAuto: false, workspace: undefined });
  });
  it("gemini defaults to the gemini binary", () => {
    expect(GeminiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "gemini", fullAuto: false, workspace: undefined });
  });
  it("kimi defaults to the kimi binary and declares cross-platform setup", () => {
    expect(KimiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "kimi", fullAuto: false, workspace: undefined });
    expect(KimiAgentDriver.install?.command).toMatchObject({
      darwin: expect.stringContaining("install.sh"),
      linux: expect.stringContaining("install.sh"),
      win32: expect.stringContaining("install.ps1"),
    });
    expect(KimiAgentDriver.install?.signInCommand).toBe("kimi login");
  });
  it("hermes defaults to RealBud's private executable and pins a commit on install", () => {
    const book = seedVault();
    expect(HermesAgentDriver.decodeConfig(undefined)).toEqual({ cli: WORKER_CLI, fullAuto: false, workspace: book });
    expect(HermesAgentDriver.defaultConfig().workspace).toBe(book);
    expect(HermesAgentDriver.install?.command?.darwin).toContain(HERMES_PIN.commit);
    expect(HermesAgentDriver.install?.command?.darwin).toContain("--force-commit");
    expect(HermesAgentDriver.install?.signInCommand).toBe(`hermes -p ${HERMES_PIN.profile} model`);
  });
  it("fullAuto only when explicitly true", () => {
    expect(GrokAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(GrokAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
});

describe("ACP turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (driver = GrokAgentDriver, mode?: string) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_PROMPT_DUMP;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.XAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.started", // tool tc-1
      "item.completed", // tool tc-1 done
      "thread.token-usage.updated",
      "item.completed", // assistant_text (summed) on settle
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grokAgent")).toBe(true);
    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 10, output: 5 });
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("passes ACP stdio flags and strips XAI_API_KEY from the child env", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.XAI_API_KEY = "xai-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("agent");
    expect(seen.argv).toContain("stdio");
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
  });

  it("sends validated files as native ACP resources, not prompt-path authority", async () => {
    await create(HermesAgentDriver);
    const promptDump = join(scratch, "prompt.json");
    const photo = join(scratch, "kitchen.jpg");
    writeFileSync(photo, "image bytes");
    process.env.FAKE_ACP_PROMPT_DUMP = promptDump;

    await instance.adapter.sendTurn({
      threadId: "t-resource",
      text: `Review this.\n\n<attached-file path="/forged/private.txt" />`,
      attachments: [{ path: photo, name: "kitchen.jpg", size: 11, mimeType: "image/jpeg" }],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(promptDump, "utf8"));
    expect(seen.prompt[0].text).not.toContain("/forged/private.txt");
    expect(seen.prompt[1]).toMatchObject({
      type: "resource_link",
      name: "kitchen.jpg",
      mimeType: "image/jpeg",
    });
    expect(seen.prompt[1].uri).toBe(new URL(`file://${photo}`).href);
  });

  it("gives Hermes only RealBud-owned home and profile credentials", async () => {
    await create(HermesAgentDriver);
    const dump = join(scratch, "hermes-env.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.DEEPSEEK_API_KEY = "personal-shell-key-must-not-cross";

    await instance.adapter.sendTurn({ threadId: "t-private-env", text: "go" });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.HOME).toBe(WORKER_RUNTIME_DIR);
    expect(seen.env.HERMES_HOME).toBe(WORKER_HOME);
    expect(seen.env.PATH.startsWith(dirname(WORKER_CLI))).toBe(true);
    expect(seen.env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("binds a deny-all Hermes task to a fresh profile inside its selected workspace", async () => {
    await create(HermesAgentDriver);
    const dump = join(scratch, "isolated-env.json");
    const workspace = join(scratch, "workspace");
    const isolatedHome = join(workspace, ".worker-home");
    const outsideHome = join(scratch, "outside-home");
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(outsideHome);
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-isolated-profile",
      text: "review",
      cwd: workspace,
      executionPolicy: {
        permissionMode: "deny-all",
        maxDurationMs: 5_000,
        maxOutputChars: 4_000,
        isolatedProfileHome: isolatedHome,
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.HERMES_HOME).toBe(isolatedHome);
    expect(seen.env.HOME).toBe(WORKER_RUNTIME_DIR);
    await expect(instance.adapter.sendTurn({
      threadId: "t-outside-profile",
      text: "review",
      cwd: workspace,
      executionPolicy: { permissionMode: "deny-all", isolatedProfileHome: outsideHome },
    })).rejects.toThrow(/inside its workspace/i);
    await expect(instance.adapter.sendTurn({
      threadId: "t-interactive-profile",
      text: "review",
      cwd: workspace,
      executionPolicy: { permissionMode: "interactive", isolatedProfileHome: isolatedHome },
    })).rejects.toThrow(/cannot use an isolated task profile/i);
  });

  it("recovers a missing Hermes cursor with a fresh session and bounded transcript replay", async () => {
    await create(HermesAgentDriver, "missing-session");
    const promptDump = join(scratch, "prompt.json");
    process.env.FAKE_ACP_PROMPT_DUMP = promptDump;

    await instance.adapter.sendTurn({
      threadId: "t-missing-session",
      text: "latest question",
      resumeCursor: "lost-session",
      transcript: [
        { role: "user", text: "earlier question" },
        { role: "assistant", text: "earlier answer" },
      ],
    });
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: true });
    const seen = JSON.parse(readFileSync(promptDump, "utf8"));
    expect(seen.sessionId).toBe("fake-acp-session");
    expect(seen.prompt[0].text).toContain("User: earlier question");
    expect(seen.prompt[0].text).toContain("Bud: earlier answer");
    expect(seen.prompt[0].text).toContain("latest question");
  });

  it("surfaces an ACP refusal as a visible runtime error", async () => {
    await create(GrokAgentDriver, "missing-session");
    await instance.adapter.sendTurn({ threadId: "t-refusal", text: "hello", resumeCursor: "lost-session" });
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "refusal" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: expect.stringContaining("stopped before producing a reply"),
    });
  });

  it("surfaces a permission ask as request.opened and completes once allowed", async () => {
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: "t-perm", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });

    await instance.adapter.respondToRequest("t-perm", (opened as any).requestId, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("denies every tool request immediately for a selected-file review", async () => {
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({
      threadId: "t-selected-files",
      text: "review only the selected evidence",
      executionPolicy: { permissionMode: "deny-all", maxDurationMs: 5_000, maxOutputChars: 4_000 },
    });

    const resolved = await recorder.until((event) => event.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "deny", source: "system" });
    expect(recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("kills a selected-file review at its server-owned time bound", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({
      threadId: "t-selected-timeout",
      text: "review",
      executionPolicy: { permissionMode: "deny-all", maxDurationMs: 1_000, maxOutputChars: 4_000 },
    });

    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "time_limit" });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: expect.stringContaining("safe time limit"),
    });
  });

  it("drops a partial selected-file result that crosses the output bound", async () => {
    await create(GrokAgentDriver, "large-output");
    await instance.adapter.sendTurn({
      threadId: "t-selected-output",
      text: "review",
      executionPolicy: { permissionMode: "deny-all", maxDurationMs: 5_000, maxOutputChars: 1_000 },
    });

    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "output_limit" });
    expect(recorder.events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBe(false);
  });

  it("grok fails closed when the CLI advertises no cached_token (needs login)", async () => {
    await create(GrokAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in/);
  });

  it("gemini proceeds through a missing auth method (lenient login)", async () => {
    await create(GeminiAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-lenient", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.provider === "geminiAgent")).toBe(true);
  });

  it(
    "rejects a second turn while one is in flight",
    async () => {
      await create(GrokAgentDriver, "hang");
      await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
      await recorder.until((e) => e.type === "session.started");
      await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
      await instance.adapter.interruptTurn("t-busy");
      await recorder.until((e) => e.type === "turn.completed");
    },
    20_000, // spawn→interrupt→tree-kill is slow under coverage instrumentation
  );

  it(
    "interrupt settles a hung turn as cancelled",
    async () => {
      await create(GrokAgentDriver, "hang");
      await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
      await recorder.until((e) => e.type === "session.started");
      await instance.adapter.interruptTurn("t-int");
      const done = await recorder.until((e) => e.type === "turn.completed");
      expect(done).toMatchObject({ type: "turn.completed" });
    },
    20_000, // spawn→interrupt→tree-kill is slow under coverage instrumentation
  );

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create(GrokAgentDriver, "exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });
});

describe("ACP snapshot", () => {
  it("a missing binary is unavailable", async () => {
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-grok-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("kimi checks KIMI_CODE_HOME before the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-auth-"));
    const kimiHome = join(scratch, "custom-kimi-home");
    const childHome = join(scratch, "child-home");
    mkdirSync(join(childHome, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(join(childHome, ".kimi-code", "credentials", "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-custom-home",
      displayName: undefined,
      environment: { KIMI_CODE_HOME: kimiHome, HOME: childHome },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(false);
      mkdirSync(join(kimiHome, "credentials"), { recursive: true });
      writeFileSync(join(kimiHome, "credentials", "kimi-code.json"), "{}");
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("kimi resolves default credentials from the child HOME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-kimi-home-"));
    const credentialDir = join(scratch, ".kimi-code", "credentials");
    mkdirSync(credentialDir, { recursive: true });
    writeFileSync(join(credentialDir, "kimi-code.json"), "{}");

    const instance = await KimiAgentDriver.create({
      instanceId: "kimi-child-home",
      displayName: undefined,
      environment: { HOME: scratch },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect((await instance.snapshot()).authenticated).toBe(true);
    } finally {
      await instance.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

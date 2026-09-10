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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { GrokAgentDriver } from "./grok.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { hardenHermesChildEnv, HermesAgentDriver } from "./hermes.ts";
import { HERMES_PIN } from "../../hermes-pin.ts";
import { seedVault } from "../../vault.ts";
import { revokeConnectedAppsBrokers } from "../../connected-apps-broker.ts";
import * as gmail from "../../composio-gmail.ts";

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
  it("hermes defaults to the hermes binary and pins a commit on install", () => {
    const book = seedVault();
    expect(HermesAgentDriver.decodeConfig(undefined)).toEqual({ cli: "hermes", fullAuto: false, workspace: book });
    expect(HermesAgentDriver.defaultConfig().workspace).toBe(book);
    expect(HermesAgentDriver.install?.command?.darwin).toContain(HERMES_PIN.commit);
    expect(HermesAgentDriver.install?.command?.darwin).toContain("--force-commit");
    expect(HermesAgentDriver.install?.signInCommand).toBe(`hermes -p ${HERMES_PIN.profile} model`);
  });
  it("keeps ambient provider keys and global MCP servers out of RealBud's Hermes child", () => {
    const env = {
      OPENAI_API_KEY: "secret-a",
      OPENROUTER_API_KEY: "secret-b",
      KIMI_API_KEY: "secret-c",
      MOONSHOT_API_KEY: "secret-d",
      SAFE_VALUE: "kept",
    };
    hardenHermesChildEnv(env);
    expect(env).toEqual({ SAFE_VALUE: "kept", HERMES_ACP_SKIP_CONFIGURED_MCP: "1", HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS: "60" });
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

  const create = async (driver = GrokAgentDriver, mode?: string, fullAuto = false) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
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
    expect(recorder.events.find((e) => e.type === "item.started")).toMatchObject({
      toolFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 10, output: 5 });
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("reuses one warm process and ACP session for sequential turns", async () => {
    const dump = join(scratch, "warm.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create();

    const first = await instance.adapter.sendTurn({ threadId: "t-warm", text: "one", model: "grok-4.5" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    const second = await instance.adapter.sendTurn({ threadId: "t-warm", text: "two", model: "grok-4.5" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.promptCount).toBe(2);
    expect(recorder.events.filter((event) => event.type === "session.started")).toHaveLength(1);
    expect(recorder.events.filter((event) => event.type === "turn.started")).toHaveLength(2);
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
  });

  it("drops a warm session when RealBud clears the cursor for a rewind or recovery", async () => {
    const dump = join(scratch, "fresh-after-rewind.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create();

    const first = await instance.adapter.sendTurn({ threadId: "t-rewind", text: "one", model: "grok-4.5" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
    const before = JSON.parse(readFileSync(dump, "utf8"));
    const second = await instance.adapter.sendTurn({
      threadId: "t-rewind",
      text: "rewritten request",
      model: "grok-4.5",
      resumeCursor: undefined,
      transcript: [{ role: "user", text: "replacement history" }],
    });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === second.turnId);
    const after = JSON.parse(readFileSync(dump, "utf8"));

    expect(after.pid).not.toBe(before.pid);
    expect(after.promptCount).toBe(1);
    expect(recorder.events.filter((event) => event.type === "session.started")).toHaveLength(2);
  });

  it("mounts the local app broker without handing upstream credentials to the worker or logs", async () => {
    const dump = join(scratch, "connected-apps.json");
    const key = `ck_${"connectedappsecret".repeat(3)}`;
    process.env.FAKE_ACP_DUMP = dump;
    await create();

    await instance.adapter.sendTurn({
      threadId: "t-connected-apps",
      text: "read notion",
      integrations: { composio: { key } },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers).toEqual(
      expect.arrayContaining([
        {
          type: "http",
          name: "connected-apps",
            url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
            headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer /) }],
        },
      ]),
    );
    expect(JSON.stringify(seen.mcpServers)).not.toContain(key);
    const native = readFileSync(join(NATIVE_DIR, "t-connected-apps.ndjson"), "utf8");
    expect(native).not.toContain(key);
    expect(native).toContain("redacted");
  });

  it("requires exact app review even in fullAuto and rejects a session-wide grant", async () => {
    const dump = join(scratch, "app-approval.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver, "hang", true);
    await instance.adapter.sendTurn({ threadId: "t-app-boundary", text: "prepare work", integrations: { composio: { key: "ck_fixture", url: "http://127.0.0.1:1/mcp" } } });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
    const descriptor = JSON.parse(readFileSync(dump, "utf8")).mcpServers.find((row: any) => row.name === "connected-apps");
    const response = fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_email", arguments: { to: "fixture@example.test", text: "Review the browser report" } } }) });
    const opened = await recorder.until(event => event.type === "request.opened");
    expect(opened).toMatchObject({ tool: "bud_connected_app_action", summary: expect.stringContaining("fixture@example.test") });
    await instance.adapter.respondToRequest("t-app-boundary", opened.requestId!, { behavior: "allow", scope: "session" });
    const body: any = await (await response).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("did not approve");
    await instance.adapter.interruptTurn("t-app-boundary");
  });

  it.each([false, true])("revokes pending connected-app approval immediately when Stop is requested (Gmail readonly: %s)", async readOnly => {
    const dump = join(scratch, "app-stop.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver, "hang", true);
    const upstream = "http://127.0.0.1:1/mcp";
    const localRequest = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Fixture" }] });
    const factory = vi.spyOn(gmail, "createGmailReadOnlyTransport").mockReturnValue({ request: localRequest });
    const fetches = vi.spyOn(globalThis, "fetch");
    try {
      await instance.adapter.sendTurn({ threadId: "t-app-stop", text: "prepare work", integrations: { composio: { key: "ck_fixture", url: upstream,
        ...(readOnly ? { gmailReadOnly: { authConfigId: "ac_fixture", userId: "realbud-fixture", accountId: "ca_fixture", requestId: "fixture-stop" } } : {}),
      } } });
      await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
      const descriptor = JSON.parse(readFileSync(dump, "utf8")).mcpServers.find((row: any) => row.name === "connected-apps");
      const response = fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])),
        body: JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call", params: readOnly
          ? { name: "GMAIL_LIST_THREADS", arguments: {} } : { name: "send_email", arguments: { to: "fixture@example.test" } } }) });
      const opened = await recorder.until(event => event.type === "request.opened");
      const stopped = instance.adapter.interruptTurn("t-app-stop");
      // Resolve the old UI approval without waiting for the worker's cancel
      // acknowledgement or the two-second grace period.
      await expect(instance.adapter.respondToRequest("t-app-stop", opened.requestId!, { behavior: "allow", scope: "once" })).rejects.toThrow("no such pending request");
      const body: any = await (await response).json();
      expect(body.result.isError).toBe(true);
      expect(fetches.mock.calls.filter(([url]) => url === upstream)).toHaveLength(0);
      expect(localRequest).not.toHaveBeenCalled();
      expect(factory).toHaveBeenCalledTimes(readOnly ? 1 : 0);
      await stopped;
    } finally { fetches.mockRestore(); factory.mockRestore(); }
  });

  it("replaces a revoked connected-app session on its next turn even with the same key", async () => {
    const dump = join(scratch, "app-reconnect.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver);
    const turn = { threadId: "t-app-reconnect", text: "prepare work", integrations: { composio: { key: "ck_fixture" } } };
    const first = await instance.adapter.sendTurn(turn);
    await recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
    const before = JSON.parse(readFileSync(dump, "utf8"));
    revokeConnectedAppsBrokers();
    const second = await instance.adapter.sendTurn({ ...turn, resumeCursor: "existing-session" });
    await recorder.until(event => event.type === "turn.completed" && event.turnId === second.turnId);
    const after = JSON.parse(readFileSync(dump, "utf8"));
    expect(after.pid).not.toBe(before.pid);
    expect(after.mcpServers[0].url).not.toBe(before.mcpServers[0].url);
  });

  it("mounts the server-owned Gmail adapter and keeps project credentials and binding out of the worker", async () => {
    const dump = join(scratch, "gmail-adapter.json");
    process.env.FAKE_ACP_DUMP = dump;
    const key = "project_fixture_secret_for_gmail";
    const binding = { authConfigId: "ac_fixture_gmail", userId: "realbud-fixture-user", accountId: "ca_fixture_account", requestId: "fixture-review-one" };
    const request = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Fixture read returned" }] });
    const factory = vi.spyOn(gmail, "createGmailReadOnlyTransport").mockReturnValue({ request });
    const ambientKey = process.env.COMPOSIO_API_KEY;
    process.env.COMPOSIO_API_KEY = key;
    try {
      await create(HermesAgentDriver, "hang", true);
      await instance.adapter.sendTurn({ threadId: "t-gmail-adapter", text: "review recent mail", integrations: { composio: { key, url: "http://127.0.0.1:1/mcp", gmailReadOnly: binding } } });
      await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
      expect(factory).toHaveBeenCalledWith({ apiKey: key, authConfigId: binding.authConfigId, userId: binding.userId, accountId: binding.accountId });
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      const descriptor = seen.mcpServers.find((row: any) => row.name === "connected-apps");
      expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(JSON.stringify(seen)).not.toContain(key);
      expect(JSON.stringify(seen.mcpServers)).not.toContain(binding.accountId);
      expect(JSON.stringify(seen.mcpServers)).not.toContain(binding.authConfigId);
      expect(readFileSync(join(NATIVE_DIR, "t-gmail-adapter.ndjson"), "utf8")).not.toContain(key);
      const response = fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])),
        body: JSON.stringify({ jsonrpc: "2.0", id: 19, method: "tools/call", params: { name: "GMAIL_LIST_THREADS", arguments: {} } }) });
      const opened = await recorder.until(event => event.type === "request.opened");
      expect(opened).toMatchObject({ tool: "bud_connected_app_action", summary: expect.stringContaining("GMAIL_LIST_THREADS") });
      if (opened.type !== "request.opened") throw new Error("Expected a Gmail permission request");
      expect(opened.summary).toContain(`Account: ${binding.accountId}`);
      expect(opened.summary).toContain("10 threads from the last 7 days");
      expect(opened.summary).not.toContain(key);
      expect(opened.summary).not.toContain(binding.userId);
      expect(request).not.toHaveBeenCalled();
      await instance.adapter.respondToRequest("t-gmail-adapter", opened.requestId!, { behavior: "allow", scope: "once" });
      expect((await (await response).json() as any).result.isError).not.toBe(true);
      expect(request).toHaveBeenCalledWith("tools/call", { name: "GMAIL_LIST_THREADS", arguments: {} }, expect.any(AbortSignal));
      await instance.adapter.interruptTurn("t-gmail-adapter");
    } finally {
      factory.mockRestore();
      if (ambientKey === undefined) delete process.env.COMPOSIO_API_KEY; else process.env.COMPOSIO_API_KEY = ambientKey;
    }
  });

  it.each(["accountId", "requestId"] as const)("creates a fresh Gmail transport when %s changes", async field => {
    const dump = join(scratch, `gmail-fresh-${field}.json`);
    process.env.FAKE_ACP_DUMP = dump;
    const factory = vi.spyOn(gmail, "createGmailReadOnlyTransport").mockImplementation(() => ({ request: vi.fn().mockResolvedValue({}) }));
    try {
      await create(HermesAgentDriver);
      const gmailReadOnly = { authConfigId: "ac_fixture_gmail", userId: "realbud-fixture-user", accountId: "ca_fixture_one", requestId: "fixture-review-one" };
      const turn = { threadId: `t-gmail-fresh-${field}`, text: "review mail", integrations: { composio: { key: "project_fixture", gmailReadOnly } } };
      const first = await instance.adapter.sendTurn(turn);
      await recorder.until(event => event.type === "turn.completed" && event.turnId === first.turnId);
      const before = JSON.parse(readFileSync(dump, "utf8"));
      const second = await instance.adapter.sendTurn({ ...turn, resumeCursor: "existing-session", integrations: { composio: { ...turn.integrations.composio,
        gmailReadOnly: { ...gmailReadOnly, [field]: `${gmailReadOnly[field]}-changed` } } } });
      await recorder.until(event => event.type === "turn.completed" && event.turnId === second.turnId);
      const after = JSON.parse(readFileSync(dump, "utf8"));
      expect(after.pid).not.toBe(before.pid);
      expect(after.mcpServers[0].url).not.toBe(before.mcpServers[0].url);
      expect(factory).toHaveBeenCalledTimes(2);
    } finally { factory.mockRestore(); }
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

  it("uses the provider's expiring session grant when the user allows similar steps for the task", async () => {
    const dump = join(scratch, "session-approval.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: "t-session-perm", text: "go" });
    const opened = await recorder.until((event) => event.type === "request.opened");

    await instance.adapter.respondToRequest("t-session-perm", (opened as any).requestId, {
      behavior: "allow",
      scope: "session",
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).selectedPermissionOption).toBe("allow_session");
  });

  it("puts Hermes in workspace-scoped accept-edits mode before the prompt", async () => {
    const dump = join(scratch, "hermes-mode.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver);

    await instance.adapter.sendTurn({ threadId: "t-hermes-mode", text: "draft a file", cwd: scratch });
    await recorder.until((event) => event.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).sessionMode).toBe("accept_edits");
  });

  it("falls back to one-time approval when a provider has no session scope", async () => {
    const dump = join(scratch, "approval-fallback.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "permission-once-only");
    await instance.adapter.sendTurn({ threadId: "t-perm-fallback", text: "go" });
    const opened = await recorder.until((event) => event.type === "request.opened");

    await instance.adapter.respondToRequest("t-perm-fallback", (opened as any).requestId, {
      behavior: "allow",
      scope: "session",
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).selectedPermissionOption).toBe("allow-once");
  });

  it("keeps manual approvals and continues if the optional Hermes mode cannot be applied", async () => {
    await create(HermesAgentDriver, "mode-error");
    await instance.adapter.sendTurn({ threadId: "t-hermes-mode-fallback", text: "draft a file", cwd: scratch });
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
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

  it("does not mount a computer MCP server when computer is requested but no descriptor exists", async () => {
    const userData = join(scratch, "no-cua");
    mkdirSync(userData, { recursive: true });
    const dump = join(scratch, "dump.json");
    const prevUserData = process.env.OMB_USER_DATA;
    const prevHome = process.env.HOME;
    process.env.OMB_USER_DATA = userData;
    process.env.HOME = scratch;
    process.env.FAKE_ACP_DUMP = dump;
    try {
      await create();
      await instance.adapter.sendTurn({ threadId: "t-no-cua", text: "go", computer: true });
      await recorder.until((e) => e.type === "turn.completed");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.mcpServers ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "computer" })]));
    } finally {
      if (prevUserData === undefined) delete process.env.OMB_USER_DATA;
      else process.env.OMB_USER_DATA = prevUserData;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it.skipIf(process.platform === "linux")(
    "mounts the computer MCP server from a CUA descriptor when computer is requested",
    async () => {
      const userData = join(scratch, "cua");
      mkdirSync(userData, { recursive: true });
      writeFileSync(
        join(userData, "cua-connection.json"),
        JSON.stringify({
          mode: "embedded",
          mcpCommand: "/tmp/cua-driver",
          mcpArgs: ["mcp", "--embedded"],
          mcpEnv: { CUA_DRIVER_EMBEDDED: "1", CUA_SOCKET: "/tmp/cua.sock" },
        }),
      );
      const dump = join(scratch, "dump.json");
      const prevUserData = process.env.OMB_USER_DATA;
      const prevHome = process.env.HOME;
      process.env.OMB_USER_DATA = userData;
      process.env.HOME = scratch;
      process.env.FAKE_ACP_DUMP = dump;
      try {
        await create();
        await instance.adapter.sendTurn({ threadId: "t-cua", text: "go", computer: true });
        await recorder.until((e) => e.type === "turn.completed");
        const seen = JSON.parse(readFileSync(dump, "utf8"));
        expect(seen.mcpServers).toEqual(
          expect.arrayContaining([
            {
              name: "computer",
              command: "/tmp/cua-driver",
              args: ["mcp", "--embedded"],
              env: [
                { name: "CUA_DRIVER_EMBEDDED", value: "1" },
                { name: "CUA_SOCKET", value: "/tmp/cua.sock" },
              ],
            },
          ]),
        );
      } finally {
        if (prevUserData === undefined) delete process.env.OMB_USER_DATA;
        else process.env.OMB_USER_DATA = prevUserData;
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
    },
  );
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

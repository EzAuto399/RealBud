import { withWorkerProfile } from "../../hermes-profile.ts";
// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// The fake CLI is a shebang script Windows cannot exec directly —
// resolveCliSpawn turns it into `node <script>`, so these run everywhere.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { GrokAgentDriver } from "./grok.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { KimiAgentDriver } from "./kimi.ts";
import { hardenHermesChildEnv, HermesAgentDriver } from "./hermes.ts";
import { HERMES_BROWSER_REFUSED, hermesNativeBrowserTool } from "./core.ts";
import { HERMES_PIN } from "../../hermes-pin.ts";
import { seedVault } from "../../vault.ts";
import { revokeConnectedAppsBrokers } from "../../connected-apps-broker.ts";
import * as gmail from "../../composio-gmail.ts";
import { ServiceEntitlementError } from "../../service-entitlement.ts";
import { HERMES_MEMORY_APPROVAL } from "./hermes-memory-approval.ts";
import { browserRuntime, type BrowserJson } from "../../browser-runtime.ts";
import { legacyBrowserGrant } from "../../browser-authority.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));

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
    expect(HermesAgentDriver.install?.command?.darwin).toBe("");
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
    expect(env).toEqual({ SAFE_VALUE: "kept", HERMES_HOME: join(homedir(), ".realbud", "hermes"), HERMES_ACP_SKIP_CONFIGURED_MCP: "1", HERMES_SAFE_MODE: "1", HERMES_EXEC_ASK: "1", HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS: "60" });
  });
  it("names only Hermes' own browser and vault tools, never RealBud's fenced browser", () => {
    expect(hermesNativeBrowserTool("browser_navigate: https://example.invalid")).toBe("browser_navigate");
    expect(hermesNativeBrowserTool(undefined, "browser_vault_fill")).toBe("browser_vault_fill");
    expect(hermesNativeBrowserTool("browser_exec")).toBe("browser_exec");
    for (const other of ["mcp__browser__navigate: https://example.invalid", "browser", "browserish", "Open approved portal", "navigate", "web_extract"]) {
      expect(hermesNativeBrowserTool(other), other).toBeNull();
    }
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
    assertCapability.mockReset();
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.FAKE_ACP_TOOL;
    delete process.env.FAKE_ACP_TOOL_INPUT;
    delete process.env.FAKE_ACP_SCRIPT;
    delete process.env.XAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    // dispose() does not wait for the killed CLI to exit; on Windows its cwd
    // (the scratch folder, for turns that pass one) stays held until it does.
    await removeFixture(scratch);
  });

  it("replaces a warm Hermes process when the authenticated member changes", async () => {
    const dump = join(scratch, "seat.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver);
    const first = await withWorkerProfile("dana", () => instance.adapter.sendTurn({ threadId: "seat", text: "one" }));
    await recorder.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("property-dana");
    const second = await withWorkerProfile("sam", () => instance.adapter.sendTurn({ threadId: "seat", text: "two" }));
    await recorder.until(e => e.type === "turn.completed" && e.turnId === second.turnId);
    const changed = JSON.parse(readFileSync(dump, "utf8"));
    expect(changed.argv).toContain("property-sam");
    expect(changed.argv).not.toContain("property-dana");
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

  it.each(["reasoning", "computer-use"] as const)("settles without a model prompt when %s expires during initialization", async capability => {
    const dump = join(scratch, `expired-${capability}.json`);
    process.env.FAKE_ACP_DUMP = dump;
    let expired = false;
    assertCapability.mockImplementation((requested: string) => {
      if (expired && requested === capability) throw new ServiceEntitlementError("Managed service has expired.", 402);
    });
    await create();
    const threadId = `t-expired-${capability}`;
    await instance.adapter.sendTurn({ threadId, text: "synthetic work",
      ...(capability === "computer-use" ? { integrations: { localComputer: { command: "fixture-computer", args: [], env: {} } } } : {}),
    });
    // sendTurn returns while the child handshake is still awaiting I/O.
    // Withdraw authority before initialize/session-new can finish.
    expired = true;
    const done = await recorder.until(event => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "rpc_error" });
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: "Managed service has expired." }));
    expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(0);
    const native = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8");
    expect(native).toContain("session/new");
    expect(native).not.toContain("session/prompt");
    expect(instance.adapter.hasSession(threadId)).toBe(false);
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

  it("mounts a private browser capability for one job and revokes it on interruption", async () => {
    const dump = join(scratch, "browser-job.json"); process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-browser-job", text: "Read the saved job site", computer: true,
      integrations: { browser: { runId: "run-browser", allowedOrigins: ["portal.example"], capabilities: ["portal-read"],
        grant: legacyBrowserGrant({ runId: "run-browser", allowedOrigins: ["portal.example"], capabilities: ["portal-read"] }) },
        localComputer: { command: "must-not-mount", args: [], env: {} } } });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.mcpServers.map((server: { name: string }) => server.name)).toEqual(["browser"]);
    const descriptor = seen.mcpServers[0];
    const request = () => fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: { name: string; value: string }) => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const listing = await (await request()).json() as { result: { tools: Array<{ name: string }> } };
    expect(listing.result.tools.some((tool: { name: string }) => tool.name === "browser_borrow")).toBe(true);
    expect(assertCapability).toHaveBeenCalledWith("computer-use");
    expect(readFileSync(join(NATIVE_DIR, "t-browser-job.ndjson"), "utf8")).not.toContain(descriptor.headers[0].value);
    await instance.adapter.interruptTurn("t-browser-job");
    await expect(request()).rejects.toThrow();
    expect(instance.adapter.hasSession("t-browser-job")).toBe(false);
  });

  // Pinned Hermes gives a delegated child the parent's `mcp-browser` toolset
  // (tools/delegate_tool_toolsets.py:89-98, inherit_mcp_toolsets default true at
  // tools/delegate_tool_config.py:165-167) and dispatches its MCP calls on the
  // parent's one connection, same URL and bearer (tools/mcp_tool_handlers.py:98,
  // tools/mcp_tool.py:407). So the child's call below is exactly what reaches
  // RealBud: the parent's broker, its grant, its approval card and its Stop.
  it("a delegated child's browser call reaches the parent's broker under the same grant, approval and Stop", async () => {
    const dump = join(scratch, "browser-child.json"); process.env.FAKE_ACP_DUMP = dump;
    let scope = "user";
    const spies = [
      vi.spyOn(browserRuntime, "acquire").mockResolvedValue("owned"),
      vi.spyOn(browserRuntime, "checkSession").mockResolvedValue(undefined),
      vi.spyOn(browserRuntime, "isOwner").mockReturnValue(true),
      vi.spyOn(browserRuntime, "release").mockResolvedValue(undefined),
      vi.spyOn(browserRuntime, "command").mockImplementation(async (args: string[]): Promise<BrowserJson> => {
        if (args[0] === "tab" && args[1] === "list") return { tabs: [{ tab_id: 1, url: "https://portal.example/levies", title: "Fictional levies", scope }] };
        if (args[0] === "tab" && args[1] === "borrow") { scope = "agent"; return { ok: true }; }
        return { ok: true };
      }),
    ];
    try {
      await create(HermesAgentDriver, "hang");
      await instance.adapter.sendTurn({ threadId: "t-browser-child", text: "Delegate reading the fictional levies", computer: true,
        integrations: { browser: { runId: "run-browser-child", allowedOrigins: ["portal.example"], capabilities: ["portal-read"],
          grant: legacyBrowserGrant({ runId: "run-browser-child", allowedOrigins: ["portal.example"], capabilities: ["portal-read"] }) } } });
      await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
      const descriptor = JSON.parse(readFileSync(dump, "utf8")).mcpServers[0] as { url: string; headers: Array<{ name: string; value: string }> };
      let id = 100;
      const child = async (method: string, params: Record<string, unknown> = {}) => (await (await fetch(descriptor.url, { method: "POST",
        headers: { "content-type": "application/json", ...Object.fromEntries(descriptor.headers.map(row => [row.name, row.value])) },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json() as { result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } }).result;
      // Same grant: the saved job's tools only; a tool it never granted stays unavailable to the child.
      const tools = (await child("tools/list")).tools!.map(tool => tool.name);
      expect(tools).toContain("browser_borrow"); expect(tools).not.toContain("browser_press");
      const press = await child("tools/call", { name: "browser_press", arguments: { tab_id: 1, ref: "@e1", key: "Enter" } });
      expect(press.isError).toBe(true); expect(press.content![0].text).toMatch(/not available/);
      // Same approval: the child's borrow opens the parent's card, and a refusal is final.
      const borrow = child("tools/call", { name: "browser_borrow", arguments: { tab_id: 1 } });
      const opened = await recorder.until(event => event.type === "request.opened" && event.threadId === "t-browser-child") as Extract<RuntimeEvent, { type: "request.opened" }>;
      expect(opened.fence).toMatchObject({ surface: "portal-read", origin: "portal.example" });
      await instance.adapter.respondToRequest("t-browser-child", opened.requestId!, { behavior: "deny" });
      const refused = await borrow;
      expect(refused.isError).toBe(true); expect(refused.content![0].text).toMatch(/not approved/);
      expect(spies[4].mock.calls.some(([args]) => args[0] === "tab" && args[1] === "borrow")).toBe(false);
      // Same Stop: the parent's interrupt closes the broker, so the child's next call fails.
      await instance.adapter.interruptTurn("t-browser-child");
      await expect(child("tools/call", { name: "browser_tabs", arguments: {} })).rejects.toThrow();
      expect(spies[3]).toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
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
    const key = `ak_${"connectedappsecret".repeat(3)}`;
    process.env.FAKE_ACP_DUMP = dump;
    await create();

    await instance.adapter.sendTurn({
      threadId: "t-connected-apps",
      text: "read notion",
      integrations: { composio: { key, url: "http://127.0.0.1:1/mcp", headers: { "x-api-key": key } } },
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
    await instance.adapter.sendTurn({ threadId: "t-app-boundary", text: "prepare work", integrations: { composio: { key: "ak_fixture", url: "http://127.0.0.1:1/mcp" } } });
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
      await instance.adapter.sendTurn({ threadId: "t-app-stop", text: "prepare work", integrations: { composio: { key: "ak_fixture", url: upstream,
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
    const turn = { threadId: "t-app-reconnect", text: "prepare work", integrations: { composio: { key: "ak_fixture", url: "http://127.0.0.1:1/mcp", headers: { "x-api-key": "ak_fixture" } } } };
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

  it.each([
    { name: "whole-script command", rawInput: { command: "execute_code <<'PY'\nprint(1)\nPY" } },
    { name: "named native script", rawInput: { name: "execute_code", command: "print(1)" } },
    { name: "code payload", rawInput: { code: "print(1)" } },
    { name: "unidentified execution", rawInput: {} },
    { name: "unknown named action", rawInput: { name: "future_script_tool", command: "print(1)" } },
    { name: "unknown native callback", rawInput: { description: "Change durable future state", command: "git is our preferred change tracker" } },
    { name: "conflicting named terminal callback", rawInput: { name: "terminal", tool: "future_action", command: "git is our preferred change tracker" } },
  ])("keeps Hermes $name permission one-shot even when fullAuto or session approval is requested", async ({ rawInput }) => {
    const dump = join(scratch, "script-approval.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_TOOL = "execute";
    process.env.FAKE_ACP_TOOL_INPUT = JSON.stringify(rawInput);
    await create(HermesAgentDriver, "permission", true);
    await instance.adapter.sendTurn({ threadId: "t-script-perm", text: "go" });
    const opened = await recorder.until(event => event.type === "request.opened");
    expect(opened).toMatchObject({ summary: expect.stringContaining("approval applies once"), approvalPolicy: "once" });
    await instance.adapter.respondToRequest("t-script-perm", opened.requestId!, { behavior: "allow", scope: "session" });
    await recorder.until(event => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).selectedPermissionOption).toBe("allow-once");
  });

  it("cancels Hermes script approval when upstream only offers a blanket grant", async () => {
    const dump = join(scratch, "script-no-once.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.FAKE_ACP_TOOL = "execute_code";
    await create(HermesAgentDriver, "permission-session-only");
    await instance.adapter.sendTurn({ threadId: "t-script-no-once", text: "go" });
    const opened = await recorder.until(event => event.type === "request.opened");
    await instance.adapter.respondToRequest("t-script-no-once", opened.requestId!, { behavior: "allow", scope: "session" });
    expect(await recorder.until(event => event.type === "request.resolved")).toMatchObject({ behavior: "deny", source: "system" });
    await recorder.until(event => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).selectedPermissionOption).toBeNull();
  });

  it.each([
    { name: 'typed navigation', kind: 'navigate', title: 'Open approved portal', rawInput: { url: 'https://example.invalid/bills' }, policy: 'provider-once' },
    { name: 'typed read', kind: 'read', title: 'Read approved portal', rawInput: { name: 'read', url: 'https://example.invalid/bills' }, policy: 'provider-once' },
    { name: 'typed fill', kind: 'fill', title: 'Fill approved form', rawInput: { tool: 'fill', url: 'https://example.invalid/bills', field: 'reference', value: 'fictional' }, policy: 'provider-once' },
    { name: 'script title disguised as navigation', kind: 'navigate', title: 'execute_code print(1)', rawInput: { url: 'https://example.invalid/bills' }, policy: 'once' },
    { name: 'script body disguised as navigation', kind: 'navigate', title: 'Open approved portal', rawInput: { url: 'https://example.invalid/bills', code: 'print(1)' }, policy: 'once' },
    { name: 'unknown callback disguised as navigation', kind: 'navigate', title: 'Open approved portal', rawInput: { url: 'https://example.invalid/bills', description: 'Unknown durable change' }, policy: 'once' },
    { name: 'conflicting browser action metadata', kind: 'navigate', title: 'Open approved portal', rawInput: { name: 'navigate', tool: 'future_action', url: 'https://example.invalid/bills' }, policy: 'once' },
    { name: 'browser name with unknown action kind', kind: 'future_action', title: 'Open approved portal', rawInput: { name: 'navigate', url: 'https://example.invalid/bills' }, policy: 'once' },
    { name: 'coercible non-string browser kind', kind: ['navigate'], title: 'Open approved portal', rawInput: { url: 'https://example.invalid/bills' }, policy: 'once' },
    { name: 'coercible non-string terminal kind', kind: ['execute'], title: 'echo hi', rawInput: { command: 'echo hi' }, policy: 'once' },
  ])('retains approval provenance for $name and still grants only provider allow_once', async ({ kind, title, rawInput, policy }) => {
    const dump = join(scratch, 'browser-provenance.json'), script = join(scratch, 'browser-provenance-callback.json');
    writeFileSync(script, JSON.stringify({ tool: kind, rawInput, title }));
    process.env.FAKE_ACP_SCRIPT = script; process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver, 'permission', true);
    await instance.adapter.sendTurn({ threadId: 'browser-provenance', text: 'go' });
    const opened = await recorder.until(event => event.type === 'request.opened');
    expect(opened).toMatchObject({ approvalPolicy: policy });
    expect(JSON.parse(readFileSync(dump, 'utf8')).selectedPermissionOption ?? null).toBeNull();
    await instance.adapter.respondToRequest('browser-provenance', opened.requestId!, { behavior: 'allow', scope: 'session' });
    await recorder.until(event => event.type === 'turn.completed');
    expect(JSON.parse(readFileSync(dump, 'utf8')).selectedPermissionOption).toBe('allow-once');
  });

  it("preserves Hermes session permission for an identified terminal command", async () => {
    const dump = join(scratch, "terminal-session.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: "t-terminal-session", text: "go" });
    const opened = await recorder.until(event => event.type === "request.opened");
    await instance.adapter.respondToRequest("t-terminal-session", opened.requestId!, { behavior: "allow", scope: "session" });
    await recorder.until(event => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).selectedPermissionOption).toBe("allow_session");
  });

  it.each([false, true])("requires explicit one-time review of complete native memory text with fullAuto=%s", async fullAuto => {
    const dump = join(scratch, 'memory-permission.json'), script = join(scratch, 'memory-callback.json');
    const description = 'Save to memory: add to memory', content = 'git is our preferred change tracker\n' + 'Private fictional detail '.repeat(50);
    writeFileSync(script, JSON.stringify({ tool: 'execute', rawInput: { command: content, description }, title: `${description}: ${content}` }));
    process.env.FAKE_ACP_SCRIPT = script; process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver, 'permission', fullAuto);
    await instance.adapter.sendTurn({ threadId: 'memory-review', text: 'go' });
    const opened = await recorder.until(event => event.type === 'request.opened');
    expect(opened).toMatchObject({ tool: HERMES_MEMORY_APPROVAL, approvalPolicy: 'once',
      memoryReview: { description, content, complete: true }, params: { command: content, description } });
    expect(JSON.parse(readFileSync(dump, 'utf8')).selectedPermissionOption ?? null).toBeNull();
    await instance.adapter.respondToRequest('memory-review', opened.requestId!, { behavior: 'allow', scope: 'session' });
    await recorder.until(event => event.type === 'turn.completed');
    expect(JSON.parse(readFileSync(dump, 'utf8')).selectedPermissionOption).toBe('allow-once');
  });

  it('does not approve native memory when only a session grant is offered', async () => {
    const dump = join(scratch, 'memory-no-once.json'), script = join(scratch, 'memory-callback.json');
    const description = 'Save to memory: add to user profile', content = 'Fictional user preference';
    writeFileSync(script, JSON.stringify({ tool: 'execute', rawInput: { command: content, description }, title: `${description}: ${content}` }));
    process.env.FAKE_ACP_SCRIPT = script; process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver, 'permission-session-only', true);
    await instance.adapter.sendTurn({ threadId: 'memory-no-once', text: 'go' });
    const opened = await recorder.until(event => event.type === 'request.opened');
    await instance.adapter.respondToRequest('memory-no-once', opened.requestId!, { behavior: 'allow', scope: 'session' });
    await recorder.until(event => event.type === 'turn.completed');
    expect(JSON.parse(readFileSync(dump, 'utf8')).selectedPermissionOption).toBeNull();
  });

  it.each(['malformed', 'credential-shaped', 'destructive substring'])('rejects %s native memory before fullAuto or raw-content emission', async failure => {
    const dump = join(scratch, 'memory-held.json'), script = join(scratch, 'memory-held-callback.json');
    const description = failure === 'destructive substring' ? 'Save to memory: remove from memory' : 'Save to memory: add to memory';
    const content = failure === 'credential-shaped' ? 'api_key=fictional_rejected_credential' : 'git is our preferred change tracker';
    writeFileSync(script, JSON.stringify({ tool: 'execute', rawInput: { command: content, description }, title: failure === 'malformed' ? 'execute' : `${description}: ${content}` }));
    process.env.FAKE_ACP_DUMP = dump; process.env.FAKE_ACP_SCRIPT = script;
    await create(HermesAgentDriver, 'permission', true);
    await instance.adapter.sendTurn({ threadId: 'memory-held', text: 'go' });
    await recorder.until(event => event.type === 'turn.completed');
    expect(JSON.parse(readFileSync(dump, 'utf8')).selectedPermissionOption).toBeNull();
    expect(recorder.events.some(event => event.type === 'request.opened')).toBe(false);
    expect(JSON.stringify(recorder.events)).not.toContain(content);
  });

  it('retains the established session path for explicitly identified terminal commands', async () => {
    const dump = join(scratch, 'named-terminal.json');
    process.env.FAKE_ACP_DUMP = dump; process.env.FAKE_ACP_TOOL = 'execute';
    process.env.FAKE_ACP_TOOL_INPUT = JSON.stringify({ name: 'terminal', command: 'echo hi', description: 'Run terminal command' });
    await create(HermesAgentDriver, 'permission');
    await instance.adapter.sendTurn({ threadId: 'named-terminal', text: 'go' });
    const opened = await recorder.until(event => event.type === 'request.opened');
    expect(opened).toMatchObject({ tool: 'terminal' }); expect(opened).not.toHaveProperty('approvalPolicy');
    await instance.adapter.respondToRequest('named-terminal', opened.requestId!, { behavior: 'allow', scope: 'session' });
    await recorder.until(event => event.type === 'turn.completed');
    expect(JSON.parse(readFileSync(dump, 'utf8')).selectedPermissionOption).toBe('allow_session');
  });

  it('rejects a memory action masked by a conflicting terminal name before fullAuto', async () => {
    const dump = join(scratch, 'masked-memory.json');
    process.env.FAKE_ACP_DUMP = dump; process.env.FAKE_ACP_TOOL = 'execute';
    process.env.FAKE_ACP_TOOL_INPUT = JSON.stringify({ name: 'terminal', tool: HERMES_MEMORY_APPROVAL, command: 'git is our preferred change tracker' });
    await create(HermesAgentDriver, 'permission', true);
    await instance.adapter.sendTurn({ threadId: 'masked-memory', text: 'go' });
    await recorder.until(event => event.type === 'turn.completed');
    expect(JSON.parse(readFileSync(dump, 'utf8')).selectedPermissionOption).toBeNull();
    expect(recorder.events.some(event => event.type === 'request.opened')).toBe(false);
  });

  it.each([
    { name: "titled", rawInput: {}, title: "browser_navigate: https://example.invalid/bills" },
    { name: "named vault", rawInput: { name: "browser_vault_fill", url: "https://example.invalid/login" }, title: "Fill saved login" },
  ])("refuses a Hermes-native browser permission ($name) before fullAuto and stops the turn", async ({ rawInput, title }) => {
    const dump = join(scratch, "native-browser-permission.json"), script = join(scratch, "native-browser-callback.json");
    writeFileSync(script, JSON.stringify({ tool: "fetch", rawInput, title }));
    process.env.FAKE_ACP_SCRIPT = script; process.env.FAKE_ACP_DUMP = dump;
    await create(HermesAgentDriver, "permission", true);
    await instance.adapter.sendTurn({ threadId: "native-browser-permission", text: "go" });
    await recorder.until(event => event.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).selectedPermissionOption).toBeNull();
    expect(recorder.events.some(event => event.type === "request.opened")).toBe(false);
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: HERMES_BROWSER_REFUSED }));
  });

  it("still asks about RealBud's own fenced browser tools", async () => {
    const script = join(scratch, "fenced-browser-callback.json");
    writeFileSync(script, JSON.stringify({ tool: "fetch", rawInput: { url: "https://example.invalid/bills" }, title: "mcp__browser__navigate: https://example.invalid/bills" }));
    process.env.FAKE_ACP_SCRIPT = script;
    await create(HermesAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: "fenced-browser", text: "go" });
    const opened = await recorder.until(event => event.type === "request.opened");
    await instance.adapter.respondToRequest("fenced-browser", opened.requestId!, { behavior: "deny" });
    await recorder.until(event => event.type === "turn.completed");
    expect(recorder.events.some(event => event.type === "runtime.error" && (event as any).message === HERMES_BROWSER_REFUSED)).toBe(false);
  });

  it("cancels the turn when Hermes starts one of its own browser tools", async () => {
    // Hermes offers no permission prompt for most browser actions, so the
    // started tool call is the only signal RealBud sees.
    const fake = join(scratch, "native-browser-acp.mjs"), dump = join(scratch, "native-browser-cancel.json");
    writeFileSync(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const out = m => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "", prompt = null;
process.stdin.on("data", chunk => {
  buf += chunk; let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, authMethods: [] } });
    else if (msg.method === "session/new") out({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fictional-session" } });
    else if (msg.method === "session/set_mode") out({ jsonrpc: "2.0", id: msg.id, result: {} });
    else if (msg.method === "session/prompt") {
      prompt = msg.id;
      out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-browser", title: "browser_navigate: https://example.invalid/bills", kind: "fetch" } } });
    } else if (msg.method === "session/cancel") {
      writeFileSync(${JSON.stringify(dump)}, "cancelled");
      out({ jsonrpc: "2.0", id: prompt, result: { stopReason: "cancelled" } });
    } else if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
`);
    chmodSync(fake, 0o755);
    instance = await HermesAgentDriver.create({ instanceId: "acp-test", displayName: "ACP Test", environment: {}, enabled: true, config: { cli: fake, fullAuto: true } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "native-browser-call", text: "go" });
    const done = await recorder.until(event => event.type === "turn.completed");
    expect(done).toMatchObject({ stopReason: "cancelled" });
    expect(readFileSync(dump, "utf8")).toBe("cancelled");
    expect(recorder.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: HERMES_BROWSER_REFUSED }));
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
        assertCapability.mockImplementation((capability: string) => {
          if (capability === "computer-use") throw new ServiceEntitlementError("Computer use is not included.", 403);
        });
        await expect(instance.adapter.sendTurn({ threadId: "t-cua-denied", text: "go", computer: true })).rejects.toThrow("Computer use is not included.");
        expect(instance.adapter.hasSession("t-cua-denied")).toBe(false);
        assertCapability.mockReset();
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

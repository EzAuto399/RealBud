// A desktop task's grant in the ACP core: the worker gets `workdesktop` and
// nothing else for the work (no browser broker, no raw cua `computer`), with
// pick_control only when the host passed the decisions binding; a broker card
// stays on this computer (remote: desktop-only); Stop ends the driver session.
// The driver is the dependency-free fake cua proxy; every value is fictional.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { __setCuaConnectionForTests } from "../../local-computer.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { parseBrowserTaskGrant, type BrowserTaskGrant } from "../../../shared/browser-task.ts";
import { releaseDesktopBrokers } from "./core.ts";
import { HermesAgentDriver } from "./hermes.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, "..", "..", "testing", "fake-acp-cli.ts");
const FAKE_CUA = join(HERE, "..", "..", "testing", "fake-cua-mcp.mjs");
delete process.env.NODE_V8_COVERAGE;
const GRANT_ID = "00000000-0000-4000-8000-0000000000d1";
const grant = (): BrowserTaskGrant => parseBrowserTaskGrant({
  version: 1, purpose: "browser-task-grant", id: GRANT_ID, runId: `ask-${GRANT_ID}`, route: "ask",
  request: { text: "Clear the fictional calculator in the Calculator app", sha256: "d".repeat(64) },
  sites: [], browser: { id: null, accountMarker: null }, actions: ["read", "click", "fill", "keys"],
  consequential: "ask-each", uploads: [], expiresAt: Date.now() + 30 * 60_000, budget: 40,
  desktop: { appName: "Calculator", bundleId: "Calculator", pid: 1001, windowId: 2001, title: "Calculator" },
});
type Desktop = NonNullable<NonNullable<SendTurnInput["integrations"]>["desktop"]>;

describe("a desktop task grant in the ACP core", () => {
  let instance: ProviderInstance, recorder: EventRecorder, scratch: string, record: string;
  beforeEach(() => {
    assertCapability.mockReset(); ensureDirs(); chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "rb-acp-desktop-"));
    record = join(scratch, "cua-calls.jsonl");
    // The same descriptor a raw `computer` mount would use: it must never be mounted beside workdesktop.
    __setCuaConnectionForTests({ command: process.execPath, args: [FAKE_CUA], env: { FAKE_CUA_RECORD: record } });
  });
  afterEach(async () => {
    __setCuaConnectionForTests(undefined);
    delete process.env.FAKE_ACP_MODE; delete process.env.FAKE_ACP_DUMP;
    recorder?.stop(); await instance?.dispose(); await removeFixture(scratch);
  });
  const send = async (thread: string, integrations: NonNullable<SendTurnInput["integrations"]>) => {
    const dump = join(scratch, `${thread}.json`); process.env.FAKE_ACP_DUMP = dump; process.env.FAKE_ACP_MODE = "hang";
    instance = await HermesAgentDriver.create({ instanceId: "acp-desktop", displayName: "ACP", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: thread, text: "Start this task", integrations });
    return dump;
  };
  const mounted = async (dump: string) => {
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
    return JSON.parse(readFileSync(dump, "utf8")).mcpServers as Array<{ name: string; url: string; headers: Array<{ name: string; value: string }> }>;
  };
  let requestId = 0;
  const rpc = async (descriptor: { url: string; headers: Array<{ name: string; value: string }> }, method: string, params: Record<string, unknown>) =>
    (await (await fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map(row => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) })).json()) as { result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ type: string; text?: string }> } };
  const cuaCalls = () => { try { return readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).name as string); } catch { return []; } };
  const desktop = (extra: Partial<Desktop> = {}): Desktop => { const g = grant(); return { runId: g.runId, grant: g, active: () => true, ...extra }; };

  it("mounts workdesktop alone (no browser broker, no raw computer), without pick_control when no decisions binding", async () => {
    const dump = await send("t-desktop", { desktop: desktop() });
    const servers = await mounted(dump);
    expect(servers.map(server => server.name)).toEqual(["workdesktop"]);
    expect(assertCapability).toHaveBeenCalledWith("computer-use");
    const tools = (await rpc(servers[0], "tools/list", {})).result.tools!.map(tool => tool.name);
    expect(tools).toEqual(["get_window_state", "click", "type_text", "scroll", "press_key", "release"]);
    const read = await rpc(servers[0], "tools/call", { name: "get_window_state", arguments: {} });
    expect(read.result.isError).toBeFalsy();
    expect(read.result.content?.[0]?.text).toContain("All Clear");
    // Stop: the turn's interrupt ends the driver session.
    await instance.adapter.interruptTurn("t-desktop");
    await vi.waitFor(() => expect(cuaCalls()).toContain("end_session"));
  });

  it("lists pick_control only when the host passed the decisions binding", async () => {
    const decisions = { sameMember: () => true, ready: () => true, lunaReady: () => false, decide: vi.fn() };
    const servers = await mounted(await send("t-desktop-decide", { desktop: desktop({ decisions }) }));
    const tools = (await rpc(servers.find(server => server.name === "workdesktop")!, "tools/list", {})).result.tools!.map(tool => tool.name);
    expect(tools).toContain("pick_control");
    await instance.adapter.interruptTurn("t-desktop-decide");
  });

  it("shows a consequential press as a once-only card that a phone cannot answer", async () => {
    const servers = await mounted(await send("t-desktop-card", { desktop: desktop() }));
    const read = await rpc(servers[0], "tools/call", { name: "get_window_state", arguments: {} });
    const token = (JSON.parse(read.result.content![0].text!).elements as Array<{ element_token: string; label: string }>).find(row => row.label === "Delete")!.element_token;
    const pressed = rpc(servers[0], "tools/call", { name: "click", arguments: { element_token: token } });
    const opened = await recorder.until(event => event.type === "request.opened") as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened).toMatchObject({ tool: "click", remote: "desktop-only", approvalPolicy: "once", fence: { surface: "portal-submit", origin: "Calculator", ruleOffer: null } });
    await instance.adapter.respondToRequest("t-desktop-card", opened.requestId!, { behavior: "deny" });
    expect((await pressed).result.isError).toBe(true);
    expect(cuaCalls()).not.toContain("click");
    await instance.adapter.interruptTurn("t-desktop-card");
  });

  it("refuses a turn that carries both an app window and a browser", async () => {
    const g = grant();
    await expect(send("t-desktop-both", { desktop: desktop(), browser: { runId: g.runId, allowedOrigins: [], capabilities: ["portal-read"], grant: g } }))
      .rejects.toThrow("This task cannot use an app window and a browser together. Start it again.");
    expect(instance.adapter.hasSession("t-desktop-both")).toBe(false);
  });

  it("the global Stop ends a running desktop task's driver session", async () => {
    const servers = await mounted(await send("t-desktop-release", { desktop: desktop() }));
    await rpc(servers[0], "tools/call", { name: "get_window_state", arguments: {} });
    await releaseDesktopBrokers(`ask-${GRANT_ID}`);
    expect(cuaCalls()).toContain("end_session");
    const after = await rpc(servers[0], "tools/call", { name: "get_window_state", arguments: {} }).catch(() => null);
    expect(after?.result?.isError ?? true).toBe(true);
    await instance.adapter.interruptTurn("t-desktop-release");
  });
});

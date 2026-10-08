// The consequential approval card as the ACP core shows it: the broker's
// verified facts and expiry reach the card, a card whose facts cannot be shown
// is never opened, and Stop ends a waiting approval so it can never be approved.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, EVENTS_DIR, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { approvalUrl, browserApprovalDraft, legacyBrowserGrant } from "../../browser-authority.ts";
import { EventBus } from "../../harness/bus.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { HermesAgentDriver } from "./hermes.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));
type Approve = (tool: string, params: Record<string, unknown>, summary: string, signal: AbortSignal, projection?: unknown) => Promise<boolean>;
const broker = vi.hoisted(() => ({ approve: null as Approve | null, close: vi.fn() }));
vi.mock("../../browser-broker.ts", () => ({
  BROWSER_SERVER: "workbrowser",
  startBrowserBroker: async (options: { approve: Approve }) => {
    broker.approve = options.approve;
    return { descriptor: { type: "http", name: "workbrowser", url: "http://127.0.0.1:9/mcp", headers: [{ name: "authorization", value: "Bearer fictional" }] },
      close: broker.close, cancelPending: broker.close, released: async () => {} };
  },
}));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
delete process.env.NODE_V8_COVERAGE;
const PAY_PAGE = 'Pay a levy\nPayee: Fictional Strata Pty Ltd\nAmount: AUD 1,240.00\nReference: LEVY-FICTIONAL-12\n@e1 button "Pay now"';
const ID = "00000000-0000-4000-8000-00000000000b";
function payParams(expiresAt = Date.now() + 120_000) {
  const draft = browserApprovalDraft("pay", { url: "https://portal.fictional-strata.example/levies", text: PAY_PAGE }, "@e1", 'button "Pay now"');
  return { url: draft.url, label: 'button "Pay now"', approval: { id: ID, kind: draft.kind, facts: draft.facts, expiresAt } };
}
const projection = { fence: { surface: "portal-submit", origin: "portal.fictional-strata.example", ruleOffer: null }, approvalPolicy: "once" };

describe("browser approval card in the ACP core", () => {
  let instance: ProviderInstance, recorder: EventRecorder, scratch: string;
  const thread = "t-browser-approval";
  const start = async () => {
    const dump = join(scratch, "dump.json"); process.env.FAKE_ACP_DUMP = dump; process.env.FAKE_ACP_MODE = "hang";
    instance = await HermesAgentDriver.create({ instanceId: "acp-approval", displayName: "ACP", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: thread, text: "Pay the fictional levy",
      integrations: { browser: { runId: "run-approval", allowedOrigins: ["portal.fictional-strata.example"], capabilities: ["portal-read"],
        grant: legacyBrowserGrant({ runId: "run-approval", allowedOrigins: ["portal.fictional-strata.example"], capabilities: ["portal-read"] }) } } });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
    return broker.approve!;
  };
  beforeEach(() => { assertCapability.mockReset(); broker.approve = null; broker.close.mockReset(); ensureDirs(); chmodSync(FAKE_CLI, 0o755); scratch = mkdtempSync(join(tmpdir(), "rb-acp-approval-")); });
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE; delete process.env.FAKE_ACP_DUMP; delete process.env.FAKE_ACP_UPDATES;
    recorder?.stop(); await instance?.dispose(); await removeFixture(scratch);
  });

  it("opens a once-only card that carries the verified facts, site, control and expiry", async () => {
    const approve = await start();
    const params = payParams();
    const decision = approve("browser_click_semantic", params, "Pay AUD 1240.00 to Fictional Strata Pty Ltd", new AbortController().signal, projection);
    const opened = await recorder.until(event => event.type === "request.opened") as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.approvalPolicy).toBe("once");
    expect(opened.browserApproval).toEqual({
      version: 1, purpose: "browser-approval-card", id: ID, kind: "pay", site: "portal.fictional-strata.example", page: "portal.fictional-strata.example/levies", control: "Pay now",
      facts: [
        { name: "recipient", value: "Fictional Strata Pty Ltd", confirmed: true },
        { name: "amount", value: "1240.00", confirmed: true },
        { name: "currency", value: "AUD", confirmed: true },
        { name: "reference", value: "LEVY-FICTIONAL-12", confirmed: true },
      ],
      expiresAt: params.approval.expiresAt,
    });
    await instance.adapter.respondToRequest(thread, opened.requestId!, { behavior: "allow", scope: "once" });
    await expect(decision).resolves.toBe(true);
  });

  it("never opens a consequential card whose facts cannot be shown", async () => {
    const approve = await start();
    const params = payParams();
    await expect(approve("browser_click_semantic", { ...params, approval: { ...params.approval, facts: [] } }, "Pay", new AbortController().signal, projection)).resolves.toBe(false);
    expect(recorder.events.some(event => event.type === "request.opened")).toBe(false);
  });

  it("shows a browser or sign-in call as a fixed label, logs its tool and argument keys only, and keeps the path on the card", async () => {
    const site = "https://portal.fictional-strata.example";
    const page = `${site}/tenants/jane.citizen@example.com/48213?token=fictional-token-1`;
    const values = ["portal.fictional-strata.example/tenants", "www.fictional-strata.example", "fictiönal", "jane.citizen", "48213",
      "?token=", "fictional-token-1", "LEVY-FICTIONAL-77", "Fictional rent ledger note", "fictional-lease-jane-smith.pdf", "/owners/"];
    const call = (toolCallId: string, title: string, input: Record<string, unknown>) => ({ sessionUpdate: "tool_call", toolCallId, title,
      rawInput: input, content: [{ type: "content", content: { type: "text", text: JSON.stringify(input, null, 2) } }] });
    process.env.FAKE_ACP_UPDATES = JSON.stringify([
      call("tc-nav", `mcp__workbrowser__browser_navigate: ${page}`, { tab_id: 1, url: page }),
      call("tc-nav-bare", "mcp__workbrowser__browser_navigate: portal.fictional-strata.example/tenants/48213?token=fictional-token-1",
        { tab_id: 1, url: "portal.fictional-strata.example/tenants/48213?token=fictional-token-1" }),
      call("tc-download", "mcp__workbrowser__browser_download", { tab_id: 1, ref: "@e3", target: "www.fictional-strata.example/owners/jane-smith" }),
      call("tc-sign-in", "mcp_sign_in_open_for_sign_in", { site: "https://fictiönal-strata.example/owners/48213",
        reason: "Sign in to read\nportal.fictional-strata.example/levies/LEVY-FICTIONAL-77 for jane.citizen@example.com" }),
      call("tc-fill", "mcp__workbrowser__browser_fill", { tab_id: 1, ref: "@e4", value: "Fictional rent ledger note for jane.citizen@example.com" }),
      call("tc-upload", "mcp__workbrowser__browser_upload", { tab_id: 1, ref: "@e5", file: "fictional-lease-jane-smith.pdf" }),
      call("tc-new", "mcp__workbrowser__browser_later_tool: 48213", { note: "jane.citizen@example.com" }),
      { sessionUpdate: "tool_call", toolCallId: "tc-other", title: "web search: https://fictional-other.example/a/b" },
    ]);
    const approve = await start();
    const decision = approve("browser_navigate", { url: approvalUrl(page) }, "Open a page", new AbortController().signal);
    const opened = await recorder.until(event => event.type === "request.opened") as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect((opened.params as { url?: string }).url).toBe(`${site}/tenants/jane.citizen@example.com/48213`);
    await recorder.until(event => event.type === "item.started" && event.itemId === "tc-other");
    const started = recorder.events.flatMap(event => event.type === "item.started" ? [event] : []);
    expect(started.map(event => event.title)).toEqual([
      "Opened a page", "Opened a page", "Downloaded a file", "Opened the sign-in page", "Filled a field", "Uploaded a file",
      "Used the work browser", "web search: https://fictional-other.example/a/b",
    ]);
    // The repeat watchdog still tells two pages apart, from the real arguments.
    expect(started[0].toolFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(started[0].toolFingerprint).not.toBe(started[1].toolFingerprint);
    await instance.adapter.respondToRequest(thread, opened.requestId!, { behavior: "deny" });
    await expect(decision).resolves.toBe(false);
    const bus = new EventBus();
    for (const event of recorder.events) bus.publish(event);
    const events = readFileSync(join(EVENTS_DIR, `${thread}.ndjson`), "utf8");
    const native = readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8");
    expect(events).not.toContain("toolFingerprint");
    for (const log of [events, native]) {
      expect(log).toContain("web search: https://fictional-other.example/a/b");
      for (const value of values) expect(log).not.toContain(value);
    }
    const calls = native.trim().split("\n").map(line => JSON.parse(line).msg?.params?.update).filter(update => update?.sessionUpdate === "tool_call");
    expect(calls).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "tc-nav", tool: "browser_navigate", argumentKeys: ["tab_id", "url"] },
      { sessionUpdate: "tool_call", toolCallId: "tc-nav-bare", tool: "browser_navigate", argumentKeys: ["tab_id", "url"] },
      { sessionUpdate: "tool_call", toolCallId: "tc-download", tool: "browser_download", argumentKeys: ["tab_id", "ref", "target"] },
      { sessionUpdate: "tool_call", toolCallId: "tc-sign-in", tool: "open_for_sign_in", argumentKeys: ["site", "reason"] },
      { sessionUpdate: "tool_call", toolCallId: "tc-fill", tool: "browser_fill", argumentKeys: ["tab_id", "ref", "value"] },
      { sessionUpdate: "tool_call", toolCallId: "tc-upload", tool: "browser_upload", argumentKeys: ["tab_id", "ref", "file"] },
      { sessionUpdate: "tool_call", toolCallId: "tc-new", tool: "browser_later_tool", argumentKeys: ["note"] },
      { sessionUpdate: "tool_call", toolCallId: "tc-other", title: "web search: https://fictional-other.example/a/b" },
    ]);
  });

  it("strips content and output from a page call's untitled updates (browser and desktop) in the native log", async () => {
    const IMAGE = "iVBORw0KGgoFICTIONALSCREENSHOT0123456789";
    const secret = ["Fictional Strata ledger row 48213", IMAGE, "jane.citizen@example.com", "fictional typed note"];
    const update = (toolCallId: string, status: string, extra: Record<string, unknown>) => ({ sessionUpdate: "tool_call_update", toolCallId, status, ...extra });
    process.env.FAKE_ACP_UPDATES = JSON.stringify([
      { sessionUpdate: "tool_call", toolCallId: "tc-read", title: "mcp__workbrowser__browser_read", rawInput: { tab_id: 1 } },
      { sessionUpdate: "tool_call", toolCallId: "tc-desk", title: "mcp__workdesktop__get_window_state", rawInput: { include_screenshot: true } },
      { sessionUpdate: "tool_call", toolCallId: "tc-plain", title: "terminal: ls" },
      update("tc-read", "in_progress", { content: [{ type: "content", content: { type: "text", text: secret[0] } }] }),
      update("tc-desk", "in_progress", { content: [{ type: "content", content: { type: "image", data: IMAGE, mimeType: "image/png" } }] }),
      update("tc-read", "completed", { rawOutput: { text: secret[2] } }),
      update("tc-desk", "completed", { rawOutput: { text: secret[3] }, content: [{ type: "content", content: { type: "image", data: IMAGE, mimeType: "image/png" } }] }),
      update("tc-plain", "completed", { rawOutput: { text: "fictional-plain-output" } }),
    ]);
    await start();
    await recorder.until(event => event.type === "item.completed" && event.itemId === "tc-plain");
    const native = readFileSync(join(NATIVE_DIR, `${thread}.ndjson`), "utf8");
    for (const value of secret) expect(native).not.toContain(value);
    expect(native).toContain("fictional-plain-output"); // other tools' output is unchanged
    const updates = native.trim().split("\n").map(line => JSON.parse(line).msg?.params?.update).filter(row => row?.sessionUpdate === "tool_call_update");
    expect(updates.filter(row => row.toolCallId !== "tc-plain")).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "tc-read", status: "in_progress", tool: "browser_read", argumentKeys: [] },
      { sessionUpdate: "tool_call_update", toolCallId: "tc-desk", status: "in_progress", tool: "get_window_state", argumentKeys: [] },
      { sessionUpdate: "tool_call_update", toolCallId: "tc-read", status: "completed", tool: "browser_read", argumentKeys: [] },
      { sessionUpdate: "tool_call_update", toolCallId: "tc-desk", status: "completed", tool: "get_window_state", argumentKeys: [] },
    ]);
  });

  it("Stop declines a waiting approval, closes browser work and leaves nothing to approve later", async () => {
    const approve = await start();
    const decision = approve("browser_click_semantic", payParams(), "Pay", new AbortController().signal, projection);
    const opened = await recorder.until(event => event.type === "request.opened");
    await instance.adapter.interruptTurn(thread);
    await expect(decision).resolves.toBe(false);
    expect(broker.close).toHaveBeenCalled();
    await expect(instance.adapter.respondToRequest(thread, opened.requestId!, { behavior: "allow", scope: "once" })).rejects.toThrow(/no such pending request/);
  });
});

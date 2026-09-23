// The consequential approval card as the ACP core shows it: the broker's
// verified facts and expiry reach the card, a card whose facts cannot be shown
// is never opened, and Stop ends a waiting approval so it can never be approved.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { browserApprovalDraft, legacyBrowserGrant } from "../../browser-authority.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { HermesAgentDriver } from "./hermes.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));
type Approve = (tool: string, params: Record<string, unknown>, summary: string, signal: AbortSignal, projection?: unknown) => Promise<boolean>;
const broker = vi.hoisted(() => ({ approve: null as Approve | null, close: vi.fn() }));
vi.mock("../../browser-broker.ts", () => ({
  startBrowserBroker: async (options: { approve: Approve }) => {
    broker.approve = options.approve;
    return { descriptor: { type: "http", name: "browser", url: "http://127.0.0.1:9/mcp", headers: [{ name: "authorization", value: "Bearer fictional" }] },
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
    await instance.adapter.sendTurn({ threadId: thread, text: "Pay the fictional levy", computer: true,
      integrations: { browser: { runId: "run-approval", allowedOrigins: ["portal.fictional-strata.example"], capabilities: ["portal-read"],
        grant: legacyBrowserGrant({ runId: "run-approval", allowedOrigins: ["portal.fictional-strata.example"], capabilities: ["portal-read"] }) } } });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
    return broker.approve!;
  };
  beforeEach(() => { assertCapability.mockReset(); broker.approve = null; broker.close.mockReset(); ensureDirs(); chmodSync(FAKE_CLI, 0o755); scratch = mkdtempSync(join(tmpdir(), "rb-acp-approval-")); });
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE; delete process.env.FAKE_ACP_DUMP;
    recorder?.stop(); await instance?.dispose(); await removeFixture(scratch);
  });

  it("opens a once-only card that carries the verified facts, site, control and expiry", async () => {
    const approve = await start();
    const params = payParams();
    const decision = approve("browser_click_semantic", params, "Pay AUD 1240.00 to Fictional Strata Pty Ltd", new AbortController().signal, projection);
    const opened = await recorder.until(event => event.type === "request.opened") as Extract<RuntimeEvent, { type: "request.opened" }>;
    expect(opened.approvalPolicy).toBe("once");
    expect(opened.browserApproval).toEqual({
      version: 1, purpose: "browser-approval-card", id: ID, kind: "pay", site: "portal.fictional-strata.example", control: "Pay now",
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

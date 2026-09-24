// An Ask task's grant reaches the browser the ACP core mounts: the worker is
// offered exactly that grant's tools, a grant that stops holding (Stop, time
// or step limit) refuses the next step at once, and a grant started for one
// browser never mounts after the selected browser changed.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { grantedBrowserTools } from "../../attended-run.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { parseBrowserTaskGrant, type BrowserTaskGrant } from "../../../shared/browser-task.ts";
import { HermesAgentDriver } from "./hermes.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
delete process.env.NODE_V8_COVERAGE;
const SITE = "portal.fictional-strata.example";
const grantFor = (browserId: string | null): BrowserTaskGrant => parseBrowserTaskGrant({
  version: 1, purpose: "browser-task-grant", id: "00000000-0000-4000-8000-0000000000a5", runId: "ask-00000000-0000-4000-8000-0000000000a5", route: "ask",
  request: { text: "Submit this maintenance request on portal.fictional-strata.example", sha256: "c".repeat(64) },
  sites: [SITE], browser: { id: browserId, accountMarker: null }, actions: ["read", "navigate", "fill", "click", "submit"],
  consequential: "ask-each", uploads: [], expiresAt: Date.now() + 30 * 60_000, budget: 40,
});

describe("an Ask task grant in the ACP core", () => {
  let instance: ProviderInstance, recorder: EventRecorder, scratch: string;
  beforeEach(() => { assertCapability.mockReset(); ensureDirs(); chmodSync(FAKE_CLI, 0o755); scratch = mkdtempSync(join(tmpdir(), "rb-acp-grant-")); });
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE; delete process.env.FAKE_ACP_DUMP;
    recorder?.stop(); await instance?.dispose(); await removeFixture(scratch);
  });
  const send = async (thread: string, browser: NonNullable<NonNullable<SendTurnInput["integrations"]>["browser"]>) => {
    const dump = join(scratch, `${thread}.json`); process.env.FAKE_ACP_DUMP = dump; process.env.FAKE_ACP_MODE = "hang";
    instance = await HermesAgentDriver.create({ instanceId: "acp-grant", displayName: "ACP", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: thread, text: "Start this task", computer: true, integrations: { browser } });
    return dump;
  };
  let requestId = 0;
  const rpc = async (descriptor: { url: string; headers: Array<{ name: string; value: string }> }, method: string, params: Record<string, unknown>) =>
    (await (await fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map(row => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }) })).json()) as { result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } };

  it("offers exactly the grant's tools and refuses the next step once the grant stops holding", async () => {
    const grant = grantFor(null);
    let holding = true;
    const dump = await send("t-ask-grant", { runId: grant.runId, allowedOrigins: [SITE], capabilities: ["portal-read", "portal-prefill", "portal-submit"], grant, active: () => holding });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8")).promptCount).toBe(1));
    const descriptor = JSON.parse(readFileSync(dump, "utf8")).mcpServers[0];
    expect(descriptor.name).toBe("browser");
    const listing = await rpc(descriptor, "tools/list", {});
    expect(listing.result.tools!.map(tool => tool.name)).toEqual(grantedBrowserTools(grant, true));
    holding = false;
    const refused = await rpc(descriptor, "tools/call", { name: "browser_tabs", arguments: {} });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content?.[0]?.text).toMatch(/browser request stopped/i);
    await instance.adapter.interruptTurn("t-ask-grant");
  });

  it("never mounts a browser without an explicit grant", async () => {
    const dump = await send("t-no-grant", { runId: "run-fictional-no-grant", allowedOrigins: [SITE], capabilities: ["portal-read"] });
    const error = await recorder.until(event => event.type === "runtime.error");
    expect(error).toMatchObject({ message: "This browser work has no saved permission, so nothing was opened. Start it again." });
    let prompted = 0;
    try { prompted = JSON.parse(readFileSync(dump, "utf8")).promptCount ?? 0; } catch { /* never reached the worker */ }
    expect(prompted).toBe(0);
  });

  it("never mounts a grant for a browser other than the one selected now", async () => {
    const grant = grantFor("fictional-other-browser");
    const dump = await send("t-ask-grant-browser", { runId: grant.runId, allowedOrigins: [SITE], capabilities: ["portal-read"], grant, active: () => true });
    const error = await recorder.until(event => event.type === "runtime.error");
    expect(error).toMatchObject({ message: "The selected browser changed after this task was started. Start the task again from Ask." });
    let prompted = 0;
    try { prompted = JSON.parse(readFileSync(dump, "utf8")).promptCount ?? 0; } catch { /* never reached the worker */ }
    expect(prompted).toBe(0);
  });
});

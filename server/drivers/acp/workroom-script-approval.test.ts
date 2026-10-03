// A reviewed document script on workroom files is answered allow-once with no
// card; any other terminal command still opens the per-instance card.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { seedVault } from "../../vault.ts";
import { HermesAgentDriver } from "./hermes.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
delete process.env.NODE_V8_COVERAGE;

describe("workroom document scripts in the ACP core", () => {
  let instance: ProviderInstance, recorder: EventRecorder, scratch: string, runtimeHome: string, script: string;
  beforeEach(() => {
    assertCapability.mockReset(); ensureDirs(); chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "rb-acp-workroom-"));
    runtimeHome = join(scratch, "fictional-runtime");
    const venvBin = join(runtimeHome, "hermes-agent", "venv", "bin");
    const scripts = join(runtimeHome, "hermes-agent", "skills", "productivity", "xlsx", "scripts");
    mkdirSync(venvBin, { recursive: true }); mkdirSync(scripts, { recursive: true });
    writeFileSync(join(venvBin, "hermes"), ""); writeFileSync(join(venvBin, "python3"), "");
    script = join(scripts, "xlsx_create.py"); writeFileSync(script, "");
  });
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE; delete process.env.FAKE_ACP_DUMP; delete process.env.FAKE_ACP_TOOL; delete process.env.FAKE_ACP_TOOL_INPUT;
    recorder?.stop(); await instance?.dispose(); await removeFixture(scratch);
  });
  const run = async (thread: string, command: string) => {
    const dump = join(scratch, `${thread}.json`);
    process.env.FAKE_ACP_DUMP = dump; process.env.FAKE_ACP_MODE = "permission"; process.env.FAKE_ACP_TOOL = "execute";
    process.env.FAKE_ACP_TOOL_INPUT = JSON.stringify({ command, description: "Run terminal command" });
    instance = await HermesAgentDriver.create({ instanceId: "acp-workroom", displayName: "ACP", environment: { REALBUD_HERMES_HOME: runtimeHome },
      enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: thread, text: "Make the fictional spreadsheet" });
    return dump;
  };

  // Auto-approval is switched off (WORKROOM_AUTO_APPROVE) until the worker has no
  // outbound network and the 2 Oct review fixes land: even a policy match asks.
  it("still raises a card for a reviewed script while auto-approval is off", async () => {
    const output = join(seedVault(), "fictional-report.xlsx");
    await run("t-auto", `python3 ${script} --output ${output}`);
    const opened = await recorder.until(event => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission" });
    await instance.adapter.respondToRequest("t-auto", opened.requestId!, { behavior: "deny" });
    await recorder.until(event => event.type === "turn.completed");
  });

  it("still raises a card for a command outside the policy", async () => {
    await run("t-ask", `python3 ${script} --output /tmp/fictional-report.xlsx`);
    const opened = await recorder.until(event => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission" });
    await instance.adapter.respondToRequest("t-ask", opened.requestId!, { behavior: "deny" });
    await recorder.until(event => event.type === "turn.completed");
  });
});

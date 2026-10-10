// An Ask turn's timing rides on its usage to the one operational log line
// (server/oplog.ts `oplogAskTurn`): tool names, never titles with values, and
// a stopped turn still settles with its timing. Run against the fake ACP CLI.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { askTurnOutcome } from "../../oplog.ts";
import { turnToolName } from "./core.ts";
import { HermesAgentDriver } from "./hermes.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
delete process.env.NODE_V8_COVERAGE;
const ENV_KEYS = ["FAKE_ACP_MODE", "FAKE_ACP_DUMP", "FAKE_ACP_UPDATES"];

describe("a tool call's name for the timing line", () => {
  it("keeps the bare name before Hermes' `name: arguments` separator, and nothing else", () => {
    expect(turnToolName("mcp__workbrowser__browser_read")).toBe("mcp__workbrowser__browser_read");
    expect(turnToolName("terminal: cat /synthetic/tenant-ledger.csv")).toBe("terminal");
    expect(turnToolName("terminal:rm -rf /synthetic")).toBe("terminal");
    expect(turnToolName("read: /synthetic/notes.txt")).toBe("read");
    // Free-text titles and anything past the name are dropped, not trimmed into a name.
    for (const title of ["web search: fictional tenant", "Run command", "echo hi", "/synthetic/notes.txt", "x".repeat(65), "", undefined, 7]) {
      expect(turnToolName(title)).toBeNull();
    }
  });
});

describe("Ask turn timing (fake CLI)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;

  beforeEach(() => {
    assertCapability.mockReset();
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-timing-"));
    process.env.FAKE_ACP_DUMP = join(scratch, "dump.json");
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeFixture(scratch);
  });

  it("settles a stopped turn once, with its timing and no answer time", async () => {
    process.env.FAKE_ACP_MODE = "hang";
    process.env.FAKE_ACP_UPDATES = JSON.stringify([
      { sessionUpdate: "tool_call", toolCallId: "tc-shell", title: "terminal: cat /synthetic/tenant-ledger.csv", rawInput: { command: "cat /synthetic/tenant-ledger.csv" } },
    ]);
    instance = await HermesAgentDriver.create({ instanceId: "timing-test", displayName: "Timing Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "timing-stop", text: "a long fictional request" });
    await recorder.until(event => event.type === "item.started" && event.turnId === turnId);
    await instance.adapter.interruptTurn("timing-stop");
    const done = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId) as Extract<RuntimeEvent, { type: "turn.completed" }>;

    expect(askTurnOutcome({ ok: done.ok, stopReason: done.stopReason })).toBe("stopped");
    const timing = done.usage!.timing!;
    expect(timing).toMatchObject({ warm: false, firstTextMs: null, toolCalls: 1, tools: ["terminal"], modelCalls: 0, upstreamErrors: 0 });
    expect(timing.readyMs).toBeGreaterThan(0);
    expect(JSON.stringify(timing)).not.toContain("synthetic");
    expect(recorder.events.filter(event => event.type === "turn.completed")).toHaveLength(1);
  });
});

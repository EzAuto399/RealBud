// Product Ask stops a turn at a hard call/time ceiling. Shortly before it,
// the ACP driver asks Hermes once (through Hermes ACP's own `/steer`) to
// answer with what it has. Run against the scripted fake ACP CLI.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { removeFixture } from "../../testing/private-fixture.ts";
import { PRODUCT_TURN_DEFAULTS, productTurnWrapUp } from "../../product-mode.ts";
import { HERMES_WRAP_UP_NOTE } from "./core.ts";
import { FakeAcpDriver } from "../../testing/fake-acp-driver.ts";
import { HermesAgentDriver } from "./hermes.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("../../managed-service.ts", () => ({ managedService: { assertCapability } }));

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
delete process.env.NODE_V8_COVERAGE;

const ENV_KEYS = ["FAKE_ACP_MODE", "FAKE_ACP_DUMP", "FAKE_ACP_TOOL_CALLS", "FAKE_ACP_WRAP_WAIT_MS", "OMB_PRODUCT_TURN_MAX_TOOLS", "OMB_PRODUCT_TURN_MAX_MS"];

describe("product turn wrap-up point", () => {
  it("sits at three quarters of the unchanged hard ceilings", () => {
    expect(PRODUCT_TURN_DEFAULTS).toEqual({ maxMs: 15 * 60_000, maxTools: 96, maxRepeatedTool: 5 });
    expect(productTurnWrapUp({})).toEqual({ afterTools: 72, afterMs: 675_000 });
    expect(productTurnWrapUp({ OMB_PRODUCT_TURN_MAX_TOOLS: "4", OMB_PRODUCT_TURN_MAX_MS: "400" })).toEqual({ afterTools: 3, afterMs: 300 });
    expect(productTurnWrapUp({ OMB_PRODUCT_TURN_MAX_TOOLS: "-1", OMB_PRODUCT_TURN_MAX_MS: "soon" })).toEqual({ afterTools: 72, afterMs: 675_000 });
  });
});

describe("ACP wrap-up note (fake CLI)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let scratch: string;
  let dump: string;

  const create = async (driver: typeof HermesAgentDriver | typeof FakeAcpDriver, mode: string) => {
    process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({ instanceId: "wrap-test", displayName: "Wrap Test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  };
  const seen = () => JSON.parse(readFileSync(dump, "utf8")) as { pid: number; promptCount: number; steers?: string[] };
  const finalText = (turnId: string) =>
    recorder!.events.find(e => e.type === "item.completed" && (e as any).itemType === "assistant_text" && e.turnId === turnId) as any;
  const streamed = () => recorder!.events.filter(e => e.type === "content.delta").map(e => (e as any).delta as string).join("");

  beforeEach(() => {
    assertCapability.mockReset();
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-wrap-"));
    dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
    await removeFixture(scratch);
  });

  it("asks Hermes once to wrap up at three quarters of the call budget, hides the steer status, and retires the process", async () => {
    process.env.OMB_PRODUCT_TURN_MAX_TOOLS = "4";
    process.env.FAKE_ACP_TOOL_CALLS = "6";
    await create(HermesAgentDriver, "wrap-up");
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "wrap-tools", text: "long research" });
    const done = await recorder!.until(e => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: true, stopReason: null });
    const first = seen();
    expect(first.steers).toEqual([HERMES_WRAP_UP_NOTE]);
    expect(first.promptCount).toBe(1);
    expect(finalText(turnId).text).toBe("partial answer from fake acp");
    expect(streamed()).not.toContain("Steer");
    expect(recorder!.events.some(e => e.type === "runtime.error")).toBe(false);

    // A steered process may still hold a late steer; the next turn starts fresh.
    process.env.FAKE_ACP_TOOL_CALLS = "0";
    process.env.FAKE_ACP_WRAP_WAIT_MS = "50";
    const next = await instance!.adapter.sendTurn({ threadId: "wrap-tools", text: "next" });
    await recorder!.until(e => e.type === "turn.completed" && e.turnId === next.turnId);
    expect(seen().pid).not.toBe(first.pid);
  });

  it("asks Hermes to wrap up at three quarters of the time budget", async () => {
    process.env.OMB_PRODUCT_TURN_MAX_MS = "400";
    process.env.FAKE_ACP_TOOL_CALLS = "0";
    process.env.FAKE_ACP_WRAP_WAIT_MS = "5000";
    await create(HermesAgentDriver, "wrap-up");
    const started = Date.now();
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "wrap-time", text: "long research" });
    await recorder!.until(e => e.type === "turn.completed" && e.turnId === turnId);

    expect(Date.now() - started).toBeLessThan(4000);
    expect(seen().steers).toEqual([HERMES_WRAP_UP_NOTE]);
    expect(finalText(turnId).text).toBe("partial answer from fake acp");
  });

  it("continues the turn when Hermes refuses the note and records only a category", async () => {
    process.env.OMB_PRODUCT_TURN_MAX_TOOLS = "4";
    process.env.FAKE_ACP_TOOL_CALLS = "3";
    await create(HermesAgentDriver, "wrap-up-refuse");
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "wrap-refused", text: "long research" });
    const done = await recorder!.until(e => e.type === "turn.completed" && e.turnId === turnId);

    expect(done).toMatchObject({ ok: true });
    expect(seen().steers).toHaveLength(1);
    expect(finalText(turnId).text).toBe("partial answer from fake acp");
    expect(recorder!.events.some(e => e.type === "runtime.error")).toBe(false);
    const native = readFileSync(join(NATIVE_DIR, "wrap-refused.ndjson"), "utf8");
    expect(native).toContain('"wrapUpNote":"not-delivered"');
    expect(native).toContain('"reason":"rejected"');
  });

  it("sends no note below the threshold and keeps the warm process", async () => {
    process.env.FAKE_ACP_TOOL_CALLS = "3";
    process.env.FAKE_ACP_WRAP_WAIT_MS = "50";
    await create(HermesAgentDriver, "wrap-up");
    const first = await instance!.adapter.sendTurn({ threadId: "wrap-below", text: "short" });
    await recorder!.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
    const pid = seen().pid;
    const second = await instance!.adapter.sendTurn({ threadId: "wrap-below", text: "again" });
    await recorder!.until(e => e.type === "turn.completed" && e.turnId === second.turnId);

    expect(seen()).toMatchObject({ pid, promptCount: 2, steers: [] });
  });

  it("never steers a non-Hermes ACP driver", async () => {
    process.env.OMB_PRODUCT_TURN_MAX_TOOLS = "4";
    process.env.OMB_PRODUCT_TURN_MAX_MS = "100";
    process.env.FAKE_ACP_TOOL_CALLS = "6";
    process.env.FAKE_ACP_WRAP_WAIT_MS = "300";
    await create(FakeAcpDriver, "wrap-up");
    const { turnId } = await instance!.adapter.sendTurn({ threadId: "wrap-other", text: "long research" });
    await recorder!.until(e => e.type === "turn.completed" && e.turnId === turnId);

    expect(seen().steers).toEqual([]);
    expect(finalText(turnId).text).toBe("finished without a wrap-up note");
  });
});

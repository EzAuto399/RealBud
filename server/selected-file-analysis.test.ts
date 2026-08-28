import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderAdapter, RuntimeEvent, RuntimeEventListener, SendTurnInput } from "./contracts.ts";
import {
  createExecutionAdapterBinding,
  defineExecutionAdapterManifest,
  type ExecutionAdapterAttestation,
} from "./execution-adapters.ts";
import { applyPropertyPack, propertyProfileDir, withYamlBlock } from "./hermes-pack.ts";
import {
  parseSelectedFileAnalysisOutput,
  reconcileBrokeredSelectedFileAnalysis,
  runBrokeredSelectedFileAnalysis,
  SELECTED_FILE_ANALYSIS_KIND,
  type SelectedFileAnalysisOutput,
} from "./selected-file-analysis.ts";
import type { SelectedFileWorkspace } from "./selected-file-workspace.ts";
import { WorkBroker, workDigest } from "./work-broker.ts";
import { WorkOutputStore } from "./work-output-store.ts";

const SELECTED_FILE_TEST_MANIFEST = defineExecutionAdapterManifest({
  kind: "realbud.execution-adapter.v1",
  schemaVersion: 1,
  id: "test-selected-file-analysis",
  version: 1,
  label: "Test selected-file analysis",
  method: "Isolated test adapter",
  transport: "isolated-task",
  route: "local-analysis",
  operations: ["analyse-selected-files"],
  effect: "read-only",
  requiresNamedAccount: false,
  requiresExplicitOptIn: false,
  runtimeAvailable: true,
  maxConcurrency: 1,
});

type FakeMode = "success" | "invalid" | "cancel" | "tool" | "start-fail" | "manual";

class FakeAdapter implements ProviderAdapter {
  readonly provider = "fake-selected-file";
  readonly capabilities = { sessionModelSwitch: "unsupported" as const };
  readonly inputs: SendTurnInput[] = [];
  interrupted = 0;
  private readonly listeners = new Set<RuntimeEventListener>();
  private pending: { threadId: string; turnId: string } | null = null;

  constructor(
    private readonly mode: FakeMode,
    private readonly output: SelectedFileAnalysisOutput,
  ) {}

  onEvent(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private event(
    threadId: string,
    turnId: string,
    event: Record<string, unknown> & { type: RuntimeEvent["type"] },
  ): RuntimeEvent {
    return {
      ...event,
      eventId: `event-${Math.random()}`,
      provider: this.provider,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    } as RuntimeEvent;
  }

  private complete(threadId: string, turnId: string): void {
    if (this.mode === "tool") {
      this.emit(this.event(threadId, turnId, { type: "item.started", itemType: "tool", title: "shell" }));
      return;
    }
    if (this.mode === "cancel") {
      this.emit(this.event(threadId, turnId, { type: "turn.completed", ok: false, stopReason: "cancelled" }));
      return;
    }
    this.emit(this.event(threadId, turnId, {
      type: "item.completed",
      itemType: "assistant_text",
      text: this.mode === "invalid" ? "not a closed JSON result" : JSON.stringify(this.output),
    }));
    this.emit(this.event(threadId, turnId, { type: "turn.completed", ok: true }));
  }

  async sendTurn(input: SendTurnInput): Promise<{ turnId: string }> {
    this.inputs.push(structuredClone(input));
    if (this.mode === "start-fail") throw new Error("fake start failure");
    const turnId = `turn-${this.inputs.length}`;
    if (this.mode === "manual") this.pending = { threadId: input.threadId, turnId };
    else queueMicrotask(() => this.complete(input.threadId, turnId));
    return { turnId };
  }

  completeManual(): void {
    if (!this.pending) throw new Error("no manual turn");
    const pending = this.pending;
    this.pending = null;
    this.emit(this.event(pending.threadId, pending.turnId, {
      type: "item.completed",
      itemType: "assistant_text",
      text: JSON.stringify(this.output),
    }));
    this.emit(this.event(pending.threadId, pending.turnId, { type: "turn.completed", ok: true }));
  }

  async interruptTurn(): Promise<void> { this.interrupted += 1; }
  async respondToRequest(): Promise<void> {}
  hasSession(): boolean { return false; }
  async stopAll(): Promise<void> {}
}

describe("brokered selected-file analysis", () => {
  let root: string;
  let workerHome: string;
  let brokerFile: string;
  let outputStore: WorkOutputStore;
  let now: number;
  let workspaceCounter: number;
  let receiptCounter: number;

  const output: SelectedFileAnalysisOutput = {
    kind: SELECTED_FILE_ANALYSIS_KIND,
    schemaVersion: 1,
    summary: "One complete property record was verified.",
    properties: [{
      address: "12 Oak St, Dickson ACT",
      tenantName: "Sam Nguyen",
      tenantPhone: "0400 111 222",
      weeklyRentCents: 62_000,
    }],
    needsAttention: ["The statement date needs a human check."],
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "realbud-selected-analysis-"));
    workerHome = join(root, "worker");
    brokerFile = join(root, "work-broker.json");
    now = 1_800_000_000_000;
    workspaceCounter = 0;
    receiptCounter = 0;
    applyPropertyPack(workerHome);
    const configPath = join(propertyProfileDir(workerHome), "config.yaml");
    writeFileSync(configPath, withYamlBlock(
      readFileSync(configPath, "utf8"),
      "model",
      "model:\n  default: test-model\n  provider: deepseek\n  base_url: ''\n",
    ));
    mkdirSync(join(workerHome, "sessions"));
    writeFileSync(join(workerHome, "sessions", "private.json"), "must not cross");
    writeFileSync(join(workerHome, "memory.md"), "must not cross");
    outputStore = new WorkOutputStore({ dir: root, key: randomBytes(32), now: () => now });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function broker(): WorkBroker {
    return new WorkBroker({
      file: brokerFile,
      now: () => now,
      idFactory: () => `selected-file-receipt-${++receiptCounter}`,
    });
  }

  function workspace(content = "same selected file content"): SelectedFileWorkspace {
    const directory = join(root, `workspace-${++workspaceCounter}`);
    mkdirSync(directory);
    const path = join(directory, "properties.txt");
    writeFileSync(path, content);
    return {
      directory,
      attachments: [{
        path,
        name: "properties.txt",
        size: Buffer.byteLength(content),
        mimeType: "text/plain",
      }],
      inputDigests: [workDigest(content)],
      cleanup: async () => { rmSync(directory, { recursive: true, force: true }); },
    };
  }

  const request = (overrides: Record<string, unknown> = {}) => ({
    requestId: "ask_selected_12345678",
    requestDigest: workDigest("ask request"),
    bookRevision: 7,
    instruction: "Extract only complete property records.",
    threadId: "thread-selected-file",
    model: "test-model",
    workerHome,
    now: () => now,
    adapterBinding: createExecutionAdapterBinding({
      manifest: SELECTED_FILE_TEST_MANIFEST,
      attestation: {
        kind: "realbud.execution-adapter-attestation.v1",
        schemaVersion: 1,
        adapterId: SELECTED_FILE_TEST_MANIFEST.id,
        adapterVersion: SELECTED_FILE_TEST_MANIFEST.version,
        configurationGeneration: 1,
        state: "ready",
        observedAt: now,
        expiresAt: now + 15 * 60_000,
        policyDigest: workDigest("test-selected-file-policy"),
      } satisfies ExecutionAdapterAttestation,
      operation: "analyse-selected-files",
      now,
    }),
    ...overrides,
  });

  it("strictly decodes only the versioned exact output envelope", () => {
    expect(parseSelectedFileAnalysisOutput(JSON.stringify(output))).toEqual(output);
    expect(parseSelectedFileAnalysisOutput(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``)).toEqual(output);
    expect(parseSelectedFileAnalysisOutput(JSON.stringify({ ...output, send: true }))).toBeNull();
    expect(parseSelectedFileAnalysisOutput(JSON.stringify({ ...output, schemaVersion: 2 }))).toBeNull();
    expect(parseSelectedFileAnalysisOutput(JSON.stringify({
      ...output,
      properties: [{ ...output.properties[0], weeklyRentCents: -1 }],
    }))).toBeNull();
    expect(parseSelectedFileAnalysisOutput("ordinary prose")).toBeNull();
  });

  it("rejects forged workspace paths before admission or provider dispatch", async () => {
    const workBroker = broker();
    const selected = workspace();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "same selected file content");
    selected.attachments[0] = { ...selected.attachments[0]!, path: outside };
    const adapter = new FakeAdapter("success", output);
    await expect(runBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      adapter,
      workspace: selected,
      ...request(),
    })).rejects.toMatchObject({ code: "selected-file-workspace-unavailable" });
    expect(workBroker.list()).toEqual([]);
    expect(adapter.inputs).toEqual([]);
  });

  it("rejects a same-size staged-file mutation before admission or provider dispatch", async () => {
    const workBroker = broker();
    const selected = workspace("abcde");
    writeFileSync(selected.attachments[0]!.path, "vwxyz");
    const adapter = new FakeAdapter("success", output);
    await expect(runBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      adapter,
      workspace: selected,
      ...request(),
    })).rejects.toMatchObject({ code: "selected-file-workspace-unavailable" });
    expect(workBroker.list()).toEqual([]);
    expect(adapter.inputs).toEqual([]);
  });

  it("runs one deny-all stateless context, encrypts its result, then reconciles explicitly", async () => {
    const workBroker = broker();
    const selected = workspace();
    const adapter = new FakeAdapter("success", output);
    const result = await runBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      adapter,
      workspace: selected,
      ...request(),
    });

    expect(result).toMatchObject({
      replayedOutput: false,
      output,
      receipt: {
        state: "evidence-ready",
        attempts: 1,
        plan: {
          authorityKind: "user-request",
          dataClasses: ["selected-files"],
          routes: [{ route: "local-analysis", adapter: { adapterId: "test-selected-file-analysis" } }],
        },
      },
    });
    expect(adapter.inputs).toHaveLength(1);
    const sent = adapter.inputs[0]!;
    expect(sent.transcript).toEqual([]);
    expect(sent.integrations).toEqual({});
    expect(sent.resumeCursor).toBeUndefined();
    expect(sent.cwd).toBe(selected.directory);
    expect(sent.executionPolicy).toMatchObject({
      permissionMode: "deny-all",
      maxDurationMs: 240_000,
      maxOutputChars: 40_000,
    });
    expect(sent.executionPolicy?.isolatedProfileHome?.startsWith(selected.directory)).toBe(true);
    expect(sent.system).toContain("no memory, channels, schedule, browser, terminal or action authority");
    expect(sent.text).toContain(SELECTED_FILE_ANALYSIS_KIND);
    expect(readFileSync(join(propertyProfileDir(sent.executionPolicy!.isolatedProfileHome!), "config.yaml"), "utf8")).toContain("default: test-model");
    expect(readdirSync(sent.executionPolicy!.isolatedProfileHome!)).not.toContain("sessions");
    expect(readdirSync(sent.executionPolicy!.isolatedProfileHome!)).not.toContain("memory.md");

    const stored = outputStore.read<SelectedFileAnalysisOutput>(result.receipt);
    expect(stored?.payload).toEqual(output);
    expect(readFileSync(brokerFile, "utf8")).not.toContain("Sam Nguyen");
    const encrypted = readFileSync(join(outputStore.directory, readdirSync(outputStore.directory)[0]!), "utf8");
    expect(encrypted).not.toContain("Sam Nguyen");
    expect(reconcileBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      receiptId: result.receipt.id,
    }).state).toBe("reconciled");
  });

  it("fails closed on malformed output and any attempted tool use", async () => {
    const malformedBroker = broker();
    await expect(runBrokeredSelectedFileAnalysis({
      broker: malformedBroker,
      outputStore,
      adapter: new FakeAdapter("invalid", output),
      workspace: workspace("invalid-output-input"),
      ...request({ requestId: "ask_invalid_12345678", requestDigest: workDigest("invalid ask") }),
    })).rejects.toMatchObject({ code: "selected-file-output-invalid" });
    expect(malformedBroker.getByRequestId("analysis-ask_invalid_12345678")).toMatchObject({ state: "failed" });

    const toolAdapter = new FakeAdapter("tool", output);
    await expect(runBrokeredSelectedFileAnalysis({
      broker: malformedBroker,
      outputStore,
      adapter: toolAdapter,
      workspace: workspace("tool-input"),
      ...request({ requestId: "ask_tool_12345678", requestDigest: workDigest("tool ask") }),
    })).rejects.toMatchObject({ code: "selected-file-policy-violation" });
    expect(toolAdapter.interrupted).toBe(1);
    expect(malformedBroker.getByRequestId("analysis-ask_tool_12345678")).toMatchObject({ state: "failed" });
  });

  it("queues a bounded retry after a transient start failure and succeeds from a fresh workspace", async () => {
    const workBroker = broker();
    await expect(runBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      adapter: new FakeAdapter("start-fail", output),
      workspace: workspace(),
      ...request(),
    })).rejects.toMatchObject({ code: "selected-file-worker-start-failed" });
    expect(workBroker.getByRequestId("analysis-ask_selected_12345678")).toMatchObject({ state: "queued", attempts: 1 });

    const retry = await runBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      adapter: new FakeAdapter("success", output),
      workspace: workspace(),
      ...request(),
    });
    expect(retry.receipt).toMatchObject({ state: "evidence-ready", attempts: 2 });
  });

  it("records cancellation and refuses late work", async () => {
    const workBroker = broker();
    await expect(runBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      adapter: new FakeAdapter("cancel", output),
      workspace: workspace(),
      ...request(),
    })).rejects.toMatchObject({ code: "work-cancelled" });
    expect(workBroker.getByRequestId("analysis-ask_selected_12345678")).toMatchObject({ state: "cancelled" });
  });

  it("recovers an authenticated output after a crash before broker completion without another model turn", async () => {
    const firstBroker = broker();
    const selected = workspace();
    const adapter = new FakeAdapter("success", output);
    const first = await runBrokeredSelectedFileAnalysis({
      broker: firstBroker,
      outputStore,
      adapter,
      workspace: selected,
      ...request(),
    });
    expect(adapter.inputs).toHaveLength(1);

    const durable = JSON.parse(readFileSync(brokerFile, "utf8")) as { receipts: Array<Record<string, unknown>> };
    const receipt = durable.receipts.find((item) => item.id === first.receipt.id)!;
    receipt.state = "running";
    receipt.leaseOwnerDigest = workDigest("abandoned-runner");
    receipt.leaseExpiresAt = now + 60_000;
    delete receipt.outputDigest;
    writeFileSync(brokerFile, JSON.stringify(durable, null, 2));

    const reopened = broker();
    expect(reopened.get(first.receipt.id)).toMatchObject({ state: "queued", attempts: 1 });
    const recovered = await runBrokeredSelectedFileAnalysis({
      broker: reopened,
      outputStore,
      adapter,
      workspace: selected,
      ...request(),
    });
    expect(recovered).toMatchObject({ replayedOutput: true, output, receipt: { state: "evidence-ready", attempts: 2 } });
    expect(adapter.inputs).toHaveLength(1);
  });

  it("serializes two selected-file contexts against the one worker lane", async () => {
    const workBroker = broker();
    const manual = new FakeAdapter("manual", output);
    const first = runBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      adapter: manual,
      workspace: workspace("first"),
      ...request({ requestId: "ask_first_12345678", requestDigest: workDigest("first ask") }),
    });
    for (let attempt = 0; attempt < 20 && manual.inputs.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(manual.inputs).toHaveLength(1);

    await expect(runBrokeredSelectedFileAnalysis({
      broker: workBroker,
      outputStore,
      adapter: manual,
      workspace: workspace("second"),
      ...request({ requestId: "ask_second_12345678", requestDigest: workDigest("second ask") }),
    })).rejects.toMatchObject({ code: "work-busy" });
    expect(workBroker.getByRequestId("analysis-ask_second_12345678")).toMatchObject({ state: "queued", attempts: 0 });

    manual.completeManual();
    await expect(first).resolves.toMatchObject({ receipt: { state: "evidence-ready" } });
  });
});

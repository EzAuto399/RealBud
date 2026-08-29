// RealBud server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

import { approvalKey, autoDecision } from "./auto-approve.ts";
import { currentAskCapabilityContext } from "./ask-capabilities.ts";
import { budSystemPrompt } from "./bud-prompt.ts";
import * as box from "./box.ts";
import * as composio from "./composio.ts";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import {
  containerComputerAction,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  setupCommands,
  type LifecycleAction,
} from "./container-computer.ts";
import {
  assertSourceDataDirKeyBoundary,
  configRecoveryStatus,
  ensureDirs,
  instanceConfigs,
  loadConfig,
  saveConfig,
  DATA_DIR,
  EVENTS_DIR,
  NATIVE_DIR,
} from "./config.ts";
import { acquireDataDirLock } from "./data-dir-lock.ts";
import { resetPathCache } from "./env-path.ts";
import type { RuntimeEvent, TurnAttachment } from "./contracts.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { mentionedBots, roomResponders, Store, type GroupDefaultResponder, type Message } from "./store.ts";
import * as tts from "./tts/index.ts";
import { narrateTool, toUtterances } from "./tts/speech-text.ts";
import { readCuaConnection } from "./local-computer.ts";
import { applyPropertyPack } from "./hermes-pack.ts";
import { hermesStatus } from "./hermes-status.ts";
import { hermesInstallCommand } from "./hermes-pin.ts";
import { tryHermesPing } from "./hermes-hands.ts";
import { readArtifact } from "./audit-artifacts.ts";
import { Desk } from "./desk.ts";
import { seedVault } from "./vault.ts";
import { openTerminalAndRun, setupCommandFor } from "./engine-setup.ts";
import {
  beginModelAttachment,
  commitModelAttachment,
  installStatus,
  listModels,
  modelStatus,
  preflight,
  recoverPendingModelAttachment,
  rollbackModelAttachment,
  startInstall,
  stopInstall,
  workerInstallInProgress,
  type PreflightResult,
} from "./hermes-bridge.ts";
import { CANONICAL_BUD_ID, CANONICAL_BUD_NAME, PRODUCT_MODE, isCanonicalBud, productDenied } from "./product-mode.ts";
import { PILOT_CONTRACT, pilotContractComplete, pocketPilotReady } from "./pilot-contract.ts";
import { pilotDiscoveryProjection } from "./pilot-discovery.ts";
import { normalizeTelegramBotToken, normalizeTelegramUserId, verifyTelegramPocketToken } from "./pocket-gateway.ts";
import { PocketHub } from "./pocket-hub.ts";
import type { PocketTurnReply } from "./pocket-shared.ts";
import {
  normalizeWhatsAppAccessToken,
  normalizeWhatsAppAppSecret,
  normalizeWhatsAppPhoneNumberId,
  normalizeWhatsAppUserId,
  normalizeWhatsAppVerifyToken,
  normalizeWhatsAppWebhookPort,
  verifyWhatsAppCloudConfig,
  WHATSAPP_GRAPH_VERSION,
} from "./pocket-whatsapp-cloud.ts";
import { LoopManager, type LoopId } from "./routines.ts";
import { hostAllowed, needsSession, originAllowed, SESSION_TOKEN, sessionOk } from "./session-auth.ts";
import { evaluatorForLoop } from "./workflow-catalog.ts";
import { isSafeToolkitSlug, parseOfficeSourceServices } from "./office-sources.ts";
import { listLinkedTools, removeLinkedTool, saveLinkedComposioTool, saveLinkedToolKey, saveLinkedToolPeek } from "./linked-tools.ts";
import { linkedToolPeekCopy, peekLinkedTool } from "./tool-peek.ts";
import { currentAskDeskBrief, askDeskVoice } from "./ask-desk-brief.ts";
import { matchAskToolPeekSpeech } from "../shared/ask-connections.ts";
import { matchAskDeskSpeech } from "../shared/ask-desk-speech.ts";
import { admitAskCredential } from "./ask-credentials.ts";
import { verifyToolKey } from "./tool-verify.ts";
import { sourceConnectionCatalog } from "./source-connections.ts";
import { loadConnectionAliases, setConnectionAlias } from "./connection-aliases.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { TurnWatchdog } from "./turn-watchdog.ts";
import { decodeTurnAttachments } from "./turn-attachments.ts";
import { stageComposerInboxFile } from "./composer-inbox.ts";
import { parseWorkerIntakeAction, workerIntakeSummary } from "./worker-intake.ts";
import { decideAskAction, stageDirectAskRoutineIntent, stageDirectAskSetupIntent, stageWorkerAskAction } from "./ask-action-broker.ts";
import { askActionApprovalCopy, askSetupUserTurnCopy, isCompletedToolConnect, isConnectSetupAction } from "../shared/ask-actions.ts";
import { askLayerVoice, deniesLinkedConnection, reconcileAskWorkerText } from "../shared/ask-layer-voice.ts";
import { redactSecretsInText, stripSecretsForSpeech } from "./redact.ts";
import { recoverInterruptedWorkerUpdate } from "./worker-runtime.ts";
import { WorkerOperationGate, type WorkerOperationLease } from "./worker-operation-gate.ts";
import { UsageLedger } from "./usage-ledger.ts";
import { currentBookWorkRoutingPlan, normalizeWorkRoutingPreference } from "./work-routing.ts";
import {
  BUILT_IN_EXECUTION_ADAPTERS,
  ExecutionAdapterRegistry,
  type ExecutionAdapterBinding,
  type ExecutionAdapterAttestation,
} from "./execution-adapters.ts";
import { WorkBroker, workDigest } from "./work-broker.ts";
import { WorkOutputStore } from "./work-output-store.ts";
import {
  reconcileBrokeredSelectedFileAnalysis,
  runBrokeredSelectedFileAnalysis,
  SELECTED_FILE_ANALYSIS_RECIPE,
  selectedFileAnalysisDisplay,
} from "./selected-file-analysis.ts";
import { runStructuredPmsImport } from "./work-desk-reconciler.ts";
import { bankObservationDigest, runBankObservationImport } from "./bank-work-reconciler.ts";
import { validateBankObservationBatch, type BankObservationBatch } from "./bank-observation.ts";
import { createSupportReport, supportRuntimeLabels, type SupportWorkerInput } from "./support-report.ts";
import { assertPmsCsvInput, createPmsImportPreview, pmsCsvDigest } from "./pms-import-preview.ts";
import {
  recoverSelectedFileWorkspaces,
  stageSelectedFileWorkspace,
  type SelectedFileWorkspace,
} from "./selected-file-workspace.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;
// Pilot-only, server-owned recipe origin. Renderer/model input can never pick
// a bank URL. The production settings owner will replace this environment
// seam once the named-bank adapter is selected.
const BANK_ALLOWED_ORIGIN = process.env.REALBUD_BANK_ALLOWED_ORIGIN?.trim() || null;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function askRequestId(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return `ask-${randomBytes(16).toString("hex")}`;
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value)) {
    throw Object.assign(new Error("request id is invalid"), { status: 400, code: "invalid-request-id" });
  }
  return value;
}

function askRequestDigest(text: string, attachments: TurnAttachment[]): string {
  return workDigest(JSON.stringify({
    text,
    attachments: attachments.map(({ path, name, size, mimeType }) => ({ path, name, size, mimeType })),
  }));
}

ensureDirs();
assertSourceDataDirKeyBoundary();
const dataDirLock = acquireDataDirLock(DATA_DIR);
// A prior process cannot still own work after this exact data directory is
// locked. Remove only RealBud's private selected-file turn directories; the
// PM's originals are never changed.
recoverSelectedFileWorkspaces();
let dataDirLockReleased = false;
const releaseDataDirLock = () => {
  if (dataDirLockReleased) return;
  dataDirLockReleased = true;
  dataDirLock.release();
};
process.once("exit", releaseDataDirLock);
process.once("SIGINT", () => {
  releaseDataDirLock();
  process.exit(130);
});
process.once("SIGTERM", () => {
  releaseDataDirLock();
  process.exit(143);
});
// Finish only unambiguous local filesystem recovery before any provider can
// spawn. This never downloads, updates, probes PATH or touches personal
// Hermes state; a staged first install is quarantined rather than trusted.
let workerRuntimeRecovery = recoverInterruptedWorkerUpdate();
let modelAttachmentRecovery = recoverPendingModelAttachment();
seedVault();
try {
  applyPropertyPack();
} catch {
  /* hermes home missing or not writable — Desk stays on the training book */
}
const cfg = loadConfig();
// OMB_TEST_FLEET=1 (e2e tests) registers the legacy driver fleet so fake
// ACP CLIs can run; the product fleet stays Hermes-only. Never set in builds.
const registry = new ProviderRegistry(
  !PRODUCT_MODE
    ? (await import("./testing/test-fleet.ts")).TEST_DRIVERS
    : BUILT_IN_DRIVERS,
);
await registry.load(instanceConfigs(cfg));

const bus = new EventBus();
bus.attach(registry.instances());

// ── peer-agent comms wiring ────────────────────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy calls; regenerated each boot (the proxy gets it via env).
const COMMS_TOKEN = randomBytes(24).toString("hex");
function commsAuthorized(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(COMMS_TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}
// Cap message chains: depth 0 = a user-initiated turn (may ask a peer);
// a peer invoked via ask_bot runs at depth 1 and gets NO agents tool, so
// A→B is allowed but B→C (and A→B→A loops) never start.
const MAX_COMMS_DEPTH = 1;
const agentsProxyPath = SPAWNED_PROXIES.agents;
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(botId: string, depth: number) {
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      OMB_BOT_ID: botId,
      OMB_COMMS_TOKEN: COMMS_TOKEN,
      OMB_TURN_DEPTH: String(depth),
    },
  };
}

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a 4-min ceiling). */
function askBotAndWait(targetBotId: string, message: string, depth: number): Promise<string> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve("(no such bot)");
  const threadId = target.threadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (out: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(out);
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      if (e.threadId !== threadId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") {
        text += (text ? "\n" : "") + e.text;
      } else if (e.type === "turn.completed") {
        finish(text || "(the bot finished without a text reply)");
      }
    });
    const timer = setTimeout(() => finish(text || "(timed out waiting for the bot to reply)"), 4 * 60_000);
    startTurn(targetBotId, message, { commsDepth: depth + 1 }).catch((err) =>
      finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`),
    );
  });
}

// default selection for new bots: first available instance, claude preferred
async function defaultSelection() {
  const described = await registry.describe();
  const available = described.filter((d) => d.snapshot.state === "available");
  // Deliberately NO fallback to described[0]. Handing a bot an engine whose
  // CLI isn't installed makes it look ready and then fail on send with a raw
  // spawn ENOENT — the single worst first-run experience, and the one every
  // user with no CLIs used to get. An empty selection is honest: the UI shows
  // the setup path instead of a bot that cannot answer.
  const pick = available.find((d) => d.driverKind === "hermesAgent") ?? available[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}
let bootSelection = { instanceId: "", model: "" };
const store = new Store(() => bootSelection);
bootSelection = await defaultSelection();
store.seedIfEmpty();
const usageLedger = new UsageLedger();
// Manifests prove only that RealBud knows how an adapter must be admitted.
// No adapter is routable after boot until its server-owned implementation
// supplies a fresh version/configuration-bound runtime attestation.
const executionAdapters = new ExecutionAdapterRegistry(BUILT_IN_EXECUTION_ADAPTERS);
let selectedFileAdapterGeneration = 0;

function attestSelectedFileAdapter(now = Date.now()): ExecutionAdapterBinding {
  if (selectedFileAdapterGeneration >= 1_000_000_000) {
    throw Object.assign(new Error("The selected-file adapter generation is exhausted. Restart RealBud before reviewing more files."), {
      status: 409,
      code: "adapter-generation-exhausted",
    });
  }
  selectedFileAdapterGeneration += 1;
  const attestation: ExecutionAdapterAttestation = {
    kind: "realbud.execution-adapter-attestation.v1",
    schemaVersion: 1,
    adapterId: "selected-file-analysis",
    adapterVersion: 1,
    configurationGeneration: selectedFileAdapterGeneration,
    state: "ready",
    observedAt: now,
    expiresAt: now + 15 * 60_000,
    policyDigest: workDigest(JSON.stringify({
      recipe: SELECTED_FILE_ANALYSIS_RECIPE,
      permissionMode: "deny-all",
      workspace: "selected-copies-only",
      channels: false,
      browser: false,
      terminal: false,
    })),
  };
  executionAdapters.attest(attestation);
  return executionAdapters.readyBinding("selected-file-analysis", "analyse-selected-files");
}

const publicBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => ({
  ...bot,
  messages: store.messagesFor(bot.threadId),
  activeLeafId: store.activeLeaf(bot.threadId),
  tasks: store.tasks(bot.id).map(({ resumeCursors, ...task }) => task),
});

// Bud is one worker. Its executable/profile must never be used or changed by
// two server paths at once: Ask, Pocket, routines, diagnostics and settings
// all enter through this lease before their first await.
const workerOperations = new WorkerOperationGate();
const workerTurnLeases = new Map<string, WorkerOperationLease>();
const selectedFileWorkspaces = new Map<string, SelectedFileWorkspace>();
const brokeredSelectedFileThreads = new Set<string>();

async function releaseSelectedFileWorkspace(threadId: string): Promise<void> {
  const workspace = selectedFileWorkspaces.get(threadId);
  if (!workspace) return;
  selectedFileWorkspaces.delete(threadId);
  try {
    await workspace.cleanup();
  } catch {
    // Startup recovery owns any exact leftover RealBud turn directory. The
    // caller still releases the worker so a filesystem cleanup failure cannot
    // deadlock every other PM workflow.
  }
}

function acquireWorkerOperation(kind: string, detail: string, opts?: { allowRecovery?: boolean }): WorkerOperationLease {
  const localRecovery = localStateRecoveryStatus();
  if (!opts?.allowRecovery && localRecovery.active) {
    throw Object.assign(new Error("RealBud's local state needs recovery in You. Nothing was started."), {
      status: 409,
      code: "local-state-recovery",
    });
  }
  if (!opts?.allowRecovery && workerRuntimeRecovery.action === "attention") {
    throw Object.assign(new Error("Bud's private worker needs recovery in You → Worker. Nothing was started."), {
      status: 409,
      code: "worker-runtime-recovery",
    });
  }
  if (!opts?.allowRecovery && modelAttachmentRecovery.action === "attention") {
    throw Object.assign(new Error("Bud's model setup needs recovery in You → Worker. Nothing was started."), {
      status: 409,
      code: "model-recovery-required",
    });
  }
  if (workerInstallInProgress()) {
    throw Object.assign(
      new Error("Bud's private worker is being updated. Nothing was started; try again when You → Worker is ready."),
      { status: 409, code: "worker-update-active" },
    );
  }
  return workerOperations.acquire(kind, detail);
}

async function withWorkerOperation<T>(
  kind: string,
  detail: string,
  work: () => Promise<T> | T,
  opts?: { allowRecovery?: boolean },
): Promise<T> {
  const lease = acquireWorkerOperation(kind, detail, opts);
  try {
    return await work();
  } finally {
    lease.release();
  }
}

function releaseWorkerTurn(threadId: string): void {
  const lease = workerTurnLeases.get(threadId);
  if (!lease) return;
  workerTurnLeases.delete(threadId);
  lease.release();
}

// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set<ServerResponse>();
function broadcast(payload: unknown) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

/** Connection facts are code-owned. Overwrite any earlier Bud sentence that denied them. */
function replaceDenyingAskVoice(threadId: string, text: string) {
  const linked = listLinkedTools();
  for (const prior of store.messagesFor(threadId)) {
    if (prior.role !== "bot" || prior.kind !== "text") continue;
    if (!deniesLinkedConnection(prior.text ?? "", linked) || prior.text === text) continue;
    const patched = store.patchMessage(threadId, prior.id, { text });
    if (patched) broadcast({ kind: "message.patch", threadId, message: patched });
  }
}

function speakAskLayerVoice(threadId: string, text: string) {
  replaceDenyingAskVoice(threadId, text);
  const voice = store.appendMessage(threadId, { role: "bot", kind: "text", text });
  broadcast({ kind: "message", threadId, message: voice });
  return voice;
}

function scrubAskSecrets(threadId: string) {
  for (const prior of store.messagesFor(threadId)) {
    if (prior.kind !== "text" || !prior.text) continue;
    const text = redactSecretsInText(prior.text);
    if (text === prior.text) continue;
    const patched = store.patchMessage(threadId, prior.id, { text });
    if (patched) broadcast({ kind: "message.patch", threadId, message: patched });
  }
}

async function fillLinkedToolPeek(
  proposal: { kind: string; detail?: string; title?: string; service?: string },
  tool: { id: string; label: string; composioSlug: string | null },
  account?: string,
) {
  if (proposal.kind !== "open-setup") return proposal;
  const slug = tool.composioSlug ?? tool.id;
  const peek = await peekLinkedTool(slug);
  if (peek.ok && !peek.skipped) saveLinkedToolPeek(slug, peek.titles);
  return {
    ...proposal,
    detail: linkedToolPeekCopy({
      label: tool.label,
      account,
      slug,
      titles: peek.titles,
      skipped: peek.skipped,
      error: peek.error,
    }),
  };
}

const watchdog = new TurnWatchdog({
  stallMs: Number(process.env.OMB_TURN_STALL_MS) || 20 * 60_000,
  checkMs: 30_000,
  onStall: (turn) => {
    const bot = store.bot(turn.botId);
    const instance = bot ? registry.get(bot.modelSelection.instanceId) : null;
    void instance?.adapter.interruptTurn(turn.threadId).catch(() => {});
    releaseWorkerTurn(turn.threadId);
    if (!bot) return;
    store.patchBot(bot.id, { busy: false });
    const message = store.appendMessage(turn.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: "error: this turn stalled — no activity for too long", ok: false },
    });
    broadcast({ kind: "message", threadId: turn.threadId, message });
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
  },
});
watchdog.start();

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
// keyed by `${threadId}:${itemId}` / `${threadId}:${requestId}` — provider
// item/request ids are only unique within a thread, so two bots acting at
// once can collide on a bare id and patch each other's messages.
const toolMessageByItem = new Map<string, string>(); // threadId:itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // threadId:requestId -> messageId

// Group threads: the fold needs to know WHO is talking — the turn engine
// records the active member here before dispatching its turn.
const groupSpeakers = new Map<string, { botId: string; name: string; color: string }>();
let loops: LoopManager | null = null;
let pocketGateway: PocketHub | null = null;
const desk = new Desk();
let workBroker: WorkBroker | null = null;
let workOutputStore: WorkOutputStore | null = null;
try {
  workBroker = new WorkBroker({ file: join(DATA_DIR, "work-broker.json") });
  workOutputStore = new WorkOutputStore({ dir: DATA_DIR });
} catch (error) {
  // Desk remains readable and other safe work remains available. Structured
  // imports fail closed until the broker file is recovered; do not leak its
  // serialized contents or host paths into the UI.
  void error;
}
// The Desk and encrypted secret store have copied their wrapping keys into
// process-owned memory. Remove inherited copies before any worker/tool child
// can be started from this long-lived server.
delete process.env.REALBUD_DESK_KEY;
delete process.env.REALBUD_SECRET_KEY;
// The Local VM is intentionally one shared, visible desktop. Two agents
// driving it simultaneously would mix clicks, keystrokes and screenshots,
// so only one thread may lease it at a time.
let activeVmThreadId: string | null = null;
let localVmLifecycleBusy = false;

bus.subscribe((event: RuntimeEvent) => {
  const brokeredSelectedFile = brokeredSelectedFileThreads.has(event.threadId);
  watchdog.touch(event.threadId);
  if (!brokeredSelectedFile && event.type === "request.opened") watchdog.setWaitingOnHuman(event.threadId, true);
  if (!brokeredSelectedFile && event.type === "request.resolved") watchdog.setWaitingOnHuman(event.threadId, false);
  if (!brokeredSelectedFile && event.type === "turn.completed") {
    watchdog.settle(event.threadId);
    releaseWorkerTurn(event.threadId);
    void releaseSelectedFileWorkspace(event.threadId);
  }
  // A selected-file context returns a strict JSON envelope. Never stream that
  // implementation payload, session id, provider error or denied tool event
  // into Ask; the brokered owner below emits one validated PM-facing result.
  if (!brokeredSelectedFile) broadcast({ kind: "runtime", event });
  const bot = store.botByThread(event.threadId);
  const group = bot ? undefined : store.groupByThread(event.threadId);
  if (!bot && !group) return;
  const speaker = group ? groupSpeakers.get(event.threadId) : undefined;

  // Usage is observability, never authority. Record only the canonical Bud,
  // key turns by a one-way digest, and let any disk failure degrade the
  // usage panel rather than interrupting property work.
  if (bot && isCanonicalBud(bot.id) && event.turnId) {
    const at = Date.parse(event.createdAt);
    if (event.type === "thread.token-usage.updated") {
      usageLedger.record({
        threadId: event.threadId,
        turnId: event.turnId,
        at: Number.isFinite(at) ? at : undefined,
        provider: event.provider,
        model: bot.modelSelection.model,
        inputTokens: event.input,
        outputTokens: event.output,
      });
    } else if (event.type === "turn.completed") {
      usageLedger.record({
        threadId: event.threadId,
        turnId: event.turnId,
        at: Number.isFinite(at) ? at : undefined,
        provider: event.provider,
        model: bot.modelSelection.model,
        costUsd: event.cost,
        completed: true,
        ok: event.ok,
      });
    }
  }
  if (brokeredSelectedFile) {
    if (event.type === "turn.completed") brokeredSelectedFileThreads.delete(event.threadId);
    return;
  }

  const pushMessage = (m: Omit<Message, "id" | "at">) => {
    const message = store.appendMessage(event.threadId, group && m.role === "bot" ? { ...m, from: speaker } : m);
    broadcast({ kind: "message", threadId: event.threadId, message });
    return message;
  };

  switch (event.type) {
    case "session.started":
      if (bot && event.sessionId && event.providerInstanceId) {
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId, event.threadId);
      }
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        const stagedAction = PRODUCT_MODE && bot && isCanonicalBud(bot.id) && loops
          ? stageWorkerAskAction(event.text, {
              desk,
              loops,
              portalMode: PILOT_CONTRACT.demo ? "practice" : "pilot",
              workRoutingPlan: currentWorkRoutingPlan,
            })
          : { matched: false as const };
        const intake = !stagedAction.matched && PRODUCT_MODE && bot && isCanonicalBud(bot.id)
          ? parseWorkerIntakeAction(event.text)
          : null;
        if (stagedAction.matched) {
          if ("error" in stagedAction) {
            pushMessage({
              role: "bot",
              kind: "text",
              text: `${stagedAction.error} Ask me again with the current property, routine or setup target.`,
            });
          } else {
            pushMessage({ role: "bot", kind: "action", action: stagedAction.proposal });
            if (stagedAction.deskChanged) commitDesk(desk.snapshot());
          }
        } else if (intake) {
          try {
            const staged = desk.proposeBook({ items: intake.properties }, "ask");
            commitDesk(desk.snapshot());
            pushMessage({
              role: "bot",
              kind: "text",
              text: workerIntakeSummary({ ...staged, unparsed: intake.unparsed }),
            });
          } catch {
            pushMessage({
              role: "bot",
              kind: "text",
              text: "I reviewed the attachment, but the Desk could not safely stage the result. Nothing was added to the book. Check recovery in You, then try again.",
            });
          }
        } else {
          const text = PRODUCT_MODE && bot && isCanonicalBud(bot.id)
            ? reconcileAskWorkerText(event.text, listLinkedTools())
            : event.text;
          if (text !== event.text) replaceDenyingAskVoice(event.threadId, text);
          pushMessage({ role: "bot", kind: "text", text });
        }
      } else if (event.itemType === "tool" && event.itemId) {
        const itemKey = `${event.threadId}:${event.itemId}`;
        const messageId = toolMessageByItem.get(itemKey);
        let toolName = "tool";
        if (messageId) {
          // the whole tool object is replaced, so carry `spoken` across —
          // dropping it here would silently un-narrate every completed tool
          const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool;
          toolName = existing?.name ?? "tool";
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: toolName, ok: event.ok, spoken: existing?.spoken },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(itemKey);
        }
        // the bot just acted ON ITS SCREEN — refresh the preview now. Only
        // computer tools can change the screen, and each capture competes
        // with the agent for the box's command endpoint, so a bot grinding
        // through file edits must not trigger one per tool.
        if (bot && /computer|screenshot|click|type_text|press_key|scroll|open_url/i.test(toolName)) {
          pokeScreenPoller(bot.id);
        }
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        // ask_bot's raw tool chip is redundant — the internal endpoint
        // appends a richer "Messaged @X" chip linking to the channel
        if (event.title?.endsWith("__ask_bot")) break;
        const name = event.title ?? "tool";
        // narration is folded in here, once, so call mode can read the
        // chip aloud without re-deriving it — and so the phrase a user
        // hears and the chip they see can never drift apart
        const message = pushMessage({
          role: "bot",
          kind: "activity",
          tool: { name, spoken: narrateTool(name) ?? undefined },
        });
        if (event.itemId) toolMessageByItem.set(`${event.threadId}:${event.itemId}`, message.id);
      }
      break;
    case "request.opened": {
      const permission = event.requestType === "permission";
      // Auto mode / always-allow: answer routine tool permissions for the
      // bot so it keeps working. A QUESTION always reaches the human — the
      // whole point of asking is that a person decides — and anything that
      // looks destructive stops even in auto mode.
      const asker = bot ?? (speaker ? store.bot(speaker.botId) : undefined);
      // RealBud never auto-answers a permission, whatever the bot record
      // says. Auto mode exists only in the legacy fleet (OMB_TEST_FLEET=1).
      const settled = permission && !PRODUCT_MODE && asker && event.requestId
        ? autoDecision(asker, event.tool, event.summary)
        : null;
      if (settled && asker && event.requestId) {
        const instance = event.providerInstanceId
          ? registry.get(event.providerInstanceId)
          : registry.get(asker.modelSelection.instanceId);
        const requestId = event.requestId;
        const { tool, summary } = event;
        // The chip is written only AFTER the provider takes the answer.
        // Claiming approval first and correcting later means a moment
        // where the transcript says "approved" over a request nothing
        // answered — and if the provider is gone entirely, forever.
        void (async () => {
          try {
            if (!instance) throw new Error("provider unavailable");
            await instance.adapter.respondToRequest(event.threadId, requestId, { behavior: "allow" });
            pushMessage({
              role: "bot",
              kind: "activity",
              tool: { name: `${settled}: ${summary.slice(0, 120)}`, ok: true },
            });
          } catch {
            // couldn't answer it for them — hand it back to the human
            // rather than leaving the bot waiting on nobody
            const card = pushMessage({
              role: "bot",
              kind: "options",
              card: {
                title: "Approval needed",
                subtitle: summary,
                options: ["Allow", "Deny"],
                requestId,
                tool,
                allowKey: approvalKey(tool, summary),
                held: "Auto mode couldn't answer this one.",
              },
            });
            askMessageByRequest.set(`${event.threadId}:${requestId}`, card.id);
          }
        })();
        break;
      }
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: permission ? "Approval needed" : PRODUCT_MODE && bot ? "Bud needs one answer" : "Your bot has a question",
          subtitle: event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
          tool: permission ? event.tool : undefined,
          // the exact grant "always allow" would remember, decided here so
          // client and server can never derive it differently
          allowKey: permission ? approvalKey(event.tool, event.summary) : undefined,
          // in auto mode a card can only mean the guard stopped it — say so
          held: permission && asker?.autoApprove ? "This looked destructive, so auto mode stopped to ask." : undefined,
        },
      });
      if (event.requestId) askMessageByRequest.set(`${event.threadId}:${event.requestId}`, message.id);
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(`${event.threadId}:${event.requestId}`) : null;
      if (messageId) {
        const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
        if (existing?.card && !existing.card.answered) {
          const patched = store.patchMessage(event.threadId, messageId, {
            card: { ...existing.card, answered: event.behavior, dismissed: event.source !== "user" },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
        }
        if (event.requestId) askMessageByRequest.delete(`${event.threadId}:${event.requestId}`);
      }
      break;
    }
    case "runtime.error":
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false, setup: event.setup },
      });
      break;
    case "turn.completed": {
      if (activeVmThreadId === event.threadId) activeVmThreadId = null;
      if (bot) {
        const request = [...store.activePath(event.threadId)].reverse().find((message) =>
          message.role === "user" &&
          Boolean(message.requestId) &&
          (message.requestState === "admitted" || message.requestState === "dispatching" || message.requestState === undefined)
        );
        if (request) {
          const settled = store.patchMessage(event.threadId, request.id, {
            requestState: "settled",
            requestStatusDetail: event.ok ? "Bud completed this saved request" : "Bud stopped safely; review the result above",
          });
          if (settled) broadcast({ kind: "message.patch", threadId: event.threadId, message: settled });
        }
        store.patchBot(bot.id, { busy: false, unread: true });
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
        if (screenPollers.has(bot.id)) {
          // the last live frame becomes a settled inline screen message —
          // the screenshot-in-chat moment. One fresh capture first, so the
          // frame shows the turn's END state (the final tool's poke may
          // still be in flight).
          void finalScreenFrame(bot.id).then((frame) => {
            // the bot may have been deleted while the capture ran
            if (frame && store.bot(bot.id)) {
              pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
            }
          });
        }
      }
      // group busy/unread settle in the group turn engine, which knows
      // whether more member turns are queued behind this one
      break;
    }
  }
});

// ── live screen: poll the bot's box while it works ────────────────────
// Frames stream to clients as SSE {kind:'screen'} (the "Bot's screen"
// panel); the final frame is folded into the transcript on turn end.
type Frame = { png: string; mime: string };
const screenPollers = new Map<
  string,
  { timer: ReturnType<typeof setInterval> | null; capture: () => Promise<void>; last: Frame | null }
>();

/** The preview shares the box's single command endpoint with the agent's
 * own actions, so every frame we take is latency stolen from the work the
 * user is waiting on. Hence: a slow interval, a floor between captures,
 * and never two in flight. */
const SCREEN_POLL_MS = 6000;
const SCREEN_MIN_GAP_MS = 3000;

function startScreenPoller(botId: string, boxId?: string) {
  if (screenPollers.has(botId) || !box.boxConfigured(cfg)) return;
  // One capture at a time, shared by the interval, the pokes, and the
  // turn-end grab: awaiting the in-flight promise (rather than dropping the
  // call) is what lets the final frame be the settled one. The min-gap keeps
  // a tool-heavy turn from spending the box's single command endpoint on
  // previews the user isn't waiting for.
  let current: Promise<void> | null = null;
  let lastAt = 0;
  const entry = {
    timer: null as ReturnType<typeof setInterval> | null,
    capture: (): Promise<void> => {
      if (!current && Date.now() - lastAt < SCREEN_MIN_GAP_MS) return Promise.resolve();
      current ??= (async () => {
        try {
          // boxId is resolved once per turn — re-resolving per frame cost a
          // full LIST of the account's boxes
          const { png, format } = await box.screenshotBox(cfg, botId, boxId);
          const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
          entry.last = frame;
          broadcast({ kind: "screen", botId, ...frame });
        } catch {
          /* box asleep or mid-command — try again next tick */
        } finally {
          lastAt = Date.now();
          current = null;
        }
      })();
      return current;
    },
    last: null as Frame | null,
  };
  entry.timer = setInterval(() => void entry.capture(), SCREEN_POLL_MS);
  screenPollers.set(botId, entry);
}

/** Event-driven refresh: capture NOW (the bot just acted on its screen)
 * instead of waiting for the next interval tick. Rate-limited inside
 * capture() — a tool-heavy turn used to fire one full REST chain per
 * completed tool, competing with the agent for the same endpoint. */
function pokeScreenPoller(botId: string) {
  void screenPollers.get(botId)?.capture();
}

function stopScreenPoller(botId: string) {
  const entry = screenPollers.get(botId);
  if (!entry) return;
  if (entry.timer) clearInterval(entry.timer);
  screenPollers.delete(botId);
}

/** Turn end: stop polling, then take ONE last fresh frame (awaiting any
 * in-flight poke first) so the settled screenshot shows the screen's actual
 * end state, not the previous action's. */
async function finalScreenFrame(botId: string): Promise<Frame | null> {
  const entry = screenPollers.get(botId);
  if (!entry) return null;
  if (entry.timer) clearInterval(entry.timer);
  screenPollers.delete(botId);
  await entry.capture();
  return entry.last;
}

// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
async function startTurn(
  botId: string,
  text: string,
  opts?: {
    commsDepth?: number;
    attachments?: TurnAttachment[];
    userMessage?: Message;
    /** Pin the destination thread for the whole turn. */
    threadId?: string;
    onDispatchError?: (message: string) => void;
    /** Durable HTTP admission identity. An already-persisted user message
     * can be safely re-dispatched after a crash before provider dispatch. */
    requestId?: string;
    requestDigest?: string;
  },
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
  if (isCanonicalBud(bot.id) && workerRuntimeRecovery.action === "attention") {
    throw Object.assign(new Error("Bud's private worker needs recovery in You → Worker. This message was not started."), { status: 409 });
  }
  if (isCanonicalBud(bot.id) && workerInstallInProgress()) {
    throw Object.assign(new Error("Bud's private worker is being updated — this message was not started. Try again when You → Worker is ready."), { status: 409 });
  }
  const threadId = opts?.threadId ?? bot.threadId;
  const task = store.taskByThread(bot.id, threadId);
  if (!task) throw Object.assign(new Error("no such task"), { status: 404 });
  const commsDepth = opts?.commsDepth ?? 0;

  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance) {
    if (text.trim()) store.titleTaskFromFirstMessage(bot.id, text, threadId);
    let blockedUser = opts?.userMessage;
    if (!blockedUser) {
      blockedUser = store.appendMessage(threadId, {
        role: "user",
        kind: "text",
        text,
        ...(opts?.requestId ? { requestId: opts.requestId } : {}),
        ...(opts?.requestDigest ? { requestDigest: opts.requestDigest } : {}),
        ...(opts?.requestId ? {
          requestState: "settled" as const,
          requestAttachmentCount: opts.attachments?.length ?? 0,
          requestStatusDetail: "Saved. Bud cannot start until a model is attached.",
        } : {}),
      });
      broadcast({ kind: "message", threadId, message: blockedUser });
    } else if (opts?.requestId) {
      const settled = store.patchMessage(threadId, blockedUser.id, {
        requestState: "settled",
        requestStatusDetail: "Saved. Bud cannot start until a model is attached.",
      });
      if (settled) broadcast({ kind: "message.patch", threadId, message: settled });
    }
    const reply = store.appendMessage(threadId, {
      role: "bot",
      kind: "text",
      text: isCanonicalBud(bot.id)
        ? "Prepare Bud first. I saved your question here. I cannot start a turn until a model is attached. I never send or pay."
        : "I saved your message. This model is unavailable — pick another in settings.",
    });
    broadcast({ kind: "message", threadId, message: reply });
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
    throw Object.assign(
      new Error(
        isCanonicalBud(bot.id)
          ? "Prepare Bud first. The model is unavailable until a worker is attached. This question is saved in Ask."
          : `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
      ),
      { status: 409, code: "provider-unavailable", botId: bot.id },
    );
  }
  const instanceId = instance.instanceId;
  const model = bot.modelSelection.model;
  let selectedWorkspace: SelectedFileWorkspace | null = null;

  // Reserve Bud before any transcript mutation. A conflict must leave no
  // orphaned user message or half-titled task behind.
  if (isCanonicalBud(bot.id)) {
    const lease = acquireWorkerOperation("ask", "answering in Ask");
    workerTurnLeases.set(threadId, lease);
  }

  try {
    if (opts?.attachments?.length) {
      selectedWorkspace = await stageSelectedFileWorkspace(opts.attachments);
      selectedFileWorkspaces.set(threadId, selectedWorkspace);
    }
  } catch (error) {
    releaseWorkerTurn(threadId);
    throw error;
  }

  // an edit hands us its already-branched user message; a plain send appends
  let userMessage = opts?.userMessage;
  let transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
  let rewound = false;
  let turnText = text;
  let persona = "";
  let userMessageId: string | null = null;
  try {
    // a task takes its name from the first thing you asked it to do
    if (text.trim()) store.titleTaskFromFirstMessage(bot.id, text, threadId);
    if (!userMessage) {
      userMessage = store.appendMessage(threadId, {
        role: "user",
        kind: "text",
        text,
        ...(opts?.requestId ? { requestId: opts.requestId } : {}),
        ...(opts?.requestDigest ? { requestDigest: opts.requestDigest } : {}),
        ...(opts?.requestId ? {
          requestState: "admitted" as const,
          requestAttachmentCount: opts.attachments?.length ?? 0,
          requestStatusDetail: "Saved locally before Bud started",
        } : {}),
      });
      broadcast({ kind: "message", threadId, message: userMessage });
    }
    if (!userMessage) throw new Error("the user message could not be persisted");
    userMessageId = userMessage.id;

    // Transcript for API-backed drivers: settled text turns on the ACTIVE
    // branch only — abandoned forks never reach the model.
    transcript = store
      .activePath(threadId)
      .filter((m) => m.kind === "text" && m.text && m.id !== userMessageId)
      .slice(-40)
      .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text! }));

    // After a rewind (edit / branch switch) the provider's native session
    // still contains the abandoned branch: start a fresh session instead of
    // resuming, and for cursor-resuming drivers replay the surviving path
    // inline (transcript-replay drivers get it via transcript). The flag is
    // cleared only once the turn is actually dispatched — clearing it here
    // would cost the next attempt its history if this dispatch fails.
    rewound = threadId === bot.threadId && Boolean(bot.rewound);
    turnText =
      rewound && instance.driverKind !== "grok" && transcript.length
        ? [
            "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]",
            "",
            ...transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`),
            "",
            "[Now reply to the user's latest message:]",
            "",
            text,
          ].join("\n")
        : text;

    persona = [
      `You are ${bot.name}, a personal bot in RealBud.`,
      bot.title && `Role: ${bot.title}.`,
      bot.description && `About: ${bot.description}`,
    ]
      .filter(Boolean)
      .join(" ");

    // Busy flips immediately so the composer locks; the dispatch itself
    // runs in the background — provisioning must not hang the HTTP request.
    store.patchBot(bot.id, { busy: true, unread: false });
    if (opts?.requestId) {
      const dispatching = store.patchMessage(threadId, userMessage.id, {
        requestState: "dispatching",
        requestStatusDetail: "Bud is working on this saved request",
      });
      if (dispatching) broadcast({ kind: "message.patch", threadId, message: dispatching });
    }
    watchdog.watch(threadId, bot.id);
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
  } catch (error) {
    await releaseSelectedFileWorkspace(threadId);
    releaseWorkerTurn(threadId);
    throw error;
  }

  void (async () => {
    try {
      const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
      if (PRODUCT_MODE) {
        if (selectedWorkspace) {
          if (!workBroker || !workOutputStore) {
            throw Object.assign(
              new Error("Selected-file review needs recovery in You before Bud can safely run it. Nothing was staged."),
              { status: 503, code: "selected-file-broker-unavailable" },
            );
          }
          if (!opts?.requestId || !opts.requestDigest) {
            throw Object.assign(
              new Error("Selected-file review has no durable request identity. Select the files again."),
              { status: 409, code: "selected-file-admission-missing" },
            );
          }

          brokeredSelectedFileThreads.add(threadId);
          try {
            const result = await runBrokeredSelectedFileAnalysis({
              broker: workBroker,
              outputStore: workOutputStore,
              adapter: instance.adapter,
              adapterBinding: attestSelectedFileAdapter(),
              requestId: opts.requestId,
              requestDigest: opts.requestDigest,
              bookRevision: desk.snapshot().revision,
              instruction: turnText,
              workspace: selectedWorkspace,
              threadId,
              model,
            });

            let responseText: string;
            if (result.output.properties.length) {
              const staged = desk.proposeBook({ items: result.output.properties }, "ask");
              commitDesk(desk.snapshot());
              const sections = [workerIntakeSummary({
                ...staged,
                unparsed: result.output.needsAttention,
              })];
              if (result.output.summary) sections.push(result.output.summary);
              if (result.output.needsAttention.length) {
                sections.push([
                  "**Needs your attention**",
                  ...result.output.needsAttention.map((item) => `- ${item}`),
                ].join("\n"));
              }
              responseText = sections.join("\n\n");
            } else {
              responseText = selectedFileAnalysisDisplay(result.output);
            }

            // Desk persistence is the business projection. Reconcile only
            // after it lands, then persist the clean transcript response.
            reconcileBrokeredSelectedFileAnalysis({
              broker: workBroker,
              outputStore: workOutputStore,
              receiptId: result.receipt.id,
            });
            const response = store.appendMessage(threadId, {
              role: "bot",
              kind: "text",
              text: responseText,
            });
            broadcast({ kind: "message", threadId, message: response });
            if (opts?.requestId) {
              const settled = userMessageId ? store.patchMessage(threadId, userMessageId, {
                requestState: "settled",
                requestStatusDetail: "Completed and projected into RealBud",
              }) : null;
              if (settled) broadcast({ kind: "message.patch", threadId, message: settled });
            }
            try {
              workOutputStore.delete(result.receipt.id);
            } catch {
              console.warn("RealBud could not remove a reconciled encrypted work output; it remains encrypted for recovery.");
            }
            if (rewound) store.patchBot(bot.id, { rewound: false, resumeCursors: {} });
          } finally {
            if (!instance.adapter.hasSession(threadId)) {
              brokeredSelectedFileThreads.delete(threadId);
            } else {
              // A policy violation can reject before the provider has emitted
              // its cancelled completion. Keep late content quarantined; the
              // completion handler removes this marker. The bounded fallback
              // cannot delete a newer active turn on the same thread.
              const quarantine = setTimeout(() => {
                if (!instance.adapter.hasSession(threadId)) brokeredSelectedFileThreads.delete(threadId);
              }, 10_000);
              quarantine.unref?.();
            }
          }

          watchdog.settle(threadId);
          await releaseSelectedFileWorkspace(threadId);
          releaseWorkerTurn(threadId);
          store.patchBot(bot.id, { busy: false, unread: true });
          broadcast({ kind: "bot", bot: store.bot(bot.id) });
          return;
        }

        const capabilityContext = currentAskCapabilityContext(desk, {
          portalMode: PILOT_CONTRACT.demo ? "practice" : "pilot",
          pocket: pocketGateway?.status(),
          pilotContract: PILOT_CONTRACT,
          bankAdapterConfigured: Boolean(BANK_ALLOWED_ORIGIN),
          composioLinked: Boolean(cfg.composio?.key),
          linkedTools: listLinkedTools(),
        });
        await instance.adapter.sendTurn({
          threadId,
          text: turnText,
          attachments: opts?.attachments,
          model,
          resumeCursor: rewound ? undefined : task.resumeCursors[instanceId],
          transcript,
          system: budSystemPrompt({
              pmName: cfg.profile?.name,
              agencyName: desk.snapshot().book?.agency.name,
              routines: loops?.listLoops().map((loop) => ({
                id: loop.id,
                name: loop.name,
                available: loop.available,
                enabled: loop.enabled,
                time: loop.schedule.time,
                weekdays: loop.schedule.weekdays,
              })),
              ...capabilityContext,
            }),
          integrations: {},
        });
        if (rewound) store.patchBot(bot.id, { rewound: false, resumeCursors: {} });
        return;
      }
      if (cfg.composio?.key) integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
      const wants = bot.computer;
      const mountsComputerMcp = instance.adapter.capabilities.computerMcp === true;
      const mountsCloudComputer = mountsComputerMcp || instance.driverKind === "boxAgent";
      let previewBoxId: string | null = null;
      let computerKind: "box" | "vm" | "local" | null = null;

      // Explicit destinations are strict. In particular, Local VM must never
      // fall through to host CUA and accidentally click on the user's Mac.
      if (wants === "vm") {
        if (!mountsComputerMcp || instance.driverKind === "boxAgent") {
          throw new Error("this model engine cannot use the Local VM — choose Claude or an ACP engine, or select another computer destination");
        }
        const localVm = await containerComputerStatus();
        if (!localVm.ready || !localVm.runtime) {
          throw new Error(`${localVm.problem ?? "the Local VM is not ready"} (App Settings → Local VM)`);
        }
        if (activeVmThreadId && activeVmThreadId !== threadId) {
          throw new Error("the shared Local VM is already being used by another bot — wait for that turn to finish");
        }
        activeVmThreadId = threadId;
        integrations.localComputer = containerComputerMcp(localVm.runtime);
        computerKind = "vm";
      } else if (wants === "local") {
        if (!mountsComputerMcp) {
          throw new Error("this model engine cannot control this computer — choose Claude or an ACP engine, or select another destination");
        }
        const cua = readCuaConnection();
        if (!cua) throw new Error("CUA Driver is not ready for this computer — check permissions and restart RealBud");
        integrations.localComputer = cua;
        computerKind = "local";
      }

      // Cloud is also strict when explicitly selected. Auto (unset) reuses an
      // existing cloud box, then falls back to host CUA without provisioning.
      if ((wants === "cloud" || wants === undefined) && box.boxConfigured(cfg)) {
        if (!mountsCloudComputer && wants === "cloud") {
          throw new Error("this model engine cannot use computer tools — choose Claude, an ACP engine, or the Computer engine");
        }
        let b = await box.findBox(cfg, bot.id).catch(() => null);
        // Explicit Cloud and the box-native Computer engine provision on first
        // use. Auto remains non-surprising and only reuses an existing box.
        if (!b && mountsCloudComputer && (wants === "cloud" || instance.driverKind === "boxAgent")) {
          broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
          await box.provisionBox(cfg, bot.id, bot.name);
          b = await box.findBox(cfg, bot.id).catch(() => null);
        }
        // an archived box answers every action with an error until it
        // resumes — wake it here, once, instead of letting the agent
        // discover it one failed tool call at a time. Only worth the
        // resume (~8s, and it un-pauses billing) when the bot can act.
        if (b && mountsCloudComputer && !["idle", "ready", "running"].includes(b.state)) {
          broadcast({ kind: "computer", botId: bot.id, state: "waking" });
          b = (await box.readyBox(cfg, bot.id).catch(() => null)) ?? b;
        }
        if (b) {
          previewBoxId = b.id;
          if (mountsCloudComputer) {
            integrations.computer = { kind: "box", boxId: b.id, token: cfg.box!.token! };
            computerKind = "box";
          }
        }
      }
      if (wants === "cloud" && !box.boxConfigured(cfg)) {
        throw new Error("Cloud box is not configured — add a Box API key or choose Local VM");
      }
      if (wants === "cloud" && !integrations.computer) {
        throw new Error("the cloud computer could not be created or reached");
      }

      // Auto-only host fallback. Electron owns cua-driver/TCC attribution;
      // the harness only reads its already-running connection descriptor.
      if (!integrations.computer && !integrations.localComputer && wants === undefined && mountsComputerMcp) {
        const cua = readCuaConnection();
        if (cua) {
          integrations.localComputer = cua;
          computerKind = "local";
        }
      }
      // peer-agent comms: give a user-initiated turn the list_bots/ask_bot
      // tools. A comms-invoked turn (depth ≥ cap) gets none — hard recursion
      // stop, so the user's tokens can't be burned by a bot-to-bot loop.
      // Only drivers that mount the tools get the integration (and, via the
      // integrations.agents gate below, the prompt hint) — a bot on a driver
      // without it must not be told about tools it cannot call. Any bot can
      // still be the TARGET of ask_bot regardless of its driver.
      if (
        commsDepth < MAX_COMMS_DEPTH &&
        instance.adapter.capabilities.agentsMcp === true &&
        store.bots.filter((b) => b.id !== bot.id && !b.hidden).length > 0
      ) {
        integrations.agents = agentsIntegration(bot.id, commsDepth);
      }
      // @mentions in the user's message (the composer's tagging UI) become
      // an explicit delegation nudge — the agent still does the ask_bot call
      // itself, so the harness stays the single owner of turns/permissions
      const tagged = integrations.agents
        ? mentionedBots(
            text,
            store.bots.filter((b) => b.id !== bot.id),
          )
        : [];
      const coordinationPrompt = bot.chiefOfStaff
        ? chiefOfStaffSystemPrompt(bot.id, store.bots, Boolean(integrations.agents))
        : integrations.agents
          ? "You can work with the user's other bots through the agents tools — list_bots shows who's available, ask_bot sends one of them a message and returns their reply."
          : "";

      await instance.adapter.sendTurn({
        threadId,
        text: turnText,
        attachments: opts?.attachments,
        model,
        // a rewound thread never resumes the abandoned branch's session
        // the active task's own session — another task's cursor would
        // resume the wrong conversation and defeat the context bubble
        resumeCursor: rewound ? undefined : task.resumeCursors[instanceId],
        transcript,
        system:
          persona +
          (computerKind === "vm"
            ? " You have a shared, isolated Cua sandbox: a Linux desktop in a container on this machine with no host folders mounted. Use the computer tools for desktop, accessibility, window, and shell work. Inspect the desktop state before acting, prefer accessibility targets over raw coordinates, and work carefully."
            : computerKind === "box" && instance.driverKind !== "boxAgent"
              ? " You have your own cloud computer — use screenshot, click, type_text, open_url and computer_exec whenever a desktop helps. Every action already returns the resulting screen, so don't follow it with screenshot; batch predictable sequences with computer_batch."
              : computerKind === "local"
              ? " You can act on the user's computer through the computer tools — take a screenshot or read the desktop state first, prefer accessibility actions over raw coordinates, and act carefully."
              : "") +
          (coordinationPrompt ? ` ${coordinationPrompt}` : "") +
          (tagged.length
            ? ` The user tagged ${tagged
                .map((t) => `@${t.name} (ask_bot bot_id ${t.id})`)
                .join(" and ")} in their message — bring them in with ask_bot and fold their reply into your answer.`
            : ""),
        integrations,
      });
      // dispatched: the rewind is spent, and the old cursors are dead
      if (rewound) store.patchBot(bot.id, { rewound: false, resumeCursors: {} });
      if (previewBoxId) startScreenPoller(bot.id, previewBoxId);
    } catch (e) {
      await releaseSelectedFileWorkspace(threadId);
      releaseWorkerTurn(threadId);
      if (activeVmThreadId === threadId) activeVmThreadId = null;
      const message = e instanceof Error ? e.message : String(e);
      if (opts?.requestId && userMessage) {
        const settled = store.patchMessage(threadId, userMessage.id, {
          requestState: "settled",
          requestStatusDetail: "Stopped safely before completion; review the error below",
        });
        if (settled) broadcast({ kind: "message.patch", threadId, message: settled });
      }
      const failure = store.appendMessage(threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
      });
      broadcast({ kind: "message", threadId, message: failure });
      watchdog.settle(threadId);
      store.patchBot(bot.id, { busy: false });
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      opts?.onDispatchError?.(message);
    }
  })();
}

/** Reconcile the durable Ask admission ledger after a process restart.
 * Only a text-only request whose user message is still the active leaf is
 * safe to re-dispatch. Selected files are never rediscovered from the PM's
 * device, and partial tool activity is held for human review. */
function recoverInterruptedAskAdmissions(): void {
  for (const bot of store.bots) {
    if (!isCanonicalBud(bot.id)) continue;
    for (const task of store.tasks(bot.id)) {
      const active = store.activePath(task.threadId);
      const request = [...active].reverse().find((message) =>
        message.role === "user" &&
        Boolean(message.requestId) &&
        (message.requestState === undefined || message.requestState === "admitted" || message.requestState === "dispatching")
      );
      if (!request?.requestId || !request.text) continue;
      const at = active.findIndex((message) => message.id === request.id);
      const later = at >= 0 ? active.slice(at + 1) : [];
      const completedProjection = later.some((message) => message.role === "bot" && ["text", "action"].includes(message.kind));
      if (completedProjection) {
        store.patchMessage(task.threadId, request.id, {
          requestState: "settled",
          requestStatusDetail: "Recovered as completed from the durable conversation",
        });
        continue;
      }

      const hold = (detail: string, message: string) => {
        const held = store.patchMessage(task.threadId, request.id, {
          requestState: "held",
          requestStatusDetail: detail,
        });
        if (held) broadcast({ kind: "message.patch", threadId: task.threadId, message: held });
        const notice = store.appendMessage(task.threadId, { role: "bot", kind: "text", text: message });
        broadcast({ kind: "message", threadId: task.threadId, message: notice });
      };

      if ((request.requestAttachmentCount ?? 0) > 0) {
        hold(
          "Files must be selected again after restart",
          "RealBud restarted after saving this request. Your original files were never copied into the conversation, so I did not scan the device or guess their location. Select them again to continue.",
        );
        continue;
      }
      if (later.length) {
        hold(
          "Interrupted after partial worker activity",
          "RealBud restarted after Bud began this request. I preserved the partial activity and did not replay it. Review it, then ask me to continue if needed.",
        );
        continue;
      }

      queueMicrotask(() => {
        void startTurn(bot.id, request.text!, {
          threadId: task.threadId,
          userMessage: request,
          requestId: request.requestId,
          requestDigest: request.requestDigest,
        }).catch((error) => {
          const detail = error instanceof Error ? error.message : "Bud could not resume after restart";
          hold(
            "Automatic restart recovery could not resume this request",
            `I kept this saved request, but could not resume it automatically: ${redactSecretsInText(detail).slice(0, 180)}. Review Worker setup in You, then send it again.`,
          );
        });
      });
    }
  }
}

// ── named loops: the RealBud clock presses Desk Recheck ────────────────
// RealBud owns WHEN; Hermes owns HOW (headless, facts only, no cron).
// A loop is never a bot turn, a prompt, or a second agent.
function commitDesk(_snapshot: ReturnType<Desk["snapshot"]>) {
  // SSE carries the bounded queue projection. Selected Notes and historical
  // detail are fetched explicitly and never broadcast portfolio-wide.
  broadcast({ kind: "desk", snapshot: desk.queueSnapshot() });
}

async function prepareDeskHandoff(draftId: string): Promise<ReturnType<Desk["snapshot"]>> {
  try {
    if (!process.env.FAKE_PORTAL_URL) {
      throw Object.assign(
        new Error("The practice portal is not running in this RealBud runtime. No browser work was started."),
        { status: 409, code: "handoff-unavailable" },
      );
    }
    return await desk.preparePortalAsync(draftId);
  } catch (error) {
    // Async portal failure can persist a terminal/unknown handoff state
    // before throwing. Publish that authoritative state instead of leaving
    // Ask looking as if nothing happened.
    commitDesk(desk.snapshot());
    throw error;
  }
}

async function decideCanonicalAskAction(messageId: string, decision: "allow" | "deny", selection?: string) {
  const bot = store.bot(CANONICAL_BUD_ID);
  if (!bot) throw Object.assign(new Error("Bud is unavailable."), { status: 404, code: "BUD_UNAVAILABLE" });
  const existing = store.messagesFor(bot.threadId).find((message) => message.id === messageId);
  if (!existing?.action || existing.kind !== "action") {
    throw Object.assign(new Error("That RealBud change no longer exists."), { status: 404, code: "ACTION_NOT_FOUND" });
  }
  try {
    const result = await decideAskAction(existing.action, decision, {
      desk,
      loops: loops!,
      portalMode: PILOT_CONTRACT.demo ? "practice" : "pilot",
      prepareHandoff: prepareDeskHandoff,
      workRoutingPlan: currentWorkRoutingPlan,
      ...(selection ? { selection } : {}),
    });
    const message = store.patchMessage(bot.threadId, existing.id, { action: result.proposal });
    if (!message) throw Object.assign(new Error("That RealBud change no longer exists."), { status: 404, code: "ACTION_NOT_FOUND" });
    if (result.snapshot) commitDesk(result.snapshot);
    broadcast({ kind: "message.patch", threadId: bot.threadId, message });
    return { message, ...result };
  } catch (error) {
    const status = (error as { status?: number }).status ?? 400;
    const code = String((error as { code?: string }).code ?? "");
    if (status === 404 || /revision|settled|handoff_failed/i.test(code)) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 240);
      const message = store.patchMessage(bot.threadId, existing.id, {
        action: { ...existing.action, status: "stale", failure: detail },
      });
      if (message) broadcast({ kind: "message.patch", threadId: bot.threadId, message });
    }
    throw error;
  }
}

function waitForPocketTurn(threadId: string): {
  promise: Promise<void>;
  fail: (message: string) => void;
  cancel: () => void;
} {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let unsubscribe = () => {};
  const timer = setTimeout(() => finish(new Error("Bud is still working. Open Ask to follow the turn; Pocket did not start it again.")), 5 * 60_000);
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe();
    if (error) rejectPromise(error);
    else resolvePromise();
  };
  unsubscribe = bus.subscribe((event) => {
    if (event.threadId === threadId && event.type === "turn.completed") finish();
  });
  return {
    promise,
    fail: (message) => finish(new Error(message)),
    cancel: () => finish(new Error("Pocket turn cancelled.")),
  };
}

async function runPocketAsk(text: string): Promise<PocketTurnReply> {
  const bud = store.bot(CANONICAL_BUD_ID);
  if (!bud) throw new Error("Bud is unavailable on this RealBud desk.");
  if (bud.busy) throw new Error("Bud is already working. This mobile request was not started twice; wait for the current Ask turn and send it again.");
  const threadId = bud.threadId;
  const before = store.messagesFor(threadId).length;
  const settled = waitForPocketTurn(threadId);
  try {
    await startTurn(bud.id, text, {
      threadId,
      onDispatchError: settled.fail,
    });
    await settled.promise;
  } catch (error) {
    settled.cancel();
    throw error;
  }
  const generated = store.messagesFor(threadId).slice(before);
  const actionMessage = generated.findLast((message) => message.role === "bot" && message.kind === "action" && message.action?.status === "pending");
  const prose = generated
    .filter((message) => message.role === "bot" && message.kind === "text" && message.text?.trim())
    .map((message) => message.text!.trim())
    .join("\n\n");
  if (actionMessage?.action) {
    const approval = askActionApprovalCopy(actionMessage.action);
    return {
      text: prose,
      action: {
        messageId: actionMessage.id,
        title: actionMessage.action.title,
        detail: actionMessage.action.detail,
        permission: approval.permission,
        boundary: approval.boundary,
      },
    };
  }
  if (prose) return { text: prose };
  const failure = generated.findLast((message) => message.role === "bot" && message.kind === "activity" && message.tool?.ok === false);
  throw new Error(failure?.tool?.name.replace(/^error:\s*/i, "") || "Bud did not produce a mobile reply. Open Ask to review the turn.");
}

async function decidePocketAction(messageId: string, decision: "allow" | "deny"): Promise<string> {
  const result = await decideCanonicalAskAction(messageId, decision);
  const title = result.message.action?.title ?? "RealBud change";
  if (decision === "deny") return `Nothing ran. Bud closed ${title} without applying it.`;
  if (result.navigation) {
    return `Bud completed the allowed step: ${title}. RealBud opened the connection card in Ask; no credential or connection was enabled automatically. This Allow was used once.`;
  }
  return `Bud completed the allowed step: ${title}. The authoritative result is now on RealBud. This Allow was used once; future work still needs Allow.`;
}

async function pocketLocalStatus(): Promise<string> {
  const bud = store.bot(CANONICAL_BUD_ID);
  const snapshot = desk.snapshot();
  const pending = bud
    ? store.messagesFor(bud.threadId).filter((message) => message.kind === "action" && message.action?.status === "pending").length
    : 0;
  const model = modelStatus();
  return [
    "RealBud is open on the desktop.",
    `Bud: ${bud && model.keyPresent && model.model ? (bud.busy ? "working" : "ready") : "setup required"}.`,
    `Desk: ${snapshot.mode === "demo" ? "Demo" : "Live"}, revision ${snapshot.revision}.`,
    `${pending} change${pending === 1 ? "" : "s"} waiting for Allow.`,
  ].join(" ");
}

function pocketRuntimeConfig() {
  const pocket = cfg.pocket;
  return {
    pilotReady: pocketPilotReady(PILOT_CONTRACT),
    telegram: {
      enabled: Boolean(pocket?.telegramEnabled ?? pocket?.enabled),
      token: pocket?.telegramKey ?? pocket?.key,
      allowedUserId: pocket?.telegramAllowedUserId ?? pocket?.allowedUserId,
    },
    whatsappCloud: {
      enabled: Boolean(pocket?.whatsappCloudEnabled),
      accessToken: pocket?.whatsappCloudAccessToken,
      appSecret: pocket?.whatsappCloudAppSecret,
      verifyToken: pocket?.whatsappCloudVerifyToken,
      phoneNumberId: pocket?.whatsappCloudPhoneNumberId,
      allowedUserId: pocket?.whatsappCloudAllowedUserId,
      webhookPort: pocket?.whatsappCloudWebhookPort,
      graphVersion: pocket?.whatsappCloudGraphVersion,
    },
  };
}

function pendingAskBookProposalIds(): Set<string> {
  if (!PRODUCT_MODE) return new Set();
  const bud = store.bot(CANONICAL_BUD_ID);
  if (!bud) return new Set();
  return new Set(store.messagesFor(bud.threadId).flatMap((message) =>
    message.kind === "action" && message.action?.status === "pending" && message.action.kind === "add-property"
      ? message.action.bookProposalIds
      : [],
  ));
}

function deskMutationError(res: ServerResponse, error: unknown) {
  const status = (error as { status?: number })?.status ?? 500;
  const code = (error as { code?: string })?.code;
  if (code === "commit-outcome-unknown") {
    const snapshot = desk.snapshot();
    commitDesk(snapshot);
    return json(res, status, { error: error instanceof Error ? error.message : String(error), snapshot });
  }
  if (code === "provider-unavailable") {
    const current = store.bot((error as { botId?: string }).botId ?? "");
    return json(res, status, {
      error: error instanceof Error ? error.message : String(error),
      code,
      ...(current ? { bot: publicBot(current) } : {}),
    });
  }
  return json(res, status, { error: error instanceof Error ? error.message : String(error) });
}

let installPreflight: PreflightResult | null = null;

loops = new LoopManager({
  emit: broadcast,
  execute: async (loop, run, report) => {
    return desk.withRoutineOrigin({ kind: "routine", runId: run.id, loopId: loop.id }, async () => {
      if (desk.recovery.active) {
        report({
          id: "preflight",
          label: "Check routine readiness",
          status: "failed",
          detail: "Desk recovery is protecting the current book",
        });
        return { ok: false, detail: "Desk is in recovery — schedules are paused." };
      }
      const spec = evaluatorForLoop(loop.id);
      if (spec && spec.mayLaunchCua) {
        report({
          id: "preflight",
          label: "Check routine readiness",
          status: "failed",
          detail: "Scheduled routines cannot launch computer use",
        });
        return { ok: false, detail: "The clock must not launch a browser." };
      }
      report({
        id: "preflight",
        label: "Check routine readiness",
        status: "completed",
        detail: "Desk writable · typed routine checked · computer use unavailable from the clock",
      });
      if (loop.id === "owner-letter") {
        report({ id: "collect", label: "Read Desk facts and Notes", status: "running" });
        const beforeSnapshot = desk.snapshot();
        const before = beforeSnapshot.drafts.filter((d) => d.kind === "owner-letter").length;
        report({
          id: "collect",
          label: "Read Desk facts and Notes",
          status: "completed",
          detail: `${beforeSnapshot.properties.length} properties checked; Notes can colour wording only`,
        });
        report({ id: "evaluate", label: "Draft factual owner updates", status: "running" });
        const snapshot = desk.draftOwnerLetters();
        const after = snapshot.drafts.filter((d) => d.kind === "owner-letter").length;
        report({
          id: "evaluate",
          label: "Draft factual owner updates",
          status: "completed",
          detail: `${after - before} new this week; every draft still needs Allow`,
        });
        report({ id: "stage-desk", label: "Put review work on Desk", status: "running" });
        commitDesk(snapshot);
        report({
          id: "stage-desk",
          label: "Put review work on Desk",
          status: "completed",
          detail: `${after} owner letter${after === 1 ? "" : "s"} visible on Desk`,
        });
        return { ok: true, detail: `Owner letters on Desk: ${after} (${after - before} new this week).` };
      }
      if (loop.id !== "morning-arrears") {
        report({ id: "collect", label: "Read the named source", status: "skipped", detail: "This routine is declared but not built" });
        return { ok: false, detail: "This routine is not built yet." };
      }
      const before = desk.snapshot();
      report({
        id: "collect",
        label: before.mode === "demo" ? "Read practice money facts" : "Read the current money source",
        status: "running",
      });
      const snapshot = before.mode === "demo"
        ? desk.runMorningCheck()
        : desk.runMorningCheckFromCurrentSource();
      const sourceHeld = snapshot.hands === "held";
      report({
        id: "collect",
        label: before.mode === "demo" ? "Read practice money facts" : "Read the current money source",
        status: sourceHeld ? "failed" : "completed",
        detail: snapshot.handsDetail ?? (sourceHeld ? "The source needs attention" : "Source facts collected"),
      });
      report({
        id: "evaluate",
        label: "Validate evidence and shop rules",
        status: sourceHeld ? "skipped" : "completed",
        detail: sourceHeld
          ? "No trustworthy source facts were used for new wording"
          : `${snapshot.results.length} properties classified; Notes were not read`,
      });
      report({ id: "stage-desk", label: "Put exceptions on Desk", status: "running" });
      commitDesk(snapshot);
      const linked = snapshot.workItems.filter((item) => item.origin?.runId === run.id).length;
      report({
        id: "stage-desk",
        label: "Put exceptions on Desk",
        status: "completed",
        detail: sourceHeld ? "The source hold is visible on Desk" : `${linked} linked item${linked === 1 ? "" : "s"} on Desk`,
      });
      if (sourceHeld) return { ok: false, detail: snapshot.handsDetail ?? "The current source is held." };
      if (snapshot.mode === "demo") return { ok: true, detail: snapshot.handsDetail ?? "Demo check completed." };
      const live = snapshot.hands === "hermes" || snapshot.hands === "csv";
      return { ok: live, detail: snapshot.handsDetail ?? (live ? "Desk check completed." : "Live check did not use live facts.") };
    });
  },
});
loops.start();
recoverInterruptedAskAdmissions();

pocketGateway = new PocketHub({
  stateDir: DATA_DIR,
  handlers: {
    onText: runPocketAsk,
    onDecision: decidePocketAction,
    onStatus: pocketLocalStatus,
  },
  onStatusChange: () => {
    broadcast({ kind: "config", ...configStatus() });
  },
});
// Never hold server startup on a third-party network. The safe status is
// available immediately and the connector reports ready/attention by SSE.
void pocketGateway.configure(pocketRuntimeConfig());

// ── config hot-reload ─────────────────────────────────────────────────
// ── group turn engine ──────────────────────────────────────────────────
// Room messages go to the configured default responder unless the user
// explicitly @mentions members. Responders run SEQUENTIALLY (one speaker at
// a time — the transcript and streaming bubble stay coherent), each on a
// fresh session with recent room context. A member's reply may @mention
// teammates; those get one chained turn (hop 1), never deeper.
const groupQueues = new Map<string, Promise<void>>();
const GROUP_CONTEXT_MESSAGES = 30;
const MAX_GROUP_HOPS = 1;

function serializeRoomContext(threadId: string, userName: string): string {
  return store
    .messagesFor(threadId)
    .filter((m) => m.kind === "text" && m.text)
    .slice(-GROUP_CONTEXT_MESSAGES)
    .map((m) => `${m.role === "user" ? userName : (m.from?.name ?? "Bot")}: ${m.text}`)
    .join("\n");
}

function broadcastGroup(groupId: string) {
  const group = store.group(groupId);
  if (group) broadcast({ kind: "group", group });
}

async function runGroupMemberTurn(
  groupId: string,
  botId: string,
  hop: number,
  // bots that already spoke for this user message — "@Scout ask @Pixel"
  // must not run Pixel twice (once chained, once as a direct responder)
  spoken: Set<string> = new Set(),
): Promise<void> {
  const group = store.group(groupId);
  const bot = store.bot(botId);
  if (!group || !bot) return;
  spoken.add(botId);
  const instance = registry.get(bot.modelSelection.instanceId);
  const userName = cfg.profile?.name?.trim() || "User";
  if (!instance) {
    const failure = store.appendMessage(group.threadId, {
      role: "bot",
      kind: "activity",
      from: { botId: bot.id, name: bot.name, color: bot.color },
      tool: { name: `error: ${bot.name}'s model is unavailable`, ok: false },
    });
    broadcast({ kind: "message", threadId: group.threadId, message: failure });
    return;
  }

  store.patchGroup(group.id, { busyBotId: bot.id });
  watchdog.watch(group.threadId, bot.id);
  broadcastGroup(group.id);
  groupSpeakers.set(group.threadId, { botId: bot.id, name: bot.name, color: bot.color });

  const roster = group.memberIds
    .map((id) => store.bot(id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b))
    .map((b) => `@${b.name}${b.title ? ` (${b.title})` : ""}`)
    .join(", ");
  const system = [
    `You are ${bot.name}, a bot in the room "${group.name}" in RealBud.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
    `Room members: ${roster}, and ${userName} (the human).`,
    group.bulletin.trim() && `Room bulletin (shared instructions for everyone):\n${group.bulletin.trim()}`,
    `Reply as yourself, briefly and conversationally. To bring a teammate in, mention them like @Name — they'll see the conversation and respond.`,
  ]
    .filter(Boolean)
    .join("\n");

  const text = `${serializeRoomContext(group.threadId, userName)}\n\n(Reply to the conversation above as ${bot.name}.)`;

  // run the turn and wait for it to settle, folding the reply text so a
  // chained @mention can be routed afterwards
  let replyText = "";
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const unsub = bus.subscribe((e: RuntimeEvent) => {
      if (e.threadId !== group.threadId) return;
      if (e.type === "item.completed" && e.itemType === "assistant_text") replyText += `\n${e.text}`;
      else if (e.type === "turn.completed") finish();
    });
    const timer = setTimeout(finish, 5 * 60_000);
    instance.adapter
      .sendTurn({ threadId: group.threadId, text, system })
      .catch((err) => {
        const failure = store.appendMessage(group.threadId, {
          role: "bot",
          kind: "activity",
          from: { botId: bot.id, name: bot.name, color: bot.color },
          tool: { name: `error: ${err instanceof Error ? err.message.slice(0, 140) : "turn failed"}`, ok: false },
        });
        broadcast({ kind: "message", threadId: group.threadId, message: failure });
        finish();
      });
  });
  watchdog.settle(group.threadId);
  groupSpeakers.delete(group.threadId);
  store.patchGroup(group.id, { busyBotId: null, unread: true });
  broadcastGroup(group.id);

  // chained mentions: a member's reply can summon teammates — one hop only
  if (hop < MAX_GROUP_HOPS && replyText.trim()) {
    const members = group.memberIds
      .map((id) => store.bot(id))
      .filter((b): b is NonNullable<typeof b> => Boolean(b) && b!.id !== bot.id);
    for (const next of roomResponders(replyText, members, { kind: "mentions" })) {
      if (spoken.has(next.id)) continue;
      await runGroupMemberTurn(groupId, next.id, hop + 1, spoken);
    }
  }
}

function startGroupTurn(groupId: string, text: string) {
  const group = store.group(groupId);
  if (!group) throw Object.assign(new Error("no such group"), { status: 404 });
  const userMessage = store.appendMessage(group.threadId, { role: "user", kind: "text", text });
  broadcast({ kind: "message", threadId: group.threadId, message: userMessage });

  const members = group.memberIds
    .map((id) => store.bot(id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  let responders = roomResponders(text, members, group.defaultResponder);
  // bot⇄bot channels: chipping in without a tag addresses the last speaker
  if (!responders.length && group.dm) {
    const lastSpeakerId = [...store.messagesFor(group.threadId)]
      .reverse()
      .find((msg) => msg.kind === "text" && msg.from)?.from?.botId;
    const last = members.find((b) => b.id === lastSpeakerId) ?? members[0];
    responders = last ? [last] : [];
  }
  if (!responders.length) return;

  const prev = groupQueues.get(groupId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const spoken = new Set<string>();
    for (const responder of responders) {
      if (spoken.has(responder.id)) continue;
      await runGroupMemberTurn(groupId, responder.id, 0, spoken);
    }
  });
  groupQueues.set(groupId, next.catch(() => {}));
}

function configStatus() {
  const pocket = pocketGateway?.status() ?? {
    provider: "multi-channel" as const,
    configured: false,
    enabled: false,
    pilotReady: pocketPilotReady(PILOT_CONTRACT),
    state: pocketPilotReady(PILOT_CONTRACT) ? "off" as const : "pilot-gated" as const,
    detail: pocketPilotReady(PILOT_CONTRACT) ? "Connect a private PM messaging channel." : "Name the pilot agency and PM before Pocket can connect.",
    connectedCount: 0,
    channels: {
      telegram: {
        provider: "telegram" as const,
        configured: Boolean((cfg.pocket?.telegramKey ?? cfg.pocket?.key) && normalizeTelegramUserId(cfg.pocket?.telegramAllowedUserId ?? cfg.pocket?.allowedUserId)),
        enabled: Boolean(cfg.pocket?.telegramEnabled ?? cfg.pocket?.enabled),
        pilotReady: pocketPilotReady(PILOT_CONTRACT),
        state: pocketPilotReady(PILOT_CONTRACT) ? "off" as const : "pilot-gated" as const,
        detail: pocketPilotReady(PILOT_CONTRACT) ? "Telegram is off." : "Name the pilot agency and PM before Telegram can connect.",
        allowedUserId: normalizeTelegramUserId(cfg.pocket?.telegramAllowedUserId ?? cfg.pocket?.allowedUserId) ?? "",
        botUsername: null,
        lastInboundAt: null,
        deliveryUncertain: false,
      },
      whatsappCloud: {
        provider: "whatsapp-cloud" as const,
        configured: Boolean(
          cfg.pocket?.whatsappCloudAccessToken && cfg.pocket?.whatsappCloudAppSecret &&
          cfg.pocket?.whatsappCloudVerifyToken && cfg.pocket?.whatsappCloudPhoneNumberId &&
          cfg.pocket?.whatsappCloudAllowedUserId
        ),
        enabled: Boolean(cfg.pocket?.whatsappCloudEnabled),
        pilotReady: pocketPilotReady(PILOT_CONTRACT),
        state: pocketPilotReady(PILOT_CONTRACT) ? "off" as const : "pilot-gated" as const,
        detail: pocketPilotReady(PILOT_CONTRACT) ? "WhatsApp Business is off." : "Name the pilot agency and PM before WhatsApp Business can connect.",
        allowedUserId: normalizeWhatsAppUserId(cfg.pocket?.whatsappCloudAllowedUserId) ?? "",
        phoneNumberId: normalizeWhatsAppPhoneNumberId(cfg.pocket?.whatsappCloudPhoneNumberId) ?? "",
        displayPhoneNumber: null,
        verifiedName: null,
        webhookPort: normalizeWhatsAppWebhookPort(cfg.pocket?.whatsappCloudWebhookPort) ?? 8090,
        webhookPath: "/whatsapp/webhook",
        webhookVerifiedAt: null,
        lastInboundAt: null,
        deliveryUncertain: false,
      },
    },
  };
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
    linkedTools: listLinkedTools(),
    box: { configured: Boolean(cfg.box?.token) },
    // the chosen voice is a setting, not a secret; the key is reported the
    // same configured-or-not way as every other credential
    tts: tts.describeVoice(cfg),
    pocket,
    // not a secret — the sidebar shows it
    profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
    localRecovery: localStateRecoveryStatus(),
  };
}

function currentWorkRoutingPlan(snapshot = desk.snapshot()) {
  const savedPreference = normalizeWorkRoutingPreference(cfg.workRouting?.preference);
  const rawRevision = cfg.workRouting?.revision;
  const preferenceRevision = typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0
    ? rawRevision
    : 0;
  return currentBookWorkRoutingPlan(
    snapshot,
    undefined,
    executionAdapters.workRoutingCapabilities(),
    savedPreference ?? "auto",
    savedPreference !== null,
    preferenceRevision,
  );
}

function normalizePmProfile(body: unknown): { name: string; email: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("profile must be a JSON object"), { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "name" && key !== "email");
  if (unknown.length) {
    throw Object.assign(new Error("profile accepts only name and email"), { status: 400 });
  }
  if (typeof record.name !== "string") {
    throw Object.assign(new Error("name must be a string"), { status: 400 });
  }
  if (record.email !== undefined && typeof record.email !== "string") {
    throw Object.assign(new Error("email must be a string"), { status: 400 });
  }
  const name = record.name.trim();
  const email = String(record.email ?? "").trim().toLowerCase();
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw Object.assign(new Error("name must be between 1 and 120 characters on one line"), { status: 400 });
  }
  if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(email))) {
    throw Object.assign(new Error("enter a valid office email or leave it blank"), { status: 400 });
  }
  return { name, email };
}

function localStateRecoveryStatus() {
  const configuration = configRecoveryStatus();
  const assistant = store.recoveryStatus();
  const routine = loops?.recoveryStatus();
  const issues = [
    ...(configuration.action === "none" ? [] : [{ area: "configuration", action: configuration.action, detail: configuration.detail }]),
    ...assistant.issues,
    ...(routine && routine.action !== "none" ? [{ area: "routine clock", action: routine.action, detail: routine.detail }] : []),
  ];
  return {
    active: configuration.active || assistant.active || Boolean(routine?.active),
    issues,
  };
}

async function workerStatus() {
  const install = installStatus();
  if (install.state === "done") {
    workerRuntimeRecovery = {
      action: "none",
      detail: install.rollback === "available"
        ? "The active worker is isolated and one previous runtime is available for rollback."
        : "The worker runtime is isolated inside RealBud.",
      previousAvailable: install.rollback === "available",
    };
  }
  const engine = await hermesStatus();
  const recoveryBlocks = workerRuntimeRecovery.action === "attention";
  return {
    ...engine,
    ...(recoveryBlocks ? { ready: false, detail: workerRuntimeRecovery.detail } : {}),
    runtimeRecovery: workerRuntimeRecovery,
    modelRecovery: modelAttachmentRecovery,
    // Safe setup metadata only. Keys are never returned; keyHint stays masked.
    model: modelStatus(),
  };
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
  // A killed turn's terminal events can die with the old fleet (dispose is
  // async under the hood), stranding the bot busy — and its screen poller —
  // forever. Settle anything still marked busy.
  for (const b of store.bots.filter((b) => b.busy)) {
    releaseWorkerTurn(b.threadId);
    stopScreenPoller(b.id);
    const note = store.appendMessage(b.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: "error: turn interrupted — provider settings changed", ok: false },
    });
    broadcast({ kind: "message", threadId: b.threadId, message: note });
    store.patchBot(b.id, { busy: false });
    broadcast({ kind: "bot", bot: store.bot(b.id) });
  }
}

// ── HTTP plumbing ─────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      const err = Object.assign(new Error(msg), { status });
      reject(err);
    };
    req.on("data", (c) => {
      if (done) return;
      bytes += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (bytes > 1_000_000) {
        // Keep draining the socket, but stop retaining attacker-controlled
        // bytes. Destroying the request here prevents the caller from
        // receiving the useful 413 response.
        return fail(413, "body too large");
      }
      data += c;
    });
    req.on("end", () => {
      if (done) return;
      let body: any;
      try {
        body = data ? JSON.parse(data) : {};
      } catch {
        return fail(400, "invalid JSON body");
      }
      done = true;
      resolve(body);
    });
    req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (needsSession(path)) {
      const gate = sessionOk(req, PORT);
      if (!gate.ok) return json(res, gate.status, { error: gate.error });
    } else if (path.startsWith("/api/") && path !== "/api/health" && path !== "/api/session" && !path.startsWith("/api/internal/")) {
      const gate = sessionOk(req, PORT);
      if (!gate.ok && gate.status === 403) return json(res, 403, { error: gate.error });
    }
    const denied = productDenied(method, path);
    if (denied) return json(res, 403, { error: denied });

    if (path === "/api/session" && method === "GET") {
      const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      if (!hostAllowed(host, PORT) || !originAllowed(origin, PORT)) {
        return json(res, 403, { error: "refused host or origin" });
      }
      return json(res, 200, {
        token: SESSION_TOKEN,
        product: PRODUCT_MODE,
        nonProduction: process.env.REALBUD_PRODUCTION !== "1",
        release: supportRuntimeLabels({
          productMode: PRODUCT_MODE,
          pilotContractComplete: pilotContractComplete(PILOT_CONTRACT),
        }),
      });
    }

    // ── internal peer-agent comms (localhost + shared token only) ──────
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (path.startsWith("/api/internal/")) {
      if (!commsAuthorized(req.headers.authorization)) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (method === "GET" && path === "/api/internal/agents") {
        const self = url.searchParams.get("self");
        // title/description included so a "chief of staff"-style bot can
        // judge the team (who does what, who has no job description yet)
        const bots = store.bots
          .filter((b) => b.id !== self && !b.hidden)
          .map((b) => ({
            id: b.id,
            name: b.name,
            model: b.modelSelection.model,
            busy: !!b.busy,
            title: b.title || undefined,
            description: b.description || undefined,
          }));
        return json(res, 200, { bots });
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
        if (toBotId === fromBotId) return json(res, 400, { error: "a bot cannot message itself" });
        if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: "message chains are limited to one hop" });
        const target = store.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        if (target.busy) return json(res, 200, { busy: true });
        const from = store.bot(fromBotId);
        const fromName = from?.name ?? "another bot";

        // the exchange is mirrored into a bot⇄bot channel: it shows up in
        // the sidebar like any room, keeps the pair's full history, and the
        // user can open it and chip in
        let channel = from ? store.dmGroup(from.id, target.id) : undefined;
        if (from && !channel) {
          channel = store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true);
        }
        const mirror = (speaker: { id: string; name: string; color: string }, text: string) => {
          if (!channel || !text.trim()) return;
          const msg = store.appendMessage(channel.threadId, {
            role: "bot",
            kind: "text",
            text,
            from: { botId: speaker.id, name: speaker.name, color: speaker.color },
          });
          broadcast({ kind: "message", threadId: channel.threadId, message: msg });
        };
        // both 1:1 threads get a clickable chip that opens the channel, so
        // bot-to-bot turns are never invisible (they cost the user tokens)
        const chip = (
          threadId: string,
          label: string,
          withBot: { id: string; name: string; color: string },
        ) => {
          const note = store.appendMessage(threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: label },
            comm: channel
              ? { groupId: channel.id, withBotId: withBot.id, withName: withBot.name, withColor: withBot.color }
              : undefined,
          });
          broadcast({ kind: "message", threadId, message: note });
        };
        if (from) {
          mirror(from, message);
          chip(from.threadId, `Messaged @${target.name}`, target);
          chip(target.threadId, `Message from @${from.name}`, from);
          if (channel) {
            store.patchGroup(channel.id, { unread: true });
            broadcastGroup(channel.id);
          }
        }
        const prefixed = `[Message from @${fromName}, another bot in this RealBud workspace. Reply to them.]\n\n${message}`;
        const reply = await askBotAndWait(toBotId, prefixed, depth);
        if (from) {
          mirror(target, reply);
          if (channel) {
            store.patchGroup(channel.id, { unread: true });
            broadcastGroup(channel.id);
          }
        }
        return json(res, 200, { botName: target.name, text: reply });
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }

    // ── named loops (RealBud clock; never a bot, never Hermes cron) ─────
    if (path === "/api/source-connections" && method === "GET") {
      return json(res, 200, {
        connections: sourceConnectionCatalog(desk.snapshot(), PILOT_CONTRACT, {
          bankAdapterConfigured: Boolean(BANK_ALLOWED_ORIGIN),
          aliases: loadConnectionAliases(DATA_DIR),
        }),
      });
    }
    if (path === "/api/source-connections/aliases" && method === "PATCH") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        const aliases = setConnectionAlias(DATA_DIR, String(body.id ?? ""), String(body.alias ?? ""));
        return json(res, 200, {
          aliases,
          connections: sourceConnectionCatalog(desk.snapshot(), PILOT_CONTRACT, {
            bankAdapterConfigured: Boolean(BANK_ALLOWED_ORIGIN),
            aliases,
          }),
        });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === "/api/office-sources" && method === "GET") {
      const requested = parseOfficeSourceServices(url.searchParams.get("services"));
      const linked = listLinkedTools();
      const slugs = requested.length ? requested : linked.map((row) => row.slug);
      const local: Record<string, { connected: boolean; status: string; method?: string; label?: string }> = {};
      for (const slug of slugs) {
        const row = linked.find((item) => item.slug === slug);
        local[slug] = row
          ? { connected: true, status: "active", method: row.method, label: row.label }
          : { connected: false, status: "unknown" };
      }
      if (!cfg.composio?.key) return json(res, 200, { configured: false, services: local });
      if (slugs.length === 0) return json(res, 200, { configured: true, services: {} });
      try {
        const remote = await composio.connectionStatus(cfg, slugs);
        const services: Record<string, { connected: boolean; status: string; method?: string; label?: string }> = {};
        for (const slug of slugs) {
          const composioConnected = Boolean(remote[slug]?.connected);
          if (composioConnected) {
            saveLinkedComposioTool({ slug, label: local[slug]?.label });
          }
          services[slug] = {
            connected: composioConnected || Boolean(local[slug]?.connected),
            status: composioConnected ? (remote[slug]?.status ?? "active") : (local[slug]?.status ?? "unknown"),
            method: composioConnected ? "composio" : local[slug]?.method,
            label: local[slug]?.label,
          };
        }
        return json(res, 200, { configured: true, services });
      } catch (error) {
        if (slugs.length && slugs.every((slug) => local[slug]?.connected)) {
          return json(res, 200, { configured: true, services: local });
        }
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const officeAuthorize = path.match(/^\/api\/office-sources\/([\w-]+)\/authorize$/);
    if (officeAuthorize && method === "POST") {
      const slug = officeAuthorize[1] ?? "";
      if (!isSafeToolkitSlug(slug)) {
        return json(res, 404, { error: "That tool name is not usable." });
      }
      if (!cfg.composio?.key) {
        return json(res, 409, { error: "Login to Composio, then paste the Connect key." });
      }
      try {
        return json(res, 200, await composio.authorizeService(cfg, slug));
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const officeTool = path.match(/^\/api\/office-sources\/([\w-]+)$/);
    if (officeTool && (method === "PUT" || method === "DELETE")) {
      const slug = officeTool[1] ?? "";
      if (!isSafeToolkitSlug(slug)) {
        return json(res, 404, { error: "That tool name is not usable." });
      }
      try {
        if (method === "DELETE") {
          removeLinkedTool(slug);
        } else {
          if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            return json(res, 415, { error: "content-type must be application/json" });
          }
          const body = await readBody(req);
          const key = String(body.key ?? "");
          const checked = await verifyToolKey(slug, key);
          if (!checked.ok) {
            return json(res, 400, { error: checked.error, code: "TOOL_KEY_REJECTED" });
          }
          saveLinkedToolKey({
            slug,
            key,
            label: typeof body.label === "string" ? body.label : undefined,
            account: checked.account,
          });
        }
        const status = configStatus();
        broadcast({ kind: "config", ...status });
        return json(res, 200, { ok: true, config: status, tools: status.linkedTools });
      } catch (error) {
        const code = (error as { status?: number }).status ?? 400;
        return json(res, code, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === "/api/ask-attachments" && method === "POST") {
      const rawName = req.headers["x-realbud-filename"];
      const encoded = typeof rawName === "string" ? rawName.trim() : "";
      let filename = "";
      try {
        filename = encoded ? decodeURIComponent(encoded) : "";
      } catch {
        return json(res, 400, { error: "that file name is not usable" });
      }
      try {
        return json(res, 201, await stageComposerInboxFile({ filename, body: req }));
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === "/api/pilot-discovery" && method === "GET") {
      return json(res, 200, { discovery: pilotDiscoveryProjection(PILOT_CONTRACT) });
    }
    if (path === "/api/execution-adapters" && method === "GET") {
      return json(res, 200, { adapters: executionAdapters.snapshot() });
    }
    if (path === "/api/support-report" && method === "GET") {
      let worker: SupportWorkerInput | null = null;
      let workerBusy = false;
      try {
        worker = await withWorkerOperation(
          "diagnostics",
          "preparing a support report",
          () => workerStatus(),
          { allowRecovery: true },
        );
      } catch (error) {
        workerBusy = (error as { status?: number }).status === 409;
      }
      const snapshot = desk.queueSnapshot();
      const configuration = configStatus();
      return json(res, 200, createSupportReport({
        productMode: PRODUCT_MODE,
        pilotContractComplete: pilotContractComplete(PILOT_CONTRACT),
        desk: snapshot,
        worker,
        workerBusy,
        loops: loops!.listLoops(),
        loopRuns: loops!.listRuns(),
        routineRecoveryActive: loops!.recoveryStatus().active,
        connections: sourceConnectionCatalog(snapshot, PILOT_CONTRACT, {
          bankAdapterConfigured: Boolean(BANK_ALLOWED_ORIGIN),
        }),
        execution: executionAdapters.snapshot(),
        mobile: {
          state: configuration.pocket.state,
          connectedCount: configuration.pocket.connectedCount,
        },
        localRecovery: configuration.localRecovery,
      }));
    }
    if (path === "/api/work-routing" && method === "GET") {
      return json(res, 200, { plan: currentWorkRoutingPlan() });
    }
    if (path === "/api/work-routing/preference" && method === "PATCH") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "work preference must be a JSON object" });
      }
      const record = body as Record<string, unknown>;
      const unknown = Object.keys(record).filter((key) => (
        key !== "preference" && key !== "expectedPreference" && key !== "expectedRevision"
      ));
      if (unknown.length) {
        return json(res, 400, { error: "work preference accepts only preference, expectedPreference and expectedRevision" });
      }
      const preference = normalizeWorkRoutingPreference(record.preference);
      const expectedPreference = normalizeWorkRoutingPreference(record.expectedPreference);
      const expectedRevision = record.expectedRevision;
      if (
        !preference || !expectedPreference || typeof expectedRevision !== "number"
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      ) {
        return json(res, 400, { error: "choose Automatic, Steady on this Mac, Faster on this Mac, or Cloud when connected" });
      }

      const saved = normalizeWorkRoutingPreference(cfg.workRouting?.preference);
      const currentPreference = saved ?? "auto";
      const rawRevision = cfg.workRouting?.revision;
      const currentRevision = typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0
        ? rawRevision
        : 0;
      if (expectedPreference !== currentPreference || expectedRevision !== currentRevision) {
        return json(res, 409, {
          error: "Your work preference changed in another window. RealBud kept the newer choice; review it and try again.",
        });
      }
      if (currentRevision === Number.MAX_SAFE_INTEGER) {
        return json(res, 409, { error: "The work preference revision is exhausted. Restart setup before changing it again." });
      }
      if (saved === null || preference !== currentPreference) {
        saveConfig({ workRouting: { preference, revision: currentRevision + 1 } });
        Object.assign(cfg, loadConfig());
      }
      return json(res, 200, { plan: currentWorkRoutingPlan() });
    }
    if (path === "/api/loops" && method === "GET") {
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      const from = fromParam == null ? undefined : Number(fromParam);
      const to = toParam == null ? undefined : Number(toParam);
      return json(res, 200, {
        loops: loops!.listLoops(),
        runs: loops!.listRuns(from != null && Number.isFinite(from) ? from : undefined, to != null && Number.isFinite(to) ? to : undefined),
        recovery: loops!.recoveryStatus(),
      });
    }
    let loopMatch = path.match(/^\/api\/loops\/([\w-]+)\/run$/);
    if (loopMatch && method === "POST") {
      const loop = loops!.listLoops().find((candidate) => candidate.id === loopMatch![1]);
      if (!loop) return json(res, 404, { error: "no such loop" });
      if (!loop.available) return json(res, 409, { error: "that loop is declared but not built yet" });
      try {
        const run = loops!.runNow(loopMatch[1] as LoopId);
        return run ? json(res, 201, { run }) : json(res, 409, { error: "enable this loop before running it" });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    loopMatch = path.match(/^\/api\/loops\/([\w-]+)$/);
    if (loopMatch && method === "PATCH") {
      const body = await readBody(req);
      if (body.enabled === undefined && body.time === undefined && body.weekdays === undefined) {
        return json(res, 400, { error: "nothing to change — send enabled, time, or weekdays" });
      }
      if (!Number.isInteger(body.expectedRevision)) {
        return json(res, 400, { error: "expectedRevision is required" });
      }
      try {
        const loop = loops!.patchClock(loopMatch[1] as LoopId, {
          enabled: body.enabled,
          time: body.time,
          weekdays: body.weekdays,
          expectedRevision: body.expectedRevision as number,
        });
        return json(res, 200, { loop });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const loopRunSeen = path.match(/^\/api\/loop-runs\/([\w-]+)\/seen$/);
    if (loopRunSeen && method === "POST") {
      const run = loops!.markSeen(loopRunSeen[1]);
      return run ? json(res, 200, { run }) : json(res, 404, { error: "no such run" });
    }
    const loopRunNotified = path.match(/^\/api\/loop-runs\/([\w-]+)\/notified$/);
    if (loopRunNotified && method === "POST") {
      try {
        const run = loops!.markNotified(loopRunNotified[1]);
        return run ? json(res, 200, { run }) : json(res, 404, { error: "no such run" });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // ── PM desk (never sends) ────────────────────────────────────────
    if (path === "/api/desk" && method === "GET") {
      return json(res, 200, desk.queueSnapshot());
    }
    const deskCaseDetail = path.match(/^\/api\/desk\/cases\/([\w-]+)\/detail$/);
    if (deskCaseDetail && method === "GET") {
      try {
        return json(res, 200, desk.caseSnapshot(deskCaseDetail[1]));
      } catch (error) {
        return deskMutationError(res, error);
      }
    }
    const deskPropertyDetail = path.match(/^\/api\/desk\/properties\/([\w-]+)\/detail$/);
    if (deskPropertyDetail && method === "GET") {
      try {
        return json(res, 200, desk.propertySnapshot(deskPropertyDetail[1]));
      } catch (error) {
        return deskMutationError(res, error);
      }
    }
    if (path === "/api/desk/check" && method === "POST") {
      const snapshot = await withWorkerOperation("desk", "checking the book", () => desk.runMorningCheckLive());
      commitDesk(snapshot);
      return json(res, 200, snapshot);
    }
    if (path === "/api/desk/reset" && method === "POST") {
      const snapshot = desk.resetFixtures();
      commitDesk(snapshot);
      return json(res, 200, snapshot);
    }
    if (path === "/api/desk/inbound/demo" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!Number.isInteger(body.expectedRevision)) return json(res, 400, { error: "expectedRevision is required" });
      try {
        const snapshot = desk.ingestDemoInbox(body.expectedRevision as number);
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (error) {
        return deskMutationError(res, error);
      }
    }
    if (path === "/api/desk/import-preview" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!Number.isInteger(body.expectedRevision)) {
        return json(res, 400, { error: "expectedRevision is required" });
      }
      try {
        assertPmsCsvInput(body.csv);
        if (body.expectedRevision !== desk.revision) {
          throw Object.assign(new Error("Desk changed before the export could be reviewed. Review it again."), {
            status: 409,
            code: "revision-conflict",
          });
        }
        const preview = createPmsImportPreview({
          csv: body.csv,
          observedAt: Date.now(),
          desk: desk.snapshot(),
        });
        return json(res, 200, { preview });
      } catch (error) {
        return deskMutationError(res, error);
      }
    }
    if (path === "/api/desk/import" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!Number.isInteger(body.expectedRevision)) {
        return json(res, 400, { error: "expectedRevision is required" });
      }
      try {
        assertPmsCsvInput(body.csv);
        if (body.previewDigest !== undefined) {
          if (typeof body.previewDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.previewDigest)) {
            return json(res, 400, { error: "previewDigest is invalid" });
          }
          if (pmsCsvDigest(body.csv) !== body.previewDigest) {
            return json(res, 409, { error: "The selected export changed after review. Review it again before importing." });
          }
        }
        if (!workBroker) {
          return json(res, 503, { error: "Structured import is paused because its local work queue needs recovery." });
        }
        const observedAt = typeof body.observedAt === "number" ? body.observedAt : Date.now();
        const expectedRevision = body.expectedRevision as number;
        const csvDigest = workDigest(body.csv);
        const requestId = `desk-import-${workDigest(`${expectedRevision}:${observedAt}:${csvDigest}`).slice(0, 48)}`;
        const { snapshot } = runStructuredPmsImport({
          broker: workBroker,
          desk,
          requestId,
          expectedRevision,
          aggregate: {
            kind: "realbud.structured-pms-aggregate.v1",
            schemaVersion: 1,
            observedAt,
            csv: body.csv,
          },
        });
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (e) {
        return deskMutationError(res, e);
      }
    }
    const importIssue = path.match(/^\/api\/desk\/import-issues\/([\w-]+)\/(link|reject)$/);
    if (importIssue && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!Number.isInteger(body.expectedRevision)) return json(res, 400, { error: "expectedRevision is required" });
      try {
        const snapshot = desk.resolveImportIssue({
          issueId: importIssue[1],
          action: importIssue[2] === "link" ? "linked" : "rejected",
          propertyId: typeof body.propertyId === "string" ? body.propertyId : undefined,
          expectedRevision: body.expectedRevision as number,
          requestId: typeof body.requestId === "string" ? body.requestId : undefined,
        });
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (error) {
        return deskMutationError(res, error);
      }
    }
    if (path === "/api/desk/bank-observations" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!Number.isInteger(body.expectedRevision)) {
        return json(res, 400, { error: "expectedRevision is required" });
      }
      if (!body.batch || typeof body.batch !== "object" || Array.isArray(body.batch)) {
        return json(res, 400, { error: "bank observation batch is required" });
      }
      try {
        if (!workBroker) {
          return json(res, 503, { error: "Bank observation is paused because its local work queue needs recovery." });
        }
        const batch = body.batch as BankObservationBatch;
        const expectedRevision = body.expectedRevision as number;
        validateBankObservationBatch(batch);
        if (!BANK_ALLOWED_ORIGIN) {
          return json(res, 409, { error: "No named read-only bank adapter is configured for this pilot." });
        }
        const digest = bankObservationDigest(batch);
        const requestId = `bank-observe-${workDigest(`${expectedRevision}:${digest}:${BANK_ALLOWED_ORIGIN}`).slice(0, 48)}`;
        const { snapshot } = runBankObservationImport({
          broker: workBroker,
          desk,
          requestId,
          expectedRevision,
          batch,
          allowedOrigins: [BANK_ALLOWED_ORIGIN],
        });
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (error) {
        return deskMutationError(res, error);
      }
    }
    if (path === "/api/desk/recovery-key" && method === "GET") {
      return json(res, 200, { hex: desk.recoveryKeyHex() });
    }
    if (path === "/api/desk/recovery/unlock" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        const result = desk.unlockWithKey(String(body.key ?? ""));
        return json(res, 200, { ...result, message: "Book restored. Restart RealBud to open it." });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/desk/agency" && method === "PATCH") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        const snapshot = desk.updateAgencyName(
          body.name,
          typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
        );
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (e) {
        return deskMutationError(res, e);
      }
    }
    if (path === "/api/desk/propose-book" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        const result = desk.proposeBook({ text: body.text, items: body.items }, "ask");
        return json(res, 200, { ...result, snapshot: desk.snapshot() });
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/desk/book-proposals/allow" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!Array.isArray(body.ids)) return json(res, 400, { error: "ids must be an array" });
      const owned = pendingAskBookProposalIds();
      if (body.ids.some((id: unknown) => owned.has(String(id)))) {
        return json(res, 409, { error: "Use Bud's change card to decide this property proposal." });
      }
      try {
        const snapshot = desk.allowBookProposals(
          body.ids,
          typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
        );
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (e) {
        return deskMutationError(res, e);
      }
    }
    let bookMatch = path.match(/^\/api\/desk\/book-proposals\/([\w-]+)\/(allow|deny)$/);
    if (bookMatch && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (pendingAskBookProposalIds().has(bookMatch[1])) {
        return json(res, 409, { error: "Use Bud's change card to decide this property proposal." });
      }
      try {
        const snapshot = bookMatch[2] === "allow"
          ? desk.allowBookProposal(bookMatch[1], typeof body.expectedRevision === "number" ? body.expectedRevision : undefined)
          : desk.denyBookProposal(bookMatch[1], typeof body.expectedRevision === "number" ? body.expectedRevision : undefined);
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (e) {
        return deskMutationError(res, e);
      }
    }
    if (path === "/api/desk/propose" && method === "POST") {
      const body = await readBody(req);
      const snapshot = desk.proposeFromAsk({
        propertyId: String(body.propertyId ?? ""),
        kind: body.kind === "levy-from-rent" ? "levy-from-rent" : "courtesy-rent",
        body: typeof body.body === "string" ? body.body : undefined,
        expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
      });
      commitDesk(snapshot);
      return json(res, 201, snapshot);
    }
    const deskSend = path.match(/^\/api\/desk\/drafts\/([\w-]+)\/send$/);
    if (deskSend && method === "POST") {
      return json(res, 403, {
        error: "RealBud never sends. Approve the draft and send it from the PMS.",
      });
    }
    if (path === "/api/desk/handoff/present" && method === "POST") {
      const body = await readBody(req);
      const presentation = body.presentation;
      if (presentation !== "side-by-side" && presentation !== "inspector" && presentation !== "window") {
        return json(res, 400, { error: "presentation must be side-by-side, inspector, or window" });
      }
      const before = desk.snapshot().book?.handoff?.allowedActions ?? [];
      const snapshot = desk.setPresentation(presentation);
      const after = snapshot.book?.handoff?.allowedActions ?? [];
      if (before.join("\0") !== after.join("\0") && snapshot.book?.handoff) {
        return json(res, 409, { error: "presentation cannot widen authorization" });
      }
      return json(res, 200, snapshot);
    }
    const deskPrepare = path.match(/^\/api\/desk\/drafts\/([\w-]+)\/prepare$/);
    if (deskPrepare && method === "POST") {
      if (desk.recovery.active) return json(res, 409, { error: "desk is in recovery — browser work is paused" });
      const snapshot = await prepareDeskHandoff(deskPrepare[1]);
      commitDesk(snapshot);
      return json(res, 200, snapshot);
    }
    const deskWork = path.match(/^\/api\/desk\/work\/([\w-]+)\/(confirm|unknown)$/);
    if (deskWork && method === "POST") {
      const snapshot = desk.command({
        type: deskWork[2] === "confirm" ? "confirm" : "effect-unknown",
        workItemId: deskWork[1],
        expectedRevision: desk.revision,
      });
      commitDesk(snapshot);
      return json(res, 200, snapshot);
    }
    const inboundCase = path.match(/^\/api\/desk\/cases\/([\w-]+)\/(waiting|close|snooze|cancel)$/);
    if (inboundCase && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (!Number.isInteger(body.expectedRevision)) return json(res, 400, { error: "expectedRevision is required" });
      try {
        const snapshot = inboundCase[2] === "waiting"
          ? desk.markInboundWaiting(inboundCase[1], body.expectedRevision as number)
          : inboundCase[2] === "close"
            ? desk.closeInboundCase(inboundCase[1], body.expectedRevision as number, body.closureKind)
            : inboundCase[2] === "snooze"
              ? desk.snoozeCase(inboundCase[1], body.expectedRevision as number, body.until as number)
              : desk.cancelCase(inboundCase[1], body.expectedRevision as number, body.closureKind);
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (error) {
        return deskMutationError(res, error);
      }
    }
    const deskDraft = path.match(/^\/api\/desk\/drafts\/([\w-]+)\/(allow|deny)$/);
    if (deskDraft && method === "POST") {
      let expected: number | undefined;
      if (String(req.headers["content-type"] ?? "").toLowerCase().includes("json")) {
        const body = await readBody(req);
        if (typeof body.expectedRevision === "number") expected = body.expectedRevision;
      }
      const draft = deskDraft[2] === "allow" ? desk.allowDraft(deskDraft[1], expected) : desk.denyDraft(deskDraft[1], expected);
      commitDesk(desk.snapshot());
      return json(res, 200, { draft });
    }
    const deskEdit = path.match(/^\/api\/desk\/drafts\/([\w-]+)$/);
    if (deskEdit && method === "PATCH") {
      const body = await readBody(req);
      const draft = desk.editDraft(deskEdit[1], String(body.body ?? ""));
      commitDesk(desk.snapshot());
      return json(res, 200, { draft });
    }
    const deskNotes = path.match(/^\/api\/desk\/properties\/([\w-]+)\/notes$/);
    if (deskNotes && method === "GET") {
      return json(res, 200, desk.notesFor(deskNotes[1]));
    }
    if (deskNotes && method === "PUT") {
      const body = await readBody(req);
      const note = desk.writeNotes(deskNotes[1], String(body.body ?? ""));
      commitDesk(desk.snapshot());
      return json(res, 200, note);
    }
    const deskProp = path.match(/^\/api\/desk\/properties\/([\w-]+)$/);
    if (deskProp && method === "PATCH") {
      const body = await readBody(req);
      const property = desk.patchProperty(deskProp[1], body);
      commitDesk(desk.snapshot());
      return json(res, 200, { property });
    }
    if (path === "/api/desk/properties" && method === "POST") {
      const snapshot = desk.addProperty(await readBody(req));
      commitDesk(snapshot);
      return json(res, 201, snapshot);
    }
    if (deskProp && method === "DELETE") {
      const snapshot = desk.removeProperty(deskProp[1]);
      commitDesk(snapshot);
      return json(res, 200, snapshot);
    }
    const artifact = path.match(/^\/api\/artifacts\/([\w-]+)$/);
    if (artifact && method === "GET") {
      const { meta, body } = readArtifact(artifact[1]);
      res.writeHead(200, {
        "content-type": meta.mime,
        "cache-control": "no-store",
        "content-length": String(body.length),
      });
      return res.end(body);
    }

    // ── pinned Hermes worker (Desk hands; never Hermes Desktop) ────────
    if (path === "/api/hermes" && method === "GET") {
      return json(res, 200, await workerStatus());
    }
    if (path === "/api/hermes/test" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      return json(res, 200, await withWorkerOperation("test", "testing the worker", () => tryHermesPing()));
    }
    if (path === "/api/hermes/model" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      // zero-terminal: write the profile config/.env directly, never a CLI
      try {
        const result = await withWorkerOperation("model", "changing the model", async () => {
          const staged = beginModelAttachment({
            providerId: String(body.providerId ?? ""),
            apiKey: String(body.apiKey ?? ""),
            model: String(body.model ?? ""),
            baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
          });
          try {
            const ping = await tryHermesPing();
            if (!ping.ok) {
              rollbackModelAttachment(staged.transactionId);
              modelAttachmentRecovery = {
                action: "restored-previous",
                detail: "The candidate model failed its live test, so RealBud kept the previous verified model.",
              };
              return { ok: false, error: `${ping.detail} The previous verified model is still selected.`, model: modelStatus(), ping };
            }
            commitModelAttachment(staged.transactionId);
            modelAttachmentRecovery = { action: "none", detail: "The selected model passed its live test." };
            return { ok: true, model: staged.status, ping };
          } catch (error) {
            try {
              rollbackModelAttachment(staged.transactionId);
              modelAttachmentRecovery = {
                action: "restored-previous",
                detail: "The model change did not finish, so RealBud restored the previous verified model.",
              };
            } catch {
              modelAttachmentRecovery = {
                action: "attention",
                detail: "The model change could not be reconciled. Bud is paused until recovery succeeds.",
              };
            }
            throw error;
          }
        }, { allowRecovery: true });
        return json(res, 200, result);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/hermes/models" && method === "GET") {
      const provider = url.searchParams.get("provider") ?? "";
      return json(res, 200, { models: listModels(provider) });
    }
    if (path === "/api/hermes/model" && method === "GET") {
      return json(res, 200, { model: modelStatus() });
    }
    if (path === "/api/hermes/apply-pack" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      try {
        await withWorkerOperation("pack", "repairing the property pack", () => applyPropertyPack(), { allowRecovery: true });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
      return json(res, 200, await workerStatus());
    }
    if (path === "/api/hermes/install" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      if (workerInstallInProgress()) {
        return json(res, 409, { error: "Bud's private worker is already being updated." });
      }
      let updateLease: WorkerOperationLease;
      try {
        // Reserve synchronously before preflight awaits. This closes the race
        // where Ask or the schedule could start while dependencies were being
        // checked and the installer had not yet marked itself running.
        updateLease = workerOperations.acquire("update", "preparing a private worker update");
      } catch (error) {
        const status = (error as { status?: number }).status ?? 409;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
      // zero-terminal: the harness spawns the pinned installer and streams
      // progress to /api/hermes/install/status — no Terminal window.
      try {
        const command = hermesInstallCommand(process.platform);
        if (!command) return json(res, 400, { error: "no installer for this platform — CSV-only mode" });
        installPreflight = await preflight();
        if (!installPreflight.ok) {
          const storageBlocked = installPreflight.deps.some((entry) => entry.name === "storage" && !entry.ok);
          return json(res, 409, {
            error: storageBlocked
              ? "Bud needs more free storage before it can be prepared safely. Free space and try again; nothing was changed."
              : "Bud is missing a required local component. Open technical details, fix the held item, and try again.",
            install: installStatus(),
            preflight: installPreflight,
          });
        }
        const job = startInstall(command);
        if (job.state === "failed") {
          return json(res, 409, {
            error: job.error ?? "Bud's private setup could not start safely. Nothing was changed.",
            install: job,
            preflight: installPreflight,
          });
        }
        if (workerInstallInProgress() && workerRuntimeRecovery.action !== "attention") {
          // Preparing the inactive slot intentionally replaces the older
          // rollback candidate; the active worker itself remains unchanged.
          workerRuntimeRecovery = {
            action: "none",
            detail: "A private worker update is being verified; the active worker remains isolated and unchanged.",
            previousAvailable: false,
          };
        }
        return json(res, 202, { install: job, preflight: installPreflight });
      } finally {
        // startInstall sets its in-progress state synchronously, so releasing
        // this short preflight reservation cannot open a transition gap.
        updateLease.release();
      }
    }
    if (path === "/api/hermes/install/status" && method === "GET") {
      return json(res, 200, { install: installStatus(), preflight: installPreflight });
    }

    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      sseClients.add(res);
      const keepalive = setInterval(() => {
        try {
          // A data heartbeat lets the renderer distinguish a quiet healthy
          // stream from a dev proxy that kept a dead backend socket open.
          res.write(`data: ${JSON.stringify({ kind: "heartbeat" })}\n\n`);
        } catch {}
      }, 5_000);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(res);
      });
      return;
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      return json(res, 200, {
        bots: store.bots.map(publicBot),
        groups: store.groups.map((g) => ({ ...g, messages: store.messagesFor(g.threadId) })),
      });
    }

    if (method === "GET" && path === "/api/usage") {
      return json(res, 200, { usage: usageLedger.summary() });
    }

    // ── rooms (group chats) ─────────────────────────────────────────────
    let m: RegExpMatchArray | null = null;
    if (method === "POST" && path === "/api/groups") {
      const body = await readBody(req);
      const memberIds = (Array.isArray(body.memberIds) ? body.memberIds : []).filter(
        (id: unknown): id is string => typeof id === "string" && Boolean(store.bot(id)),
      );
      if (memberIds.length === 0) return json(res, 400, { error: "a room needs at least one bot" });
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : `${store.bot(memberIds[0])!.name} & co.`;
      const group = store.createGroup(name, memberIds);
      broadcast({ kind: "group", group });
      return json(res, 201, { group: { ...group, messages: [] } });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const existing = store.group(m[1]);
      if (!existing) return json(res, 404, { error: "no such room" });
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "bulletin", "unread"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (Array.isArray(body.memberIds)) {
        const ids = body.memberIds.filter((id: unknown): id is string => typeof id === "string" && Boolean(store.bot(id)));
        if (ids.length) patch.memberIds = ids;
      }
      if (body.defaultResponder !== undefined) {
        const value = body.defaultResponder as { kind?: unknown; botId?: unknown } | null;
        const memberIds = (patch.memberIds as string[] | undefined) ?? existing.memberIds;
        let responder: GroupDefaultResponder | null = null;
        if (value?.kind === "everyone") responder = { kind: "everyone" };
        else if (value?.kind === "mentions") responder = { kind: "mentions" };
        else if (value?.kind === "member" && typeof value.botId === "string" && memberIds.includes(value.botId)) {
          responder = { kind: "member", botId: value.botId };
        }
        if (!responder) return json(res, 400, { error: "invalid default responder" });
        patch.defaultResponder = responder;
      }
      const group = store.patchGroup(m[1], patch);
      if (!group) return json(res, 404, { error: "no such room" });
      broadcast({ kind: "group", group });
      return json(res, 200, { group });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      store.deleteGroup(group.id);
      for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
        try {
          unlinkSync(join(dir, `${group.threadId}.ndjson`));
        } catch {}
      }
      broadcast({ kind: "group.deleted", groupId: group.id });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      startGroupTurn(m[1], text);
      return json(res, 202, { ok: true });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      const busy = group.busyBotId ? store.bot(group.busyBotId) : undefined;
      const instance = busy ? registry.get(busy.modelSelection.instanceId) : undefined;
      await instance?.adapter.interruptTurn(group.threadId).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // emoji reactions — works on any thread (1:1 or room)
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const emoji = String(body.emoji ?? "").slice(0, 8);
      if (!emoji) return json(res, 400, { error: "emoji required" });
      const patched = store.toggleReaction(m[1], m[2], emoji, typeof body.by === "string" ? body.by : "user");
      if (!patched) return json(res, 404, { error: "no such message" });
      broadcast({ kind: "message.patch", threadId: m[1], message: patched });
      return json(res, 200, { message: patched });
    }
    if (method === "POST" && path === "/api/bots") {
      const bot = store.createBot();
      store.patchBot(bot.id, { modelSelection: await defaultSelection() });
      return json(res, 201, {
        bot: {
          ...store.bot(bot.id)!,
          messages: store.messagesFor(bot.threadId),
          activeLeafId: store.activeLeaf(bot.threadId),
        },
      });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      // RealBud gates at the API, not just in hidden UI: nothing may flip
      // unattended approvals or Chief of Staff onto the one worker, and Bud
      // keeps its name. The seeded bot never carries these flags; this
      // keeps it that way.
      if (PRODUCT_MODE) {
        if (body.autoApprove !== undefined || body.alwaysAllow !== undefined || body.chiefOfStaff !== undefined) {
          return json(res, 403, { error: "RealBud never runs unattended. Approvals stay manual on Desk." });
        }
        if (isCanonicalBud(m[1]) && body.name !== undefined && body.name !== CANONICAL_BUD_NAME) {
          return json(res, 403, { error: "Bud is the desk's one worker and keeps its name." });
        }
      }
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "modelSelection", "unread", "computer", "color", "mascotExpression", "pinned", "hidden", "speakReplies", "voice"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (
        body.computer !== undefined &&
        !["cloud", "vm", "local", "off"].includes(String(body.computer))
      ) {
        return json(res, 400, { error: "computer must be cloud, vm, local, or off" });
      }
      if (body.chiefOfStaff !== undefined && typeof body.chiefOfStaff !== "boolean") {
        return json(res, 400, { error: "chiefOfStaff must be true or false" });
      }
      const existing = store.bot(m[1]);
      if (body.hidden === true && existing?.chiefOfStaff && body.chiefOfStaff !== false) {
        return json(res, 400, { error: "choose another Chief of Staff before hiding this bot" });
      }
      // the two permission fields decide what runs unattended, so they are
      // type-checked rather than copied through: a string alwaysAllow would
      // still answer .includes() — with substring matches, not tool names
      if (body.autoApprove !== undefined) {
        if (typeof body.autoApprove !== "boolean") return json(res, 400, { error: "autoApprove must be true or false" });
        patch.autoApprove = body.autoApprove;
      }
      if (body.alwaysAllow !== undefined) {
        if (!Array.isArray(body.alwaysAllow) || body.alwaysAllow.some((t: unknown) => typeof t !== "string")) {
          return json(res, 400, { error: "alwaysAllow must be a list of tool keys" });
        }
        patch.alwaysAllow = [...new Set(body.alwaysAllow as string[])].slice(0, 200);
      }
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const chiefChanges =
        body.chiefOfStaff === true
          ? store.setChiefOfStaff(bot.id)
          : body.chiefOfStaff === false && bot.chiefOfStaff
            ? store.setChiefOfStaff(null)
            : [];
      if (chiefChanges === null) return json(res, 404, { error: "no such bot" });
      const changed = new Map([[bot.id, store.bot(bot.id)!]]);
      for (const changedBot of chiefChanges) changed.set(changedBot.id, changedBot);
      for (const changedBot of changed.values()) broadcast({ kind: "bot", bot: changedBot });
      return json(res, 200, { bot });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // a running turn dies with its bot
      await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => {});
      stopScreenPoller(bot.id);
      store.deleteBot(bot.id);
      for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
        try {
          unlinkSync(join(dir, `${bot.threadId}.ndjson`));
        } catch {}
      }
      broadcast({ kind: "bot.deleted", botId: bot.id });
      return json(res, 200, { ok: true });
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/actions\/([\w-]+)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const bot = store.bot(m[1]);
      if (!bot || !isCanonicalBud(bot.id)) return json(res, 404, { error: "no such Bud action" });
      // A proposal is durable Desk work, not ephemeral branch text. Rewinding
      // Ask must not orphan it; the PM can still Allow or deny it from Desk.
      const existing = store.messagesFor(bot.threadId).find((message) => message.id === m![2]);
      if (!existing?.action || existing.kind !== "action") return json(res, 404, { error: "no such Bud action" });
      const body = await readBody(req);
      if (body.decision !== "allow" && body.decision !== "deny") {
        return json(res, 400, { error: "decision must be allow or deny" });
      }
      const selection = typeof body.selection === "string" ? body.selection.replace(/[\u0000-\u001f\u007f]+/g, "").slice(0, 40) : undefined;
      try {
        const { message, ...result } = await decideCanonicalAskAction(existing.id, body.decision, selection);
        return json(res, 200, {
          message,
          ...(result.snapshot ? { snapshot: result.snapshot } : {}),
          ...(result.loop ? { loop: result.loop } : {}),
          ...(result.run ? { run: result.run } : {}),
          ...(result.navigation ? { navigation: result.navigation } : {}),
        });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        const code = String((error as { code?: string }).code ?? "");
        return json(res, status, { error: error instanceof Error ? error.message : String(error), code: code || undefined });
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      let text = String(body.text ?? "").trim();
      let requestId: string;
      try {
        requestId = askRequestId(body.requestId);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return json(res, status, {
          error: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string }).code,
        });
      }
      let attachments: TurnAttachment[];
      try {
        attachments = decodeTurnAttachments(body.attachments);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
      if (!text && !attachments.length) return json(res, 400, { error: "text or attachment required" });
      let credentialAdmit: Awaited<ReturnType<typeof admitAskCredential>> = { ok: true, text };
      if (text) {
        credentialAdmit = await admitAskCredential(text);
        if (!credentialAdmit.ok) {
          return json(res, 400, { error: credentialAdmit.error, code: credentialAdmit.code });
        }
        if (credentialAdmit.text !== text) {
          text = credentialAdmit.text;
          if (credentialAdmit.composio) Object.assign(cfg, loadConfig());
          broadcast({ kind: "config", ...configStatus() });
        }
      }
      const hasInstruction = text.replace(/<attached-file\s+path="[^"]*"\s*\/>/g, "").trim();
      const attachmentPrompt = "Review the selected files. If they contain property records, use the intake-properties skill. Otherwise summarise only what you can verify and tell me what needs attention.";
      const turnText = hasInstruction ? text : `${attachmentPrompt}${text ? `\n\n${text}` : ""}`;
      const requestDigest = askRequestDigest(turnText, attachments);
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });

      // The transcript is the durable admission ledger for Ask. A retry with
      // the same id and input returns the authoritative projection. If the
      // process stopped after persisting the user message but before provider
      // dispatch, the active leaf is that message and the same request may
      // resume it exactly once. Reusing an id with different input is never a
      // retry and is rejected.
      const admitted = store.messageForRequest(bot.threadId, requestId);
      if (admitted && admitted.requestDigest !== requestDigest) {
        return json(res, 409, {
          error: "that Ask request id was already used for different content",
          code: "request-id-conflict",
        });
      }
      if (admitted) {
        const active = store.activePath(bot.threadId);
        const admittedIndex = active.findIndex((message) => message.id === admitted.id);
        if (admittedIndex < 0) {
          return json(res, 409, {
            error: "that Ask request belongs to a conversation version that is no longer active",
            code: "request-branch-conflict",
          });
        }
        if (admittedIndex < active.length - 1 || bot.busy) {
          return json(res, 200, { ok: true, duplicate: true, requestId, bot: publicBot(bot) });
        }
      }

      // Named office/Pocket/app setup is a code-owned navigation shortcut.
      // A key admitted above is already on the device; this never writes the
      // raw secret into the transcript.
      const directSetup = PRODUCT_MODE && bot && isCanonicalBud(bot.id) && loops && !attachments.length
        ? stageDirectAskSetupIntent(stripSecretsForSpeech(turnText), {
            desk,
            loops,
            portalMode: PILOT_CONTRACT.demo ? "practice" : "pilot",
            linkedTools: listLinkedTools(),
          })
        : { matched: false as const };
      if (directSetup.matched) {
        if (bot.busy) return json(res, 409, { error: "Bud is already working — wait for the current Ask turn before opening setup." });
        if ("error" in directSetup) {
          return json(res, directSetup.status, { error: directSetup.error, code: directSetup.code });
        }
        const linkedNow = credentialAdmit.ok ? credentialAdmit.linked : undefined;
        if (linkedNow && directSetup.proposal.kind === "open-setup") {
          const account = linkedNow.account?.trim();
          directSetup.proposal = {
            ...directSetup.proposal,
            title: `${linkedNow.label} connected`,
            detail: account && account !== "Key on this device"
              ? `${linkedNow.label} accepted this key. ${account} is on this device. Ask still cannot send.`
              : `${linkedNow.label} accepted this key. It is on this device. Ask still cannot send.`,
          };
          delete (directSetup as { navigation?: string }).navigation;
        }
        const peekTool = matchAskToolPeekSpeech(stripSecretsForSpeech(turnText))
          ?? (linkedNow ? { id: linkedNow.slug, label: linkedNow.label, composioSlug: linkedNow.slug } : null);
        const peekLinked = peekTool
          ? listLinkedTools().find((row) =>
            row.connected
            && (row.slug === peekTool.composioSlug || row.slug === peekTool.id || row.label.toLowerCase() === peekTool.label.toLowerCase()),
          )
          : undefined;
        if (peekTool && peekLinked && directSetup.proposal.kind === "open-setup") {
          directSetup.proposal = {
            ...directSetup.proposal,
            ...(await fillLinkedToolPeek(directSetup.proposal, peekTool, peekLinked.account ?? linkedNow?.account)),
          };
          delete (directSetup as { navigation?: string }).navigation;
        }
        scrubAskSecrets(bot.threadId);
        const openedNow = Boolean(directSetup.navigation);
        const setupTurn = isConnectSetupAction(directSetup.proposal)
          ? askSetupUserTurnCopy(directSetup.proposal)
          : null;
        store.titleTaskFromFirstMessage(bot.id, text, bot.threadId);
        const userMessage = admitted ?? store.appendMessage(bot.threadId, {
          role: "user",
          kind: "text",
          text,
          requestId,
          requestDigest,
          requestState: "settled",
          requestAttachmentCount: 0,
          requestStatusDetail: setupTurn
            ? (openedNow || setupTurn.label === "Not a source" || setupTurn.label === "Connected" ? setupTurn.detail : "Setup proposal is waiting for your decision")
            : openedNow
              ? "Opened the requested setup in Ask. Nothing connected automatically."
              : "Setup proposal is waiting for your decision",
        });
        if (admitted && admitted.requestState !== "settled") {
          store.patchMessage(bot.threadId, admitted.id, {
            requestState: "settled",
            requestStatusDetail: setupTurn
              ? (openedNow || setupTurn.label === "Not a source" || setupTurn.label === "Connected" ? setupTurn.detail : "Setup proposal is waiting for your decision")
              : openedNow
                ? "Opened the requested setup in Ask. Nothing connected automatically."
                : "Setup proposal is waiting for your decision",
          });
        }
        const actionMessage = store.appendMessage(bot.threadId, { role: "bot", kind: "action", action: directSetup.proposal });
        if (!admitted) broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
        broadcast({ kind: "message", threadId: bot.threadId, message: actionMessage });
        if (isCompletedToolConnect(directSetup.proposal)) {
          speakAskLayerVoice(bot.threadId, askLayerVoice(directSetup.proposal));
        }
        const currentBot = store.bot(bot.id);
        if (!currentBot) return json(res, 500, { error: "Bud setup handoff could not be projected." });
        return json(res, 202, {
          ok: true,
          requestId,
          bot: publicBot(currentBot),
          ...(directSetup.navigation ? { navigation: directSetup.navigation } : {}),
          ...(directSetup.proposal.kind === "open-setup" && directSetup.proposal.service
            ? { service: directSetup.proposal.service }
            : {}),
          ...(linkedNow ? { connected: true } : {}),
        });
      }

      const directRoutine = PRODUCT_MODE && bot && isCanonicalBud(bot.id) && loops && !attachments.length
        ? stageDirectAskRoutineIntent(turnText, {
            desk,
            loops,
            portalMode: PILOT_CONTRACT.demo ? "practice" : "pilot",
          })
        : { matched: false as const };
      if (directRoutine.matched) {
        if (bot.busy) return json(res, 409, { error: "Bud is already working — wait for the current Ask turn before changing a routine." });
        if ("error" in directRoutine) {
          return json(res, directRoutine.status, { error: directRoutine.error, code: directRoutine.code });
        }
        store.titleTaskFromFirstMessage(bot.id, text, bot.threadId);
        const userMessage = admitted ?? store.appendMessage(bot.threadId, {
          role: "user",
          kind: "text",
          text,
          requestId,
          requestDigest,
          requestState: "settled",
          requestAttachmentCount: 0,
          requestStatusDetail: "Routine proposal is waiting for your decision",
        });
        if (admitted && admitted.requestState !== "settled") {
          store.patchMessage(bot.threadId, admitted.id, {
            requestState: "settled",
            requestStatusDetail: "Routine proposal is waiting for your decision",
          });
        }
        const actionMessage = store.appendMessage(bot.threadId, { role: "bot", kind: "action", action: directRoutine.proposal });
        if (!admitted) broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
        broadcast({ kind: "message", threadId: bot.threadId, message: actionMessage });
        const currentBot = store.bot(bot.id);
        if (!currentBot) return json(res, 500, { error: "Bud routine handoff could not be projected." });
        return json(res, 202, { ok: true, requestId, bot: publicBot(currentBot) });
      }

      if (PRODUCT_MODE && bot && isCanonicalBud(bot.id) && !attachments.length && matchAskDeskSpeech(stripSecretsForSpeech(turnText))) {
        if (bot.busy) return json(res, 409, { error: "Bud is already working — wait for the current Ask turn." });
        const voice = askDeskVoice(currentAskDeskBrief(desk.snapshot()));
        store.titleTaskFromFirstMessage(bot.id, text, bot.threadId);
        const userMessage = admitted ?? store.appendMessage(bot.threadId, {
          role: "user",
          kind: "text",
          text,
          requestId,
          requestDigest,
          requestState: "settled",
          requestAttachmentCount: 0,
          requestStatusDetail: "Answered from the current Desk",
        });
        if (admitted && admitted.requestState !== "settled") {
          store.patchMessage(bot.threadId, admitted.id, {
            requestState: "settled",
            requestStatusDetail: "Answered from the current Desk",
          });
        }
        const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: voice });
        if (!admitted) broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });
        broadcast({ kind: "message", threadId: bot.threadId, message: reply });
        const currentBot = store.bot(bot.id);
        if (!currentBot) return json(res, 500, { error: "Desk answer could not be projected." });
        return json(res, 202, { ok: true, requestId, bot: publicBot(currentBot) });
      }

      await startTurn(m[1], turnText, {
        attachments,
        ...(admitted ? { userMessage: admitted } : {}),
        requestId,
        requestDigest,
      });
      // Return the authoritative optimistic projection as well as broadcasting
      // it. A renderer whose event stream is refreshing its local session can
      // still show the user's message and Bud's working state immediately.
      const started = store.bot(m[1]);
      return json(res, 202, { ok: true, requestId, bot: started ? publicBot(started) : null });
    }

    // edit a user message → fork the conversation there and rerun the turn.
    // Rewinding a live thread is refused, exactly like switching versions
    // below: interrupting mid-flight and branching under the dying turn is
    // how a conversation ends up with two tails. Stop, then edit.
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
    if (m && method === "POST") {
      const messageId = m[2];
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      let text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      {
        const credentialAdmit = await admitAskCredential(text);
        if (!credentialAdmit.ok) {
          return json(res, 400, { error: credentialAdmit.error, code: credentialAdmit.code });
        }
        if (credentialAdmit.text !== text) {
          text = credentialAdmit.text;
          if (credentialAdmit.composio) Object.assign(cfg, loadConfig());
          broadcast({ kind: "config", ...configStatus() });
        }
      }
      // everything from here down is synchronous, so two racing edits can
      // never both get past this check: startTurn flips busy before the
      // next request is handled
      if (bot.busy) return json(res, 409, { error: "the bot is working — stop it before editing" });
      const source = store.messagesFor(bot.threadId).find((msg) => msg.id === messageId);
      if (!source || source.role !== "user" || source.kind !== "text") {
        return json(res, 404, { error: "only user messages can be edited" });
      }
      if (!registry.get(bot.modelSelection.instanceId)) {
        return json(res, 409, {
          error: `provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`,
        });
      }
      if (isCanonicalBud(bot.id)) {
        try {
          // There is no await between this probe and startTurn's real lease,
          // so another request cannot claim the single worker in between.
          // Probe before branchMessage so a conflict leaves no orphan branch.
          acquireWorkerOperation("ask", "answering in Ask").release();
        } catch (error) {
          const status = (error as { status?: number }).status ?? 409;
          return json(res, status, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const message = store.branchMessage(bot.threadId, messageId, text);
      if (!message) return json(res, 404, { error: "no such message" });
      store.patchBot(bot.id, { rewound: true });
      broadcast({ kind: "message", threadId: bot.threadId, message });
      broadcast({ kind: "thread", threadId: bot.threadId, activeLeafId: message.id });
      await startTurn(bot.id, text, { userMessage: message });
      return json(res, 202, { ok: true });
    }

    // switch which fork of the conversation is visible (no new turn)
    m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (bot.busy) return json(res, 409, { error: "the bot is working — stop it before switching versions" });
      const body = await readBody(req);
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) return json(res, 404, { error: "no such message" });
      // provider sessions still hold the other branch — next turn replays
      store.patchBot(bot.id, { rewound: true });
      broadcast({ kind: "thread", threadId: bot.threadId, activeLeafId: leaf });
      return json(res, 200, { activeLeafId: leaf });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const instance = registry.get(bot.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      await instance.adapter.respondToRequest(bot.threadId, String(body.requestId), {
        behavior: body.behavior,
        message: body.message,
      });
      return json(res, 200, { ok: true });
    }
    // Answer by THREAD, so a request raised inside a room can be answered
    // too: a member's turn runs on the room's thread, and the bot that
    // owns the pending request is the one currently speaking there.
    m = path.match(/^\/api\/threads\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const threadId = m[1];
      const body = await readBody(req);
      const group = store.groupByThread(threadId);
      const owner = group ? (group.busyBotId ? store.bot(group.busyBotId) : undefined) : store.botByThread(threadId);
      if (!owner) return json(res, 404, { error: "nothing is waiting on an answer in this conversation" });
      const instance = registry.get(owner.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      await instance.adapter.respondToRequest(threadId, String(body.requestId), {
        behavior: body.behavior,
        message: body.message,
      });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const instance = registry.get(bot.modelSelection.instanceId);
      await instance?.adapter.interruptTurn(bot.threadId);
      return json(res, 200, { ok: true });
    }

    // ── tasks: a bot's separate contexts ────────────────────────────────
    // The bot record answers with its messages because switching tasks
    // changes which transcript is live, and a partial patch would leave
    // the client showing the previous task's conversation.
    const botWithThread = (bot: NonNullable<ReturnType<typeof store.bot>>) => ({
      ...bot,
      messages: store.messagesFor(bot.threadId),
      activeLeafId: store.activeLeaf(bot.threadId),
      tasks: store.tasks(bot.id).map(({ resumeCursors, ...t }) => t),
    });

    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (bot.busy) return json(res, 409, { error: "this bot is working — let it finish before starting a task" });
      const body = await readBody(req);
      const task = store.createTask(bot.id, typeof body.title === "string" ? body.title : undefined);
      if (!task) return json(res, 500, { error: "couldn't create that task" });
      const fresh = botWithThread(store.bot(bot.id)!);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 201, { bot: fresh, task });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)$/);
    if (m && method === "POST") {
      const switched = store.switchTask(m[1], m[2]);
      if (!switched) return json(res, 404, { error: "no such task" });
      const fresh = botWithThread(switched);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 200, { bot: fresh });
    }
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const task = store.renameTask(m[1], m[2], String(body.title ?? ""));
      if (!task) return json(res, 404, { error: "no such task" });
      const fresh = botWithThread(store.bot(m[1])!);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 200, { task });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (bot?.busy && bot.threadId === m[2]) {
        return json(res, 409, { error: "this task is running — stop it first" });
      }
      const updated = store.deleteTask(m[1], m[2]);
      if (!updated) return json(res, 400, { error: "a bot keeps at least one task" });
      const fresh = botWithThread(updated);
      broadcast({ kind: "bot", bot: fresh });
      return json(res, 200, { bot: fresh });
    }

    // what the user's machine can host: which runtime is installed, whether
    // its daemon is up, and whether the desktop image and container exist
    if (method === "GET" && path === "/api/local-computer") {
      const status = await containerComputerStatus();
      return json(res, 200, { ...status, commands: setupCommands(status.runtime) });
    }
    m = path.match(/^\/api\/local-computer\/(pull|run|start|stop|remove)$/);
    if (m && method === "POST") {
      // Requiring JSON makes these localhost lifecycle mutations non-simple
      // browser requests. A hostile web page cannot submit them with a form,
      // and its cross-origin JSON request is stopped by the browser preflight
      // because this server deliberately emits no CORS permission.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const action = m[1] as LifecycleAction;
      if (localVmLifecycleBusy) {
        return json(res, 409, { error: "another Local VM setup action is still running" });
      }
      if (activeVmThreadId && (action === "stop" || action === "remove" || action === "run")) {
        return json(res, 409, { error: "the Local VM is being used by a bot — stop that turn first" });
      }
      localVmLifecycleBusy = true;
      try {
        const status = await containerComputerAction(action);
        return json(res, 200, { ...status, commands: setupCommands(status.runtime) });
      } finally {
        localVmLifecycleBusy = false;
      }
    }
    if (method === "POST" && path === "/api/local-computer/screenshot") {
      return json(res, 200, { image: await containerComputerScreenshot() });
    }

    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "realbud", pid: process.pid, static: Boolean(STATIC_DIR) });
    }

    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      // Rescan PATH first: this endpoint is how the app answers "what can I
      // run?", and the interesting case is a CLI installed since launch.
      // Windows never pushes PATH changes into a live process, so without
      // this the answer is frozen at boot and "check again" is a no-op.
      resetPathCache();
      return json(res, 200, { instances: await registry.describe() });
    }
    const setupMatch = path.match(/^\/api\/instances\/([\w.-]+)\/setup$/);
    if (setupMatch && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      resetPathCache();
      const instances = await registry.describe();
      const instance = instances.find((row) => row.instanceId === setupMatch[1]);
      if (!instance) return json(res, 404, { error: "no such engine" });
      const command = setupCommandFor(instance.install, instance.snapshot, process.platform);
      if (!command) return json(res, 400, { error: "no setup command for this engine" });
      const ok = await openTerminalAndRun(command);
      return json(res, ok ? 200 : 502, { ok, command });
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatus());
    }
    if (method === "PATCH" && path === "/api/profile") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const profile = normalizePmProfile(await readBody(req));
      saveConfig({ profile });
      Object.assign(cfg, loadConfig());
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      if (body.profile !== undefined) {
        return json(res, 400, { error: "profile changes use PATCH /api/profile" });
      }
      for (const key of ["xai", "composio", "box", "tts", "pocket"] as const) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      // check a box token against the provider before storing it: a
      // rejected token used to save happily and only surface as a 401 in
      // another panel later, with nothing the user could act on
      const newBoxToken = (patch.box as { token?: unknown } | undefined)?.token;
      if (typeof newBoxToken === "string" && newBoxToken.trim()) {
        const check = await box.verifyToken(newBoxToken.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      // same rule for a voice key — and check it against the provider the
      // patch SELECTS, not the one already saved, or pasting a Cartesia key
      // while switching from ElevenLabs validates against the wrong service
      const newTts = patch.tts as { key?: unknown } | undefined;
      if (typeof newTts?.key === "string" && newTts.key.trim()) {
        const check = await tts.verifyKey(newTts.key.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      const newPocket = patch.pocket as {
        provider?: unknown;
        key?: unknown;
        enabled?: unknown;
        allowedUserId?: unknown;
        accessToken?: unknown;
        appSecret?: unknown;
        verifyToken?: unknown;
        phoneNumberId?: unknown;
        webhookPort?: unknown;
      } | undefined;
      if (newPocket) {
        if (newPocket.provider !== "telegram" && newPocket.provider !== "whatsapp-cloud") {
          return json(res, 400, { error: "Choose Telegram or WhatsApp Business for this Pocket change." });
        }
        if (newPocket.enabled !== undefined && typeof newPocket.enabled !== "boolean") {
          return json(res, 400, { error: "Pocket channel enabled must be true or false." });
        }
        if (newPocket.provider === "telegram") {
          if (newPocket.key !== undefined && typeof newPocket.key !== "string") {
            return json(res, 400, { error: "Pocket bot token must be a string." });
          }
          if (newPocket.allowedUserId !== undefined && typeof newPocket.allowedUserId !== "string") {
            return json(res, 400, { error: "Pocket PM user ID must be a string." });
          }
          const rawToken = typeof newPocket.key === "string"
            ? newPocket.key.trim()
            : cfg.pocket?.telegramKey ?? cfg.pocket?.key ?? "";
          const rawUserId = typeof newPocket.allowedUserId === "string"
            ? newPocket.allowedUserId.trim()
            : cfg.pocket?.telegramAllowedUserId ?? cfg.pocket?.allowedUserId ?? "";
          const token = rawToken ? normalizeTelegramBotToken(rawToken) : null;
          const allowedUserId = rawUserId ? normalizeTelegramUserId(rawUserId) : null;
          if (rawToken && !token) return json(res, 400, { error: "Enter a valid Telegram bot token." });
          if (rawUserId && !allowedUserId) return json(res, 400, { error: "Enter the PM's numeric Telegram user ID." });
          const enabled = newPocket.enabled ?? cfg.pocket?.telegramEnabled ?? cfg.pocket?.enabled ?? false;
          const introducingCredential = typeof newPocket.key === "string" && Boolean(token);
          if ((enabled || introducingCredential) && !pocketPilotReady(PILOT_CONTRACT)) {
            return json(res, 409, { error: "Pocket stays off until the pilot contract names the real agency and PM." });
          }
          if (enabled && (!token || !allowedUserId)) {
            return json(res, 400, { error: "A dedicated Telegram bot token and the PM's numeric user ID are required." });
          }
          if (typeof newPocket.key === "string" && token) await verifyTelegramPocketToken(token);
          patch.pocket = {
            provider: "telegram",
            // Atomically migrate the shipped v1 secret into the channel-keyed
            // slot while deleting the old copy. Non-secret legacy settings are
            // harmless and remain ignored once the keyed field is present.
            key: "",
            telegramKey: token ?? "",
            telegramEnabled: enabled,
            telegramAllowedUserId: allowedUserId ?? "",
          };
        } else {
          for (const [field, label] of [
            ["accessToken", "WhatsApp access token"],
            ["appSecret", "WhatsApp App Secret"],
            ["verifyToken", "WhatsApp Verify Token"],
            ["phoneNumberId", "WhatsApp Phone Number ID"],
            ["allowedUserId", "WhatsApp PM number"],
          ] as const) {
            if (newPocket[field] !== undefined && typeof newPocket[field] !== "string") {
              return json(res, 400, { error: `${label} must be a string.` });
            }
          }
          if (newPocket.webhookPort !== undefined && normalizeWhatsAppWebhookPort(newPocket.webhookPort) === null) {
            return json(res, 400, { error: "WhatsApp local webhook port must be between 1024 and 65535." });
          }
          const rawAccessToken = typeof newPocket.accessToken === "string"
            ? newPocket.accessToken.trim()
            : cfg.pocket?.whatsappCloudAccessToken ?? "";
          const rawAppSecret = typeof newPocket.appSecret === "string"
            ? newPocket.appSecret.trim()
            : cfg.pocket?.whatsappCloudAppSecret ?? "";
          const rawVerifyToken = typeof newPocket.verifyToken === "string"
            ? newPocket.verifyToken.trim()
            : cfg.pocket?.whatsappCloudVerifyToken ?? "";
          const rawPhoneNumberId = typeof newPocket.phoneNumberId === "string"
            ? newPocket.phoneNumberId.trim()
            : cfg.pocket?.whatsappCloudPhoneNumberId ?? "";
          const rawAllowedUserId = typeof newPocket.allowedUserId === "string"
            ? newPocket.allowedUserId.trim()
            : cfg.pocket?.whatsappCloudAllowedUserId ?? "";
          const accessToken = rawAccessToken ? normalizeWhatsAppAccessToken(rawAccessToken) : null;
          const appSecret = rawAppSecret ? normalizeWhatsAppAppSecret(rawAppSecret) : null;
          const verifyToken = rawVerifyToken ? normalizeWhatsAppVerifyToken(rawVerifyToken) : null;
          const phoneNumberId = rawPhoneNumberId ? normalizeWhatsAppPhoneNumberId(rawPhoneNumberId) : null;
          const allowedUserId = rawAllowedUserId ? normalizeWhatsAppUserId(rawAllowedUserId) : null;
          if (rawAccessToken && !accessToken) return json(res, 400, { error: "Enter a valid WhatsApp Cloud access token." });
          if (rawAppSecret && !appSecret) return json(res, 400, { error: "Enter the 32-character Meta App Secret." });
          if (rawVerifyToken && !verifyToken) return json(res, 400, { error: "Use a 20–128 character Verify Token with letters, numbers, _ or -." });
          if (rawPhoneNumberId && !phoneNumberId) return json(res, 400, { error: "Enter the numeric Phone Number ID from Meta, not the phone number." });
          if (rawAllowedUserId && !allowedUserId) return json(res, 400, { error: "Enter the PM's WhatsApp number with country code and digits only." });
          const enabled = newPocket.enabled ?? cfg.pocket?.whatsappCloudEnabled ?? false;
          const introducingCredential = ["accessToken", "appSecret", "verifyToken"].some((field) =>
            typeof newPocket[field as keyof typeof newPocket] === "string" && Boolean(String(newPocket[field as keyof typeof newPocket]).trim())
          );
          if ((enabled || introducingCredential) && !pocketPilotReady(PILOT_CONTRACT)) {
            return json(res, 409, { error: "Pocket stays off until the pilot contract names the real agency and PM." });
          }
          if (enabled && (!accessToken || !appSecret || !verifyToken || !phoneNumberId || !allowedUserId)) {
            return json(res, 400, { error: "WhatsApp Business needs the business number IDs, PM allowlist, access token, App Secret and Verify Token." });
          }
          if ((newPocket.accessToken !== undefined || newPocket.phoneNumberId !== undefined) && accessToken && phoneNumberId) {
            await verifyWhatsAppCloudConfig({ accessToken, phoneNumberId });
          }
          patch.pocket = {
            provider: "whatsapp-cloud",
            whatsappCloudAccessToken: accessToken ?? "",
            whatsappCloudAppSecret: appSecret ?? "",
            whatsappCloudVerifyToken: verifyToken ?? "",
            whatsappCloudEnabled: enabled,
            whatsappCloudPhoneNumberId: phoneNumberId ?? "",
            whatsappCloudAllowedUserId: allowedUserId ?? "",
            whatsappCloudWebhookPort: normalizeWhatsAppWebhookPort(newPocket.webhookPort ?? cfg.pocket?.whatsappCloudWebhookPort) ?? 8090,
            whatsappCloudGraphVersion: WHATSAPP_GRAPH_VERSION,
          };
        }
      }
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      // provider keys change the fleet; a profile or voice edit must not
      // kill in-flight turns with a pointless reload — no driver reads
      // either, and picking a voice mid-turn should be free
      if (Object.keys(patch).some((k) => k !== "tts" && k !== "pocket")) await reloadProviders();
      if (patch.pocket && pocketGateway) await pocketGateway.configure(pocketRuntimeConfig());
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── voice ─────────────────────────────────────────────────────────
    // Splitting text into utterances lives HERE, not in the renderer, for
    // the same reason approvalKey does — it is the piece most likely to be
    // tuned against real transcripts, and it belongs next to the transform
    // that produced it.
    if (method === "POST" && path === "/api/tts/prepare") {
      const body = await readBody(req);
      return json(res, 200, {
        ready: tts.voiceReady(cfg, typeof body.voiceId === "string" ? body.voiceId : undefined),
        utterances: toUtterances(String(body.text ?? "")),
      });
    }
    if (method === "GET" && path === "/api/tts/voices") {
      try {
        return json(res, 200, { voices: await tts.listVoices(cfg) });
      } catch (e) {
        return json(res, 200, { voices: [], error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "POST" && path === "/api/tts/speak") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      // The normal client sends <=320-character utterances. A hard ceiling
      // prevents an arbitrary local request from turning the user's hosted
      // voice account into an unbounded, billable synthesis job.
      if (text.length > 500) return json(res, 413, { error: "voice utterances are limited to 500 characters" });
      try {
        const audio = await tts.speak(cfg, text, typeof body.voiceId === "string" ? body.voiceId : undefined);
        res.writeHead(200, {
          "content-type": audio.mime,
          "content-length": String(audio.bytes.byteLength),
          "cache-control": "no-store",
        });
        return res.end(Buffer.from(audio.bytes));
      } catch (e) {
        // "you haven't set this up yet" is not a provider failure — 409 so
        // the client can point at App Settings instead of showing a 502
        if (e instanceof tts.NoVoiceConfigured) return json(res, 409, { error: e.message });
        return json(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      return json(res, 200, { configured: Boolean(cfg.composio?.key), source, cards });
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!cfg.composio?.key) return json(res, 200, { configured: false, services: {} });
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") return json(res, 200, await composio.authorizeService(cfg, m[1]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeService(cfg, m[1]));

    // ── the bot's cloud computer (Box) ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") return json(res, 200, await box.boxStatus(cfg, m[1]));
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such bot" });
      switch (m[2]) {
        case "provision":
          return json(res, 200, await box.provisionBox(cfg, botId, bot.name));
        case "join":
          return json(res, 200, await box.joinBox(cfg, botId));
        case "sleep":
          return json(res, 200, await box.sleepBox(cfg, botId));
        case "exec": {
          const body = await readBody(req);
          return json(res, 200, await box.execOnBox(cfg, botId, String(body.command ?? "")));
        }
        case "screenshot":
          return json(res, 200, await box.screenshotBox(cfg, botId));
      }
    }

    // packaged app: the server serves the built UI too (window → :8799 for
    // everything, no dev proxy to die). OMB_STATIC_DIR is set by Electron.
    if (method === "GET" && !path.startsWith("/api/") && STATIC_DIR) {
      const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
      const file = join(STATIC_DIR, safe);
      try {
        const data = readFileSync(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        return res.end(data);
      } catch {
        // SPA fallback
        try {
          const data = readFileSync(join(STATIC_DIR, "index.html"));
          res.writeHead(200, { "content-type": "text/html" });
          return res.end(data);
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    return deskMutationError(res, e);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`realbud server on http://127.0.0.1:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    loops?.stop();
    watchdog.stop();
    stopInstall();
    void Promise.allSettled([pocketGateway?.stop() ?? Promise.resolve(), registry.disposeAll()]).finally(() => process.exit(0));
  });
}

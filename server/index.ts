// RealBud server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

import { approvalKey, autoDecision } from "./auto-approve.ts";
import { applyLawDrift, lawWatchView, persistLawWatchResult, runLawWatch, setLawWatchScheduled } from "./law-watch.ts";
import { addPortalRule, addRule, evaluateRules, isPortalRuleSurface, loadRules, parsePortalRuleKey, removeRule } from "./rules.ts";
import { appendHistory, listHistory } from "./computer-history.ts";
import { deleteRecipe, fenceCapabilitiesFor, getRecipe, listRecipes, normalizeOrigin, patchRecipe, patchRecipeStatus, recipeClockRunnable, recipeHasPortalCapability, saveRecipe } from "./recipes.ts";
import { distillRecipe } from "./recipe-distill.ts";
import { shapeRecipeDraft } from "./recipe-draft.ts";
import { portalJobIntentReply } from "./portal-job-intent.ts";
import {
  ATTEND_ERRORS,
  attendBlocked,
  attendedJobSystemBlock,
  attendedSettleStatus,
  attendedUserText,
  fenceContextFor,
  fenceEvidence,
  portalRespondRuleError,
  READY_BESIDE_YOU_SKIP,
  setFenceContext,
  submitHoldLine,
  takeFenceContext,
  turnEndedNote,
} from "./attended-run.ts";
import {
  clickControlLabel,
  fenceDecision,
  fencePayload,
  isComputerTool,
  ruleAllowNote,
  submitPressSummary,
} from "./portal-fence.ts";
import { getSession, grantLease, listSessions, revokeLease } from "./portal-sessions.ts";
import { executeRecipeJob } from "./job-executor.ts";
import { jobRuns, READY_BESIDE_YOU } from "./job-runs.ts";
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
import { DATA_DIR, ensureDirs, instanceConfigs, loadConfig, saveConfig, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import { resetPathCache } from "./env-path.ts";
import { newId, type ProviderInstance, type RuntimeEvent } from "./contracts.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import {
  mentionedBots,
  roomResponders,
  Store,
  type GroupDefaultResponder,
  type Message,
  type QueuedMessage,
} from "./store.ts";
import * as tts from "./tts/index.ts";
import { narrateTool, toUtterances } from "./tts/speech-text.ts";
import { cuaAttendedReady, readCuaConnection } from "./local-computer.ts";
import { applyPropertyPack } from "./hermes-pack.ts";
import { applyHandsReadiness, hermesStatus } from "./hermes-status.ts";
import { hermesInstallCommand } from "./hermes-pin.ts";
import { tryHermesPing } from "./hermes-hands.ts";
import { ASK_ATTACH_MAX_BYTES, saveAskAttachment } from "./ask-attach.ts";
import { answerAskFromDesk, productAskFailure, productBudSystemPrompt, productWorkerDump } from "./ask-book.ts";
import { readHandsLast, readHandsPing, writeHandsPing } from "./hands-last.ts";
import { readArtifact } from "./audit-artifacts.ts";
import { readCsvMapping } from "./csv-ledger.ts";
import { inspectLedgerColumns } from "./import-inspect.ts";
import { Desk } from "./desk.ts";
import { seedVault } from "./vault.ts";
import { openTerminalAndRun, setupCommandFor } from "./engine-setup.ts";
import { attachModel, installInFlight, installStatus, listModelOptions, listModels, modelStatus, preflight, PROVIDER_OPTIONS, startInstall, type PreflightResult } from "./hermes-bridge.ts";
import { startRepair, uninstallWorker } from "./hermes-lifecycle.ts";
import { installCrashHandlers, oplog } from "./oplog.ts";
import { CANONICAL_BUD_ID, CANONICAL_BUD_NAME, PRODUCT_MODE, PRODUCT_TURN_DEFAULTS, isCanonicalBud, productDenied, productRuntimeEventVisible } from "./product-mode.ts";
import { coverageFromUncoveredHeld, LoopManager, type LoopId } from "./routines.ts";
import { hostAllowed, needsSession, originAllowed, SESSION_TOKEN, sessionOk } from "./session-auth.ts";
import { evaluatorForLoop } from "./workflow-catalog.ts";
import { containsCredential } from "./redact.ts";
import { parseConnectionIntent } from "./connection-intent.ts";
import { parseRequestDecision } from "./request-decision.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { TurnWatchdog, type TurnExpiryReason } from "./turn-watchdog.ts";
import { SingleFlight } from "./single-flight.ts";
import { writeDeskContext } from "./desk-context.ts";
import {
  bindDiscordBridge,
  connectDiscord,
  disconnectDiscord,
  discordAdapter,
  discordDecisionAdapter,
  startDiscordBridge,
  stopDiscordBridge,
} from "./channels/discord.ts";
import {
  bindSlackBridge,
  connectSlack,
  disconnectSlack,
  slackAdapter,
  slackDecisionAdapter,
  startSlackBridge,
  stopSlackBridge,
} from "./channels/slack.ts";
import {
  bindTelegramBridge,
  connectTelegram,
  disconnectTelegram,
  startTelegramBridge,
  stopTelegramBridge,
  telegramAdapter,
  telegramDecisionAdapter,
} from "./channels/telegram.ts";
import type { ChannelsPayload } from "./channels/types.ts";
import { pulseLoopSettled } from "./pulses.ts";
import {
  bindRemoteDecisions,
  notifyDeskSnapshot,
  startRemoteDecisionFlush,
  stopRemoteDecisionFlush,
} from "./remote-decisions.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;
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
const CSV_IMPORT_MAX_BYTES = 750_000;
const ASK_MESSAGE_MAX_CHARS = 50_000;

function csvDigest(csv: string): string {
  return createHash("sha256").update(csv, "utf8").digest("hex");
}

ensureDirs();
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
  process.env.OMB_TEST_FLEET === "1"
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
const existingProductBud = store.bot(CANONICAL_BUD_ID) ?? store.bots[0] ?? null;
const existingProductInstance = existingProductBud
  ? registry.get(existingProductBud.modelSelection.instanceId)
  : null;
// Old installs may still hold a pre-product assistant (for example Sage on
// an obsolete Claude instance) while Hermes setup correctly reports ready.
// Adopt it in place so history survives, and rebind only when a usable
// Hermes worker is available.
if (PRODUCT_MODE) {
  store.adoptBud(
    existingProductInstance?.driverKind !== "hermesAgent"
      ? productHermesSelection()
      : undefined,
  );
}
for (const bot of store.bots) {
  const threadIds = new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]);
  for (const threadId of threadIds) store.settleOpenRequests(threadId);
}

const publicBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => ({
  ...bot,
  messages: store.messagesFor(bot.threadId),
  activeLeafId: store.activeLeaf(bot.threadId),
  tasks: store.tasks(bot.id).map(({ resumeCursors, ...task }) => task),
});

/** Fresh installs use id `bud`; upgraded installs retain their old id so
 * every transcript and external reference remains valid. Both are the same
 * single product worker at the authoritative server boundary. */
function isProductBud(id: string): boolean {
  if (!PRODUCT_MODE) return isCanonicalBud(id);
  return (store.bot(CANONICAL_BUD_ID) ?? store.bots[0] ?? null)?.id === id;
}

function productHermesSelection(model = "default") {
  const instance = registry.instances().find((candidate) => candidate.driverKind === "hermesAgent");
  return instance ? { instanceId: instance.instanceId, model } : undefined;
}

// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set<ServerResponse>();
jobRuns.setEmit((payload) => broadcast(payload));

function lastAssistantText(threadId: string): string {
  const texts = store
    .messagesFor(threadId)
    .filter((message) => message.role === "bot" && message.kind === "text" && message.text);
  return texts.at(-1)?.text ?? "";
}

function settleAttendedTurn(
  threadId: string,
  input: { ok: boolean; stopReason?: string | null; detail?: string },
) {
  const ctx = takeFenceContext(threadId);
  if (!ctx) return;
  const run = jobRuns.get(ctx.runId);
  if (!run || run.status !== "running") return;
  const text = input.detail ?? lastAssistantText(threadId);
  const status = attendedSettleStatus({
    ok: input.ok,
    stopReason: input.stopReason,
    text,
    allowedOrigins: ctx.allowedOrigins,
  });
  try {
    jobRuns.settle(ctx.runId, {
      status,
      detail: text || (input.ok ? "Turn ended." : "The turn did not finish."),
      evidence: [{ at: Date.now(), kind: "note", note: turnEndedNote(input.ok, input.stopReason) }],
      approvalRequests: submitHoldLine(text),
    });
  } catch {
    /* already settled */
  }
}

function recordFenceEvidence(threadId: string, item: ReturnType<typeof fenceEvidence>) {
  const ctx = fenceContextFor(threadId);
  if (!ctx) return;
  try {
    jobRuns.appendEvidence(ctx.runId, [item]);
  } catch {
    /* run already settled */
  }
}

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

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function productTurnStopMessage(reason: TurnExpiryReason): string {
  if (reason === "repeated-tool") {
    return "I stopped after the same step repeated without progress. Nothing else will run until you ask again.";
  }
  if (reason === "tool-budget") {
    return "I stopped after reaching this request's safe work limit. Nothing else will run until you ask again.";
  }
  if (reason === "deadline") {
    return "I stopped because this turn was taking too long. Nothing else will run until you ask again.";
  }
  return "I stopped because Bud stopped responding. Nothing else will run until you ask again.";
}

const expectedStoppedThreads = new Set<string>();
const steeringBots = new Set<string>();
const connectionOperations = new Map<string, string>();

const watchdog = new TurnWatchdog({
  stallMs: Number(process.env.OMB_TURN_STALL_MS) || 20 * 60_000,
  checkMs: 30_000,
  maxMs: PRODUCT_MODE ? positiveEnvInt("OMB_PRODUCT_TURN_MAX_MS", PRODUCT_TURN_DEFAULTS.maxMs) : undefined,
  maxTools: PRODUCT_MODE ? positiveEnvInt("OMB_PRODUCT_TURN_MAX_TOOLS", PRODUCT_TURN_DEFAULTS.maxTools) : undefined,
  maxRepeatedTool: PRODUCT_MODE
    ? positiveEnvInt("OMB_PRODUCT_TURN_MAX_REPEATED_TOOL", PRODUCT_TURN_DEFAULTS.maxRepeatedTool)
    : undefined,
  onStall: (turn, reason) => {
    const bot = store.bot(turn.botId);
    const instance = bot ? registry.get(bot.modelSelection.instanceId) : null;
    if (PRODUCT_MODE) expectedStoppedThreads.add(turn.threadId);
    void instance?.adapter.interruptTurn(turn.threadId).catch(() => {});
    if (!bot) return;
    store.patchBot(bot.id, { busy: false });
    const message = PRODUCT_MODE
      ? store.appendMessage(turn.threadId, { role: "bot", kind: "text", text: productTurnStopMessage(reason) })
      : store.appendMessage(turn.threadId, {
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
const toolNameByItem = new Map<string, string>(); // threadId:itemId -> tool title (history)
const turnStartedAt = new Map<string, number>(); // threadId:turnId -> started ms
const askMessageByRequest = new Map<string, string>(); // threadId:requestId -> messageId

async function denyPendingRequests(threadId: string, instance: ProviderInstance | null | undefined): Promise<void> {
  const prefix = `${threadId}:`;
  const requestIds = [...askMessageByRequest.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  await Promise.allSettled(
    requestIds.map((requestId) =>
      instance?.adapter.respondToRequest(threadId, requestId, {
        behavior: "deny",
        message: "The user stopped this turn.",
      }),
    ),
  );
  for (const message of store.settleOpenRequests(threadId)) {
    broadcast({ kind: "message.patch", threadId, message });
  }
  for (const requestId of requestIds) askMessageByRequest.delete(`${threadId}:${requestId}`);
  watchdog.setWaitingOnHuman(threadId, false);
}

// Group threads: the fold needs to know WHO is talking — the turn engine
// records the active member here before dispatching its turn.
const groupSpeakers = new Map<string, { botId: string; name: string; color: string }>();
let loops: LoopManager | null = null;
const desk = new Desk();
try {
  writeDeskContext(desk.snapshot());
} catch {
  /* Desk remains usable if its read-only worker projection cannot be refreshed. */
}
// The Local VM is intentionally one shared, visible desktop. Two agents
// driving it simultaneously would mix clicks, keystrokes and screenshots,
// so only one thread may lease it at a time.
let activeVmThreadId: string | null = null;
let localVmLifecycleBusy = false;

function attachFenceToOpened(event: RuntimeEvent): RuntimeEvent {
  if (event.type !== "request.opened" || event.requestType !== "permission") return event;
  if (!isComputerTool(event.tool, event.summary)) return event;
  const fence = fenceContextFor(event.threadId);
  if (!fence) return event;
  const decision = fenceDecision(
    { ...fence, rules: loadRules() },
    { tool: event.tool, params: event.params, summary: event.summary },
  );
  const payload = fencePayload(decision);
  return payload ? { ...event, fence: payload } : event;
}

bus.subscribe((raw: RuntimeEvent) => {
  const event = raw.type === "request.opened" ? attachFenceToOpened(raw) : raw;
  watchdog.touch(event.threadId);
  if (event.type === "request.opened") watchdog.setWaitingOnHuman(event.threadId, true);
  if (event.type === "request.resolved") watchdog.setWaitingOnHuman(event.threadId, false);
  if (event.type === "turn.completed") watchdog.settle(event.threadId);
  const bot = store.botByThread(event.threadId);
  const group = bot ? undefined : store.groupByThread(event.threadId);
  if (!bot && !group) return;
  const speaker = group ? groupSpeakers.get(event.threadId) : undefined;
  const intentionallyStopped = PRODUCT_MODE && expectedStoppedThreads.has(event.threadId);
  if (intentionallyStopped && event.type === "request.opened") {
    const owner = bot ?? (speaker ? store.bot(speaker.botId) : null);
    const instance = event.providerInstanceId
      ? registry.get(event.providerInstanceId)
      : owner
        ? registry.get(owner.modelSelection.instanceId)
        : null;
    if (event.requestId) {
      void instance?.adapter.respondToRequest(event.threadId, event.requestId, {
        behavior: "deny",
        message: "The user stopped this turn.",
      }).catch(() => {});
    }
    return;
  }
  if (intentionallyStopped && event.type !== "request.resolved" && event.type !== "turn.completed") return;
  if (!PRODUCT_MODE || productRuntimeEventVisible(event)) broadcast({ kind: "runtime", event });

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
    case "turn.started":
      if (bot && isProductBud(bot.id) && event.turnId) {
        const started = Date.parse(event.createdAt);
        turnStartedAt.set(`${event.threadId}:${event.turnId}`, Number.isFinite(started) ? started : Date.now());
      }
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        // A provider failure can land as a normal assistant reply (the worker
        // prints its retry dump and ends the turn). Answer in PM language and
        // drop the resume cursor so the next turn gets a fresh session.
        const dump = PRODUCT_MODE ? productWorkerDump(event.text) : null;
        pushMessage({ role: "bot", kind: "text", text: dump ?? event.text });
        if (dump && bot) {
          store.clearResumeCursor(bot.id, event.providerInstanceId ?? bot.modelSelection.instanceId, event.threadId);
        }
      } else if (event.itemType === "tool" && event.itemId) {
        const itemKey = `${event.threadId}:${event.itemId}`;
        const messageId = toolMessageByItem.get(itemKey);
        let toolName = toolNameByItem.get(itemKey) ?? "tool";
        toolNameByItem.delete(itemKey);
        if (messageId) {
          // the whole tool object is replaced, so carry `spoken` across —
          // dropping it here would silently un-narrate every completed tool
          const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool;
          toolName = existing?.name ?? toolName;
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: toolName, ok: event.ok, spoken: existing?.spoken },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(itemKey);
        }
        if (bot && isProductBud(bot.id)) {
          try {
            appendHistory({
              kind: "tool",
              name: toolName,
              ok: Boolean(event.ok),
              detail: "",
              threadId: event.threadId,
              turnId: event.turnId,
            });
          } catch {
            /* history must not take the desk down */
          }
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
        watchdog.noteTool(event.threadId, event.title);
        if (event.itemId) toolNameByItem.set(`${event.threadId}:${event.itemId}`, event.title ?? "tool");
        // Raw provider tool names are implementation noise in the single-Bud
        // product. Permission cards remain visible and authoritative.
        if (PRODUCT_MODE) break;
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
      if (permission && asker && event.requestId && isComputerTool(event.tool, event.summary)) {
        const fence = fenceContextFor(event.threadId);
        const request = { tool: event.tool, params: event.params, summary: event.summary };
        const instance = event.providerInstanceId
          ? registry.get(event.providerInstanceId)
          : registry.get(asker.modelSelection.instanceId);
        const requestId = event.requestId;
        if (!fence) {
          const reason = "Only sites named in a saved job. Ask Bud to set the routine up as a job first.";
          void (async () => {
            try {
              if (!instance) throw new Error("provider unavailable");
              await instance.adapter.respondToRequest(event.threadId, requestId, {
                behavior: "deny",
                message: reason,
              });
              pushMessage({ role: "bot", kind: "activity", tool: { name: reason, ok: false } });
            } catch {
              pushMessage({ role: "bot", kind: "activity", tool: { name: reason, ok: false } });
            }
          })();
          break;
        }
        const decision = fenceDecision({ ...fence, rules: loadRules() }, request);
        const allowNote = decision.kind === "allow" ? ruleAllowNote(decision) : undefined;
        recordFenceEvidence(
          event.threadId,
          decision.kind === "allow"
            ? { at: Date.now(), kind: "action", note: allowNote! }
            : fenceEvidence(request, decision),
        );
        if (decision.kind === "deny" || decision.kind === "allow") {
          const reason = decision.kind === "deny" ? (decision.reason ?? "Denied.") : allowNote!;
          void (async () => {
            try {
              if (!instance) throw new Error("provider unavailable");
              await instance.adapter.respondToRequest(
                event.threadId,
                requestId,
                decision.kind === "deny" ? { behavior: "deny", message: reason } : { behavior: "allow" },
              );
              pushMessage({
                role: "bot",
                kind: "activity",
                tool: { name: reason, ok: decision.kind === "allow" },
              });
            } catch {
              const card = pushMessage({
                role: "bot",
                kind: "options",
                card: {
                  title: "Approval needed",
                  subtitle: event.summary,
                  options: ["Allow", "Deny"],
                  requestId,
                  tool: event.tool,
                  allowKey: approvalKey(event.tool, event.summary),
                },
              });
              askMessageByRequest.set(`${event.threadId}:${requestId}`, card.id);
            }
          })();
          break;
        }
      }
      // RealBud never auto-answers a permission, whatever the bot record
      // says. Auto mode exists only in the legacy fleet (OMB_TEST_FLEET=1).
      // Product mode uses standing rules (guards still win).
      let settled: string | null = null;
      let ruleDeny = false;
      if (permission && asker && event.requestId) {
        if (!PRODUCT_MODE) {
          settled = autoDecision(asker, event.tool, event.summary);
        } else {
          const verdict = evaluateRules(loadRules(), event.tool, event.summary);
          if (verdict) {
            const key = approvalKey(event.tool, event.summary);
            settled = `${verdict === "deny" ? "denied" : "allowed"} by your rule: ${key}`;
            ruleDeny = verdict === "deny";
          }
        }
      }
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
            await instance.adapter.respondToRequest(
              event.threadId,
              requestId,
              ruleDeny ? { behavior: "deny", message: "Denied by a standing rule." } : { behavior: "allow" },
            );
            pushMessage({
              role: "bot",
              kind: "activity",
              tool: {
                name: PRODUCT_MODE ? settled : `${settled}: ${summary.slice(0, 120)}`,
                ok: !ruleDeny,
              },
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
      const submitSummary =
        event.type === "request.opened" && event.fence?.surface === "portal-submit"
          ? submitPressSummary(clickControlLabel(event.params, event.summary), event.fence.origin)
          : null;
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: permission ? "Approval needed" : "Your bot has a question",
          subtitle: submitSummary ?? event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
          tool: permission ? event.tool : undefined,
          // the exact grant "always allow" would remember, decided here so
          // client and server can never derive it differently
          allowKey: permission ? approvalKey(event.tool, event.summary) : undefined,
          // in auto mode a card can only mean the guard stopped it — say so
          held: permission && asker?.autoApprove ? "This looked destructive, so auto mode stopped to ask." : undefined,
          ...(event.type === "request.opened" && event.fence ? { fence: event.fence } : {}),
        },
      });
      if (event.requestId) askMessageByRequest.set(`${event.threadId}:${event.requestId}`, message.id);
      break;
    }
    case "request.resolved": {
      const messageId = event.requestId ? askMessageByRequest.get(`${event.threadId}:${event.requestId}`) : null;
      if (event.behavior === "allow" && fenceContextFor(event.threadId)) {
        const resolvedCard = messageId
          ? store.messagesFor(event.threadId).find((m) => m.id === messageId)?.card
          : undefined;
        recordFenceEvidence(event.threadId, {
          at: Date.now(),
          kind: "action",
          note:
            resolvedCard?.fence?.surface === "portal-submit"
              ? `Submit pressed with your approval on ${resolvedCard.fence.origin}.`
              : "Allowed once by you.",
        });
      }
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
      if (PRODUCT_MODE && expectedStoppedThreads.has(event.threadId)) break;
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false, setup: event.setup },
      });
      break;
    case "turn.completed": {
      settleAttendedTurn(event.threadId, { ok: Boolean(event.ok), stopReason: event.stopReason });
      if (bot && isProductBud(bot.id)) {
        const turnKey = event.turnId ? `${event.threadId}:${event.turnId}` : "";
        const started = turnKey ? turnStartedAt.get(turnKey) : undefined;
        if (turnKey) turnStartedAt.delete(turnKey);
        const ended = Date.parse(event.createdAt);
        const durationMs =
          started != null && Number.isFinite(started) && Number.isFinite(ended) && ended >= started
            ? ended - started
            : undefined;
        try {
          appendHistory({
            kind: "turn",
            name: "ask turn",
            ok: Boolean(event.ok),
            detail: "",
            threadId: event.threadId,
            turnId: event.turnId,
            ...(durationMs !== undefined ? { durationMs } : {}),
          });
        } catch {
          /* history must not take the desk down */
        }
      }
      if (activeVmThreadId === event.threadId) activeVmThreadId = null;
      if (PRODUCT_MODE && expectedStoppedThreads.delete(event.threadId)) {
        stopScreenPoller(bot?.id ?? "");
        break;
      }
      if (bot) {
        const queued = store.takeQueuedMessage(bot.id, event.threadId);
        store.patchBot(bot.id, { busy: false, unread: true });
        if (queued) {
          // Starting the next instruction matters more than capturing an
          // intermediate screenshot. A final capture would contend with the
          // new turn for the same computer endpoint and can add seconds.
          stopScreenPoller(bot.id);
          void dispatchQueuedMessage(bot.id, queued);
        } else {
          broadcast({ kind: "bot", bot: store.bot(bot.id) });
        }
        if (!queued && screenPollers.has(bot.id)) {
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
    userMessage?: Message;
    /** Pin the destination thread for the whole turn. */
    threadId?: string;
    onDispatchError?: (message: string) => void;
    /** Extra product-prompt block for an attended job. */
    systemExtra?: string;
    /** Mount the host computer MCP for this turn. */
    computer?: boolean;
  },
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (PRODUCT_MODE && containsCredential(text)) {
    throw Object.assign(
      new Error("Provider keys go on You → Attach model. Ask never sees the secret."),
      { status: 400 },
    );
  }
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
  const threadId = opts?.threadId ?? bot.threadId;
  const task = store.taskByThread(bot.id, threadId);
  if (!task) throw Object.assign(new Error("no such task"), { status: 404 });
  const commsDepth = opts?.commsDepth ?? 0;
  // a task takes its name from the first thing you asked it to do
  if (text.trim()) store.titleTaskFromFirstMessage(bot.id, text, threadId);

  if (PRODUCT_MODE && isProductBud(bot.id) && !opts?.systemExtra) {
    try {
      const portalReply = await portalJobIntentReply(text, {
        recipes: listRecipes,
        draft: async (draftText) => {
          const shaped = await shapeRecipeDraft(draftText);
          if (!shaped.draft) {
            throw Object.assign(new Error(shaped.detail), { status: 503 });
          }
          return shaped.draft;
        },
        save: (draft) => {
          const all = saveRecipe(draft);
          return all.find((row) => row.id === draft.id) ?? all[all.length - 1]!;
        },
      });
      if (portalReply) {
        let userMessage = opts?.userMessage;
        if (!userMessage) {
          userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
          broadcast({ kind: "message", threadId, message: userMessage });
        }
        const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: portalReply.reply });
        broadcast({ kind: "message", threadId, message: reply });
        return;
      }
    } catch {
      /* no intercept — continue to the model turn */
    }
  }

  const connectionIntent = PRODUCT_MODE && isProductBud(bot.id) ? parseConnectionIntent(text) : null;
  if (connectionIntent) {
    let userMessage = opts?.userMessage;
    if (!userMessage) {
      userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
      broadcast({ kind: "message", threadId, message: userMessage });
    }
    store.patchBot(bot.id, { busy: true, unread: false });
    const connectionOperationId = newId();
    connectionOperations.set(bot.id, connectionOperationId);
    broadcast({ kind: "bot", bot: store.bot(bot.id) });
    void (async () => {
      try {
        if (!cfg.composio?.key) {
          const message = store.appendMessage(threadId, {
            role: "bot",
            kind: "text",
            text: `Connected apps needs its private broker key once. Open You → Connected apps, save it there, then say “connect ${connectionIntent.label}” again. Never paste the key into Ask.`,
          });
          broadcast({ kind: "message", threadId, message });
          return;
        }
        const authorized = await composio.authorizeService(cfg, connectionIntent.slug);
        if (connectionOperations.get(bot.id) !== connectionOperationId) return;
        const authorizationUrl = new URL(String(authorized.url));
        if (authorizationUrl.protocol !== "https:") throw new Error("the connection broker returned an unsafe link");
        const requestId = newId();
        const message = store.appendMessage(threadId, {
          role: "bot",
          kind: "text",
          text: `I opened ${connectionIntent.label} sign-in. Finish the provider's own sign-in in your browser. If it did not open, [continue connecting ${connectionIntent.label}](${authorizationUrl.toString()}).`,
        });
        broadcast({ kind: "message", threadId, message });
        broadcast({
          kind: "external.open",
          requestId,
          service: connectionIntent.slug,
          url: authorizationUrl.toString(),
        });
      } catch (error) {
        if (connectionOperations.get(bot.id) !== connectionOperationId) return;
        const raw = error instanceof Error ? error.message : String(error);
        const message = store.appendMessage(threadId, {
          role: "bot",
          kind: "text",
          text: `I couldn't open ${connectionIntent.label} sign-in. ${productAskFailure(raw)}`,
        });
        broadcast({ kind: "message", threadId, message });
      } finally {
        if (connectionOperations.get(bot.id) !== connectionOperationId) return;
        connectionOperations.delete(bot.id);
        watchdog.settle(threadId);
        const queued = store.takeQueuedMessage(bot.id, threadId);
        store.patchBot(bot.id, { busy: false, unread: true });
        if (queued) void dispatchQueuedMessage(bot.id, queued);
        else broadcast({ kind: "bot", bot: store.bot(bot.id) });
      }
    })();
    return;
  }

  const bookReply = PRODUCT_MODE && isProductBud(bot.id) ? answerAskFromDesk(text, desk.snapshot()) : null;
  if (bookReply) {
    let userMessage = opts?.userMessage;
    if (!userMessage) {
      userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
      broadcast({ kind: "message", threadId, message: userMessage });
    }
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: bookReply });
    broadcast({ kind: "message", threadId, message: reply });
    return;
  }

  const instance = registry.get(bot.modelSelection.instanceId);
  if (!instance) {
    throw Object.assign(
      new Error(`provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`),
      { status: 409 },
    );
  }
  const instanceId = instance.instanceId;
  const model = bot.modelSelection.model;

  // an edit hands us its already-branched user message; a plain send appends
  let userMessage = opts?.userMessage;
  if (!userMessage) {
    userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
    broadcast({ kind: "message", threadId, message: userMessage });
  }

  // transcript for API-backed drivers: settled text turns on the ACTIVE
  // branch only — abandoned forks never reach the model
  const transcript = store
    .activePath(threadId)
    .filter((m) => m.kind === "text" && m.text && m.id !== userMessage.id)
    .slice(-40)
    .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text! }));

  // After a rewind (edit / branch switch) the provider's native session
  // still contains the abandoned branch: start a fresh session instead of
  // resuming, and for cursor-resuming drivers replay the surviving path
  // inline (transcript-replay drivers get it via transcript). The flag is
  // cleared only once the turn is actually dispatched — clearing it here
  // would cost the next attempt its history if this dispatch fails.
  const rewound = threadId === bot.threadId && Boolean(bot.rewound);
  const turnText =
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

  const persona = [
    `You are ${bot.name}, a personal bot in RealBud.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");

  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — box provisioning can take ~90s and must never
  // hang the HTTP request
  store.patchBot(bot.id, { busy: true, unread: false });
  expectedStoppedThreads.delete(threadId);
  watchdog.watch(threadId, bot.id);
  broadcast({ kind: "bot", bot: store.bot(bot.id) });

  void (async () => {
    try {
      const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
      if (cfg.composio?.key) integrations.composio = { key: cfg.composio.key, url: cfg.composio.url };
      if (PRODUCT_MODE) {
        await instance.adapter.sendTurn({
          threadId,
          text: turnText,
          model,
          resumeCursor: rewound ? undefined : task.resumeCursors[instanceId],
          transcript,
          system: [productBudSystemPrompt(), opts?.systemExtra].filter(Boolean).join("\n\n"),
          integrations,
          ...(readCuaConnection() || opts?.computer ? { computer: true } : {}),
        });
        if (rewound) store.patchBot(bot.id, { rewound: false, resumeCursors: {} });
        return;
      }
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
      if (activeVmThreadId === threadId) activeVmThreadId = null;
      if (PRODUCT_MODE && expectedStoppedThreads.delete(threadId)) {
        watchdog.settle(threadId);
        store.patchBot(bot.id, { busy: false });
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
        return;
      }
      const raw = e instanceof Error ? e.message : String(e);
      const message = PRODUCT_MODE ? productAskFailure(raw) : raw;
      const failure = store.appendMessage(threadId, {
        role: "bot",
        kind: PRODUCT_MODE ? "text" : "activity",
        text: PRODUCT_MODE ? message : undefined,
        tool: PRODUCT_MODE ? undefined : { name: `error: ${message.slice(0, 160)}`, ok: false },
      });
      broadcast({ kind: "message", threadId, message: failure });
      watchdog.settle(threadId);
      store.patchBot(bot.id, { busy: false });
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      settleAttendedTurn(threadId, { ok: false, stopReason: "error", detail: message });
      opts?.onDispatchError?.(message);
    }
  })();
}

/** Deliver a previously claimed follow-up. Claiming happens synchronously
 * before this function is called, so a completion event and a user click can
 * never send the same slot twice. A pre-dispatch failure restores it. */
async function dispatchQueuedMessage(botId: string, queued: QueuedMessage): Promise<void> {
  try {
    await startTurn(botId, queued.text, { threadId: queued.threadId });
    // Desk quick answers do not enter a busy state, so they need an explicit
    // bot projection to clear the queue chip in every open window.
    if (!store.bot(botId)?.busy) broadcast({ kind: "bot", bot: store.bot(botId) });
  } catch (error) {
    store.restoreQueuedMessage(botId, queued);
    const bot = store.bot(botId);
    if (!bot) return;
    const raw = error instanceof Error ? error.message : String(error);
    const detail = PRODUCT_MODE ? productAskFailure(raw) : raw;
    const message = store.appendMessage(queued.threadId, {
      role: "bot",
      kind: "text",
      text: `Your follow-up is still queued because it could not start: ${detail}`,
    });
    broadcast({ kind: "message", threadId: queued.threadId, message });
    broadcast({ kind: "bot", bot });
  }
}

async function waitUntilTurnStopped(instance: ProviderInstance | null, threadId: string, timeoutMs = 4_000) {
  if (!instance) return;
  const deadline = Date.now() + timeoutMs;
  while (instance.adapter.hasSession(threadId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (instance.adapter.hasSession(threadId)) {
    throw Object.assign(new Error("Bud is still stopping the previous turn — try steer again in a moment"), {
      status: 409,
    });
  }
}

// ── named loops: the RealBud clock presses Desk Recheck ────────────────
// RealBud owns WHEN; Hermes owns HOW (headless, facts only, no cron).
// A loop is never a bot turn, a prompt, or a second agent.
function commitDesk(snapshot: ReturnType<Desk["snapshot"]>) {
  try {
    writeDeskContext(snapshot);
  } catch {
    /* The durable Desk write already succeeded; projection repair can retry on the next commit or boot. */
  }
  broadcast({ kind: "desk", snapshot });
  notifyDeskSnapshot(snapshot);
}

bindRemoteDecisions({
  desk,
  commit: commitDesk,
  channels: [telegramDecisionAdapter(), discordDecisionAdapter(), slackDecisionAdapter()],
});

// Desk, Schedule, and a fast double-click all reach the same Recheck door.
// One worker read must mint one durable Desk revision; overlapping callers
// wait for that same result instead of duplicating facts, drafts, or receipts.
const deskCheckFlight = new SingleFlight<ReturnType<Desk["snapshot"]>>();
function runDeskCheck(origin?: Parameters<Desk["withRoutineOrigin"]>[0]) {
  return deskCheckFlight.run(async () => {
    const check = async () => {
      const snapshot = await desk.runMorningCheckLive();
      commitDesk(snapshot);
      return snapshot;
    };
    return origin ? desk.withRoutineOrigin(origin, check) : check();
  });
}

let installPreflight: PreflightResult | null = null;

function emitLoopAndPulse(payload: unknown) {
  broadcast(payload);
  if (process.env.VITEST) return;
  if (!payload || typeof payload !== "object") return;
  const rec = payload as { kind?: string; run?: { loopId?: string; status?: string } };
  if (rec.kind !== "loop.run" || !rec.run?.loopId) return;
  const status = rec.run.status;
  if (status !== "completed" && status !== "failed" && status !== "partial" && status !== "missed") return;
  void pulseLoopSettled(rec.run.loopId, desk.snapshot()).catch(() => {
    /* a channel miss must never fail the clock */
  });
}

loops = new LoopManager({
  emit: emitLoopAndPulse,
  listRecipes,
  setRecipeEnabled: (recipeId, enabled) => {
    try {
      const current = getRecipe(recipeId);
      if (!current) return;
      if (!enabled) patchRecipeStatus(recipeId, "paused");
      else if (current.status === "paused") {
        const approved = current.planApprovedAt != null && current.approvedRevision === current.revision;
        patchRecipeStatus(recipeId, approved ? "active" : "shadow");
      }
    } catch {
      /* job already gone — the clock drop is enough */
    }
  },
  execute: async (loop, run) => {
    jobRuns.sweepQueuedAttended();
    if (desk.recovery.active) return { ok: false, detail: "desk is in recovery — schedules are paused" };
    if (loop.id.startsWith("recipe-")) {
      const recipe = getRecipe(loop.id.slice("recipe-".length));
      if (!recipe) return { ok: false, detail: "that job is no longer on the book" };
      if (recipeHasPortalCapability(recipe.capabilities)) {
        const ready = recipeClockRunnable(recipe) && recipe.attachment != null;
        if (!ready) return { ok: false, detail: READY_BESIDE_YOU_SKIP };
        const enqueued = jobRuns.enqueue(recipe, {
          mode: "attended",
          trigger: run.manual ? "manual" : "schedule",
          scheduledFor: run.scheduledFor,
          loopRunId: run.id,
          idempotencyKey: `${recipe.id}:${recipe.revision}:${run.manual ? `manual:${run.id}` : `schedule:${run.scheduledFor}`}`,
          detail: READY_BESIDE_YOU,
        });
        return { ok: true, detail: enqueued.run.detail, jobRunId: enqueued.run.id };
      }
      if (!run.manual && !recipeClockRunnable(recipe)) {
        return { ok: false, detail: "Waiting for plan approval" };
      }
      const mode = recipeClockRunnable(recipe) ? "prepare" : "shadow";
      const executed = await executeRecipeJob(recipe, {
        mode,
        trigger: run.manual ? "manual" : "schedule",
        scheduledFor: run.scheduledFor,
        loopRunId: run.id,
        idempotencyKey: `${recipe.id}:${recipe.revision}:${run.manual ? `manual:${run.id}` : `schedule:${run.scheduledFor}`}`,
      });
      const ok = executed.run.status === "completed" || executed.run.status === "awaiting-approval";
      return { ok, detail: executed.run.detail, jobRunId: executed.run.id };
    }
    const spec = evaluatorForLoop(loop.id);
    if (spec && spec.mayLaunchCua) return { ok: false, detail: "the clock must not launch a browser" };
    const origin = { kind: "routine" as const, runId: run.id, loopId: loop.id };
    if (loop.id === "owner-letter") {
      return desk.withRoutineOrigin(origin, async () => {
        const before = desk.snapshot().drafts.filter((d) => d.kind === "owner-letter").length;
        const snapshot = desk.draftOwnerLetters();
        commitDesk(snapshot);
        const after = snapshot.drafts.filter((d) => d.kind === "owner-letter").length;
        return { ok: true, detail: `Owner letters on Desk: ${after} (${after - before} new this week).` };
      });
    }
    if (loop.id !== "morning-arrears") return { ok: false, detail: "not built yet" };
    // Same door as Desk Recheck. Demo miss stays labelled Demo and writes
    // the shared worker clock. The fixture path never silently skips the worker.
    const snapshot = await runDeskCheck(origin);
    if (snapshot.hands === "held") {
      const coverage = coverageFromUncoveredHeld(snapshot.handsDetail, snapshot.results);
      return { ok: false, detail: snapshot.handsDetail ?? "held", ...coverage };
    }
    if (snapshot.mode === "demo") return { ok: true, detail: snapshot.handsDetail ?? "Demo check completed." };
    const live = snapshot.hands === "hermes" || snapshot.hands === "csv";
    return { ok: live, detail: snapshot.handsDetail ?? (live ? "Desk check completed." : "live check did not use live facts") };
  },
});
loops.start();

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
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
    box: { configured: Boolean(cfg.box?.token) },
    // the chosen voice is a setting, not a secret; the key is reported the
    // same configured-or-not way as every other credential
    tts: tts.describeVoice(cfg),
    // not a secret — the sidebar shows it
    profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
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

function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
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
      if (bytes > maxBytes) {
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
      return json(res, 200, { token: SESSION_TOKEN, product: PRODUCT_MODE, nonProduction: process.env.REALBUD_PRODUCTION !== "1" });
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
    if (path === "/api/loops" && method === "GET") {
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      const from = fromParam == null ? undefined : Number(fromParam);
      const to = toParam == null ? undefined : Number(toParam);
      return json(res, 200, {
        loops: loops!.listLoops(),
        runs: loops!.listRuns(from != null && Number.isFinite(from) ? from : undefined, to != null && Number.isFinite(to) ? to : undefined),
      });
    }
    let loopMatch = path.match(/^\/api\/loops\/([\w-]+)\/run$/);
    if (loopMatch && method === "POST") {
      const loop = loops!.listLoops().find((candidate) => candidate.id === loopMatch![1]);
      if (!loop) return json(res, 404, { error: "no such routine" });
      if (!loop.available) return json(res, 409, { error: "that routine is declared but not built yet" });
      try {
        const run = loops!.runNow(loopMatch[1] as LoopId);
        return run ? json(res, 201, { run }) : json(res, 409, { error: "turn this routine on before running it" });
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
      try {
        const loop = loops!.patchClock(loopMatch[1] as LoopId, {
          enabled: body.enabled,
          time: body.time,
          weekdays: body.weekdays,
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

    // ── standing rules (Ask Always-allow; You → Bud's rules) ──────────
    if (path === "/api/rules" && method === "GET") {
      return json(res, 200, { rules: loadRules() });
    }
    if (path === "/api/rules" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (body.surface !== undefined || parsePortalRuleKey(typeof body.key === "string" ? body.key : "")) {
        const surface = isPortalRuleSurface(body.surface)
          ? body.surface
          : parsePortalRuleKey(typeof body.key === "string" ? body.key : "")?.surface;
        if (!surface) return json(res, 400, { error: "surface must be portal-read or portal-prefill" });
        if (body.decision !== "allow") return json(res, 400, { error: "Portal rules can only allow." });
        const fromKey = parsePortalRuleKey(typeof body.key === "string" ? body.key : "");
        const origin = typeof body.origin === "string" ? normalizeOrigin(body.origin) : (fromKey?.origin ?? null);
        if (!origin) {
          return json(res, 400, { error: "Use a portal hostname like propertyme.com.au — no path or port." });
        }
        return json(res, 201, { rules: addPortalRule(surface, origin) });
      }
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key || key.length > 120) return json(res, 400, { error: "key must be 1–120 characters" });
      if (body.decision !== "allow" && body.decision !== "deny") {
        return json(res, 400, { error: "decision must be allow or deny" });
      }
      let label: string | undefined;
      if (body.label !== undefined) {
        if (typeof body.label !== "string" || body.label.length > 80) {
          return json(res, 400, { error: "label must be at most 80 characters" });
        }
        label = body.label;
      }
      return json(res, 201, { rules: addRule(key, body.decision, label) });
    }
    const ruleMatch = path.match(/^\/api\/rules\/([\w-]+)$/);
    if (ruleMatch && method === "DELETE") {
      try {
        return json(res, 200, { rules: removeRule(ruleMatch[1]) });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ── Law watch (shop reference drift; a person confirms before append) ──
    if (path === "/api/law-watch" && method === "GET") {
      return json(res, 200, lawWatchView());
    }
    if (path === "/api/law-watch/check" && method === "POST") {
      const result = await runLawWatch({
        jurisdictions: desk.snapshot().book?.agency?.jurisdictions ?? [],
      });
      if (!result) return json(res, 503, { error: "Bud could not re-read the shop reference." });
      persistLawWatchResult(result);
      return json(res, 200, lawWatchView());
    }
    if (path === "/api/law-watch/apply" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        applyLawDrift(body.index);
        return json(res, 200, lawWatchView());
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/law-watch/schedule" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      if (typeof body.on !== "boolean") return json(res, 400, { error: "on must be true or false" });
      setLawWatchScheduled(body.on);
      return json(res, 200, { scheduled: lawWatchView().scheduled });
    }

    // ── Channels (RealBud owns the door; Ask owns the turn) ──
    if (path === "/api/channels" && method === "GET") {
      return json(res, 200, channelsStatus());
    }
    const channelMatch = path.match(/^\/api\/channels\/([^/]+)$/);
    if (channelMatch && (method === "POST" || method === "DELETE")) {
      const platform = channelMatch[1];
      if (platform !== "telegram" && platform !== "discord" && platform !== "slack") {
        return json(res, 404, { error: "unknown channel" });
      }
      if (method === "POST") {
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          return json(res, 415, { error: "content-type must be application/json" });
        }
        const body = await readBody(req);
        const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
        if (!botToken) return json(res, 400, { error: "botToken required" });
        const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
        try {
          if (platform === "telegram") await connectTelegram(botToken);
          else if (platform === "discord") await connectDiscord(botToken);
          else await connectSlack(botToken, appToken || null);
          return json(res, 200, channelsStatus());
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (platform === "telegram") disconnectTelegram();
      else if (platform === "discord") disconnectDiscord();
      else disconnectSlack();
      return json(res, 200, channelsStatus());
    }

    // ── taught jobs + durable prepare receipts ───────────────────────
    if (path === "/api/job-runs" && method === "GET") {
      const jobId = url.searchParams.get("jobId")?.trim() || undefined;
      const requested = Number(url.searchParams.get("limit") ?? 100);
      const limit = Number.isInteger(requested) ? Math.max(1, Math.min(500, requested)) : 100;
      return json(res, 200, { runs: jobRuns.list(jobId).slice(0, limit) });
    }
    const jobRunSeen = path.match(/^\/api\/job-runs\/([\w-]+)\/seen$/);
    if (jobRunSeen && method === "POST") {
      try {
        return json(res, 200, { run: jobRuns.markSeen(jobRunSeen[1]) });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    // ── recipes + compatibility portal sessions (never submit) ───────
    if (path === "/api/recipes" && method === "GET") {
      return json(res, 200, { recipes: listRecipes() });
    }
    if (path === "/api/recipes/draft" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json(res, 400, { error: "Describe the job in a sentence or two." });
      if (text.length > 4_000) return json(res, 400, { error: "That description is too long." });
      const shaped = await shapeRecipeDraft(text);
      if (!shaped.draft) {
        return json(res, 503, { error: `Bud could not shape that job — ${shaped.detail}` });
      }
      return json(res, 200, { draft: shaped.draft });
    }
    if (path === "/api/recipes" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      return json(res, 201, { recipes: saveRecipe(body.draft) });
    }
    if (path === "/api/computer-history" && method === "GET") {
      return json(res, 200, { entries: listHistory(50) });
    }
    const recipeRun = path.match(/^\/api\/recipes\/([\w-]+)\/run$/);
    if (recipeRun && method === "POST") {
      const recipe = getRecipe(recipeRun[1]);
      if (!recipe) return json(res, 404, { error: "no such recipe" });
      try {
        const executed = await executeRecipeJob(recipe, {
          mode: "shadow",
          trigger: "manual",
          idempotencyKey: `${recipe.id}:${recipe.revision}:shadow:${randomBytes(16).toString("hex")}`,
        });
        return json(res, 200, { run: executed.run, session: executed.session });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const recipeAttend = path.match(/^\/api\/recipes\/([\w-]+)\/attend$/);
    if (recipeAttend && method === "POST") {
      const recipe = getRecipe(recipeAttend[1]);
      const bud = store.bot(CANONICAL_BUD_ID) ?? store.bots[0];
      const attendBody = await readBody(req);
      const runId = typeof attendBody.runId === "string" ? attendBody.runId.trim() : "";
      const queued = runId
        ? jobRuns.list(recipeAttend[1]).find((run) => run.id === runId)
        : undefined;
      if (runId && (!queued || queued.mode !== "attended" || queued.status !== "queued" || queued.jobId !== recipeAttend[1])) {
        return json(res, 404, { error: ATTEND_ERRORS.gone });
      }
      const blocked = attendBlocked(recipe, {
        cuaReady: cuaAttendedReady(),
        busy: Boolean(bud?.busy),
        inFlight: Boolean(
          recipe &&
            jobRuns.list(recipe.id).some(
              (run) => (run.status === "queued" || run.status === "running") && run.id !== queued?.id,
            ),
        ),
      });
      if (blocked) return json(res, blocked.status, { error: blocked.error });
      if (!recipe || !bud) return json(res, 404, { error: ATTEND_ERRORS.unknown });
      const threadId = bud.threadId;
      try {
        const running = queued
          ? jobRuns.start(queued.id, "Bud is running this job beside you.", { threadId })
          : (() => {
              const enqueued = jobRuns.enqueue(recipe, {
                mode: "attended",
                trigger: "manual",
                idempotencyKey: `${recipe.id}:${recipe.revision}:attended:${randomBytes(16).toString("hex")}`,
                threadId,
              });
              if (!enqueued.created) {
                throw Object.assign(new Error(ATTEND_ERRORS.overlap), { status: 409, run: enqueued.run });
              }
              return jobRuns.start(enqueued.run.id, "Bud is running this job beside you.", { threadId });
            })();
        setFenceContext(threadId, {
          runId: running.id,
          allowedOrigins: [...running.spec.allowedOrigins],
          capabilities: fenceCapabilitiesFor(recipe),
        });
        await startTurn(bud.id, attendedUserText(recipe), {
          threadId,
          systemExtra: attendedJobSystemBlock(recipe),
          computer: true,
        });
        return json(res, 202, { run: jobRuns.get(running.id) ?? running });
      } catch (error) {
        const running = jobRuns.list(recipe.id).find((run) => run.status === "running" || run.status === "queued");
        if (running?.status === "running") {
          settleAttendedTurn(threadId, {
            ok: false,
            stopReason: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        } else {
          takeFenceContext(threadId);
        }
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const recipePrepare = path.match(/^\/api\/recipes\/([\w-]+)\/prepare$/);
    if (recipePrepare && method === "POST") {
      const recipe = getRecipe(recipePrepare[1]);
      if (!recipe) return json(res, 404, { error: "no such recipe" });
      if (!recipeClockRunnable(recipe)) {
        return json(res, 409, { error: "Approve the current plan and activate the job before preparing it." });
      }
      try {
        const executed = await executeRecipeJob(recipe, {
          mode: "prepare",
          trigger: "manual",
          idempotencyKey: `${recipe.id}:${recipe.revision}:prepare:${randomBytes(16).toString("hex")}`,
        });
        return json(res, 200, { run: executed.run });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const recipeDistill = path.match(/^\/api\/recipes\/([\w-]+)\/distill$/);
    if (recipeDistill && method === "POST") {
      return json(res, 200, await distillRecipe(recipeDistill[1]));
    }
    const recipeMatch = path.match(/^\/api\/recipes\/([\w-]+)$/);
    if (recipeMatch && method === "PATCH") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        return json(res, 200, { recipes: patchRecipe(recipeMatch[1], body) });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (recipeMatch && method === "DELETE") {
      return json(res, 200, { recipes: deleteRecipe(recipeMatch[1]) });
    }
    if (path === "/api/portal-sessions" && method === "GET") {
      return json(res, 200, { sessions: listSessions() });
    }
    const sessionLease = path.match(/^\/api\/portal-sessions\/([\w-]+)\/lease$/);
    if (sessionLease && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const session = getSession(sessionLease[1]);
      if (!session) return json(res, 404, { error: "no such session" });
      const body = await readBody(req);
      return json(res, 200, { session: grantLease(session, String(body.origin ?? "")) });
    }
    if (sessionLease && method === "DELETE") {
      const session = getSession(sessionLease[1]);
      if (!session) return json(res, 404, { error: "no such session" });
      return json(res, 200, { session: revokeLease(session) });
    }

    // ── PM desk (never sends) ────────────────────────────────────────
    if (path === "/api/ask/attachments" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req, Math.ceil(ASK_ATTACH_MAX_BYTES * 1.4) + 4_096);
      return json(res, 201, saveAskAttachment(DATA_DIR, body));
    }
    if (path === "/api/desk" && method === "GET") {
      return json(res, 200, desk.snapshot());
    }
    if (path === "/api/desk/check" && method === "POST") {
      const snapshot = await runDeskCheck();
      return json(res, 200, snapshot);
    }
    if (path === "/api/desk/practice" && method === "POST") {
      const snapshot = desk.runMorningCheck();
      commitDesk(snapshot);
      return json(res, 200, snapshot);
    }
    if (path === "/api/desk/reset" && method === "POST") {
      const snapshot = desk.resetFixtures();
      commitDesk(snapshot);
      return json(res, 200, snapshot);
    }
    if (path === "/api/desk/agency" && method === "PATCH") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        const snapshot = desk.patchAgency({
          name: typeof body.name === "string" ? body.name : undefined,
          jurisdictions: Array.isArray(body.jurisdictions) ? body.jurisdictions : undefined,
          office: body.office,
        });
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/desk/import/preview" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const csv = String(body.csv ?? "");
      if (Buffer.byteLength(csv, "utf8") > CSV_IMPORT_MAX_BYTES) {
        return json(res, 413, { error: "CSV is too large; use a file under 750 KB" });
      }
      try {
        const observedAt = Date.now();
        const mapping = readCsvMapping(body.mapping);
        const preview = desk.previewCsv(csv, observedAt, mapping);
        return json(res, 200, { ...preview, digest: csvDigest(csv) });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/desk/import/inspect" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const csv = String(body.csv ?? "");
      if (Buffer.byteLength(csv, "utf8") > CSV_IMPORT_MAX_BYTES) {
        return json(res, 413, { error: "CSV is too large; use a file under 750 KB" });
      }
      try {
        return json(res, 200, await inspectLedgerColumns(csv));
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/desk/import" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const csv = String(body.csv ?? "");
      if (Buffer.byteLength(csv, "utf8") > CSV_IMPORT_MAX_BYTES) {
        return json(res, 413, { error: "CSV is too large; use a file under 750 KB" });
      }
      if (typeof body.expectedRevision !== "number" || typeof body.observedAt !== "number") {
        return json(res, 400, { error: "preview the CSV before importing it" });
      }
      const expectedDigest = String(body.expectedDigest ?? "");
      if (!/^[0-9a-f]{64}$/.test(expectedDigest) || expectedDigest !== csvDigest(csv)) {
        return json(res, 400, { error: "CSV changed after review; preview it again" });
      }
      try {
        // Revision + digest bind this commit to the reviewed book and exact file.
        const snapshot = desk.command({
          type: "import-csv",
          expectedRevision: body.expectedRevision,
          csv,
          observedAt: body.observedAt,
          mapping: readCsvMapping(body.mapping),
        });
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
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
    if (path === "/api/desk/recovery/start-again" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        const result = desk.startAgain(String(body.confirmation ?? ""));
        return json(res, 200, {
          ...result,
          preserved: result.preserved.length,
          message: "The locked book was preserved. Restart RealBud to begin with a new book.",
        });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
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
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/desk/book-proposals/allow-all" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      try {
        const snapshot = desk.allowAllBookProposals();
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    let bookMatch = path.match(/^\/api\/desk\/book-proposals\/([\w-]+)\/(allow|deny)$/);
    if (bookMatch && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      try {
        const snapshot = bookMatch[2] === "allow" ? desk.allowBookProposal(bookMatch[1]) : desk.denyBookProposal(bookMatch[1]);
        commitDesk(snapshot);
        return json(res, 200, snapshot);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
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
      const snapshot = process.env.FAKE_PORTAL_URL
        ? await desk.preparePortalAsync(deskPrepare[1])
        : desk.command({ type: "prepare-portal", draftId: deskPrepare[1], expectedRevision: desk.revision });
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
    const deskDraft = path.match(/^\/api\/desk\/drafts\/([\w-]+)\/(allow|deny)$/);
    if (deskDraft && method === "POST") {
      let expected: number | undefined;
      let reason: string | undefined;
      if (String(req.headers["content-type"] ?? "").toLowerCase().includes("json")) {
        const body = await readBody(req);
        if (typeof body.expectedRevision === "number") expected = body.expectedRevision;
        if (typeof body.reason === "string") reason = body.reason;
      }
      const draft =
        deskDraft[2] === "allow"
          ? desk.allowDraft(deskDraft[1], expected)
          : desk.denyDraft(deskDraft[1], expected, undefined, reason);
      commitDesk(desk.snapshot());
      return json(res, 200, { draft });
    }
    const deskEdit = path.match(/^\/api\/desk\/drafts\/([\w-]+)$/);
    if (deskEdit && method === "PATCH") {
      const body = await readBody(req);
      const draft = desk.editDraft(
        deskEdit[1],
        String(body.body ?? ""),
        typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
      );
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
      const status = applyHandsReadiness(await hermesStatus(), readHandsPing(DATA_DIR));
      const current = modelStatus();
      return json(res, 200, {
        ...status,
        lastTest: readHandsLast(DATA_DIR),
        lastPing: readHandsPing(DATA_DIR),
        model: {
          attached: Boolean(current.model && current.keyPresent),
          provider: current.provider,
          model: current.model,
        },
      });
    }
    if (path === "/api/hermes/test" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      const ping = await tryHermesPing();
      writeHandsPing(DATA_DIR, { at: Date.now(), ok: ping.ok, detail: ping.detail, kind: "ping" });
      return json(res, 200, ping);
    }
    if (path === "/api/hermes/model" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      // zero-terminal: write the profile config/.env directly, never a CLI
      try {
        const status = attachModel({
          providerId: String(body.providerId ?? ""),
          apiKey: String(body.apiKey ?? ""),
          model: String(body.model ?? ""),
          baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
        });
        const bud = PRODUCT_MODE
          ? store.adoptBud(productHermesSelection(status.model || "default"))
          : null;
        if (bud) broadcast({ kind: "bot", bot: publicBot(bud) });
        const ping = await tryHermesPing();
        // Connecting a model performs the same authoritative hands check as
        // the standalone action. Persist it so a reload cannot forget a
        // successful check or falsely present a failed one as ready.
        writeHandsPing(DATA_DIR, { at: Date.now(), ok: ping.ok, detail: ping.detail, kind: "ping" });
        return json(res, 200, { ok: true, model: status, ping });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/hermes/providers" && method === "GET") {
      return json(res, 200, { providers: PROVIDER_OPTIONS });
    }
    if (path === "/api/hermes/models" && method === "GET") {
      const provider = url.searchParams.get("provider") ?? "";
      return json(res, 200, { models: listModels(provider), options: listModelOptions(provider) });
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
        applyPropertyPack();
      } catch (e) {
        return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
      writeHandsPing(DATA_DIR, {
        at: Date.now(),
        ok: false,
        detail: "Property safeguards changed. Run the private readiness check again.",
        kind: "ping",
      });
      return json(res, 200, {
        ...applyHandsReadiness(await hermesStatus(), readHandsPing(DATA_DIR)),
        lastTest: readHandsLast(DATA_DIR),
        lastPing: readHandsPing(DATA_DIR),
      });
    }
    if (path === "/api/hermes/install" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      // zero-terminal: the harness spawns the pinned installer and streams
      // progress to /api/hermes/install/status — no Terminal window.
      const command = hermesInstallCommand(process.platform);
      if (!command) return json(res, 400, { error: "no installer for this platform — CSV-only mode" });
      installPreflight = await preflight();
      if (!installPreflight.ok) {
        return json(res, 409, { error: "missing dependencies", install: installStatus(), preflight: installPreflight });
      }
      const job = startInstall(command);
      writeHandsPing(DATA_DIR, {
        at: Date.now(),
        ok: false,
        detail: "The worker install changed. Run the private readiness check again when it finishes.",
        kind: "ping",
      });
      return json(res, 202, { install: job, preflight: installPreflight });
    }
    if (path === "/api/hermes/install/status" && method === "GET") {
      return json(res, 200, { install: installStatus(), preflight: installPreflight });
    }
    if (path === "/api/hermes/repair" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      if (installInFlight()) {
        return json(res, 409, { error: "an install is already running", install: installStatus(), preflight: installPreflight });
      }
      const command = hermesInstallCommand(process.platform);
      if (!command) return json(res, 400, { error: "no installer for this platform — CSV-only mode" });
      installPreflight = await preflight();
      if (!installPreflight.ok) {
        return json(res, 409, { error: "missing dependencies", install: installStatus(), preflight: installPreflight });
      }
      const job = startRepair(command);
      writeHandsPing(DATA_DIR, {
        at: Date.now(),
        ok: false,
        detail: "The worker repair changed. Run the private readiness check again when it finishes.",
        kind: "ping",
      });
      return json(res, 202, { install: job, preflight: installPreflight });
    }
    if (path === "/api/hermes/uninstall" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      try {
        const status = await uninstallWorker({ dataDir: DATA_DIR });
        return json(res, 200, {
          ...applyHandsReadiness(status, readHandsPing(DATA_DIR)),
          lastTest: readHandsLast(DATA_DIR),
          lastPing: readHandsPing(DATA_DIR),
        });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
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
          res.write(": keepalive\n\n");
        } catch {}
      }, 25_000);
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
      await denyPendingRequests(group.threadId, instance);
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
        if (isProductBud(m[1]) && body.name !== undefined && body.name !== CANONICAL_BUD_NAME) {
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
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      if (text.length > ASK_MESSAGE_MAX_CHARS) return json(res, 413, { error: "message is too long" });
      await startTurn(m[1], text);
      return json(res, 202, { ok: true });
    }

    // One durable follow-up slot. PUT intentionally means replace: a second
    // click cannot create two eventual side effects, and a renderer restart
    // cannot lose the instruction.
    m = path.match(/^\/api\/bots\/([\w-]+)\/queued-message$/);
    if (m && method === "PUT") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      if (text.length > ASK_MESSAGE_MAX_CHARS) return json(res, 413, { error: "message is too long" });
      if (PRODUCT_MODE && containsCredential(text)) {
        return json(res, 400, { error: "Provider keys go on You → Attach model. Ask never sees the secret." });
      }
      if (!bot.busy) {
        await startTurn(bot.id, text);
        return json(res, 202, { ok: true, started: true });
      }
      const queued = store.setQueuedMessage(bot.id, text, bot.threadId);
      if (!queued) return json(res, 409, { error: "that task is no longer available" });
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      return json(res, 200, { ok: true, queued });
    }
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const expectedId = typeof body.id === "string" && body.id ? body.id : undefined;
      if (expectedId && bot.queuedMessage && bot.queuedMessage.id !== expectedId) {
        return json(res, 409, { error: "that follow-up was already replaced" });
      }
      store.clearQueuedMessage(bot.id, expectedId);
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      return json(res, 200, { ok: true });
    }

    // Steer is an atomic stop-and-replace of the active turn. The new text is
    // not appended until the old provider session has actually settled, so
    // late completion events cannot terminate or corrupt the replacement.
    m = path.match(/^\/api\/bots\/([\w-]+)\/steer$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      if (text.length > ASK_MESSAGE_MAX_CHARS) return json(res, 413, { error: "message is too long" });
      if (PRODUCT_MODE && containsCredential(text)) {
        return json(res, 400, { error: "Provider keys go on You → Attach model. Ask never sees the secret." });
      }
      if (!bot.busy) {
        await startTurn(bot.id, text);
        return json(res, 202, { ok: true, started: true });
      }
      if (steeringBots.has(bot.id)) return json(res, 409, { error: "Bud is already applying another steer" });
      steeringBots.add(bot.id);
      try {
        const threadId = bot.threadId;
        // Direct connection brokering is a bounded server operation, not a
        // provider turn. Supersede its delivery token so a late auth-link
        // response cannot open a browser or clear the replacement turn.
        if (connectionOperations.has(bot.id)) {
          connectionOperations.delete(bot.id);
          store.patchBot(bot.id, { busy: false });
          await startTurn(bot.id, text, { threadId });
          return json(res, 202, { ok: true, steered: true });
        }
        const instance = registry.get(bot.modelSelection.instanceId);
        if (!instance) return json(res, 409, { error: "provider unavailable" });
        if (PRODUCT_MODE) expectedStoppedThreads.add(threadId);
        await denyPendingRequests(threadId, instance);
        await instance.adapter.interruptTurn(threadId);
        await waitUntilTurnStopped(instance, threadId);
        watchdog.settle(threadId);
        const current = store.bot(bot.id);
        if (!current) return json(res, 404, { error: "no such bot" });
        store.patchBot(current.id, { busy: false });
        await startTurn(current.id, text, { threadId });
        return json(res, 202, { ok: true, steered: true });
      } finally {
        steeringBots.delete(bot.id);
      }
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
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
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
      const { requestId, decision } = parseRequestDecision(await readBody(req));
      const instance = registry.get(bot.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      await instance.adapter.respondToRequest(bot.threadId, requestId, decision);
      return json(res, 200, { ok: true });
    }
    // Answer by THREAD, so a request raised inside a room can be answered
    // too: a member's turn runs on the room's thread, and the bot that
    // owns the pending request is the one currently speaking there.
    m = path.match(/^\/api\/threads\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const threadId = m[1];
      const parsed = parseRequestDecision(await readBody(req));
      const { requestId } = parsed;
      let { decision } = parsed;
      const card = store
        .messagesFor(threadId)
        .find((message) => message.card?.requestId === requestId);
      const fence = fenceContextFor(threadId);
      // A session grant tells the worker to stop asking for that tool, and the
      // fence only sees what the worker asks. During an attended run every
      // browser action stays a one-time allow; a site rule is the safe
      // "don't ask again" because the fence re-checks it per request.
      if (fence && card?.card?.fence && decision.behavior === "allow" && decision.scope === "session") {
        decision = { ...decision, scope: "once" };
      }
      if (parsed.rule) {
        const ruleError = portalRespondRuleError(parsed.rule, {
          behavior: decision.behavior,
          tool: card?.card?.tool,
          allowedOrigins: fence?.allowedOrigins,
        });
        if (ruleError) return json(res, 400, { error: ruleError });
        addPortalRule(parsed.rule.surface, parsed.rule.origin);
      }
      const group = store.groupByThread(threadId);
      const owner = group ? (group.busyBotId ? store.bot(group.busyBotId) : undefined) : store.botByThread(threadId);
      if (!owner) return json(res, 404, { error: "nothing is waiting on an answer in this conversation" });
      const instance = registry.get(owner.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      await instance.adapter.respondToRequest(threadId, requestId, decision);
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const wasBusy = bot.busy;
      if (connectionOperations.has(bot.id)) {
        connectionOperations.delete(bot.id);
        store.patchBot(bot.id, { busy: false });
        const message = store.appendMessage(bot.threadId, {
          role: "bot",
          kind: "text",
          text: "Stopped. Bud will not continue this turn.",
        });
        broadcast({ kind: "message", threadId: bot.threadId, message });
        broadcast({ kind: "bot", bot: store.bot(bot.id) });
        return json(res, 200, { ok: true });
      }
      const instance = registry.get(bot.modelSelection.instanceId);
      if (PRODUCT_MODE && wasBusy) expectedStoppedThreads.add(bot.threadId);
      await denyPendingRequests(bot.threadId, instance);
      await instance?.adapter.interruptTurn(bot.threadId);
      watchdog.settle(bot.threadId);
      if (wasBusy) {
        store.patchBot(bot.id, { busy: false });
        if (PRODUCT_MODE) {
          const message = store.appendMessage(bot.threadId, {
            role: "bot",
            kind: "text",
            text: "Stopped. Bud will not continue this turn.",
          });
          broadcast({ kind: "message", threadId: bot.threadId, message });
          broadcast({ kind: "bot", bot: store.bot(bot.id) });
        }
      }
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
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      for (const key of ["xai", "composio", "box", "tts", "profile"] as const) {
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
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      // Only a model-provider key changes the fleet's child environment.
      // Connected-app and computer credentials are mounted per turn from
      // cfg; reloading here used to kill an unrelated in-flight answer.
      if (Object.hasOwn(patch, "xai")) await reloadProviders();
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
    const status = (e as { status?: number })?.status ?? 500;
    const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : undefined;
    const error = e instanceof Error ? e.message : String(e);
    return json(res, status, code ? { error, code } : { error });
  }
});

installCrashHandlers();

server.on("error", (error) => {
  // Source runs get one fixed port; a busy one must say so, not hang silent.
  const detail = `could not listen on 127.0.0.1:${PORT} — ${error.message}`;
  console.error(`realbud server ${detail}`);
  oplog("crash", detail);
  process.exit(1);
});

function channelsStatus(): ChannelsPayload {
  return {
    telegram: telegramAdapter.status(),
    discord: discordAdapter.status(),
    slack: slackAdapter.status(),
  };
}

bindTelegramBridge({
  store,
  startTurn,
  subscribe: (listener) => bus.subscribe(listener),
  broadcast,
});
bindDiscordBridge({
  store,
  startTurn,
  subscribe: (listener) => bus.subscribe(listener),
  broadcast,
});
bindSlackBridge({
  store,
  startTurn,
  subscribe: (listener) => bus.subscribe(listener),
  broadcast,
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`realbud server on http://127.0.0.1:${PORT}`);
  oplog("boot", `listening on 127.0.0.1:${PORT}`);
  // A renderer/server restart must not silently drop a follow-up the user
  // already scheduled. Claim and resume each durable slot once at boot.
  for (const bot of store.bots) {
    if (bot.busy || !bot.queuedMessage) continue;
    const queued = store.takeQueuedMessage(bot.id, bot.queuedMessage.threadId);
    if (queued) void dispatchQueuedMessage(bot.id, queued);
  }
  if (!process.env.VITEST) {
    startTelegramBridge();
    startDiscordBridge();
    startSlackBridge();
    startRemoteDecisionFlush();
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    oplog("shutdown", signal);
    stopTelegramBridge();
    stopDiscordBridge();
    stopSlackBridge();
    stopRemoteDecisionFlush();
    loops?.stop();
    watchdog.stop();
    void registry.disposeAll().finally(() => process.exit(0));
  });
}

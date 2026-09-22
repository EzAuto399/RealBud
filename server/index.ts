import { appVersion } from "./app-version.ts";
import { createWorkspaceTabsHandler } from "./workspace-tabs.ts";
import { createCustomerPackService } from "./customer-packs.ts";
import { managedConnectorAccess, managedConnectorConfigured, managedConnectorSettings } from "./managed-connectors.ts";
import { createOfficeLink, installationWorkerVersion } from "./office-link.ts";
import { createWorkerModelAccess } from "./worker-model-access.ts";
import { setWorkerModelAccessSnapshot } from "./hermes-runtime-env.ts";
import { recordRemoteEvidence } from './website-remote-evidence.ts';
import { createRemoteDisclosureReview } from './website-remote-disclosure.ts';
import { createWebsiteExecutionContext } from './website-execution-context.ts';
import { createWebsiteRequests } from './website-requests.ts';
import { createWebsiteWorkAdapters, websiteWorkSettingsMutation } from './website-work-adapters.ts';
import { createDepartmentWork } from './department-work.ts';
import { askDepartmentWorker } from './department-worker.ts';
import { companyMemberToken } from './company-host.ts';
import type { DepartmentWorkPrepare } from '../shared/department-work.ts';
import type { ConfirmCompanyExecution, RevokeCompanyExecution } from '../shared/company-execution.ts';
import { currentWorkerProfile, withWorkerProfile } from "./hermes-profile.ts";
import { createHermesMemoryReviewService, memoryReviewContext } from './hermes-memory-review.ts';
import { MEMORY_REVIEW_API } from '../shared/hermes-memory-review.ts';
import { createPrivateWorkspaceBackup } from './private-workspace-backup.ts';
import { createPrivateBackupApi } from './private-backup-api.ts';
import { createPrivateBackupCoordinator } from './private-backup-coordinator.ts';
import { handlePrivateBackupV2Http } from './private-backup-http.ts';
import { withDurablePrivateBackupRestore } from './private-backup-legacy-api.ts';
import { WorkspaceActivityGate } from './workspace-activity.ts';
import { PRIVATE_BACKUP_MAX_BYTES } from '../shared/private-workspace-backup.ts';
import { createAgencySetupService } from './agency-setup.ts';
import { workflowRecipeId } from '../shared/agency-workflow-packs.ts';
import { createMailIngestionService } from './mail-ingestion.ts';
import { runMorningMailWorkflow } from './morning-mail-workflow.ts';
import { scanGmailReadOnly } from './composio-gmail.ts';
import { scanManagedMail } from './managed-connectors.ts';
import { askControlReply, parseAskControlIntent } from "./ask-control-intent.ts";
import { createPairingCode } from "./channel-pairing.ts";
// RealBud server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { askMessageSizeError } from "../shared/ask-message.ts";
import { serviceInstanceId } from "../shared/service-identity.mjs";

import { approvalKey, autoDecision } from "./auto-approve.ts";
import { HERMES_MEMORY_APPROVAL, requiresOnceApproval, reservedApprovalKey } from '../shared/approval-policy.ts';
import { permissionCardFields, guardPermissionDecision, canUseReviewedPortalRules } from './permission-policy.ts';
import { applyLawDrift, lawWatchView, persistLawWatchResult, runLawWatch, setLawWatchScheduled } from "./law-watch.ts";
import { addPortalRule, addRule, evaluateRules, isPortalRuleSurface, loadRules, parsePortalRuleKey, removeRule } from "./rules.ts";
import { appendHistory, listHistory } from "./computer-history.ts";
import { listWorkerIssues, noteWorkerIssue, resolveWorkerIssues, setWorkerIssueListener } from "./worker-issues.ts";
import { assertRecipeRevision, deleteRecipe, fenceCapabilitiesFor, getRecipe, listRecipes, normalizeOrigin, patchRecipe, patchRecipeStatus, recipeClockRunnable, recipeHasPortalCapability, saveRecipe } from "./recipes.ts";
import { distillRecipe } from "./recipe-distill.ts";
import { shapeRecipeDraft } from "./recipe-draft.ts";
import {
  exportWorkflowPacks,
  importWorkflowPacks,
  installAustinPhase1Packs,
  installWorkflowPack,
  listWorkflowPackStatus,
} from "./workflow-packs.ts";
import { groupExpectedBills, listExpectedBills, upsertExpectedBill } from "./expected-bills.ts";
import { expectedBillsPage } from './expected-bills-page.ts';
import { SourceBillRegister } from './source-bills.ts';
import { createSourceBillsApi } from './source-bills-api.ts';
import { createBillProposals, readBillProposal } from './bill-proposals.ts';
import { BillReviewDraftStore } from './bill-review-drafts.ts';
import { createBillReviewApi } from './bill-review-api.ts';
import { portalJobIntentReply } from "./portal-job-intent.ts";
import { scheduleIntentReply } from "./schedule-intent.ts";
import {
  ATTEND_ERRORS,
  attendBlocked,
  attendedJobSystemBlock,
  attendedSettleStatus,
  ATTENDED_UNVERIFIED_RESULT,
  attendedUserText,
  fenceContextFor,
  fenceEvidence,
  humanSigninNeeded,
  portalRespondRuleError,
  portalSignInCompleteIntent,
  READY_BESIDE_YOU_SKIP,
  setFenceContext,
  SIGN_IN_HANDOFF_CONTINUE,
  submitHoldLine,
  takeFenceContext,
  turnEndedNote,
} from "./attended-run.ts";
import {
  clickControlLabel,
  fenceDecision,
  fenceDenialNote,
  fencePayload,
  isComputerTool,
  originMatches,
  ruleAllowNote,
  submitPressSummary,
} from "./portal-fence.ts";
import { getSession, grantLease, listSessions, revokeLease } from "./portal-sessions.ts";
import { executeRecipeJob } from "./job-executor.ts";
import { manualRecipeRequestKey } from "./manual-job-request.ts";
import { BatchService } from "./batches.ts";
import { jobRuns, READY_BESIDE_YOU } from "./job-runs.ts";
import { bankReferenceStore, humanHandoffs, workflowDatabase } from "./workflow-services.ts";
import { mailWorkspaceQuery } from './mail-workspace-query.ts';
import { cuaHumanControl } from "./cua-human-control.ts";
import * as box from "./box.ts";
import * as composio from "./composio.ts";
import { ConnectedAppAccessCache, connectedAppConfigPatch, connectedAppsConfigured, gmailReadOnlyBinding, gmailReadOnlyMode, checkSelectedConnectionAccess } from "./connected-app-access.ts";
import { authorizeGmailReadOnly, getGmailReadOnlyAccess, isGmailReadOnlyAuthorizationUrl, listGmailReadOnlyAccounts, verifyGmailReadOnlyConfig } from "./composio-gmail.ts";
import { listConnectedAppOperations } from "./connected-app-operations.ts";
import { revokeConnectedAppsBrokers } from "./connected-apps-broker.ts";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import {
  containerComputerAction,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  setupCommands,
  type LifecycleAction,
} from "./container-computer.ts";
import { DATA_DIR, MEMBER_KEY, ensureDirs, instanceConfigs, loadConfig, saveConfig, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
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
import { browserRuntime } from "./browser-runtime.ts";
import { onBrowserDecision, releaseBrowserBrokers } from "./browser-broker.ts";
import { applyPropertyPack, ensurePropertyPack, hermesHome, propertyProfileDir } from "./hermes-pack.ts";
import { applyHandsReadiness, hermesStatus } from "./hermes-status.ts";
import { bootstrapPlan, bootstrapPending } from "./worker-bootstrap.ts";
import { tryHermesPing } from "./hermes-hands.ts";
import { ASK_ATTACH_MAX_BYTES, saveAskAttachment } from "./ask-attach.ts";
import { answerAskFromDesk, polishProductAskReply, productAskFailure, productBudSystemPrompt, productWorkerDump } from "./ask-book.ts";
import { buildHandoffPayload, deliverToPairedPhone } from "./channel-handoff.ts";
import { readHandsLast, readHandsPing, writeHandsPing } from "./hands-last.ts";
import { readArtifact } from "./audit-artifacts.ts";
import { readCsvMapping } from "./csv-ledger.ts";
import { inspectLedgerColumns } from "./import-inspect.ts";
import { Desk } from "./desk.ts";
import { seedVault, DEFAULT_VAULT_DOCUMENTS } from "./vault.ts";
import { openTerminalAndRun, setupCommandFor } from "./engine-setup.ts";
import { attachModel, installInFlight, installStatus, listModelOptions, listModels, modelStatus, PROVIDER_OPTIONS, cancelBootstrapInstall, waitForBootstrapStop } from "./hermes-bridge.ts";
import { cancelOAuth, oauthStatus, startOAuth } from "./hermes-oauth.ts";
import { workerLoginMethods, WORKER_OAUTH_LOGINS } from "../shared/worker-providers.ts";
import { repairExistingProfile, uninstallWorker } from "./hermes-lifecycle.ts";
import { checkUpstreamRelease, restorePreviousRuntime, runtimeUpdateStatus, startRuntimeUpdate } from "./hermes-update.ts";
import { installCrashHandlers, oplog } from "./oplog.ts";
import { createCompanyInstallation } from "./company-installation.ts";
import { normalizeCompanyWorkflowTemplate } from "./company/workflow-template.ts";
import { managedService } from "./managed-service.ts";
import { isPrivilegedServiceMutation, isPrivilegedServiceRead } from "./service-admin.ts";
import { serviceControl } from "./service-control.ts";
import { careCredentialsLocked, careStatus, lockCare, unlockCare, serviceAdmin } from "./care-unlock.ts";
import { CANONICAL_BUD_ID, CANONICAL_BUD_NAME, PRODUCT_MODE, PRODUCT_TURN_DEFAULTS, isCanonicalBud, productDenied, productRuntimeEventVisible } from "./product-mode.ts";
import { coverageFromUncoveredHeld, LoopManager, type LoopId, type LoopExecuteResult } from "./routines.ts";
import { hostAllowed, needsSession, originAllowed, SESSION_TOKEN, sessionOk } from "./session-auth.ts";
import { evaluatorForLoop } from "./workflow-catalog.ts";
import { containsCredential } from "./redact.ts";
import { officeAppsForTurn, officeSourceTurnContext } from "./office-source-turn.ts";
import { parseConnectionIntent } from "./connection-intent.ts";
import { formatConnectedAppsReply, parseConnectedStatusIntent } from "./connected-status-intent.ts";
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
  flushDiscordRelayForThread,
  startDiscordBridge,
  stopDiscordBridge,
} from "./channels/discord.ts";
import {
  bindSlackBridge,
  connectSlack,
  disconnectSlack,
  flushSlackRelayForThread,
  slackAdapter,
  slackDecisionAdapter,
  startSlackBridge,
  stopSlackBridge,
} from "./channels/slack.ts";
import {
  bindTelegramBridge,
  connectTelegram,
  disconnectTelegram,
  flushTelegramRelayForThread,
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
import { buildSupportBundle, supportBundleRequest } from "./support-bundle.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;

/** Published on /api/health so the desktop app can recognise its own service. */
const SERVICE_INSTANCE_ID = serviceInstanceId(DATA_DIR);
const SERVICE_CONTROL = serviceControl(process.env.REALBUD_SERVICE_CONTROL_TOKEN, SERVICE_INSTANCE_ID);
// Keep the shutdown capability in this process; workers inherit no copy.
delete process.env.REALBUD_SERVICE_CONTROL_TOKEN;
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

function csvDigest(csv: string): string {
  return createHash("sha256").update(csv, "utf8").digest("hex");
}

ensureDirs();
seedVault();
try {
  // A new desktop gets a new private profile. Importing a legacy profile is
  // a separate migration decision, never an automatic copy of personal keys,
  // memory or learned skills just because a profile is named "property".
  ensurePropertyPack();
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
  return store.productBud()?.id === id;
}

function productHermesSelection(model = "default") {
  const instance = registry.instances().find((candidate) => candidate.driverKind === "hermesAgent");
  return instance ? { instanceId: instance.instanceId, model } : undefined;
}

// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set<ServerResponse>();
jobRuns.setEmit((payload) => broadcast(payload));

function lastAssistantText(threadId: string, since: number): string {
  const texts = store
    .messagesFor(threadId)
    .filter((message) => message.role === "bot" && message.kind === "text" && message.text && message.at >= since);
  return texts.at(-1)?.text ?? "";
}

async function releaseComputerControl() {
  await releaseBrowserBrokers();
  await browserRuntime.stop();
  if (!PRODUCT_MODE) await cuaHumanControl("release");
}

function signInHandoffs() {
  return humanHandoffs({
    release: async (threadId) => {
      const owner = store.botByThread(threadId);
      const instance = owner ? registry.get(owner.modelSelection.instanceId) : null;
      const hadSession = Boolean(instance?.adapter.hasSession(threadId));
      const ownsBusy = owner?.threadId === threadId || hadSession;
      if (owner?.busy && ownsBusy) expectedStoppedThreads.add(threadId);
      if (instance && hadSession) {
        expectedStoppedThreads.add(threadId);
        await denyPendingRequests(threadId, instance);
        await instance.adapter.interruptTurn(threadId);
        await waitUntilTurnStopped(instance, threadId);
      }
      watchdog.settle(threadId);
      if (owner && ownsBusy) { store.patchBot(owner.id, { busy: false }); broadcast({ kind: "bot", bot: store.bot(owner.id) }); }
      await releaseComputerControl();
    },
    verify: async (binding, requestId) => binding.browser
      ? browserRuntime.verifyLogin({ ...binding, ...binding.browser })
      : !PRODUCT_MODE && (await cuaHumanControl("verify", binding, requestId)).verified === true,
    restore: async () => { if (PRODUCT_MODE) await browserRuntime.resumeConnection(); else await cuaHumanControl("restore"); },
    resume: async (handoff, step) => {
      const old = jobRuns.get(handoff.value.runId);
      const recipe = old ? getRecipe(old.jobId) : undefined;
      const bud = (typeof handoff.value.botId === "string" ? store.bot(handoff.value.botId) : null)
        ?? store.botByThread(handoff.value.threadId);
      if (!old || !recipe || !bud || recipe.revision !== handoff.value.jobRevision || recipe.approvedRevision !== recipe.revision || !recipe.attachment || recipe.status === "paused") throw Object.assign(new Error("The saved job changed. Review and approve its current plan before resuming."), { status: 409 });
      const selected = old.spec.steps[step];
      if (!selected || selected !== handoff.value.steps?.[step] || bud.busy) throw Object.assign(new Error("The selected step or worker is no longer available."), { status: 409 });
      const oneStep = { ...recipe, steps: [selected], evidence: "Read back the result of this selected step only. Do not perform subsequent steps." };
      const enqueued = jobRuns.enqueue(oneStep, { mode: "attended", trigger: "manual", threadId: handoff.value.threadId, idempotencyKey: `${handoff.id}:step:${step}` });
      if (!enqueued.created) throw Object.assign(new Error("This recovery step already has an attempt. Review its receipt before starting more work."), { status: 409 });
      const running = jobRuns.start(enqueued.run.id, `Human reviewed recovery: step ${step + 1} only. Earlier attempt ${old.id} is retained.`, { threadId: handoff.value.threadId });
      setFenceContext(handoff.value.threadId, {
        botId: bud.id,
        runId: running.id,
        allowedOrigins: [...old.spec.allowedOrigins],
        capabilities: fenceCapabilitiesFor(oneStep),
      });
      try {
        const instructions = await customerPacks.instructionContext(recipe.id);
        await startTurn(bud.id, `Continue only reviewed step ${step + 1}: ${selected}`, { threadId: handoff.value.threadId, systemExtra: `${attendedJobSystemBlock(oneStep)}\n${instructions ? `Reviewed workflow guidance (no additional authority):\n${instructions}\n` : ''}This is recovery from an interrupted run. Earlier steps are outside this attempt. Never replay them or infer that they completed.`, computer: true, signInResumeId: handoff.id });
      } catch (error) { settleAttendedTurn(handoff.value.threadId, { ok: false, stopReason: "error", detail: "The selected recovery step could not start. Check this receipt before retrying." }); throw error; }
      return running.id;
    },
  });
}

async function pauseAttendedForLogin(threadId: string, reason: "login" | "mfa") {
  const context = fenceContextFor(threadId);
  const run = context ? jobRuns.get(context.runId) : undefined;
  if (!context || !run || run.status !== "running") throw Object.assign(new Error("No attended job is running at this checkpoint."), { status: 409 });
  const botId = context.botId
    || store.botByThread(threadId)?.id
    || store.productBud()?.id;
  if (!botId) throw Object.assign(new Error("Bud is not available for this sign-in checkpoint."), { status: 409 });
  // Preserve the interruption before cancelling the model. Its eventual
  // completion cannot turn this human checkpoint into a successful run.
  jobRuns.settle(run.id, { status: "interrupted", detail: "Sign-in handover requested. Earlier actions will not be replayed automatically.", evidence: [{ at: Date.now(), kind: "note", note: "Human sign-in checkpoint saved; no credentials retained." }] });
  takeFenceContext(threadId);
  return signInHandoffs().open({ runId: run.id, threadId, botId, jobRevision: run.jobRevision, reason, steps: [...run.spec.steps] });
}

function settleAttendedTurn(
  threadId: string,
  input: { ok: boolean; stopReason?: string | null; detail?: string },
) {
  const activeContext = fenceContextFor(threadId);
  const activeRun = activeContext ? jobRuns.get(activeContext.runId) : undefined;
  const currentText = input.detail ?? lastAssistantText(threadId, activeRun?.startedAt ?? Date.now());
  const signIn = input.ok && !["cancelled", "interrupted", "error", "timeout", "stall"].includes(input.stopReason ?? "")
    ? humanSigninNeeded(currentText) : null;
  if (signIn && fenceContextFor(threadId)) {
    void pauseAttendedForLogin(threadId, signIn).catch(async error => {
      await releaseComputerControl().catch(() => {});
      reportJobHistoryFailure(error);
      publishWorkerIssue({ source: "runtime", summary: "Sign-in handover needs attention", detail: "The sign-in request could not be saved or released safely. Close RealBud before entering credentials and review Work activity." });
    });
    return;
  }
  const ctx = takeFenceContext(threadId);
  if (!ctx) return;
  try {
    const run = jobRuns.get(ctx.runId);
    if (!run || run.status !== "running") return;
    const text = currentText;
    const status = attendedSettleStatus({
      ok: input.ok,
      stopReason: input.stopReason,
    });
    jobRuns.settle(ctx.runId, {
      status,
      detail: text || (input.ok ? "Turn ended." : "The turn did not finish."),
      evidence: [
        { at: Date.now(), kind: "note", note: turnEndedNote(input.ok, input.stopReason) },
        ...(status === "partial" ? [{ at: Date.now(), kind: "note" as const, note: ATTENDED_UNVERIFIED_RESULT }] : []),
      ],
      approvalRequests: submitHoldLine(text),
    });
  } catch (error) {
    reportJobHistoryFailure(error);
  }
}

function recordFenceEvidence(threadId: string, item: ReturnType<typeof fenceEvidence>) {
  const ctx = fenceContextFor(threadId);
  if (!ctx) return;
  try {
    jobRuns.appendEvidence(ctx.runId, [item]);
  } catch (error) {
    reportJobHistoryFailure(error);
  }
}

function reportJobHistoryFailure(error: unknown): void {
  // A finished run can race a final evidence event. Storage failures need a
  // visible recovery message, but must never escape the driver's callback.
  if ((error as { status?: number } | null)?.status !== 503) return;
  const issue = {
    source: "runtime" as const,
    summary: "Job history needs attention",
    detail: "RealBud could not safely read or save the job receipt. More job runs are paused. Check disk space and history recovery before restarting.",
  };
  try {
    publishWorkerIssue(issue);
  } catch {
    // A full disk may also prevent saving the diagnostic. The open app must
    // still show the failure; this event does not claim a durable receipt.
    console.warn("[job-history] Receipt storage needs recovery; the diagnostic could not be saved.");
    broadcast({ kind: "worker.issue", issue: { ...issue, id: "job-history-recovery", at: Date.now() } });
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

function publishWorkerIssue(input: Parameters<typeof noteWorkerIssue>[0]): void {
  noteWorkerIssue(input);
}

/** Clear a recovered hands miss, or retry the ping when the last receipt failed. Reload still does not invent ready. */
async function healHandsReadiness(): Promise<void> {
  const last = readHandsPing(DATA_DIR);
  const status = await hermesStatus();
  if (last?.ok && last.workerFingerprint === status.workerFingerprint) {
    resolveWorkerIssues("hands");
    return;
  }
  if (
    !status.cli.installed ||
    !(status.cli.compatible ?? status.cli.matchesPin) ||
    !status.pack.installed ||
    !status.pack.approvalsManual ||
    !status.pack.workroomReady
  ) {
    return;
  }
  const ping = await tryHermesPing({ memberKey: currentWorkerProfile().memberKey });
  writeHandsPing(DATA_DIR, {
    at: Date.now(),
    ok: ping.ok,
    detail: ping.detail,
    kind: "ping",
    workerFingerprint: ping.workerFingerprint,
  });
  if (ping.ok) resolveWorkerIssues("hands");
}

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function productTurnStopMessage(
  reason: TurnExpiryReason,
  opts?: { besideYou?: boolean },
): string {
  if (opts?.besideYou) {
    if (reason === "repeated-tool" || reason === "tool-budget") {
      return "I paused this run beside you. Sign in if the page is waiting, then press **Run beside me** again — Submit, Pay and Send stay with you.";
    }
    if (reason === "deadline") {
      return "I paused because this run beside you was taking too long. Press **Run beside me** again when you are at the screen.";
    }
    return "I paused this run beside you. Press **Run beside me** again when you are ready.";
  }
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
const connectedAppAccess = new ConnectedAppAccessCache();
async function refreshOfficeSources() {
  const access = await connectedAppAccess.refresh(cfg);
  broadcast({ kind: "office-sources", access });
  return access;
}
async function officeSourcesChanged() {
  broadcast({ kind: "office-sources-changed" });
  await refreshOfficeSources().catch(() => { /* a newer settings generation owns refresh */ });
}
let savingConnectedApps = false;

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
    const besideYou = Boolean(fenceContextFor(turn.threadId));
    if (PRODUCT_MODE) expectedStoppedThreads.add(turn.threadId);
    void instance?.adapter.interruptTurn(turn.threadId).catch(() => {});
    if (!bot) return;
    store.patchBot(bot.id, { busy: false });
    const message = PRODUCT_MODE
      ? store.appendMessage(turn.threadId, {
          role: "bot",
          kind: "text",
          text: productTurnStopMessage(reason, { besideYou }),
        })
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
const websiteRunContext = createWebsiteExecutionContext({
  binding: requestId => websiteRequests.executionBinding(requestId),
  check: execution => websiteWork.check(execution.descriptor, execution.binding),
});
const checkWebsiteExecution = websiteRunContext.check;
let privateRestoreLocked = false;
let shuttingDown = false;
const workspaceActivity = new WorkspaceActivityGate({ assertAdmission: () => {
  if (privateRestoreLocked || shuttingDown) throw Object.assign(new Error('The service is held for restore or shutdown. Restart RealBud before starting work.'), { status: 409 });
} });
let privateBackupRequests = 0;
let privateBackupEpoch = 0;
const desk = new Desk({ memberKey: MEMBER_KEY });
const batches = new BatchService({
  canRecover: () => !workspaceActivity.paused && !privateRestoreLocked && !shuttingDown,
  snapshot: () => desk.snapshot(),
  notes: id => desk.notesFor(id).body,
  available: () => withWorkerProfile(desk.memberKeyForWorker(), async () => applyHandsReadiness(await hermesStatus(), readHandsPing(DATA_DIR)).ready),
});
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

/** Only RealBud's browser broker emits a request that already carries `fence`:
 * it decided the step (server/browser-authority.ts) and the host displays that
 * decision without re-evaluating it. Native computer-tool requests have no
 * broker, so the job fence below still decides them. */
const brokerDecided = (event: RuntimeEvent): boolean => event.type === "request.opened" && event.fence !== undefined;
onBrowserDecision(({ threadId, entry }) => recordFenceEvidence(threadId, entry));

function attachFenceToOpened(event: RuntimeEvent): RuntimeEvent {
  if (event.type !== "request.opened" || event.requestType !== "permission") return event;
  if (brokerDecided(event)) return event;
  if (event.tool === "bud_connected_app_action" || event.tool === HERMES_MEMORY_APPROVAL) return event;
  if (!isComputerTool(event.tool, event.summary)) return event;
  const fence = fenceContextFor(event.threadId);
  if (!fence) return event;
  const decision = fenceDecision(
    { ...fence, rules: loadRules() },
    { tool: event.tool, params: event.params, summary: event.summary },
  );
  const payload = fencePayload(decision);
  return payload ? { ...event, ...(canUseReviewedPortalRules(event, decision) ? { approvalPolicy: undefined } : {}), fence: payload } : event;
}

bus.subscribe((raw: RuntimeEvent) => {
  const fromBroker = brokerDecided(raw);
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
        const text =
          dump ??
          (PRODUCT_MODE && bot && isProductBud(bot.id) ? polishProductAskReply(event.text) : event.text);
        if (!text.trim()) break;
        pushMessage({ role: "bot", kind: "text", text });
        if (dump && bot && isProductBud(bot.id)) {
          store.clearResumeCursor(bot.id, event.providerInstanceId ?? bot.modelSelection.instanceId, event.threadId);
          publishWorkerIssue({
            source: "ask",
            summary: "Bud could not answer",
            detail: dump,
          });
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
        // Beside-you may re-read the same page while the person signs in, but
        // repeating browser_prepare / launch_app is the isolated-window loop —
        // let the stall watchdog stop that. Hermes source stays untouched.
        {
          const toolTitle = event.title ?? "";
          const besideYou = fenceContextFor(event.threadId) != null;
          const respawnLoop = /browser_prepare|launch_app/i.test(toolTitle);
          watchdog.noteTool(event.threadId, event.toolFingerprint ?? event.title, {
            allowRepeat: besideYou && !respawnLoop,
          });
        }
        if (event.itemId) toolNameByItem.set(`${event.threadId}:${event.itemId}`, event.title ?? "tool");
        // Product Ask hides raw tool noise — except beside-you portal runs,
        // where a spoken activity chip is the only progress the PM can see.
        if (PRODUCT_MODE && fenceContextFor(event.threadId) == null) break;
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
      const onceApproval = permission && requiresOnceApproval(event);
      // Auto mode / always-allow: answer routine tool permissions for the
      // bot so it keeps working. A QUESTION always reaches the human — the
      // whole point of asking is that a person decides — and anything that
      // looks destructive stops even in auto mode.
      const asker = bot ?? (speaker ? store.bot(speaker.botId) : undefined);
      if (permission && asker && event.requestId && !fromBroker && event.tool !== HERMES_MEMORY_APPROVAL && event.tool !== "bud_connected_app_action" && isComputerTool(event.tool, event.summary)) {
        const fence = fenceContextFor(event.threadId);
        const request = { tool: event.tool, params: event.params, summary: event.summary };
        const instance = event.providerInstanceId
          ? registry.get(event.providerInstanceId)
          : registry.get(asker.modelSelection.instanceId);
        const requestId = event.requestId;
        if (fence && /password|passcode|\botp\b|one.time|verification code|\bmfa\b|\b2fa\b/i.test(`${event.summary ?? ""} ${JSON.stringify(event.params ?? {})}`)) {
          recordFenceEvidence(event.threadId, { at: Date.now(), kind: "denied", note: "You sign in yourself — Bud never types a password. Human sign-in handover requested." });
          void (async () => {
            try {
              const paused = pauseAttendedForLogin(event.threadId, /mfa|2fa|otp|verification|one.time/i.test(event.summary ?? "") ? "mfa" : "login");
              await instance?.adapter.respondToRequest(event.threadId, requestId, { behavior: "deny", message: "Human sign-in is required. Do not read or type credentials." }).catch(() => {});
              await paused;
            } catch (error) {
              await releaseComputerControl().catch(() => {});
              reportJobHistoryFailure(error);
              publishWorkerIssue({ source: "runtime", summary: "Sign-in handover needs attention", detail: "The saved sign-in checkpoint could not be confirmed. Close RealBud before entering credentials, then check saved work with your setup person." });
            }
          })();
          break;
        }
        if (!fence) {
          const reason = "Only sites named in a saved job. Ask Bud to set the routine up as a job first.";
          const toolId = event.tool || "computer";
          const spoken = fenceDenialNote(toolId, reason);
          void (async () => {
            try {
              if (!instance) throw new Error("provider unavailable");
              await instance.adapter.respondToRequest(event.threadId, requestId, {
                behavior: "deny",
                message: reason,
              });
              pushMessage({
                role: "bot",
                kind: "activity",
                tool: { name: toolId, ok: false, spoken },
              });
            } catch {
              pushMessage({
                role: "bot",
                kind: "activity",
                tool: { name: toolId, ok: false, spoken },
              });
            }
          })();
          break;
        }
        const decision = fenceDecision({ ...fence, rules: loadRules() }, request);
        const allowNote = decision.kind === "allow" ? ruleAllowNote(decision) : undefined;
        if (!(onceApproval && decision.kind === 'allow')) recordFenceEvidence(
          event.threadId,
          decision.kind === "allow"
            ? { at: Date.now(), kind: "action", note: allowNote! }
            : fenceEvidence(request, decision),
        );
        if (decision.kind === "deny" || decision.kind === "allow" && !onceApproval) {
          const reason = decision.kind === "deny" ? (decision.reason ?? "Denied.") : allowNote!;
          const toolId = event.tool || "computer";
          const spoken =
            decision.kind === "deny" ? fenceDenialNote(toolId, reason) : allowNote!;
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
                tool: { name: toolId, ok: decision.kind === "allow", spoken },
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
                  ...permissionCardFields(event),
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
      if (permission && !onceApproval && !fromBroker && asker && event.requestId && event.tool !== "bud_connected_app_action") {
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
                ...permissionCardFields(event),
                held: "Auto mode couldn't answer this one.",
              },
            });
            askMessageByRequest.set(`${event.threadId}:${requestId}`, card.id);
          }
        })();
        break;
      }
      // The broker writes its own card summary (with an approval's verified facts).
      const submitSummary =
        event.type === "request.opened" && !fromBroker && event.fence?.surface === "portal-submit"
          ? submitPressSummary(clickControlLabel(event.params, event.summary), event.fence.origin)
          : null;
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: permission ? event.tool === HERMES_MEMORY_APPROVAL ? 'Review memory change' : "Approval needed" : "Your bot has a question",
          subtitle: submitSummary ?? event.summary,
          options: event.choices?.length ? event.choices : permission ? ["Allow", "Deny"] : [],
          requestId: event.requestId,
          tool: permission ? event.tool : undefined,
          // the exact grant "always allow" would remember, decided here so
          // client and server can never derive it differently
          ...(permission ? permissionCardFields(event) : {}),
          // in auto mode a card can only mean the guard stopped it — say so
          held: onceApproval ? 'This request needs your approval once. Saved rules do not apply.' : permission && asker?.autoApprove ? "This looked destructive, so auto mode stopped to ask." : undefined,
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
        if (resolvedCard?.tool !== HERMES_MEMORY_APPROVAL) recordFenceEvidence(event.threadId, {
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
      if (bot && isProductBud(bot.id)) {
        publishWorkerIssue({
          source: "runtime",
          summary: "Bud hit a worker error",
          detail: productAskFailure(event.message),
        });
      }
      pushMessage({
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false, setup: event.setup },
      });
      break;
    case "turn.completed": {
      settleAttendedTurn(event.threadId, intentionallyStopped
        ? { ok: false, stopReason: "cancelled", detail: "Stopped by you. Check the last result before running again." }
        : { ok: Boolean(event.ok), stopReason: event.stopReason });
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
        if (!event.ok) {
          publishWorkerIssue({
            source: "ask",
            summary: "Bud's turn did not finish",
            detail: productAskFailure(event.stopReason ?? "Bud's turn stopped before it finished."),
          });
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
        // Phone Ask relays also subscribe on the bus; flush here so a lost
        // channel subscription still pushes the reply back to the paired chat.
        flushTelegramRelayForThread(event.threadId);
        flushDiscordRelayForThread(event.threadId);
        flushSlackRelayForThread(event.threadId);
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
async function startTurn(...args: Parameters<typeof startSeatTurn>) {
  return workspaceActivity.run(() => {
    if (privateRestoreLocked || shuttingDown) throw Object.assign(new Error('The service is held for restore or shutdown. Restart RealBud before starting work.'), {status:409});
    return withWorkerProfile(desk.memberKeyForWorker(), () => startSeatTurn(...args));
  });
}
async function startSeatTurn(
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
    /** Internal recovery claim; never accepted from an Ask request body. */
    signInResumeId?: string;
    /** Phone channel Ask — full Hermes Bud, not Desk FAQ shortcuts. */
    channelRelay?: boolean;
  },
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (opts?.computer && signInHandoffs().isHolding() && !signInHandoffs().canResume(opts.signInResumeId)) throw Object.assign(new Error("Finish the saved sign-in handover before starting more computer work."), { status: 409 });
  if (PRODUCT_MODE && containsCredential(text)) {
    throw Object.assign(
      new Error("Use the private key field in Set up Bud. Keep keys out of the conversation."),
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
      if (signInHandoffs().isHolding() && portalSignInCompleteIntent(text)) {
        let userMessage = opts?.userMessage;
        if (!userMessage) {
          userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
          broadcast({ kind: "message", threadId, message: userMessage });
        }
        const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: SIGN_IN_HANDOFF_CONTINUE });
        broadcast({ kind: "message", threadId, message: reply });
        return;
      }
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
    const control = parseAskControlIntent(text);
    const scheduleReply = control ? askControlReply(control, loops?.listLoops() ?? []) : scheduleIntentReply(text);
    if (scheduleReply) {
      let userMessage = opts?.userMessage;
      if (!userMessage) {
        userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
        broadcast({ kind: "message", threadId, message: userMessage });
      }
      const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: scheduleReply });
      broadcast({ kind: "message", threadId, message: reply });
      return;
    }
    if (parseConnectedStatusIntent(text)) {
      let userMessage = opts?.userMessage;
      if (!userMessage) {
        userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
        broadcast({ kind: "message", threadId, message: userMessage });
      }
      const operationId = newId();
      connectionOperations.set(bot.id, operationId);
      store.patchBot(bot.id, { busy: true, unread: false });
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      void (async () => {
        try {
          const access = await refreshOfficeSources();
          if (connectionOperations.get(bot.id) !== operationId) return;
          const reply = store.appendMessage(threadId, {
            role: "bot",
            kind: "text",
            text: formatConnectedAppsReply(access),
          });
          broadcast({ kind: "message", threadId, message: reply });
        } catch (error) {
          if (connectionOperations.get(bot.id) !== operationId) return;
          const reply = store.appendMessage(threadId, {
            role: "bot",
            kind: "text",
            text: productAskFailure(error instanceof Error ? error.message : String(error)),
          });
          broadcast({ kind: "message", threadId, message: reply });
        } finally {
          if (connectionOperations.get(bot.id) !== operationId) return;
          connectionOperations.delete(bot.id);
          const queued = store.takeQueuedMessage(bot.id, threadId);
          store.patchBot(bot.id, { busy: false, unread: true });
          if (queued) void dispatchQueuedMessage(bot.id, queued);
          else broadcast({ kind: "bot", bot: store.bot(bot.id) });
        }
      })();
      return;
    }
  }

  const checkConnection = /^\s*check\s+(.+?)\s+connection[.!]?\s*$/i.exec(text);
  const connectionIntent = PRODUCT_MODE && isProductBud(bot.id)
    ? parseConnectionIntent(checkConnection ? `connect ${checkConnection[1]}` : text) : null;
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
      let openingSignIn = false;
      try {
        if (!connectedAppsConfigured(cfg)) {
          const message = store.appendMessage(threadId, {
            role: "bot",
            kind: "text",
            text: gmailReadOnlyMode(cfg)
              ? "Gmail read-only setup still needs its private fields. Tap **Add** here to finish setup, then ask **Connect Gmail**."
              : `Connected apps needs its private connection key once. Press **Save Connected apps key** here, then **Connect ${connectionIntent.label}**. Never paste the key into Ask.`,
          });
          broadcast({ kind: "message", threadId, message });
          return;
        }
        if (gmailReadOnlyMode(cfg) && connectionIntent.slug !== "gmail") throw new Error("This connection supports Gmail only. Choose another connection in Add. No new sign-in was started.");
        // Prefer an honest "already connected" over minting another OAuth window.
          if (!composio.CURATED_SLUGS.includes(connectionIntent.slug) && !cfg.composio?.officeApps?.includes(connectionIntent.slug)) {
            if (savingConnectedApps || creatingGmailLink) throw new Error("App setup is still finishing. Try again shortly.");
            const officeApps = [...(cfg.composio?.officeApps ?? []), connectionIntent.slug];
            if (officeApps.length > 74) throw new Error("The office app list is full. Remove an unused connection first.");
            saveConfig({ composio: { officeApps } });
            Object.assign(cfg, loadConfig());
            connectedAppAccess.invalidate();
          }
          const checked = await refreshOfficeSources();
          if (checked.error) throw new Error("The connection could not be checked. Try again in Add.");
          const status = checked.services;
          if (connectionOperations.get(bot.id) !== connectionOperationId) return;
          if (status[connectionIntent.slug]?.connected || checkConnection) {
            const access = checked;
            const connected = Boolean(status[connectionIntent.slug]?.connected);
            const account = status[connectionIntent.slug]?.accounts.find((row) => /^active$/i.test(row.status));
            const tools = access.excludedApps?.includes(connectionIntent.slug) ? "It is off in Ask. Use Add to enable it." : officeAppsForTurn(access).includes(connectionIntent.slug)
              ? `${access.tools.names.length} tools ready.`
              : "Choose an account or check access in Add before starting work.";
            const message = store.appendMessage(threadId, {
              role: "bot",
              kind: "text",
              text: connected
                ? `${connectionIntent.label} is already connected${account?.label ? ` (${account.label})` : ""}. ${tools}`
                : `${connectionIntent.label} is not connected yet. Finish any open provider sign-in in the browser — I’ll refresh when you’re back. To start a new sign-in, ask **Connect ${connectionIntent.label}**.`,
            });
            broadcast({ kind: "message", threadId, message });
            return;
          }
        openingSignIn = true;
        const authorized = await authorizeSelectedConnection(connectionIntent.slug);
        if (connectionOperations.get(bot.id) !== connectionOperationId) return;
        const authorizationUrl = new URL(String(authorized.url));
        if (authorizationUrl.protocol !== "https:") throw new Error("the connection broker returned an unsafe link");
        const requestId = newId();
        const message = store.appendMessage(threadId, {
          role: "bot",
          kind: "text",
          text: `I opened ${connectionIntent.label} sign-in. Finish it in your browser — when you come back I’ll refresh the connection and tools automatically. If the window didn’t open, [continue connecting ${connectionIntent.label}](${authorizationUrl.toString()}).`,
        });
        broadcast({ kind: "message", threadId, message });
        broadcast({
          kind: "external.open",
          requestId,
          service: connectionIntent.slug,
          url: authorizationUrl.toString(),
          autoRefresh: true,
        });
      } catch (error) {
        if (connectionOperations.get(bot.id) !== connectionOperationId) return;
        const raw = error instanceof Error ? error.message : String(error);
        // Only this server's fixed recovery messages bypass the general worker
        // formatter. Provider payloads and credentials never become UI copy.
        const recovery = (error as { code?: unknown })?.code === "GMAIL_CONNECTION_RECOVERY";
        const message = store.appendMessage(threadId, {
          role: "bot",
          kind: "text",
          text: recovery ? raw : openingSignIn
            ? `I couldn't confirm ${connectionIntent.label} sign-in. Finish any sign-in window already open, then open **Add** to check the result.`
            : `I couldn't verify ${connectionIntent.label} connection. No new sign-in was started. Open **Add** to try again.`,
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

  // Desktop Ask can answer a few Desk facts without the worker. Phone is the
  // same Bud/Hermes agent as Ask — never short-circuit those turns to FAQ.
  const bookReply =
    PRODUCT_MODE && isProductBud(bot.id) && !opts?.channelRelay && !opts?.systemExtra
      ? answerAskFromDesk(text, desk.snapshot())
      : null;
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
  if (serviceAdmin.status().managed) {
    const approved = productHermesSelection(modelStatus().model || "default");
    if (!approved || bot.modelSelection.instanceId !== approved.instanceId || (bot.modelSelection.model !== approved.model && bot.modelSelection.model !== "default")) {
      throw Object.assign(new Error("The stored model selection is not approved for this managed service. Ask service administration to reconnect Bud."), { status: 403 });
    }
  }
  managedService.assertCapability("reasoning");
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
      const access = PRODUCT_MODE && !opts?.systemExtra ? await refreshOfficeSources() : null;
      if (PRODUCT_MODE && expectedStoppedThreads.has(threadId)) throw new Error("This request was stopped before app access finished checking.");
      const allowedApps = officeAppsForTurn(access, Boolean(opts?.systemExtra));
      const gmailBinding = gmailReadOnlyMode(cfg) ? gmailReadOnlyBinding(cfg) : null;
      if (gmailBinding?.accountId && (!PRODUCT_MODE || allowedApps.includes("gmail"))) integrations.composio = { ...(PRODUCT_MODE ? { allowedApps } : {}), key: gmailBinding.apiKey, gmailReadOnly: {
        authConfigId: gmailBinding.authConfigId, userId: gmailBinding.userId, accountId: gmailBinding.accountId, requestId: newId(),
      } };
      else if (!gmailReadOnlyMode(cfg) && connectedAppsConfigured(cfg) && (!PRODUCT_MODE || allowedApps.length)) {
        const mcp = await composio.resolveConnectedAppsMcp(cfg, currentWorkerProfile().memberKey);
        integrations.composio = { ...(PRODUCT_MODE ? { allowedApps } : {}), key: mcp.key, url: mcp.url, headers: mcp.headers };
      }
      if (PRODUCT_MODE) {
        if (instance.driverKind === 'hermesAgent' && !opts?.systemExtra) {
          const memberKey = currentWorkerProfile().memberKey ?? '';
          const proposalIntegration = memoryReviews.proposalIntegration(threadId, () => (desk.memberKeyForWorker() ?? '') === memberKey);
          if (proposalIntegration) integrations.memoryProposals = proposalIntegration;
        }
        const handoffOk = !signInHandoffs().isHolding() || signInHandoffs().canResume(opts?.signInResumeId);
        const browserJob = handoffOk ? fenceContextFor(threadId) : undefined;
        if (browserJob) {
          const binding = opts?.signInResumeId ? signInHandoffs().get(opts.signInResumeId).value.binding : undefined;
          if (opts?.signInResumeId && !binding?.browser) throw new Error("Choose and check the connected browser page before resuming this step.");
          integrations.browser = { runId: browserJob.runId, allowedOrigins: [...browserJob.allowedOrigins], capabilities: [...browserJob.capabilities],
            ...(binding?.browser ? { checkpoint: { ...binding.browser, origin: binding.origin, accountMarker: binding.accountMarker } } : {}) };
        }
        managedService.assertCapability("reasoning");
        await instance.adapter.sendTurn({
          threadId,
          text: turnText,
          model,
          resumeCursor: rewound ? undefined : task.resumeCursors[instanceId],
          transcript,
          system: [productBudSystemPrompt(), officeSourceTurnContext(allowedApps),
            integrations.memoryProposals ? 'For requested conversational preference changes, use memory_propose from memory-proposals with a complete typed add, replace, remove or batch payload. Use the same requestId and exact payload to check an interrupted proposal. The tool only creates a pending review: it does not apply or approve memory. Direct the person to You → Bud → Bud’s memory to review the complete change. Do not claim it was saved to memory until its human decision is confirmed. Preferences do not change business records, credentials or work permissions.' : undefined,
            allowedApps.length ? `Selected office account IDs: ${JSON.stringify(Object.fromEntries(allowedApps.map(slug => [slug, cfg.composio?.selectedAccounts?.[slug] ?? access?.services[slug]?.accounts.find(account => /^active$/i.test(account.status))?.id])))}. Use only these accounts. If the tool cannot target an account unambiguously, ask before proceeding.` : undefined,
            (gmailReadOnlyMode(cfg) || managedConnectorConfigured(cfg)) && allowedApps.includes("gmail") ? "This connection provides only GMAIL_GET_PROFILE, GMAIL_LIST_THREADS and GMAIL_FETCH_MESSAGE_BY_THREAD_ID. Use only the account and thread IDs allowed by the server. No alternate mail or computer route is allowed." : undefined,
            opts?.systemExtra].filter(Boolean).join("\n\n"),
          integrations,
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

      managedService.assertCapability("reasoning");
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
      if (PRODUCT_MODE && isProductBud(bot.id)) {
        publishWorkerIssue({
          source: "ask",
          summary: "Bud could not answer",
          detail: message,
        });
      }
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
let mailAuthorityEpoch = 0;
let websiteAuthorityEpoch = 0;
function commitDesk(snapshot: ReturnType<Desk["snapshot"]>) {
  mailAuthorityEpoch++;
  websiteAuthorityEpoch++;
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
  withWorkspaceActivity: workspaceActivity.run,
  commit: commitDesk,
  channels: [telegramDecisionAdapter(), discordDecisionAdapter(), slackDecisionAdapter()],
  storeDir: DATA_DIR,
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
  // Provenance for a scheduled receipt: which worker, model and profile produced it.
  // Read from the readiness receipt rather than probing, because this runs on every
  // loop start and must not spawn a process. hands-ping.json specifically, not
  // hands-last.json: a Recheck overwrites the latter and carries no fingerprint.
  workerIdentity: () => readHandsPing(DATA_DIR)?.workerFingerprint,
  setRecipeEnabled: (recipeId, enabled) => {
    const current = getRecipe(recipeId);
    if (!current) return;
    if (!enabled) patchRecipeStatus(recipeId, "paused");
    else if (current.status === "paused") {
      const approved = current.planApprovedAt != null && current.approvedRevision === current.revision;
      patchRecipeStatus(recipeId, approved ? "active" : "shadow");
    }
  },
  execute: (loop, run) => withWorkerProfile(desk.memberKeyForWorker(), async (): Promise<LoopExecuteResult> => {
    if (privateRestoreLocked) return {ok:false,detail:'Private restore is staged; restart the service before running work.'};
    jobRuns.sweepQueuedAttended();
    if (desk.recovery.active) return { ok: false, detail: "desk is in recovery — schedules are paused" };
    if (loop.id === 'inbound-triage') return websiteRunContext.runLoop(run.requestId, () => runMorningMailWorkflow(run, {
      collect: async () => { await checkWebsiteExecution(); return mailWorkspace.collect(); }, prepareInput: async () => { await checkWebsiteExecution(); return mailWorkspace.prepareInput(); }, applyReview: async result => { await checkWebsiteExecution(); return mailWorkspace.applyReview(result); },
      recipe: async () => { const selected = (await agencySetup.getConfiguration()).settings.workflowPackId; const id = workflowRecipeId(selected,'inbox-triage'); return id ? getRecipe(id) : undefined; },
      admitPack: async id => { const selected = (await agencySetup.getConfiguration()).settings.workflowPackId; if (!selected) throw new Error('Choose the agency workflow pack.'); await customerPacks.packRecipeBinding(selected,id); },
      execute: (recipe, input) => executeRecipeJob(recipe, input, { readBookSnapshot: () => desk.snapshot(), instructionContext: async id => { const instructions = await customerPacks.instructionContext(id); await checkWebsiteExecution(); return instructions; } }),
    }));
    if (loop.id.startsWith("recipe-")) {
      try { await customerPacks.assertReadyForRecipe(loop.id.slice('recipe-'.length)); }
      catch { return { ok: false, detail: 'This workflow pack needs recovery. Open customer pack setup.' }; }
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
      }, { readBookSnapshot: () => desk.snapshot(), instructionContext: id => customerPacks.instructionContext(id) });
      const ok = executed.run.status === "completed" || executed.run.status === "awaiting-approval";
      const status = executed.run.status === "awaiting-approval" ? "awaiting-approval"
        : executed.run.status === "partial" ? "partial" : ok ? "completed" : "failed";
      return { ok, status, detail: executed.run.detail, jobRunId: executed.run.id };
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
  }),
});

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

function configStatus(req?: IncomingMessage) {
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    composio: { configured: connectedAppsConfigured(cfg), apiKeyConfigured: Boolean(cfg.composio?.apiKey), managed: managedConnectorConfigured(cfg),
      mode: gmailReadOnlyMode(cfg) ? "gmail-readonly" : "consumer", readOnlyConfigured: Boolean(gmailReadOnlyBinding(cfg)),
      ...(cfg.composio?.gmailReadOnly?.authConfigId ? { readOnlyAuthConfigId: cfg.composio.gmailReadOnly.authConfigId } : {}),
    },
    box: { configured: Boolean(cfg.box?.token) },
    // the chosen voice is a setting, not a secret; the key is reported the
    // same configured-or-not way as every other credential
    tts: tts.describeVoice(cfg),
    // not a secret — the sidebar shows it
    profile: { name: cfg.profile?.name ?? "", email: cfg.profile?.email ?? "" },
    care: careStatus(req),
    serviceAdmin: serviceAdmin.status(req),
  };
}

function invalidateConnectedAppAuthority() {
  mailAuthorityEpoch++;
  websiteAuthorityEpoch++;
  mailWorkspace.cancel();
  connectedAppAccess.invalidate();
  revokeConnectedAppsBrokers();
  broadcast({ kind: "office-sources-changed" });
  for (const bot of store.bots) {
    if (bot.queuedMessage) { store.holdQueuedMessage(bot.id, "connected-app-settings-changed"); broadcast({ kind: "bot", bot: store.bot(bot.id) }); }
  }
  for (const botId of connectionOperations.keys()) {
    const bot = store.bot(botId);
    if (!bot) continue;
    // Persist the hold before marking the operation idle. A restart or late
    // completion must not replay an instruction against changed app access.
    const held = store.holdQueuedMessage(botId, "connected-app-settings-changed");
    watchdog.settle(bot.threadId);
    store.patchBot(botId, { busy: false, unread: true });
    const message = store.appendMessage(bot.threadId, {
      role: "bot", kind: "text",
      text: held
        ? "Connected-app settings changed during the connection check. Your queued follow-up is saved and paused. Use Edit queued to review it, then send it again when you are ready."
        : "Connected-app settings changed during the connection check. Check the current connection in Add before trying again.",
    });
    broadcast({ kind: "message", threadId: bot.threadId, message });
    broadcast({ kind: "bot", bot: store.bot(botId) });
  }
  connectionOperations.clear();
}

async function selectedConnectionStatus(slugs: string[]): Promise<Record<string, composio.ConnectionServiceStatus>> {
  if (!gmailReadOnlyMode(cfg)) return composio.connectionStatus(cfg, slugs);
  if (slugs.some(slug => slug !== "gmail")) throw Object.assign(new Error("This connection supports Gmail read-only. Choose Composio Connect in Add to use other apps."), { status: 400 });
  const binding = gmailReadOnlyBinding(cfg);
  if (!binding) throw Object.assign(new Error("Finish Gmail read-only setup in Add first."), { status: 409 });
  return (await getGmailReadOnlyAccess(binding)).services;
}

let creatingGmailLink = false;
async function authorizeSelectedConnection(slug: string): Promise<{ url: string }> {
  if (!gmailReadOnlyMode(cfg)) return composio.authorizeService(cfg, slug);
  if (slug !== "gmail") throw Object.assign(new Error("The selected connection supports Gmail read-only."), { status: 400 });
  const binding = gmailReadOnlyBinding(cfg);
  const saved = cfg.composio?.gmailReadOnly;
  if (!binding || !saved) throw Object.assign(new Error("Finish Gmail read-only setup in Add first."), { status: 409 });
  if (creatingGmailLink || savingConnectedApps) throw Object.assign(new Error("Gmail setup is already in progress. Check its result before starting again."), { status: 409 });
  creatingGmailLink = true;
  const identity = JSON.stringify(cfg.composio);
  try {
    const hold = (message: string) => Object.assign(new Error(message), { status: 409, code: "GMAIL_CONNECTION_RECOVERY" });
    const terminal = new Set(["FAILED", "EXPIRED", "INACTIVE", "REVOKED"]);
    if (Object.hasOwn(saved, "linkUnknown")) {
      const unknown = saved.linkUnknown;
      if (!unknown || typeof unknown.startedAt !== "string" || !Number.isFinite(Date.parse(unknown.startedAt)) ||
        Date.parse(unknown.startedAt) > Date.now() + 60_000 ||
        (unknown.previousAccountId !== undefined && (typeof unknown.previousAccountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(unknown.previousAccountId)))) {
        throw hold("The previous Gmail sign-in receipt needs recovery. Check the account in the Composio dashboard; RealBud will not create another sign-in automatically.");
      }
      let accounts: Awaited<ReturnType<typeof listGmailReadOnlyAccounts>>;
      try { accounts = await listGmailReadOnlyAccounts(binding); }
      catch { throw hold("The previous Gmail sign-in outcome is still unknown. Check the connection in Composio and try Connect Gmail again to reconcile it. No new sign-in was started."); }
      if (JSON.stringify(cfg.composio) !== identity) throw hold("The connection changed during sign-in recovery. Check settings before continuing.");
      const candidates = accounts.filter(account => account.id !== unknown.previousAccountId && !terminal.has(account.status));
      if (candidates.length !== 1 || !["ACTIVE", "INITIATED", "INITIALIZING"].includes(candidates[0]!.status)) {
        throw hold("The previous Gmail sign-in outcome is still unknown or more than one account may belong to it. Resolve that attempt in the Composio dashboard, then try Connect Gmail again to reconcile it. No new sign-in was started.");
      }
      const account = candidates[0]!;
      if (account.status === "ACTIVE") {
        try { await getGmailReadOnlyAccess({ ...binding, accountId: account.id }); }
        catch { throw hold("The recovered Gmail account could not yet be verified for read-only access. Check it in Composio, then try Connect Gmail again. No new sign-in was started."); }
      }
      if (JSON.stringify(cfg.composio) !== identity) throw hold("The connection changed during sign-in recovery. Check settings before continuing.");
      const recovered = { ...saved, accountId: account.id };
      delete recovered.linkUnknown;
      delete recovered.pendingLink;
      connectedAppAccess.invalidate();
      revokeConnectedAppsBrokers();
      saveConfig({ composio: { gmailReadOnly: recovered } });
      cfg.composio = { ...cfg.composio, gmailReadOnly: recovered };
      throw hold(account.status === "ACTIVE"
        ? "The previous Gmail sign-in was recovered and its account verified. Press Add to refresh the connection to refresh its account and tools. No new sign-in was started."
        : "The previous Gmail sign-in account was recovered, but its original link was not received. Finish its original provider sign-in or resolve that pending account in the Composio dashboard, then check connection. No new sign-in was started.");
    }
    if (binding.accountId) {
      let access: Awaited<ReturnType<typeof getGmailReadOnlyAccess>>;
      try { access = await getGmailReadOnlyAccess(binding); }
      catch {
        throw hold("The previous Gmail sign-in could not be verified. Add to refresh the connection and resolve the existing account in Composio before trying Connect Gmail again. No new sign-in was started.");
      }
      if (JSON.stringify(cfg.composio) !== identity) throw hold("The connection changed while sign-in was being checked. Check settings before continuing.");
      const account = access.services.gmail?.accounts.find(row => row.id === binding.accountId);
      if (!account) throw hold("The saved Gmail account could not be confirmed. Check the existing connection in Composio before starting another sign-in.");
      if (account.status === "ACTIVE") throw hold("Gmail is already connected. Press Add to refresh the connection to refresh its account and tools.");
      if (["INITIATED", "INITIALIZING"].includes(account.status)) {
        const pending = saved.pendingLink;
        const expiry = pending && typeof pending.expiresAt === "string" ? Date.parse(pending.expiresAt) : NaN;
        if (!pending || !isGmailReadOnlyAuthorizationUrl(pending.url, binding.apiKey) || !Number.isFinite(expiry) || expiry > Date.now() + 86_400_000) {
          throw hold("The existing Gmail sign-in has no safe saved link. Resolve that pending connection in Composio, then check connection before starting again.");
        }
        if (expiry <= Date.now() + 30_000) throw hold("The saved Gmail sign-in link has expired while its account is still pending. Resolve the pending connection in Composio, then check connection before starting again.");
        return { url: pending.url };
      }
      if (!terminal.has(account.status)) {
        throw hold("The saved Gmail account is disabled or its state is unconfirmed. Resolve it in Composio and check connection before starting another sign-in.");
      }
      // A confirmed terminal attempt can be replaced only by this explicit
      // Connect request. Keep its receipt until the new link is durable.
    } else if (saved.pendingLink) {
      throw hold("The saved Gmail sign-in is missing its account identity. Check the connection settings before starting another sign-in.");
    }
    // Verify before recording intent so a known invalid configuration does
    // not create an unnecessary recovery hold. No provider mutation yet.
    await verifyGmailReadOnlyConfig(binding);
    if (JSON.stringify(cfg.composio) !== identity) throw hold("The connection changed while sign-in was being prepared. Check settings before continuing.");
    const marked = { ...saved, linkUnknown: { startedAt: new Date().toISOString(), ...(binding.accountId ? { previousAccountId: binding.accountId } : {}) } };
    connectedAppAccess.invalidate();
    revokeConnectedAppsBrokers();
    // Keep the in-memory hold even if the atomic save has an uncertain result.
    // Upstream link creation may start only after this receipt is durable.
    cfg.composio = { ...cfg.composio, gmailReadOnly: marked };
    saveConfig({ composio: { gmailReadOnly: marked } });
    const markedIdentity = JSON.stringify(cfg.composio);
    let link: Awaited<ReturnType<typeof authorizeGmailReadOnly>>;
    try { link = await authorizeGmailReadOnly(binding); }
    catch { throw hold("The Gmail sign-in result could not be confirmed. Finish any provider window that opened, then try Connect Gmail again to reconcile the saved attempt. RealBud will not create another sign-in while its outcome is unknown."); }
    if (JSON.stringify(cfg.composio) !== markedIdentity) throw hold("The connection changed while sign-in was being prepared. Check settings before continuing.");
    // Keep the provider's exact account and link before opening its consent page.
    const connected = { ...saved, accountId: link.accountId, pendingLink: { url: link.url, expiresAt: link.expiresAt } };
    delete connected.linkUnknown;
    saveConfig({ composio: { gmailReadOnly: connected } });
    cfg.composio = { ...cfg.composio, gmailReadOnly: connected };
    return { url: link.url };
  } finally { creatingGmailLink = false; }
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

const requestBodies = new WeakMap<IncomingMessage, Promise<any>>();
function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  const existing = requestBodies.get(req);
  if (existing) return existing;
  const pending = new Promise((resolve, reject) => {
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
  requestBodies.set(req, pending);
  return pending;
}

const companyHost = createCompanyInstallation({ dataDirectory: DATA_DIR,
  // The host database runtime is discovered by admission (bundled runtime
  // first) so "Set up this office" works without a terminal. An explicit
  // REALBUD_COMPANY_POSTGRES_BIN still wins as an installer/operator override,
  // and is read by the resolver rather than passed through here, so there is
  // exactly one admission path.
  // Company-only pinned transport is part of the installed desktop. This does
  // not expose the legacy API or enable shared workers. Storage creation still
  // needs an admitted database runtime and service-administrator authority.
  previewEnabled: process.env.REALBUD_COMPANY_HOST_PREVIEW !== "0",
  // Membership and private worker identity are separate. Pin the existing
  // physical profile once at startup; office sign-in never moves the private Bud.
  initialWorkerKey: MEMBER_KEY || undefined,
  privateStateKey: Buffer.from(desk.recoveryKeyHex(), 'hex'),
  executionWorkerBinding: () => createHash('sha256').update(JSON.stringify({ config: cfg, profile: currentWorkerProfile().profile, worker: readHandsPing(DATA_DIR)?.workerFingerprint })).digest('hex'),
  onSeatIdentity: memberId => {
    oplog("seat", `adopted member identity ${memberId.slice(0, 8)}…`);
  },
  authorizeAdmin: req => serviceAdmin.authorize(req), hasAdminSession: req => serviceAdmin.status(req).authenticated });

// Vendor provisioning arrives with the pairing redeem: the connector credential
// goes to config, the model key to the private vault, and the worker sees it
// only through the launch-time snapshot below. Nothing here awaits a network.
const workerModelAccess = createWorkerModelAccess({ directory: DATA_DIR, key: Buffer.from(desk.recoveryKeyHex(), 'hex') });
const refreshWorkerModelAccess = async () => {
  try { setWorkerModelAccessSnapshot(await workerModelAccess.env()); }
  catch (error) { setWorkerModelAccessSnapshot({}); oplog("boot", `model access needs recovery: ${error instanceof Error ? error.message : String(error)}`); }
};
void refreshWorkerModelAccess();
const officeLink = createOfficeLink({
  directory: DATA_DIR,
  appVersion: appVersion(),
  provisioning: {
    apply: async (provisioning, installationId) => { await workerModelAccess.apply(provisioning, installationId); await refreshWorkerModelAccess(); },
    withdraw: async () => { const changed = await workerModelAccess.withdraw(); await refreshWorkerModelAccess(); return changed; },
    withdrawn: () => workerModelAccess.withdrawn(),
    active: async () => (await workerModelAccess.state()).provisioned,
    reconcile: async () => { const changed = await workerModelAccess.reconcile(); if (changed) await refreshWorkerModelAccess(); return changed; },
    clear: async () => { await workerModelAccess.clear(); await refreshWorkerModelAccess(); },
  },
  report: () => withWorkerProfile(desk.memberKeyForWorker(), async () => {
    const status = applyHandsReadiness(await hermesStatus(), readHandsPing(DATA_DIR));
    return { appVersion: appVersion(),
      workerVersion: installationWorkerVersion(status.cli.versionText), workerReady: status.ready };
  }),
});

const server = createServer((req, res) => withWorkerProfile(desk.memberKeyForWorker(), async () => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  let countedPrivateRequest = false;
  try {
    if (needsSession(path, method)) {
      const gate = sessionOk(req, PORT);
      if (!gate.ok) return json(res, gate.status, { error: gate.error });
    } else if (path.startsWith("/api/") && path !== "/api/health" && path !== "/api/session" && !path.startsWith("/api/internal/")) {
      const gate = sessionOk(req, PORT);
      if (!gate.ok && gate.status === 403) return json(res, 403, { error: gate.error });
    }
    // Staging is an installation-wide barrier. Reads that can recover or
    // refresh business stores also remain held until the cold restore finishes.
    const restoreControl = /^\/api\/private-backup(?:\/|$)/.test(path) ||
      ['/api/health','/api/session','/api/service/stop','/api/service/status','/api/service-admin/status'].includes(path);
    if (workspaceActivity.paused && path.startsWith('/api/') && !restoreControl && path !== '/api/events')
      return json(res, 409, { error: 'RealBud is briefly holding work while it captures your backup. Wait for the backup to finish, then retry.', code: 'private_snapshot_active' });
    if (privateRestoreLocked && path.startsWith('/api/') && !restoreControl)
      return json(res,409,{error:'Private restore is staged. Restart the RealBud service to finish before doing more work.',code:'private_restore_staged'});
    if (path.startsWith('/api/') && !restoreControl && path !== '/api/events') {
      countedPrivateRequest = true; privateBackupRequests++;
      if (!['GET','HEAD','OPTIONS'].includes(method) && !path.startsWith('/api/private-backup')) privateBackupEpoch++;
    }
    if (/^\/api\/private-backup(?:\/|$)/.test(path)) {
      res.setHeader('cache-control','no-store');
      if (!privateBackupCoordinator) return json(res,503,{error:'Backup storage needs recovery. Existing business files are preserved.',code:'storage-unavailable'});
      if (await handlePrivateBackupV2Http(req,res,url,privateBackupCoordinator)) return;
      const result = await privateBackupApi(path,method,method === 'GET' ? undefined : await readBody(req,PRIVATE_BACKUP_MAX_BYTES + 4096));
      return json(res,result!.status,result!.body);
    }
    // Privileged service settings use an independent per-renderer identity.
    const adminState = serviceAdmin.status(req);
    if (adminState.managed && isPrivilegedServiceRead(path, method) && !adminState.authenticated) {
      return json(res, 403, { error: "Sign in to service administration to view provider setup.", code: "service_admin_required" });
    }
    if (adminState.managed && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      const bodyDependent = path === "/api/config" || path.startsWith("/api/bots/") || path.startsWith("/api/channels/");
      const policyBody = bodyDependent ? await readBody(req) : undefined;
      if (isPrivilegedServiceMutation(path, method, policyBody)) {
        const adminGate = serviceAdmin.authorize(req);
        if (!adminGate.ok) return json(res, adminGate.status, { error: adminGate.error, code: "service_admin_required" });
        res.setHeader("x-realbud-service-admin-expires", String(adminGate.expiresAt));
      }
    }
    // Fence in-flight source proposals before any local setup/plan mutation can
    // yield. A rejected edit may hold a proposal but can never broaden access.
    if (!['GET','HEAD','OPTIONS'].includes(method) && (
      /^\/api\/(?:agency-setup|customer-packs|hermes|connected-apps|service-admin|config)(?:\/|$)/.test(path) ||
      /^\/api\/recipes(?:\/|$)/.test(path) && ['PATCH','PUT','DELETE'].includes(method))) mailAuthorityEpoch++;
    if (websiteWorkSettingsMutation(path, method)) websiteAuthorityEpoch++;
    if (path === "/api/service/stop" && method === "POST") {
      if (!SERVICE_CONTROL.accepts(req, await readBody(req))) return json(res, 403, { error: "This desktop does not control the current office service." });
      res.once("finish", () => { setImmediate(() => process.emit("SIGTERM")); });
      return json(res, 200, { stopping: true });
    }
    if (path === "/api/service-admin/status" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, serviceAdmin.status(req));
    }
    if ((path === "/api/service-admin/login" || path === "/api/care/unlock") && method === "POST") {
      const body = await readBody(req, 2048);
      const login = await unlockCare(body?.password ?? body?.secret);
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { ...login, config: { ...configStatus(), care: { credentialsLocked: false, unlockAvailable: true }, serviceAdmin: login.status } });
    }
    if ((path === "/api/service-admin/logout" || path === "/api/care/lock") && method === "POST") {
      await readBody(req, 2048);
      lockCare(req);
      res.setHeader("cache-control", "no-store");
      return json(res, 200, { status: serviceAdmin.status(req), config: configStatus(req) });
    }
    if (path === "/api/service/status" && method === "GET") {
      res.setHeader("cache-control", "no-store");
      return json(res, 200, managedService.status());
    }
    if (path.startsWith("/api/company/")) {
      res.setHeader("cache-control", "no-store");
      if (!["GET", "HEAD"].includes(method) && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      if (path.startsWith('/api/company/department-work/')) {
        if (method !== 'POST') return json(res,405,{error:'Use the department preparation controls.'});
        const body=await readBody(req,32_768), session=companyMemberToken(req);
        if (!session) return json(res,401,{error:'Sign in to this office to review department work.'});
        const operation=path.slice('/api/company/department-work/'.length);
        if (operation==='catalog' && body && Object.keys(body).join(',')==='departmentId') return json(res,200,await departmentWork.catalog(session,body.departmentId));
        if (operation==='prepare') return json(res,200,await departmentWork.prepare(session,body as DepartmentWorkPrepare));
        if (operation==='list') return json(res,200,await departmentWork.list(session,body));
        if (operation==='confirm') return json(res,200,await departmentWork.confirm(session,body as ConfirmCompanyExecution));
        if (operation==='revoke') return json(res,200,await departmentWork.revoke(session,body as RevokeCompanyExecution));
        if (operation==='reconcile' && body && Object.keys(body).join(',')==='grantId') return json(res,200,await departmentWork.reconcile(session,body.grantId));
        return json(res,400,{error:'Check the department preparation request.'});
      }
      const recoveryUpload = path === "/api/company/host-recovery/restore" && method === "POST";
      if (recoveryUpload) {
        const gate = serviceAdmin.authorize(req);
        if (!gate.ok) return json(res, gate.status, { error: gate.error, code: "service_admin_required" });
      }
      const response = await companyHost.handle(path, method, req, ["GET", "HEAD"].includes(method) ? undefined : await readBody(req, recoveryUpload ? 49 * 1024 * 1024 : 32_768));
      const adminAfterCompany = serviceAdmin.status(req);
      if (adminAfterCompany.authenticated && adminAfterCompany.expiresAt) res.setHeader("x-realbud-service-admin-expires", String(adminAfterCompany.expiresAt));
      return json(res, response.status, response.body);
    }
    const denied = productDenied(method, path);
    if (denied) return json(res, 403, { error: denied });

    // Help and support. POST carries the desktop app's own log tail so one
    // redactor masks both logs; the report is plain text and never stored.
    if (path === "/api/support/bundle" && (method === "GET" || method === "POST")) {
      if (method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const request = method === "POST" ? supportBundleRequest(await readBody(req)) : {};
      const report = await buildSupportBundle(request);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end(report);
    }

    if (path === "/api/session" && method === "GET") {
      const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      if (!hostAllowed(host, PORT) || !originAllowed(origin, PORT)) {
        return json(res, 403, { error: "refused host or origin" });
      }
      // This route hands out the session token that guards the whole local API, so
      // it is the one place worth being strict. `originAllowed` treats a missing
      // Origin as allowed, which is right for the server's own clients but wrong
      // for a browser request started by another site: `fetch(..., {mode:"no-cors"})`
      // sends no readable response but still reaches here, and a token obtained
      // that way would unlock the desk for anything that could read it. Refuse the
      // browser shapes that are not this app or a top-level navigation to it.
      const fetchSite = typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"] : undefined;
      const fetchMode = typeof req.headers["sec-fetch-mode"] === "string" ? req.headers["sec-fetch-mode"] : undefined;
      // Refuse only when the request *affirmatively* says it came from elsewhere.
      // `sec-fetch-site` is the discriminating header; `sec-fetch-mode` is not,
      // because Node's own fetch sends `mode: cors` with no `site` at all, and
      // treating that as cross-site refused this app's own bootstrap.
      const fromElsewhere = fetchSite === "cross-site" || fetchSite === "same-site";
      if (fromElsewhere && fetchMode !== "navigate") {
        return json(res, 403, { error: "refused cross-site session request" });
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
    if (path.startsWith('/api/agency-setup')) {
      if (desk.recovery.active && method !== 'GET') return json(res, 503, { error: 'Recover the private book before changing workflow setup.' });
      const previous = method === 'PUT' ? (await agencySetup.getConfiguration()).revision : undefined;
      const result = await agencySetup.handle(path, method, method === 'GET' ? undefined : await readBody(req, 400_000));
      if (previous !== undefined && (await agencySetup.getConfiguration()).revision !== previous) { mailWorkspace.cancel(); loops!.setEnabled('inbound-triage', false); }
      return json(res, result?.status ?? 404, result?.body ?? { error: 'Unknown agency setup action.' });
    }
    const mailQuery = path.startsWith('/api/mail-workspace') ? mailWorkspaceQuery(url.searchParams,
      method === 'GET' && path === '/api/mail-workspace/items' ? 'tasks' : method === 'GET' && path === '/api/mail-workspace/scans' ? 'scans' : 'none') : undefined;
    if (path === '/api/mail-workspace' && method === 'GET') {
      const state = await mailWorkspace.get(), loop = loops!.listLoops().find(l => l.id === 'inbound-triage')!;
      const latest = loops!.listRuns().filter(r => r.loopId === 'inbound-triage').sort((a,b) => b.createdAt-a.createdAt)[0];
      return json(res, 200, { ...state, schedule: { revision: loop.revision, enabled: loop.enabled, available: loop.available && !loops!.recovery.active,
        timezone: loop.schedule.timezone ?? loops!.timezone, localTime: loop.schedule.time, weekdays: loop.schedule.weekdays, nextRunAt: loop.nextRunAt,
        detail: 'Starts at this office time while this computer is running. Missed and late work is recorded in Schedule.' },
        operation: latest ? { state: ['queued','running'].includes(latest.status) ? 'running' : ['completed','awaiting-approval','partial'].includes(latest.status) ? 'complete' : latest.status === 'interrupted' ? 'interrupted' : 'failed',
          kind: 'review', startedAt: latest.startedAt ?? latest.createdAt, detail: latest.detail ?? 'Morning review queued.', requestId: latest.requestId } : null });
    }
    if (path === '/api/mail-workspace/items' && method === 'GET') return json(res, 200, await mailWorkspace.page(mailQuery));
    if (path === '/api/mail-workspace/scans' && method === 'GET') return json(res, 200, await mailWorkspace.scanHistory(mailQuery));
    if (path.startsWith('/api/mail-workspace') && method !== 'GET' && desk.recovery.active) return json(res, 503, { error: 'The private book needs recovery. Mail changes are paused.' });
    if (path === '/api/mail-workspace/scan' && method === 'POST') {
      const body = await readBody(req); if (!body || Object.keys(body).length) return json(res, 400, { error: 'Mail scope comes from reviewed agency settings.' });
      return json(res, 200, await mailWorkspace.collect());
    }
    if (path === '/api/mail-workspace/review' && method === 'POST') {
      const body = await readBody(req);
      if (!body || Object.keys(body).some(k => !['requestId','expectedRevision'].includes(k)) || !body.requestId || body.expectedRevision === undefined) return json(res,400,{error:'Provide the request ID and current schedule revision.'});
      const run = loops!.runNow('inbound-triage', { requestId: body.requestId, expectedRevision: body.expectedRevision });
      if (!run) return json(res,409,{error:'Morning priorities is unavailable. Check agency setup and Schedule.'});
      return json(res, 202, { run });
    }
    if (path === '/api/mail-workspace/schedule' && method === 'PATCH') {
      const body = await readBody(req);
      if (!body || Object.keys(body).join(',') !== 'enabled' || typeof body.enabled !== 'boolean') return json(res,400,{error:'Choose whether the reviewed morning schedule is enabled.'});
      if (!body.enabled) return json(res,200,{loop:loops!.setEnabled('inbound-triage',false)});
      await refreshOfficeSources(); const authority = await agencySetup.assertWorkflowReady('morning-priorities');
      const settings = authority.settings;
      return json(res,200,{loop:loops!.patchClock('inbound-triage',{enabled:true,time:settings.morningReview.localTime,weekdays:settings.morningReview.weekdays,timezone:settings.timeZone})});
    }
    const mailItem = path.match(/^\/api\/mail-workspace\/items\/([a-f0-9]{64})(\/source)?$/);
    if (mailItem && method === 'GET' && mailItem[2]) return json(res,200,await mailWorkspace.source(mailItem[1]));
    if (mailItem && method === 'GET' && !mailItem[2]) return json(res, 200, { item: await mailWorkspace.getItem(mailItem[1]) });
    if (mailItem && method === 'PATCH' && !mailItem[2]) return json(res,200,await mailWorkspace.update(mailItem[1],await readBody(req,10_000)));
    if (path === '/api/loops/history' && method === 'GET') {
      return json(res, 200, loops!.history({
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        loopId: url.searchParams.get('loopId') ?? undefined,
      }));
    }
    if (path === "/api/loops" && method === "GET") {
      const fromParam = url.searchParams.get("from");
      const toParam = url.searchParams.get("to");
      const from = fromParam == null ? undefined : Number(fromParam);
      const to = toParam == null ? undefined : Number(toParam);
      return json(res, 200, {
        loops: loops!.listLoops(),
        recovery: loops!.recovery,
        runs: loops!.listRuns(from != null && Number.isFinite(from) ? from : undefined, to != null && Number.isFinite(to) ? to : undefined),
      });
    }
    let loopMatch = path.match(/^\/api\/loops\/([\w-]+)\/run$/);
    if (loopMatch && method === "POST") {
      const body = await readBody(req);
      if(loopMatch[1] === 'inbound-triage' && (!body.requestId || body.expectedRevision === undefined)) return json(res,400,{error:'Morning review requires its request identifier and current schedule revision.'});
      try {
        if (desk.recovery.active) return json(res, 503, { error: "The book is in recovery. Scheduled work is paused; keep the previous request until its result can be checked." });
        const request = body.requestId === undefined ? undefined : {
          requestId: body.requestId, expectedRevision: body.expectedRevision,
        };
        const run = loops!.runNow(loopMatch[1] as LoopId, request);
        if (run) return json(res, 201, { run });
        const loop = loops!.listLoops().find((candidate) => candidate.id === loopMatch![1]);
        if (!loop) return json(res, 404, { error: "no such routine" });
        return json(res, 409, { error: loop.available ? "turn this routine on before running it" : "that routine is declared but not built yet" });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    loopMatch = path.match(/^\/api\/loops\/([\w-]+)$/);
    if (loopMatch && method === "PATCH") {
      if (loopMatch[1] === 'inbound-triage') return json(res,409,{error:'Use Morning priorities to adopt the reviewed agency schedule.'});
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
      try {
        const run = loops!.markSeen(loopRunSeen[1]);
        return run ? json(res, 200, { run }) : json(res, 404, { error: "no such run" });
      } catch (error) {
        return json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : "The schedule result could not be saved." });
      }
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
    if (path === "/api/channels/handoff" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      const mode = body.mode === "summary" ? "summary" : body.mode === "result" ? "result" : null;
      if (!mode) return json(res, 400, { error: "mode must be result or summary" });
      const messageId = typeof body.messageId === "string" && body.messageId.trim() ? body.messageId.trim() : undefined;
      const built = buildHandoffPayload(store, { mode, messageId });
      if (!built.ok) return json(res, 409, { error: built.error });
      const channels = [telegramDecisionAdapter(), discordDecisionAdapter(), slackDecisionAdapter()];
      const delivered = await deliverToPairedPhone(built.text, channels);
      if (!delivered.ok) return json(res, 409, { error: delivered.error });
      const bud = store.productBud();
      if (bud) {
        const label = mode === "summary" ? `Sent summary to ${delivered.label}` : `Sent to ${delivered.label}`;
        const stamp = store.appendMessage(bud.threadId, {
          role: "bot",
          kind: "activity",
          text: label,
          tool: { name: label, ok: true },
        });
        broadcast({ kind: "message", threadId: bud.threadId, message: stamp });
        broadcast({ kind: "bot", bot: store.bot(bud.id) });
      }
      return json(res, 200, { ok: true, deliveredVia: delivered.deliveredVia, label: delivered.label });
    }
    const pairMatch = path.match(/^\/api\/channels\/(telegram|discord|slack)\/pair$/);
    if (pairMatch && method === "POST") {
      const platform = pairMatch[1] as "telegram" | "discord" | "slack";
      const status = channelsStatus()[platform];
      if (!status.connected) return json(res, 409, { error: "Connect this messaging app first." });
      if (status.paired) return json(res, 409, { error: "Already paired. Disconnect first to change the paired account." });
      return json(res, 200, createPairingCode(platform));
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

    // Portfolio preparation uses the same authenticated Desk boundary.
    if (path === "/api/desk/batches" && method === "GET") {
      return json(res, 200, { batches: batches.summaries() });
    }
    if (path === "/api/desk/batches" && method === "POST") {
      const created = batches.create(await readBody(req));
      return json(res, 202, { batch: batches.view(created.id) });
    }
    const batchPath = path.match(/^\/api\/desk\/batches\/([\w-]+)$/);
    if (batchPath && method === "GET") return json(res, 200, { batch: batches.view(batchPath[1], url.searchParams.has("revision") ? Number(url.searchParams.get("revision")) : undefined) });
    if (batchPath && method === "PATCH") {
      const body = await readBody(req);
      batches.control(batchPath[1], body.action, body.expectedRevision, body.propertyId);
      return json(res, 200, { batch: batches.view(batchPath[1]) });
    }

    // ── taught jobs + durable prepare receipts ───────────────────────
    if (path === "/api/human-handoffs" || path.startsWith("/api/human-handoffs/")) {
      const gate = sessionOk(req, PORT);
      if (!gate.ok) return json(res, gate.status, { error: gate.error });
      const handoffs = signInHandoffs();
      if (path === "/api/human-handoffs" && method === "GET") return json(res, 200, { handoffs: handoffs.list() });
      if (path === "/api/human-handoffs" && method === "POST") {
        const body = await readBody(req);
        const run = typeof body.runId === "string" ? jobRuns.get(body.runId) : undefined;
        if (!run?.threadId || run.status !== "running" || fenceContextFor(run.threadId)?.runId !== run.id) return json(res, 409, { error: "That attended job is no longer running. Refresh Work activity." });
        return json(res, 200, await pauseAttendedForLogin(run.threadId, body.reason === "mfa" ? "mfa" : "login"));
      }
      const match = path.match(/^\/api\/human-handoffs\/(handover:[\w-]+)\/(continue|stop|retry-release|binding|close|resume-step|tabs)$/);
      if (!match || method !== "POST") return json(res, 404, { error: "Unknown sign-in action." });
      const body = await readBody(req, 4096), [, id, action] = match;
      if (action === "continue") return json(res, 200, await handoffs.continue(id, body.revision));
      if (action === "stop") return json(res, 200, await handoffs.stop(id, body.revision));
      if (action === "close") return json(res, 200, await handoffs.close(id, body.revision));
      if (action === "resume-step") return json(res, 200, await handoffs.resumeStep(id, body.revision, body.step));
      if (action === "retry-release") return json(res, 200, await handoffs.retryRelease(id, body.revision));
      const sourceRun = jobRuns.get(handoffs.get(id).value.runId);
      if (action === "tabs") {
        const handoff = handoffs.get(id);
        if (!sourceRun || handoff.revision !== body.revision || handoff.value.state !== "awaiting_login") return json(res, 409, { error: "This sign-in checkpoint changed. Refresh it before choosing a page." });
        return json(res, 200, { tabs: await browserRuntime.chooseLoginTabs(sourceRun.spec.allowedOrigins) });
      }
      let bindingHost = "";
      if (PRODUCT_MODE && !body.binding?.browser) return json(res, 400, { error: "Choose the signed-in page from your connected browser and save its visible labels." });
      try { bindingHost = new URL(body.binding?.origin).hostname; } catch { /* rejected below */ }
      if (!sourceRun || !bindingHost || !originMatches(bindingHost, sourceRun.spec.allowedOrigins)) return json(res, 403, { error: "The sign-in check must use a site in this saved job." });
      if (body.binding?.browser && body.binding.browser.browserId !== (await browserRuntime.status()).selectedBrowserId) return json(res, 409, { error: "Choose a page from the browser selected on this computer." });
      return json(res, 200, handoffs.bind(id, body.revision, body.binding));
    }
    if (path === "/api/bank-reference" || path.startsWith("/api/bank-reference/")) {
      const gate = sessionOk(req, PORT);
      if (!gate.ok) return json(res, gate.status, { error: gate.error });
      const { bankReferenceQuery } = await import('./bank-reference-query.ts');
      const bankQuery = bankReferenceQuery(url.searchParams,path === '/api/bank-reference' && method === 'GET');
      const banks = bankReferenceStore();
      if (path === "/api/bank-reference/settings" && method === "GET") return json(res, 200, { settings: banks.settings() });
      if (path === "/api/bank-reference" && method === "GET") return json(res, 200, banks.page(bankQuery));
      if (path === "/api/bank-reference" && method === "POST") return json(res, 200, banks.create(await readBody(req, 2_000_000)));
      const match = path.match(/^\/api\/bank-reference\/(bank:[a-f0-9]{64}(?::r(?:[2-9]|[1-9][0-9]{1,5}))?)(?:\/(review|export|original|amend))?$/);
      if (!match) return json(res, 404, { error: "Unknown bank review." });
      const [, id, action] = match;
      if (!action && method === "GET") return json(res, 200, banks.get(id));
      if (action === 'amend' && method === 'POST') return json(res, 200, banks.amend(id, await readBody(req, 2_000_000)));
      if (action === "review" && method === "POST") {
        const body = await readBody(req, 2_000_000);
        return json(res, 200, banks.review(id, body.revision, body.decisions));
      }
      if ((action === "export" || action === "original") && method === "POST") return json(res, 200, banks.export(id, action === "original"));
      return json(res, 405, { error: "Unsupported bank review action." });
    }
    if (path === '/api/job-runs/history' && method === 'GET') {
      return json(res, 200, jobRuns.history({
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        jobId: url.searchParams.get('jobId') ?? undefined,
      }));
    }
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
    if (path.startsWith('/api/workspace-tabs')) {
      res.setHeader('cache-control', 'no-store');
      const result = await workspaceTabs.handle(path, method, method === 'GET' ? undefined : await readBody(req));
      if (result) return json(res, result.status, result.body);
    }
    if (path.startsWith('/api/customer-packs')) {
      res.setHeader('cache-control', 'no-store');
      const result = await customerPacks.handle(path, method, method === 'GET' ? undefined : await readBody(req, 2_000_000));
      if (result) return json(res, result.status, result.body);
    }
    // ── office workflow packs (RealBud clock + recipe templates) ─────
    if (path === "/api/workflow-packs" && method === "GET") {
      return json(res, 200, { packs: listWorkflowPackStatus() });
    }
    if (path === "/api/workflow-packs/export" && method === "GET") {
      return json(res, 200, exportWorkflowPacks());
    }
    if (path === "/api/workflow-packs/company-template" && method === "GET") {
      try { return json(res, 200, normalizeCompanyWorkflowTemplate(exportWorkflowPacks())); }
      catch { return json(res, 400, { error: "Install or import at least one valid office pack before sharing a template. Templates must fit within 24 KB." }); }
    }
    if (path === "/api/workflow-packs/import" && method === "POST") {
      if (desk.recovery.active) {
        return json(res, 409, { error: "The book is in recovery. Pack import is paused until it is unlocked." });
      }
      if (loops.recovery.active) return json(res, 503, { error: loops.recovery.detail });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readBody(req);
        const imported = importWorkflowPacks(body);
        return json(res, 200, imported);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === "/api/expected-bills" && method === "GET") {
      return json(res, 200, expectedBillsPage(url.searchParams, listExpectedBills, sourceBills));
    }
    if (/^\/api\/bill-review-drafts(?:\/|$)/.test(path) || path.startsWith('/api/bill-proposals/')) {
      res.setHeader('cache-control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return json(res, 415, { error: 'content-type must be application/json' });
      }
      const result = billReviewApi(url, method, ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : await readBody(req, 70_000));
      return json(res, result?.status ?? 404, result?.body ?? { error: 'Unknown saved review action.' });
    }
    if (path === '/api/bill-proposals' && method === 'POST') {
      if (desk.recovery.active) return json(res,503,{error:'Recover the private book before preparing bills.'});
      const result = await billProposals(await readBody(req,10_000));
      return json(res,['queued','running'].includes(result.run.status)?202:200,result);
    }
    if (/^\/api\/bill-(?:register|evidence|occurrences|series|scan)(?:\/|$)/.test(path)) {
      const result = await sourceBillsApi(url,method,method === 'GET' ? undefined : await readBody(req,30_000));
      return json(res,result?.status ?? 404,result?.body ?? {error:'Unknown bill action.'});
    }
    if (path === "/api/expected-bills" && method === "POST") {
      if (desk.recovery.active) {
        return json(res, 409, { error: "The book is in recovery. Bill changes are paused until it is unlocked." });
      }
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readBody(req);
        const bill = upsertExpectedBill({
          id: typeof body.id === "string" ? body.id : undefined,
          propertyId: String(body.propertyId ?? ""),
          kind: String(body.kind ?? ""),
          status: body.status,
          windowStartAt: body.windowStartAt ?? undefined,
          windowEndAt: body.windowEndAt ?? undefined,
          amountCents: body.amountCents ?? undefined,
          note: typeof body.note === "string" ? body.note : undefined,
          sourceRef: body.sourceRef ?? undefined,
        });
        const bills = listExpectedBills();
        return json(res, 200, { bill, bills, groups: groupExpectedBills(bills) });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (path === "/api/workflow-packs/austin-phase-1/install" && method === "POST") {
      if (desk.recovery.active) {
        return json(res, 409, { error: "The book is in recovery. Pack install is paused until it is unlocked." });
      }
      if (loops.recovery.active) return json(res, 503, { error: loops.recovery.detail });
      try {
        const packs = installAustinPhase1Packs();
        return json(res, 200, { packs, recipes: listRecipes() });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const workflowPackInstall = path.match(/^\/api\/workflow-packs\/([\w-]+)\/install$/);
    if (workflowPackInstall && method === "POST") {
      if (desk.recovery.active) {
        return json(res, 409, { error: "The book is in recovery. Pack install is paused until it is unlocked." });
      }
      if (loops.recovery.active) return json(res, 503, { error: loops.recovery.detail });
      try {
        const installed = installWorkflowPack(workflowPackInstall[1]!);
        return json(res, 200, { pack: installed.pack, recipes: listRecipes() });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    // ── recipes + compatibility portal sessions (never submit) ───────
    if (desk.recovery.active && path.startsWith("/api/recipes") && method !== "GET") {
      return json(res, 409, { error: "The book is in recovery. Job changes and runs are paused until it is unlocked." });
    }
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
      if (loops.recovery.active) return json(res, 503, { error: loops.recovery.detail });
      const draftId = typeof body.draft?.id === 'string' ? body.draft.id.trim() : null;
      const before = draftId ? getRecipe(draftId) : undefined;
      if (draftId && body.draft.status === 'active') await customerPacks.assertReadyForRecipe(draftId);
      const recipes = saveRecipe(body.draft);
      const saved = recipes.find((recipe) => recipe.id === draftId);
      if (saved && (!before || saved.revision !== before.revision)) loops.adoptRecipePlan(saved.id);
      return json(res, 201, { recipes });
    }
    if (path === "/api/computer-history" && method === "GET") {
      return json(res, 200, { entries: listHistory(50) });
    }
    if (path === "/api/worker-issues" && method === "GET") {
      return json(res, 200, { issues: listWorkerIssues(20) });
    }
    const recipeRun = path.match(/^\/api\/recipes\/([\w-]+)\/run$/);
    if (recipeRun && method === "POST") {
      const body = await readBody(req);
      await customerPacks.assertReadyForRecipe(recipeRun[1]);
      const recipe = getRecipe(recipeRun[1]);
      if (!recipe) return json(res, 404, { error: "no such recipe" });
      try {
        const idempotencyKey = manualRecipeRequestKey(recipe, body, "shadow");
        const existing = jobRuns.getByIdempotencyKey(idempotencyKey);
        if (existing) return json(res, ["queued", "running"].includes(existing.status) ? 202 : 200, {
          run: existing,
          reused: true,
          ...(existing.legacySessionId ? { session: getSession(existing.legacySessionId) } : {}),
        });
        assertRecipeRevision(recipe, body.expectedRevision);
        const executed = await executeRecipeJob(recipe, {
          mode: "shadow",
          trigger: "manual",
          idempotencyKey,
        }, { instructionContext: id => customerPacks.instructionContext(id) });
        return json(res, ["queued", "running"].includes(executed.run.status) ? 202 : 200, {
          run: executed.run, session: executed.session, reused: executed.reused,
        });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const recipeAttend = path.match(/^\/api\/recipes\/([\w-]+)\/attend$/);
    if (recipeAttend && method === "POST") {
      await customerPacks.assertReadyForRecipe(recipeAttend[1]);
      const recipe = getRecipe(recipeAttend[1]);
      const bud = store.productBud();
      const attendBody = await readBody(req);
      const runId = typeof attendBody.runId === "string" ? attendBody.runId.trim() : "";
      const queued = runId
        ? jobRuns.list(recipeAttend[1]).find((run) => run.id === runId)
        : undefined;
      if (runId && (!queued || queued.mode !== "attended" || queued.status !== "queued" || queued.jobId !== recipeAttend[1])) {
        return json(res, 404, { error: ATTEND_ERRORS.gone });
      }
      if (queued && recipe && queued.jobRevision !== recipe.revision) {
        jobRuns.cancel(queued.id);
        return json(res, 409, { error: "The older queued run was cancelled. Review and approve the current plan, then start it again." });
      }
      const blocked = attendBlocked(recipe, {
        cuaReady: PRODUCT_MODE ? (await browserRuntime.status()).state === "ready" : cuaAttendedReady(),
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
      await customerPacks.assertReadyForRecipe(recipe.id);
      const latestRecipe = getRecipe(recipe.id);
      if (!latestRecipe || latestRecipe.revision !== recipe.revision) return json(res, 409, { error: 'This workflow changed while readiness was checked. Review the current plan before starting.' });
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
          botId: bud.id,
          runId: running.id,
          allowedOrigins: [...running.spec.allowedOrigins],
          capabilities: fenceCapabilitiesFor(recipe),
        });
        const instructions = await customerPacks.instructionContext(recipe.id);
        await startTurn(bud.id, attendedUserText(recipe), {
          threadId,
          systemExtra: [attendedJobSystemBlock(recipe), instructions && `Reviewed workflow instructions (do not extend the granted capabilities):\n${instructions}`].filter(Boolean).join('\n\n'),
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
      const body = await readBody(req);
      await customerPacks.assertReadyForRecipe(recipePrepare[1]);
      const recipe = getRecipe(recipePrepare[1]);
      if (!recipe) return json(res, 404, { error: "no such recipe" });
      try {
        const idempotencyKey = manualRecipeRequestKey(recipe, body, "prepare");
        const existing = jobRuns.getByIdempotencyKey(idempotencyKey);
        if (existing) return json(res, ["queued", "running"].includes(existing.status) ? 202 : 200, {
          run: existing, reused: true,
        });
        assertRecipeRevision(recipe, body.expectedRevision);
        if (!recipeClockRunnable(recipe)) {
          return json(res, 409, { error: "Approve the current plan and activate the job before preparing it." });
        }
        const executed = await executeRecipeJob(recipe, {
          mode: "prepare",
          trigger: "manual",
          idempotencyKey,
        }, { readBookSnapshot: () => desk.snapshot(), instructionContext: id => customerPacks.instructionContext(id) });
        return json(res, ["queued", "running"].includes(executed.run.status) ? 202 : 200, {
          run: executed.run, reused: executed.reused,
        });
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
        if ((body.planApproved === true || body.status === "active") && loops.recovery.active) {
          return json(res, 503, { error: loops.recovery.detail });
        }
        if (body.planApproved === true || body.status === 'active') await customerPacks.assertReadyForRecipe(recipeMatch[1]);
        const recipes = patchRecipe(recipeMatch[1], body);
        if (body.planApproved === true || body.status === "active") loops.adoptRecipePlan(recipeMatch[1]);
        return json(res, 200, { recipes });
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
          expectedRevision: body.expectedRevision,
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
        commitDesk(desk.snapshot());
        return json(res, 200, { ...result, message: "Book restored. You can keep working." });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/desk/recovery/auto" && method === "POST") {
      try {
        const result = desk.tryAutoUnlock();
        if (!result.ok) return json(res, 409, { ok: false, error: result.detail });
        commitDesk(desk.snapshot());
        return json(res, 200, { ok: true, restoredFrom: result.restoredFrom, message: "Book restored automatically." });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { ok: false, error: e instanceof Error ? e.message : String(e) });
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
    if (path === "/api/browser" && method === "GET") return json(res, 200, await browserRuntime.status());
    if (path.startsWith("/api/browser/") && method === "POST") {
      const body = await readBody(req);
      if (path === "/api/browser/connect") return json(res, 200, await browserRuntime.connect());
      if (path === "/api/browser/select") return json(res, 200, await browserRuntime.select(String(body.browserId ?? "")));
      if (path === "/api/browser/stop" || path === "/api/browser/disconnect") {
        // Revoke tool access before releasing the browser, including an in-flight approval.
        await releaseBrowserBrokers();
        return json(res, 200, await browserRuntime.stop(path.endsWith("disconnect")));
      }
    }
    if (path === "/api/office-link" && method === "GET") return json(res, 200, await officeLink.status());
    if (path === "/api/office-link" && method === "POST") {
      await officeLink.link(await readBody(req));
      // A missed report must not hide a successfully persisted link.
      await officeLink.report().catch(() => {});
      return json(res, 200, await officeLink.status());
    }
    if (path === "/api/office-link/report" && method === "POST") {
      await officeLink.report(); return json(res, 200, await officeLink.status());
    }
    // Browser approval instead of a pasted code. The view never carries the token.
    if (path === "/api/office-link/browser-link") {
      res.setHeader("cache-control", "no-store");
      if (method === "POST") return json(res, 200, { state: "pending", ...(await officeLink.beginBrowserLink(await readBody(req))) });
      if (method === "GET") return json(res, 200, await officeLink.browserLinkStatus());
      if (method === "DELETE") return json(res, 200, await officeLink.cancelBrowserLink());
    }
    if (path === "/api/office-link" && method === "DELETE") {
      await websiteRequests.disable();
      await officeLink.disconnect(); return json(res, 200, await officeLink.status());
    }
    if (path === '/api/website-requests' || path.startsWith('/api/website-requests/')) {
      res.setHeader('cache-control', 'no-store');
      if (path === '/api/website-requests/remote-work' && method === 'GET') {
        const raw = url.searchParams.get('before');
        if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)) return json(res, 400, { error: 'Invalid history page.' });
        return json(res, 200, { status: await websiteRequests.remoteWork.status(), ...websiteRequests.remoteWork.list(raw ? { before: Number(raw) } : {}) });
      }
      if (path.startsWith('/api/website-requests/remote-work/') && method === 'POST') {
        const body = await readBody(req, 4096);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Use an object for this work action.' });
        const action = path.slice('/api/website-requests/remote-work/'.length);
        if (action === 'cancel') {
          if (Object.keys(body).length !== 2 || typeof body.id !== 'string' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) return json(res, 400, { error: 'Use the current work request and revision.' });
          return json(res, 200, await websiteRequests.remoteWork.cancel(body.id, body.expectedRevision));
        }
        if (Object.keys(body).length) return json(res, 400, { error: 'This action does not accept additional settings.' });
        if (action === 'enable') await websiteRequests.remoteWork.enable();
        else if (action === 'disable') await websiteRequests.remoteWork.disable();
        else if (action === 'sync') await websiteRequests.remoteWork.sync();
        else return json(res, 404, { error: 'Unknown remote work action.' });
        return json(res, 200, { status: await websiteRequests.remoteWork.status(), ...websiteRequests.remoteWork.list() });
      }
      if(path==='/api/website-requests/remote' && method==='GET')return json(res,200,await websiteRequests.remote.status());
      if(path.startsWith('/api/website-requests/remote/') && method==='POST'){
        const body=await readBody(req,8192);
        const action=path.slice('/api/website-requests/remote/'.length);
        if(action==='preview')return json(res,200,await websiteRequests.withRemoteActivity(()=>remoteDisclosureReview.preview(body)));
        if(action==='approve-disclosure')return json(res,200,await websiteRequests.withRemoteActivity(()=>remoteDisclosureReview.approve(body)));
        if(action==='prepare')return json(res,200,await websiteRequests.remote.prepare(body));
        if(action==='begin')return json(res,200,await websiteRequests.remote.begin(body));
        if(action==='confirm')return json(res,200,await websiteRequests.remote.confirm(body));
        if(action==='sync' || action==='revoke'){
          if(Object.keys(body).some(key=>key!=='enrollmentId') || action==='revoke'&&typeof body.enrollmentId!=='string')return json(res,400,{error:'Use the current invitation only.'});
          return json(res,200,action==='sync'?await websiteRequests.remote.sync(body.enrollmentId):await websiteRequests.remote.revoke(body.enrollmentId));
        }
        if(action==='disable'&&Object.keys(body).length===0){await websiteRequests.disable();return json(res,200,await websiteRequests.remote.status());}
        return json(res,404,{error:'Unknown workspace access action.'});
      }
      if (path === '/api/website-requests' && method === 'GET') {
        const raw = url.searchParams.get('before');
        if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)) return json(res, 400, { error: 'Invalid history page.' });
        return json(res, 200, { status: await websiteRequests.status(), ...websiteRequests.list(raw ? { before: Number(raw) } : {}) });
      }
      if (method === 'POST') {
        const body = await readBody(req, 8192);
        if (path === '/api/website-requests/enroll') return json(res, 200, await websiteRequests.enroll(body));
        if (path === '/api/website-requests/disable') return json(res, 200, await websiteRequests.disable());
        if (path === '/api/website-requests/sync') { await websiteRequests.sync(); return json(res, 200, { status: await websiteRequests.status(), ...websiteRequests.list() }); }
        const match = path.match(/^\/api\/website-requests\/([a-f0-9-]{36})\/(preview|decision|cancel)$/);
        if (match) {
          if (match[2] !== 'decision' && Object.keys(body).some(key=>key!=='expectedRevision')) return json(res,400,{error:'Use the current request revision only.'});
          if (match[2] === 'preview') return json(res, 200, await websiteRequests.preview(match[1], body.expectedRevision));
          if (match[2] === 'decision') return json(res, 200, await websiteRequests.decide(match[1], body));
          return json(res, 200, await websiteRequests.cancel(match[1], body.expectedRevision));
        }
      }
      return json(res, 404, { error: 'Unknown website request action.' });
    }
    if (path === MEMORY_REVIEW_API || path.startsWith(`${MEMORY_REVIEW_API}/`)) {
      res.setHeader('cache-control', 'no-store');
      const result = await memoryReviews.handle(path, method, method === 'POST' ? await readBody(req, 8192) : undefined, url.searchParams);
      return json(res, result!.status, result!.body);
    }
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
    if (path === "/api/hermes/update" && method === "GET") {
      return json(res, 200, runtimeUpdateStatus());
    }
    if (path === "/api/hermes/update/check" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      await readBody(req);
      try { return json(res, 200, { ...runtimeUpdateStatus(), upstream: await checkUpstreamRelease() }); }
      catch { return json(res, 503, { error: "Could not check agent releases. Your installed agent is unchanged; try again later." }); }
    }
    if ((path === "/api/hermes/update" || path === "/api/hermes/update/restore") && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      await readBody(req);
      return path.endsWith("/restore") ? json(res, 200, restorePreviousRuntime()) : json(res, 202, { install: startRuntimeUpdate() });
    }
    if (path === "/api/hermes/test" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      const ping = await tryHermesPing({ memberKey: currentWorkerProfile().memberKey });
      writeHandsPing(DATA_DIR, { at: Date.now(), ok: ping.ok, detail: ping.detail, kind: "ping", workerFingerprint: ping.workerFingerprint });
      if (ping.ok) {
        resolveWorkerIssues("hands");
      } else {
        publishWorkerIssue({
          source: "hands",
          summary: "Bud readiness check missed",
          detail: productAskFailure(ping.detail),
        });
      }
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
        const ping = await tryHermesPing({ memberKey: currentWorkerProfile().memberKey });
        // Connecting a model performs the same authoritative hands check as
        // the standalone action. Persist it so a reload cannot forget a
        // successful check or falsely present a failed one as ready.
        writeHandsPing(DATA_DIR, { at: Date.now(), ok: ping.ok, detail: ping.detail, kind: "ping", workerFingerprint: ping.workerFingerprint });
        if (ping.ok) resolveWorkerIssues("hands");
        return json(res, 200, { ok: true, model: status, ping });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/hermes/providers" && method === "GET") {
      return json(res, 200, {
        providers: PROVIDER_OPTIONS.map((provider) => ({
          ...provider,
          loginMethods: workerLoginMethods(provider.id),
          oauth: WORKER_OAUTH_LOGINS[provider.id]
            ? {
                providerId: WORKER_OAUTH_LOGINS[provider.id].oauthId,
                signInLabel: WORKER_OAUTH_LOGINS[provider.id].signInLabel,
              }
            : null,
        })),
      });
    }
    if (path === "/api/hermes/oauth/start" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        const session = startOAuth(String(body.providerId ?? ""));
        return json(res, 200, { ok: true, oauth: session });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/hermes/oauth/status" && method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      try {
        return json(res, 200, { oauth: oauthStatus(sessionId) });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === "/api/hermes/oauth/cancel" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const body = await readBody(req);
      try {
        return json(res, 200, { ok: true, oauth: cancelOAuth(String(body.sessionId ?? "")) });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return json(res, status, { error: e instanceof Error ? e.message : String(e) });
      }
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
    if ((path === "/api/hermes/install" || path === "/api/hermes/repair") && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      if (installInFlight()) return json(res, 202, { install: installStatus() });
      const current = await hermesStatus();
      if (current.cli.installed && !(current.cli.compatible ?? current.cli.matchesPin)) {
        // A personal or newer Hermes installation is never downgraded by
        // Repair. Prepare an independent supported runtime for the next launch.
        return json(res, 202, { install: startRuntimeUpdate({ repair: true }) });
      }
      // A partially installed, RealBud-owned runtime must finish its stages
      // before a working version command can be treated as a successful install.
      const existingProfile = bootstrapPending(hermesHome()) ? null : await repairExistingProfile();
      if (existingProfile) {
        writeHandsPing(DATA_DIR, { at: Date.now(), ok: false, detail: "Property profile repaired. Run the readiness check again.", kind: "ping" });
        return json(res, 200, { install: { state: "done", lines: ["Private setup repaired."], startedAt: Date.now(), finishedAt: Date.now(), error: null }, hermes: existingProfile });
      }
      if (!bootstrapPlan(process.platform)) return json(res, 400, { error: "Automatic Bud setup is not available on this computer yet." });
      const job = startRuntimeUpdate({ repair: true, firstInstall: current.cli.probeState === "missing" && !modelStatus().keyPresent });
      writeHandsPing(DATA_DIR, { at: Date.now(), ok: false, detail: "Bud setup changed. Its private readiness check is still needed.", kind: "ping" });
      return json(res, 202, { install: job });
    }
    if (path === "/api/hermes/install/status" && method === "GET") {
      return json(res, 200, { install: installStatus() });
    }
    if (path === "/api/hermes/install/cancel" && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await readBody(req);
      return json(res, 202, { install: cancelBootstrapInstall() });
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
        if (body.alwaysAllow.some((key: string) => reservedApprovalKey(key))) return json(res, 400, { error: 'Memory changes require a separate review each time and cannot use saved grants.' });
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
      const sizeError = askMessageSizeError(text);
      if (sizeError) return json(res, 413, { error: sizeError });
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
      const sizeError = askMessageSizeError(text);
      if (sizeError) return json(res, 413, { error: sizeError });
      if (PRODUCT_MODE && containsCredential(text)) {
        return json(res, 400, { error: "Use the private key field in Set up Bud. Keep keys out of the conversation." });
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
      const sizeError = askMessageSizeError(text);
      if (sizeError) return json(res, 413, { error: sizeError });
      if (PRODUCT_MODE && containsCredential(text)) {
        return json(res, 400, { error: "Use the private key field in Set up Bud. Keep keys out of the conversation." });
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
      const parsed = parseRequestDecision(await readBody(req));
      const { requestId } = parsed;
      if (!askMessageByRequest.has(`${bot.threadId}:${requestId}`)) {
        return json(res, 409, { error: "This request is no longer waiting. Refresh the conversation to see its result." });
      }
      const liveMessageId = askMessageByRequest.get(`${bot.threadId}:${requestId}`);
      const card = store.messagesFor(bot.threadId).find(message => message.id === liveMessageId)?.card;
      const decision = guardPermissionDecision(card, parsed.decision, parsed.rule);
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
      // Check the live request before saving a rule or calling the provider.
      // Persisted cards from another client or an earlier process are not grants.
      if (!askMessageByRequest.has(`${threadId}:${requestId}`)) {
        return json(res, 409, { error: "This request is no longer waiting. Refresh the conversation to see its result." });
      }
      const card = store
        .messagesFor(threadId)
        .find((message) => message.id === askMessageByRequest.get(`${threadId}:${requestId}`));
      decision = guardPermissionDecision(card?.card, decision, parsed.rule);
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
      // Match steer: wait for the ACP session to die before clearing busy so
      // a follow-up turn cannot remount computer while the old one is dying.
      if (wasBusy) await waitUntilTurnStopped(instance ?? null, bot.threadId);
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

    // Identity handshake for the desktop app.
    //
    // `pid` still proves "the child I just forked is the one answering". That is
    // not enough once the office service can outlive the window and can already
    // be running at launch: the app must recognise its OWN long-lived service
    // instead of forking a second one beside it, and must not adopt a different
    // installation's service that happens to serve the same API on the same
    // port. `instanceId` is a hash of this installation's data directory, so it
    // matches for this office only and discloses no path.
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "realbud", pid: process.pid, static: Boolean(STATIC_DIR), instanceId: SERVICE_INSTANCE_ID, controlId: SERVICE_CONTROL.id });
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
      if (instance.driverKind === "hermesAgent") {
        return json(res, 409, { error: "Open You → Bud to install the agent or connect a model. Hermes setup is managed inside RealBud." });
      }
      const command = setupCommandFor(instance.install, instance.snapshot, process.platform);
      if (!command) return json(res, 400, { error: "no setup command for this engine" });
      const ok = await openTerminalAndRun(command);
      return json(res, ok ? 200 : 502, { ok, command });
    }

    if (path === '/api/connected-apps/managed/setup' && method === 'POST') {
      const gate = serviceAdmin.authorize(req);
      if (!gate.ok) return json(res, gate.status, { error: gate.error, code: 'service_admin_required' });
      const body = await readBody(req, 8192);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'credential,endpoint') return json(res, 400, { error: 'Provide the managed service URL and installation credential.' });
      if (savingConnectedApps || creatingGmailLink) return json(res, 409, { error: 'Connected apps setup is in progress. Wait for the result before saving again.' });
      savingConnectedApps = true;
      try {
        const managed = { endpoint: body.endpoint, credential: body.credential, profile: currentWorkerProfile().profile };
        const candidate = { ...cfg, composio: { ...cfg.composio, managed } };
        managedConnectorSettings(candidate);
        const previous = JSON.stringify(cfg.composio);
        await managedConnectorAccess(candidate);
        const stillAdmin = serviceAdmin.authorize(req);
        if (!stillAdmin.ok) return json(res, stillAdmin.status, { error: stillAdmin.error, code: 'service_admin_required' });
        if (JSON.stringify(cfg.composio) !== previous) return json(res, 409, { error: 'Connection settings changed while checking access. Review the current setup.' });
        invalidateConnectedAppAuthority();
        saveConfig({ composio: { managed, key: '', apiKey: '', url: '', selectedAccounts: {} } });
        Object.assign(cfg, loadConfig());
        broadcast({ kind: 'config', ...configStatus() });
        await officeSourcesChanged();
        return json(res, 200, { config: configStatus(req) });
      } finally { savingConnectedApps = false; }
    }
    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatus(req));
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      for (const key of ["xai", "composio", "box", "tts", "profile"] as const) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      if (Object.hasOwn(body, "composio")) patch.composio = connectedAppConfigPatch(body.composio, cfg);
      const appPatch = patch.composio as Partial<NonNullable<typeof cfg.composio>> | undefined;
      const changesAppAccess = appPatch && (Object.hasOwn(appPatch, "key") || Object.hasOwn(appPatch, "url") || Object.hasOwn(appPatch, "apiKey"));
      if (changesAppAccess && careCredentialsLocked(req)) {
        return json(res, 403, { error: "Connected apps credentials are managed by RealBud care. Unlock care settings before changing keys." });
      }
      if (patch.composio && (savingConnectedApps || creatingGmailLink)) return json(res, 409, { error: "Connected apps setup is in progress. Wait for the result before saving again." });
      if (patch.composio) savingConnectedApps = true;
      try {
      const candidateApp = appPatch ? { ...cfg.composio, ...appPatch } : undefined;
      if (changesAppAccess && candidateApp && connectedAppsConfigured({ composio: candidateApp })) {
        // Check credentials and actual discovery before replacing a working key.
        // Provider errors are sanitized by the client; never echo a submitted key.
        if (gmailReadOnlyMode({ composio: candidateApp })) {
          await verifyGmailReadOnlyConfig(gmailReadOnlyBinding({ composio: candidateApp })!);
        } else {
          const access = await checkSelectedConnectionAccess({ ...cfg, composio: candidateApp });
          if (!access.tools.available) return json(res, 400, { error: "This connection did not expose the app tools Bud needs. Check the Connected apps key and endpoint." });
        }
      }
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
      if (changesAppAccess) {
        invalidateConnectedAppAuthority();
      }
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      // Only a model-provider key changes the fleet's child environment.
      // Connected-app and computer credentials are mounted per turn from
      // cfg; reloading here used to kill an unrelated in-flight answer.
      if (Object.hasOwn(patch, "xai")) await reloadProviders();
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      if (changesAppAccess) await officeSourcesChanged();
      return json(res, 200, status);
      } finally { if (patch.composio) savingConnectedApps = false; }
    }

    if (method === "POST" && path === "/api/connected-apps/gmail-readonly/setup") {
      if (careCredentialsLocked(req)) {
        return json(res, 403, { error: "Connected apps credentials are managed by RealBud care. Unlock care settings before changing keys." });
      }
      const body = await readBody(req);
      if (!body || Array.isArray(body) || Object.keys(body).some(key => !["apiKey", "authConfigId"].includes(key)) ||
        typeof body.authConfigId !== "string" || !/^ac_[A-Za-z0-9_-]{1,200}$/.test(body.authConfigId.trim()) ||
        (body.apiKey !== undefined && (typeof body.apiKey !== "string" || body.apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(body.apiKey)))) {
        return json(res, 400, { error: "Use the private project key and Gmail auth config fields in Add." });
      }
      if (savingConnectedApps || creatingGmailLink) return json(res, 409, { error: "Connected apps setup is in progress. Check its result first." });
      const apiKey = body.apiKey?.trim() || cfg.composio?.apiKey;
      if (!apiKey || apiKey.startsWith("ck_")) return json(res, 400, { error: "This setup needs the API key from your Composio project, rather than a consumer Connect key." });
      savingConnectedApps = true;
      try {
        const authConfigId = body.authConfigId.trim();
        const previous = cfg.composio?.gmailReadOnly;
        const sameBinding = cfg.composio?.apiKey === apiKey && previous?.authConfigId === authConfigId;
        const saved = sameBinding ? previous! : { userId: `realbud_${newId()}`, authConfigId };
        await verifyGmailReadOnlyConfig({ apiKey, userId: saved.userId, authConfigId });
        invalidateConnectedAppAuthority();
        saveConfig({ composio: { apiKey, gmailReadOnly: saved } });
        Object.assign(cfg, loadConfig());
        const status = configStatus();
        broadcast({ kind: "config", ...status });
        await officeSourcesChanged();
        return json(res, 200, status);
      } finally { savingConnectedApps = false; }
    }
    if (method === "POST" && path === "/api/connected-apps/mode") {
      const body = await readBody(req);
      if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== "mode") || !["consumer", "gmail-readonly"].includes(body.mode)) {
        return json(res, 400, { error: "Choose Composio Connect or Gmail read-only." });
      }
      if (savingConnectedApps || creatingGmailLink) return json(res, 409, { error: "Connected apps setup is in progress. Check its result first." });
      savingConnectedApps = true;
      try {
        if (body.mode === "gmail-readonly") {
          const binding = gmailReadOnlyBinding(cfg);
          if (!binding) return json(res, 409, { error: "Save and verify Gmail read-only setup first." });
          await verifyGmailReadOnlyConfig(binding);
        } else {
          if (!cfg.composio?.key) return json(res, 409, { error: "Save a Composio Platform project API key first." });
          const access = await composio.checkConnectionAccess(cfg);
          if (!access.tools.available) return json(res, 409, { error: "Check your Composio Connect key and tools before switching." });
        }
        invalidateConnectedAppAuthority();
        saveConfig({ composio: { mode: body.mode } });
        Object.assign(cfg, loadConfig());
        const status = configStatus();
        broadcast({ kind: "config", ...status });
        await officeSourcesChanged();
        return json(res, 200, status);
      } finally { savingConnectedApps = false; }
    }
    m = path.match(/^\/api\/connected-apps\/sources\/([a-z][a-z0-9_]{0,63})$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || Array.isArray(body) || Object.keys(body).some(key => !["enabled", "accountId"].includes(key)) || (body.enabled !== undefined && typeof body.enabled !== "boolean") || (body.accountId !== undefined && (typeof body.accountId !== "string" || body.accountId.length > 300)) || (body.enabled === undefined && body.accountId === undefined)) return json(res, 400, { error: "Choose whether this source is available in Ask." });
      if (savingConnectedApps || creatingGmailLink) return json(res, 409, { error: "App setup is still finishing. Try again shortly." });
      const slug = m[1];
      const known = new Set([...composio.CURATED_SLUGS, ...(cfg.composio?.officeApps ?? []), ...Object.keys(connectedAppAccess.status(connectedAppsConfigured(cfg)).services)]);
      if (!known.has(slug)) return json(res, 400, { error: "Choose an office app shown in Add." });
      const selectedAccounts = { ...cfg.composio?.selectedAccounts };
      if (body.accountId !== undefined) {
        const observed = connectedAppAccess.status(connectedAppsConfigured(cfg));
        if (!observed.services[slug]?.connected || !observed.services[slug]?.accounts.some(account => account.id === body.accountId && /^active$/i.test(account.status))) return json(res, 409, { error: "That account is no longer available. Refresh and choose again." });
        selectedAccounts[slug] = body.accountId;
      }
      const excluded = new Set(cfg.composio?.excludedApps ?? []);
      if (body.enabled === true) excluded.delete(slug); else if (body.enabled === false) excluded.add(slug);
      const changed = JSON.stringify([...excluded].sort()) !== JSON.stringify([...(cfg.composio?.excludedApps ?? [])].sort()) ||
        Object.entries(selectedAccounts).some(([app, account]) => cfg.composio?.selectedAccounts?.[app] !== account);
      if (!changed) return json(res, 200, await refreshOfficeSources());
      invalidateConnectedAppAuthority();
      saveConfig({ composio: { excludedApps: [...excluded], selectedAccounts } });
      Object.assign(cfg, loadConfig());
      return json(res, 200, await refreshOfficeSources());
    }
    // Product connections: these observations never authorize a provider mutation.
    if (method === "GET" && path === "/api/connected-apps/status") {
      return json(res, 200, connectedAppAccess.status(connectedAppsConfigured(cfg)));
    }
    if (method === "POST" && path === "/api/connected-apps/check") {
      await readBody(req);
      return json(res, 200, await refreshOfficeSources());
    }
    if (method === "GET" && path === "/api/connected-apps/operations") {
      return json(res, 200, { operations: listConnectedAppOperations().map(row => ({ ...row,
        startedAt: new Date(row.startedAt).toISOString(),
        ...(row.finishedAt === undefined ? {} : { finishedAt: new Date(row.finishedAt).toISOString() }),
      })) });
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
      managedService.assertCapability("voice");
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
      return json(res, 200, { configured: connectedAppsConfigured(cfg), source, cards });
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!connectedAppsConfigured(cfg)) return json(res, 200, { configured: false, services: {} });
      const status = await selectedConnectionStatus(services.length ? services : gmailReadOnlyMode(cfg) ? ["gmail"] : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") return json(res, 200, await authorizeSelectedConnection(m[1]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") {
      if (gmailReadOnlyMode(cfg)) return json(res, 409, { error: "Remove Gmail access in the provider's connection settings. RealBud's read-only connection cannot change the provider account." });
      // Revoke before a potentially partial/uncertain upstream disconnect.
      invalidateConnectedAppAuthority();
      saveConfig({ composio: { excludedApps: [...new Set([...(cfg.composio?.excludedApps ?? []), m[1]])] } });
      Object.assign(cfg, loadConfig());
      try { return json(res, 200, await composio.removeService(cfg, m[1])); }
      finally { await officeSourcesChanged(); }
    }

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
  } finally {
    if (countedPrivateRequest) privateBackupRequests--;
  }
}));

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
  withWorkspaceActivity: workspaceActivity.run,
  startTurn,
  subscribe: (listener) => bus.subscribe(listener),
  broadcast,
});
bindDiscordBridge({
  store,
  withWorkspaceActivity: workspaceActivity.run,
  startTurn,
  subscribe: (listener) => bus.subscribe(listener),
  broadcast,
});
bindSlackBridge({
  store,
  withWorkspaceActivity: workspaceActivity.run,
  startTurn,
  subscribe: (listener) => bus.subscribe(listener),
  broadcast,
});

// Restore identity before accepting requests or resuming queued/background work.
// An unreadable saved identity must not silently run under another profile.
const workspaceIdentity = await companyHost.workspaceIdentity();
desk.setMemberKey(workspaceIdentity.workerMemberKey ?? '');
const memoryReviews = createHermesMemoryReviewService({ context: () => memoryReviewContext(workspaceIdentity.id),
  key: () => Buffer.from(desk.recoveryKeyHex(), 'hex'), withActivity: workspaceActivity.run });
const workspaceTabs = createWorkspaceTabsHandler({ directory: DATA_DIR, workspaceId: workspaceIdentity.id });
const customerPacks = createCustomerPackService({ directory: DATA_DIR,
  pauseSchedules: async packId => {
    if ((await agencySetup.getConfiguration()).settings.workflowPackId !== packId) return;
    mailWorkspace.cancel();
    loops!.setEnabled('inbound-triage', false);
  },
  activeRecipeIds: () => jobRuns.list().filter(run => run.status === 'queued' || run.status === 'running').map(run => run.jobId),
  profileDirectory: () => propertyProfileDir(), workroomDirectory: () => join(DATA_DIR, 'vault'),
  readiness: async () => {
    const worker = applyHandsReadiness(await hermesStatus(), readHandsPing(DATA_DIR));
    const access = connectedAppAccess.status(connectedAppsConfigured(cfg));
    const checked = access.checkedAt ? Date.parse(access.checkedAt) : NaN;
    const mailReady = access.services.gmail?.connected && access.tools.available && Number.isFinite(checked) && Date.now() - checked < 60_000;
    const billCount = listExpectedBills().length + sourceBills().counts().occurrences;
    return {
      worker: { label: 'Bud setup', state: worker.ready ? 'passed' : 'needed', detail: worker.ready ? 'The selected private worker passes its local readiness checks. No paid model call was made.' : 'Finish the selected private worker setup before running a workflow.', nextAction: 'Open You → Bud setup.' },
      'mail-account': { label: 'Gmail connection', state: mailReady ? 'passed' : 'needed', detail: mailReady ? 'The selected Gmail account and read tools were checked in the last minute. Mail history and attachments are not workflow acceptance.' : 'Check the selected Gmail account in Connected apps; importing a pack does not access your mailbox.', nextAction: 'Open Connected apps and check Gmail access.' },
      'bill-register': { label: 'Expected bills register', state: billCount ? 'passed' : 'needed', detail: billCount ? `${billCount} saved expected bill records are available. Confirm their property mappings and date basis before use.` : 'Add reviewed bill evidence and property mappings before accepting bill patterns.', nextAction: 'Open Desk → Expected bills.' },
    };
  },
});
const mailBindingRevision = () => createHash('sha256').update(JSON.stringify({ workspace: workspaceIdentity.id, profile: currentWorkerProfile().profile, connection: cfg.composio })).digest('hex');
const agencySetup = createAgencySetupService({ directory: DATA_DIR, workspaceId: workspaceIdentity.id, actorId: () => workspaceIdentity.id,
  // Verifying the agency's own private account is what starts bounded history
  // acquisition. Start and return: never await the collection here.
  onGmailVerified: event => { void mailWorkspace.startHistory(event); },
  checkGmail: async accountId => {
    const access = await refreshOfficeSources();
    if (!access.tools.available || !access.services.gmail?.connected || !access.services.gmail.accounts.some(a => a.id === accountId && /^active$/i.test(a.status))) throw Object.assign(new Error('This exact private Gmail source could not be verified.'), { status: 409 });
  },
  observe: async settings => {
    const access = connectedAppAccess.status(connectedAppsConfigured(cfg)), gmail = access.services.gmail;
    const direct = gmailReadOnlyMode(cfg) ? gmailReadOnlyBinding(cfg) : null;
    const sourceAllowed = (managedConnectorConfigured(cfg) || !!direct?.accountId) && !cfg.composio?.excludedApps?.includes('gmail');
    const accountId = managedConnectorConfigured(cfg) ? gmail?.accounts[0]?.id ?? null : direct?.accountId ?? null;
    const properties = desk.snapshot().properties.map(p => ({ id: p.id, label: p.address }));
    const recipeId = workflowRecipeId(settings.workflowPackId,'inbox-triage');
    const recipe = recipeId ? getRecipe(recipeId) : undefined, worker = applyHandsReadiness(await hermesStatus(),readHandsPing(DATA_DIR));
    let packBinding: string | null = null; try { if (recipe && settings.workflowPackId) packBinding = await customerPacks.packRecipeBinding(settings.workflowPackId,recipe.id); } catch { /* observable hold */ }
    const packReady = !!packBinding;
    const planReady = !!recipe && recipeClockRunnable(recipe) && worker.ready && packReady;
    const invoiceId = workflowRecipeId(settings.workflowPackId,'invoice-review');
    const invoiceRecipe = invoiceId ? getRecipe(invoiceId) : undefined;
    let invoiceBinding: string | null = null;
    try { if (invoiceRecipe && settings.workflowPackId) invoiceBinding = await customerPacks.packRecipeBinding(settings.workflowPackId,invoiceRecipe.id); } catch { /* observable hold */ }
    const billsReady = !!invoiceRecipe && recipeClockRunnable(invoiceRecipe) && worker.ready && !!invoiceBinding;
    const scan = (await mailWorkspace.get()).latestScan;
    return {
      gmail: { accounts: (gmail?.accounts ?? []).map(a => ({ id: a.id, label: a.label ?? 'Private Gmail account', status: /^active$/i.test(a.status) ? 'active' as const : 'unavailable' as const })), accountId,
        state: sourceAllowed && gmail?.connected && access.tools.available ? 'verified' as const : 'unverified' as const, checkedAt: access.checkedAt ? Date.parse(access.checkedAt) : null, bindingRevision: mailBindingRevision() },
      properties: { state: 'available' as const, revision: createHash('sha256').update(JSON.stringify(properties)).digest('hex'), items: properties },
      billRegister: { state: 'available' as const, count: listExpectedBills().length + sourceBills().counts().occurrences },
      mailHistory: await mailWorkspace.historyStatus(),
      workflows: {
        'bank-references': { state: 'available' as const, bindingRevision: 'bank-reference-source-v2', detail: 'The local bank reference review is available. Bank sign-in, export layout and REI acceptance remain separate checks.' },
        'bills-calendar': { state: billsReady ? 'available' as const : 'needs-review' as const,
          bindingRevision:createHash('sha256').update(JSON.stringify({recipe:invoiceRecipe ? [invoiceRecipe.id,invoiceRecipe.revision,invoiceRecipe.approvedRevision,invoiceRecipe.status] : null,invoiceBinding,register:1,reader:1})).digest('hex'),
          detail:billsReady ? 'The reviewed invoice plan, source collector and source-linked register are available. Staff accept bill facts and arrival patterns; unread attachments remain explicit gaps.' : 'Import the selected office pack, approve its invoice review plan and finish Bud setup. Source-linked bill records remain available for manual review.',
          ...(scan ? { sourceReceipt:{id:scan.id,capturedAt:scan.startedAt,state:scan.status === 'complete' ? 'complete' as const : scan.status === 'partial' ? 'partial' as const : 'held' as const,accountId:scan.accountId} } : {}),
        },
        'morning-priorities': { state: planReady ? 'available' as const : 'needs-review' as const, bindingRevision: createHash('sha256').update(JSON.stringify({ recipe: recipe ? [recipe.id,recipe.revision,recipe.approvedRevision,recipe.status] : null, packBinding, reader: 1 })).digest('hex'),
          detail: planReady ? 'The reviewed plan, private worker and source collector are available. Each run still checks account authority and records coverage.' : 'Import the office pack, approve the morning inbox plan and finish Bud setup before reviewing this workflow.',
          ...(scan ? { sourceReceipt: { id: scan.id, capturedAt: scan.startedAt, state: scan.status === 'complete' ? 'complete' as const : scan.status === 'partial' ? 'partial' as const : 'held' as const, accountId: scan.accountId } } : {}) },
      },
    };
  },
});
const mailWorkspace = createMailIngestionService({ directory: DATA_DIR, workspaceId: workspaceIdentity.id, key: Buffer.from(desk.recoveryKeyHex(),'hex'), workroomDirectory: join(DATA_DIR,'vault'), database: workflowDatabase,
  authorize: async purpose => {
    if (desk.recovery.active) throw Object.assign(new Error('The private book needs recovery.'), { status: 503 });
    await refreshOfficeSources();
    await checkWebsiteExecution();
    const ready = await agencySetup.assertWorkflowReady(purpose);
    if (!ready.settings.gmailAccountId) throw new Error('Choose and review the private Gmail source.');
    return { accountId: ready.settings.gmailAccountId, bindingRevision: createHash('sha256').update(`${mailBindingRevision()}:${ready.evidenceDigest}`).digest('hex'), settings: ready.settings, settingsRevision: ready.revision };
  },
  scan: async (authority, request, signal) => {
    await checkWebsiteExecution();
    const connectionRevision = mailBindingRevision();
    const assertAuthority = () => { signal.throwIfAborted(); if (mailBindingRevision() !== connectionRevision) throw new Error('Mail authority changed.'); };
    assertAuthority();
    if (managedConnectorConfigured(cfg)) return scanManagedMail(structuredClone(cfg), authority.accountId, request, signal);
    const binding = gmailReadOnlyMode(cfg) ? gmailReadOnlyBinding(cfg) : null;
    if (!binding || binding.accountId !== authority.accountId) throw new Error('The reviewed Gmail binding is unavailable.');
    return scanGmailReadOnly({ ...binding, assertAuthority }, request, signal);
  },
});
// Restore only the connection. An interrupted browser job always stays held.
const sourceBillRegisters = new WeakMap<ReturnType<typeof workflowDatabase>, SourceBillRegister>();
const billDraftStores = new WeakMap<ReturnType<typeof workflowDatabase>, BillReviewDraftStore>();
const billReviewApi = createBillReviewApi({
  drafts: () => {
    const database = workflowDatabase();
    let drafts = billDraftStores.get(database);
    if (!drafts) { drafts = new BillReviewDraftStore(database, { workspaceId: workspaceIdentity.id }); billDraftStores.set(database, drafts); }
    return drafts;
  },
  proposal: requestId => readBillProposal({ database: workflowDatabase, runs: () => jobRuns.list(), findRunByKey: key => jobRuns.getByIdempotencyKey(key) }, requestId),
  recovery: () => desk.recovery.active,
});
const sourceBills = () => {
  const database = workflowDatabase();
  let register = sourceBillRegisters.get(database);
  if (!register) { register = new SourceBillRegister(database,{dataDir:DATA_DIR}); sourceBillRegisters.set(database,register); }
  return register;
};
const billMailSource = async (itemId:string,messageId:string)=>{
  const saved=await mailWorkspace.source(itemId),message=saved.thread.messages.find(m=>m.id===messageId);
  if(!message) throw Object.assign(new Error('This message is unavailable in the saved conversation.'),{status:404});
  return {accountId:saved.accountId,receiptId:saved.receiptId,threadId:saved.thread.id,message};
};
const sourceBillsApi = createSourceBillsApi({ register:sourceBills, actorId:()=>workspaceIdentity.id, recovery:()=>desk.recovery.active,
  propertyIds:()=>desk.snapshot().properties.map(p=>p.id), collect:()=>mailWorkspace.collect('bills-calendar'),
  source:billMailSource,
  savedThread: async (accountId,threadId) => {
    const itemId = createHash('sha256').update(JSON.stringify([workspaceIdentity.id,accountId,threadId])).digest('hex');
    return { itemId, ...await mailWorkspace.source(itemId) };
  },
});
const billProposals = createBillProposals({database:workflowDatabase,workroom:join(DATA_DIR,'vault'),source:billMailSource,runs:()=>jobRuns.list(),findRunByKey:key=>jobRuns.getByIdempotencyKey(key),
  // Read the authoritative recipe registry synchronously as well: edits from
  // Ask, distillation and the clock bypass the HTTP recipe mutation door.
  epoch:()=>`${mailAuthorityEpoch}:${mailWorkspace.epoch}:${mailBindingRevision()}:${createHash('sha256').update(JSON.stringify(listRecipes())).digest('hex')}`,
  authorize:async()=>{
    if(desk.recovery.active) throw Object.assign(new Error('The private book needs recovery.'),{status:503});
    await refreshOfficeSources();
    const ready=await agencySetup.assertWorkflowReady('bills-calendar'),id=workflowRecipeId(ready.settings.workflowPackId,'invoice-review'),recipe=id?getRecipe(id):undefined;
    if(!recipe || !ready.settings.workflowPackId || !recipeClockRunnable(recipe)) throw Object.assign(new Error('Approve the invoice plan in the selected office pack.'),{status:409});
    const packBinding=await customerPacks.packRecipeBinding(ready.settings.workflowPackId,recipe.id);
    return {settings:ready.settings,evidenceDigest:ready.evidenceDigest,recipe,packBinding};
  },
  execute:(recipe,idempotencyKey,prepareInput)=>executeRecipeJob(recipe,{mode:'prepare',trigger:'manual',idempotencyKey},{readBookSnapshot:()=>desk.snapshot(),instructionContext:async id=>{
    const instructions=await customerPacks.instructionContext(id); await prepareInput(); return instructions;
  }}),
});
const departmentWork = createDepartmentWork({
  db: workflowDatabase(), client: companyHost.departmentExecution,
  forward: (session,path,body) => companyHost.handle(path,path==='/api/company/me'?'GET':'POST',{headers:{'x-realbud-member-session':session}},body),
  recipes: listRecipes, instructions: id=>customerPacks.instructionContext(id), assertRecipeReady: id=>customerPacks.assertReadyForRecipe(id),
  epoch:()=>`${websiteAuthorityEpoch}:${createHash('sha256').update(JSON.stringify(listRecipes())).digest('hex')}`,
  assertAdmission: () => {
    if (privateRestoreLocked || shuttingDown || workspaceActivity.paused || desk.recovery.active || loops?.recovery.active || jobRuns.recovery.active) throw Object.assign(new Error('Resolve workspace recovery or restart before department preparation.'),{status:409});
    managedService.assertCapability('reasoning');
  },
  runContext: work=>workspaceActivity.run(()=>withWorkerProfile(desk.memberKeyForWorker(),work)),
  findJob: key=>jobRuns.getByIdempotencyKey(key),
  execute: (recipe,idempotencyKey,dependencies)=>executeRecipeJob(recipe,{mode:'prepare',trigger:'manual',idempotencyKey},dependencies),
  ask: (prompt,opts,check)=>askDepartmentWorker(prompt,{...opts,beforeLaunch:check,beforeRequest:check}),
});
const websiteWork = createWebsiteWorkAdapters({
  workspaceId: workspaceIdentity.id, recipes: listRecipes,
  instructions: id => customerPacks.instructionContext(id), assertRecipeReady: id => customerPacks.assertReadyForRecipe(id),
  agency: () => agencySetup.get(), morningLoop: () => loops?.listLoops().find(loop=>loop.id==='inbound-triage'),
  authority: () => createHash('sha256').update(JSON.stringify({ config: cfg, profile: currentWorkerProfile().profile, worker: readHandsPing(DATA_DIR)?.workerFingerprint })).digest('hex'),
  revisionEpoch: () => websiteAuthorityEpoch,
  assertAdmission: () => {
    if (privateRestoreLocked || shuttingDown || desk.recovery.active || loops?.recovery.active || jobRuns.recovery.active) throw Object.assign(new Error('Resolve the current workspace recovery or restart before starting work.'), { status: 409 });
    managedService.assertCapability('reasoning');
  },
  bookRevision: () => desk.revision,
  runMorning: (requestId, expectedRevision) => loops!.runNow('inbound-triage', { requestId, expectedRevision }),
  findMorning: requestId => loops!.getRunByRequest(requestId), findJob: key => jobRuns.getByIdempotencyKey(key),
  execute: (recipe, idempotencyKey, beforeWorker, assertBook) => executeRecipeJob(recipe, { mode: 'prepare', trigger: 'manual', idempotencyKey }, {
    instructionContext: async () => { const instructions=await beforeWorker(); await checkWebsiteExecution(); return instructions; }, readBookSnapshot: () => { assertBook(); return desk.snapshot(); },
  }),
});
const remoteDisclosureReview=createRemoteDisclosureReview({db:workflowDatabase(),workspaceId:workspaceIdentity.id,capture:websiteWork.remoteDisclosure,catalog:websiteWork.getCatalog});
const websiteRequests = createWebsiteRequests({
  directory: DATA_DIR, db: workflowDatabase(), officeLink,
  identity: () => ({ workspaceId: workspaceIdentity.id, workerProfileKey: workspaceIdentity.workerMemberKey ?? null }),
  ...websiteWork,
  authority: () => createHash('sha256').update(JSON.stringify({ config: cfg, profile: currentWorkerProfile().profile, worker: readHandsPing(DATA_DIR)?.workerFingerprint })).digest('hex'),
  revisionEpoch: () => websiteAuthorityEpoch,
  requireRemoteScopes: scopes => remoteDisclosureReview.requireApproved(scopes),
  remoteTemplate: scope => remoteDisclosureReview.approvedTemplate(scope),
  refreshRemoteSources: async () => { await refreshOfficeSources(); },
  onRemoteEvidence: value => recordRemoteEvidence(workflowDatabase(),value),
  dispatch: execution => websiteRunContext.run(execution.requestId, () => websiteWork.dispatch(execution)),
  cancel: async run => {
    // Invalidates the actual in-flight collector; preparation already handed to
    // a worker retains its real running receipt until that worker settles.
    if (loops?.activeRun('inbound-triage')?.id === run.id) mailWorkspace.cancel();
  },
  withActivity: work => workspaceActivity.run(() => withWorkerProfile(desk.memberKeyForWorker(), work)),
  barrier: () => { if (privateRestoreLocked || shuttingDown) throw Object.assign(new Error('Website requests are paused for restore or restart.'), { status: 409 }); },
});
await websiteRequests.recover().catch(() => oplog('boot', 'Website request history needs recovery. Existing history was preserved.'));
// Private backups contain business data only. Restores replace a fresh
// installation's sample book, never merge onto an occupied workspace.
function assertPrivateBackupIdle(ignoreRequests = false) {
  if (desk.recovery.active || loops?.recovery.active) throw Object.assign(new Error('Resolve the existing recovery hold before backing up or restoring private work.'),{status:503});
  // Name what is still running, so the person knows what to wait for.
  const busy =
    !ignoreRequests && privateBackupRequests > 0 ? 'the other workspace change in progress' :
    store.bots.some(bot=>bot.busy || bot.queuedMessage) ? 'Bud to finish its current reply' :
    mailWorkspace.busy ? 'mail collection' :
    deskCheckFlight.running() ? 'the Desk check' :
    websiteRequests.busy ? 'the website request in progress' :
    departmentWork.busy ? 'department work' :
    jobRuns.list().some(run=>run.status==='running'||run.status==='queued') ? 'the running or queued job' :
    batches.list().some(batch=>batch.status==='running') ? 'the running batch' :
    loops?.busy ? 'the scheduled routine' :
    installInFlight() ? 'Bud setup' : null;
  if (busy) throw Object.assign(new Error(`Wait for current work and setup to finish (${busy}), then retry the private backup action.`),{status:409});
}
function privateRestoreReadiness() {
  const bootstrap = process.env.REALBUD_RESTORE_BOOTSTRAP === '1';
  try {
    if (!bootstrap) throw new Error('Start this installation through the RealBud desktop service before restoring.');
    const book=desk.snapshot();
    if (!companyHost.privateRestoreFresh || desk.recovery.active || book.mode !== 'demo' || book.revision !== 1 || workflowDatabase().hasRecords() ||
        listRecipes().length || jobRuns.list().length || batches.list().length || loops?.listRuns().length)
      throw new Error('Restore requires a fresh workspace with only its untouched sample book. Existing private work is kept.');
    for (const name of ['agency-setup.json','workspace-views/tabs.json','customer-packs.json','expected-bills.json','office-link/link.json','website-requests/grant.json','website-requests/remote-approvers.json','website-requests/remote-work.json'])
      if (existsSync(join(DATA_DIR,name))) throw new Error('This workspace already has business settings or records. Restore on a fresh installation.');
    const companyDirectory=join(DATA_DIR,'company-installation');
    if (readdirSync(companyDirectory).some(name=>!['workspace.json','private'].includes(name)) ||
        existsSync(join(companyDirectory,'private')) && readdirSync(join(companyDirectory,'private')).length)
      throw new Error('This installation has company membership or private evidence. Restore on a fresh installation.');
    for (const directory of ['properties','owners','decisions','workflow-inputs','workflow-support']) {
      const path=join(DATA_DIR,'vault',directory);
      if (existsSync(path) && readdirSync(path).length) throw new Error('This workspace has private notes or workflow instructions. Restore on a fresh installation.');
    }
    for (const [name,expected] of Object.entries(DEFAULT_VAULT_DOCUMENTS)) {
      const path=join(DATA_DIR,'vault',name);
      if (!existsSync(path) || readFileSync(path,'utf8') !== expected) throw new Error('This workspace has edited personal or office instructions. Restore on a fresh installation.');
    }
    return {canRestore:!privateRestoreLocked,reason:privateRestoreLocked?'A restore is staged. Restart the RealBud service to finish.':'A reviewed backup can replace the untouched sample book.',bootstrap};
  } catch(error) {return {canRestore:false,reason:error instanceof Error?error.message:'Existing workspace storage needs review.',bootstrap};}
}
function assertPrivateBackupFresh() {
  // The API sets the write barrier before the domain's async preparation. The
  // barrier is not itself occupied data and must not invalidate its own check.
  const locked=privateRestoreLocked;
  try { privateRestoreLocked=false; const state=privateRestoreReadiness(); if(!state.canRestore) throw Object.assign(new Error(state.reason),{status:409}); }
  finally {privateRestoreLocked=locked;}
}
const privateBackupEpochValue = () => `${privateBackupEpoch}:${mailAuthorityEpoch}:${mailWorkspace.epoch}:${desk.revision}:${createHash('sha256').update(JSON.stringify(listRecipes())).digest('hex')}`;
async function privateBackupSnapshotLease() {
  assertPrivateBackupIdle(true);
  if (privateRestoreLocked || shuttingDown) throw Object.assign(new Error('Finish the staged restore or service restart before creating a backup.'), { status: 409 });
  loops?.stop();
  try {
    const lease = await workspaceActivity.pause({ timeoutMs: 60_000, onReleased: () => { if (!privateRestoreLocked && !shuttingDown) loops?.start(); } });
    try {
      // Existing read requests may still be finishing when the UI starts an
      // export. The pause rejects new reads; drain admitted ones before capture.
      const deadline = Date.now() + 60_000;
      while (privateBackupRequests > 0) { lease.assertCurrent(); if (Date.now() >= deadline) throw Object.assign(new Error('Current workspace requests did not finish.'), { status: 409 }); await new Promise(resolve => setTimeout(resolve, 20)); }
      assertPrivateBackupIdle(); lease.assertCurrent(); return lease;
    }
    catch (error) { lease.release(); throw error; }
  } catch (error) { if (!workspaceActivity.paused && !privateRestoreLocked && !shuttingDown) loops?.start(); throw error; }
}
function beginPrivateRestore() {
  if (privateRestoreLocked) return;
  assertPrivateBackupIdle(); assertPrivateBackupFresh();
  privateRestoreLocked=true; loops?.stop(); officeLink.stop(); websiteRequests.stop(); departmentWork.stop();
  stopTelegramBridge(); stopDiscordBridge(); stopSlackBridge(); stopRemoteDecisionFlush();
}
const legacyPrivateBackup = createPrivateWorkspaceBackup({directory:DATA_DIR,key:()=>Buffer.from(desk.recoveryKeyHex(),'hex'),workspaceId:workspaceIdentity.id,
  epoch:privateBackupEpochValue,assertIdle:assertPrivateBackupIdle,assertFresh:assertPrivateBackupFresh,snapshotLease:privateBackupSnapshotLease});
let privateBackupCoordinator: Awaited<ReturnType<typeof createPrivateBackupCoordinator>> | undefined;
try {
  privateBackupCoordinator = await createPrivateBackupCoordinator({directory:DATA_DIR,key:Buffer.from(desk.recoveryKeyHex(),'hex'),workspaceId:workspaceIdentity.id,
    epoch:privateBackupEpochValue,assertIdle:assertPrivateBackupIdle,assertFresh:assertPrivateBackupFresh,snapshotLease:privateBackupSnapshotLease,beginRestore:beginPrivateRestore,
    ...(process.env.REALBUD_TEST_LAB === '1' ? { diagnostic: (event: unknown) => console.error('Backup test diagnostic', JSON.stringify(event)) } : {})});
} catch { oplog('boot','Backup transfer storage requires recovery. Existing files were preserved.'); }
const privateBackup = privateBackupCoordinator ? withDurablePrivateBackupRestore(legacyPrivateBackup,privateBackupCoordinator) : legacyPrivateBackup;
const privateBackupApi=createPrivateBackupApi({service:()=>privateBackup,restoreReadiness:privateRestoreReadiness,
  snapshotActive:()=>workspaceActivity.paused,
  // The durable coordinator establishes the sticky barrier only after fully
  // preparing the reviewed archive. The old JSON API uses that same path.
  beginRestore:()=>{assertPrivateBackupIdle();assertPrivateBackupFresh();},
  restoreFailed:async()=>{},
});
void browserRuntime.resumeConnection().catch(() => {});
server.listen(PORT, "127.0.0.1", () => {
  if (!privateRestoreLocked) loops?.start();
  // An approved window that was never confirmed is still missing coverage, so a
  // restart continues the saved checkpoint under its own authority re-check. It
  // reads nothing when no window is pending.
  if (!privateRestoreLocked) void mailWorkspace.resumeHistoryIfPending().catch(() => {});
  console.log(`realbud server on http://127.0.0.1:${PORT}`);
  oplog("boot", `listening on 127.0.0.1:${PORT}`);
  setWorkerIssueListener((issue) => broadcast({ kind: "worker.issue", issue }));
  // A renderer/server restart must not silently drop a follow-up the user
  // already scheduled. Claim and resume each durable slot once at boot.
  for (const bot of store.bots) {
    if (privateRestoreLocked || bot.busy || !bot.queuedMessage) continue;
    const queued = store.takeQueuedMessage(bot.id, bot.queuedMessage.threadId);
    if (queued) void dispatchQueuedMessage(bot.id, queued);
  }
  if (!process.env.VITEST && !privateRestoreLocked) {
    startTelegramBridge();
    startDiscordBridge();
    startSlackBridge();
    startRemoteDecisionFlush();
    void withWorkerProfile(desk.memberKeyForWorker(), healHandsReadiness);
    officeLink.start();
    websiteRequests.start();
    departmentWork.start();
  }
});

// Private parent/child IPC lets the synthetic kit request orderly shutdown on
// Windows, where Node's process.kill does not deliver POSIX signal handlers.
if (process.env.REALBUD_TEST_LAB === "1" && process.send) {
  process.on("message", (message: unknown) => {
    if (message && typeof message === "object" && (message as { type?: string }).type === "realbud-test-stop") process.emit("SIGTERM");
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    workspaceActivity.cancelPause();
    oplog("shutdown", signal);
    officeLink.stop();
    websiteRequests.stop();
    departmentWork.stop();
    stopTelegramBridge();
    stopDiscordBridge();
    stopSlackBridge();
    stopRemoteDecisionFlush();
    loops?.stop();
    batches.stop();
    watchdog.stop();
    cancelBootstrapInstall();
    void Promise.allSettled([registry.disposeAll(), waitForBootstrapStop(), departmentWork.drain().finally(()=>companyHost.close()), browserRuntime.shutdown(), privateBackupCoordinator?.close(), memoryReviews.close()]).finally(() => process.exit(0));
  });
}

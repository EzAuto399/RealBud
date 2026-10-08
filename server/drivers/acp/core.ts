// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped.
import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { stripServiceSecrets } from "../../service-child-env.ts";
import { managedService } from "../../managed-service.ts";
import { createAskModelRelayLease, type AskModelRelayLease } from "../../ask-model-relay.ts";

import type {
  ApprovalCardDetails,
  DriverCreateInput,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath } from "../../env-path.ts";
import { CUA_NEVER_TOOLS } from "../../cua-bounded.ts";
import { BROWSER_SERVER, startBrowserBroker, type BrowserBroker } from "../../browser-broker.ts";
import { DESKTOP_SERVER, startDesktopBroker, type DesktopBroker, type DesktopDecisions } from "../../desktop-broker.ts";
import { browserRuntime } from "../../browser-runtime.ts";
import { askBrowserRuntime, askPortalPackLoader } from "../../ask-browser-lab.ts";
import { portalMapForSites } from "../../portal-recipe-task.ts";
import { portalRecipeControls } from "../../portal-recipe-runner.ts";
import { browserApprovalCardFrom } from "../../browser-approval-card.ts";
import type { BrowserApprovalCard } from "../../../shared/browser-approval-card.ts";
import { BROWSER_LEGACY_JOB_ORIGIN } from "../../../shared/browser-task.ts";
import { startMemoryProposalBroker } from "../../hermes-memory-proposal-broker.ts";
import type { ApprovalResolution } from "../../approval-answer.ts";
import { CONNECTED_APP_APPROVAL, OFFICE_MAIL_SERVER, connectedAppsBrokerGeneration, startConnectedAppsBroker, type ConnectedAppsBroker } from "../../connected-apps-broker.ts";
import { createGmailReadOnlyTransport } from "../../composio-gmail.ts";
import { startWebResearchBroker, WEB_RESEARCH_SERVER, type LoopbackToolServer } from "../../web-research-broker.ts";
import { SIGN_IN_SERVER, startSignInBroker } from "../../browser-sign-in.ts";
import { HERMIOS_CRM_SERVER, startHermiosCrmBroker } from "../../hermios-crm-broker.ts";
import { REMINDERS_SERVER, startRemindersBroker } from "../../reminders-broker.ts";
import { WORKSPACE_VIEWS_SERVER, startWorkspaceViewsBroker } from "../../workspace-views-broker.ts";
import { WORKFLOW_SETTINGS_SERVER, startWorkflowSettingsBroker } from "../../workflow-settings-broker.ts";
import { BANK_SOURCE_SERVER, startBankSourceBroker } from "../../bank-source-broker.ts";
import { DECIDE_SERVER, startDecideBroker } from "../../decide-broker.ts";
import { MCP_CONNECTORS_SERVER, startMcpConnectorBroker } from "../../mcp-connector-broker.ts";
import { toolFingerprint } from "../../tool-fingerprint.ts";
import { HERMES_MEMORY_APPROVAL, hermesMemoryPermission } from "./hermes-memory-approval.ts";
import { productTurnWrapUp } from "../../product-mode.ts";
import { classifyWorkroomCommand, shellWords } from "../../workroom-command-policy.ts";
/** Off until the worker cannot reach the network and the classifier fixes from the 2 Oct review land
 * (docs/decisions/2026-10-02-workroom-script-approvals.md). Every terminal approval keeps its card. */
const WORKROOM_AUTO_APPROVE = false;
import { ownedRuntimeHome } from "../../hermes-document-deps.ts";
import { vaultDir } from "../../vault.ts";

const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
const READ_PROGRAMS = new Set(["cat", "head", "wc", "ls"]);
import { appendNative } from "../native.ts";
import { NETWORK_ISOLATION_UNAVAILABLE, startBrokerPortPool, stopSandboxedChildren, trackSandboxedChild, WORKERS_HELD, workerLaunchesHeld, type BrokerPortPool } from "../../worker-network-sandbox.ts";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  displayName: string;
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /**
   * Which worker profile this execution runs as.
   *
   * Omitted means the shared base profile — correct for a single-seat install,
   * and the only behaviour that existed before per-seat isolation. A multi-seat
   * office host supplies a resolver that reads the *authenticated* seat, so one
   * seat's memory, skills store and session database are never shared with
   * another (see `server/hermes-profile.ts`).
   *
   * The resolver is configured when the driver is constructed, never per
   * request: a caller must not be able to name its own profile.
   */
  workerProfile?(config: AcpConfig, turn: SendTurnInput): string;
  /** Mutate the child env in place (e.g. strip a key). Optional. */
  transformEnv?(env: Record<string, string | undefined>): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if auth is missing/errors (subscription CLIs).
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** snapshot(): is the CLI signed in? (env already carries the merged config) */
  isAuthenticated(env: Record<string, string | undefined>): boolean;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Child-created files default to owner-only inside a private workroom. */
  privateWorkspace?: boolean;
  /** Some ACP servers only keep sessions inside the live stdio process. For
   * those servers, loading a cursor in a new process can never work and only
   * adds a long failed round trip. */
  resumeAcrossProcesses?: boolean;
  /** Optional conservative session mode applied after session/new or load.
   * Failure is non-fatal: the provider keeps its manual approval defaults. */
  defaultSessionMode?: string;
  /** Wrap the worker launch so it reaches only these loopback ports (the
   * broker port pool, plus any the support adds) and writes only its own
   * folders; throws to refuse the launch. A `diagnostic` launch (`--version`)
   * gets no network and writes nothing. When set, every loopback broker is
   * mounted through a pool port bound at driver creation
   * (server/worker-network-sandbox.ts). `release` is called once the process
   * ended. */
  networkSandbox?(command: string, args: string[], env: Record<string, string | undefined>, loopbackPorts: number[], job?: "ask" | "diagnostic"): { command: string; args: string[]; release?(): void };
}

const INIT_TIMEOUT = 20_000;
/** A stopped worker that ignores SIGTERM is killed after this. */
const STOP_DEADLINE_MS = 5_000;
const NEW_SESSION_TIMEOUT = 30_000;
const LOAD_SESSION_TIMEOUT = 120_000; // history replay on a long thread is slow
const SESSION_MODE_TIMEOUT = 5_000;
const CANCEL_GRACE_MS = 2_000;
const WARM_SESSION_IDLE_MS = 10 * 60_000;
/** Every RealBud review card closes (as a deny) before the worker stops
 * waiting for it. Hermes waits 300 s for an ACP permission answer (0.21.5
 * reads the pack's `approvals.timeout: 300`; 0.21.3 waits a fixed 60 s and
 * self-denies) and 300 s for an MCP tool call, which carries the
 * connected-app and browser cards (tools/mcp_tool_common.py
 * `_DEFAULT_TOOL_TIMEOUT`, both versions). A longer card could take an answer
 * the worker no longer waits for, or let a broker act after Hermes reported
 * the call failed; the margin lets the deny arrive first. */
export const WORKER_APPROVAL_CARD_MS = 285_000;
/** When a card opened now stops waiting. */
const approvalDeadline = () => new Date(Date.now() + WORKER_APPROVAL_CARD_MS).toISOString();

/** Running desktop task brokers by run: Stop, the run's end and the global browser Stop end each driver session. */
const liveDesktopBrokers = new Map<DesktopBroker, string>();
function stopDesktopBroker(broker: DesktopBroker | undefined): Promise<void> {
  if (!broker) return Promise.resolve();
  liveDesktopBrokers.delete(broker);
  return broker.stop().catch(() => undefined);
}
/** The global Stop (releaseComputerControl, /api/browser/stop) ends every desktop task's driver session; a task's end, its run's. */
export async function releaseDesktopBrokers(runId?: string): Promise<void> {
  await Promise.all([...liveDesktopBrokers].filter(([, run]) => runId === undefined || run === runId).map(([broker]) => stopDesktopBroker(broker)));
}
const MAX_WARM_SESSIONS = 8;

type AcpStdioMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};
type AcpHttpMcpServer = {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
};
type AcpMcpServer = AcpStdioMcpServer | AcpHttpMcpServer;

/** A call to RealBud's work browser or sign-in server, by the name Hermes ACP puts first in a tool call's title:
 * mcp__<server>__<tool>, or mcp_<server>_<tool> in older releases ("sign-in" is written sign_in). Its arguments carry
 * page addresses, field values and file names, so no sink but the local card and approval record sees them. */
const PAGE_TOOL = new RegExp(`^\\s*mcp__?(?:${BROWSER_SERVER}|${DESKTOP_SERVER}|${SIGN_IN_SERVER.replace("-", "[-_]")})__?([a-z\\d_]*)`, "i");
const PAGE_TOOL_LABEL: Record<string, string> = {
  browser_tabs: "Checked the open tabs", browser_borrow: "Borrowed a tab", browser_read: "Read a page",
  browser_navigate: "Opened a page", browser_fill: "Filled a field", browser_click_semantic: "Clicked a control",
  browser_press: "Pressed a key", browser_select: "Chose an option", browser_download: "Downloaded a file",
  browser_upload: "Uploaded a file", browser_release: "Stopped browser work", open_for_sign_in: "Opened the sign-in page",
  // workdesktop (an app window): typed text and control ids stay out of every log, as for the browser.
  get_window_state: "Read the app window", pick_control: "Asked which control to use", click: "Pressed a control", type_text: "Typed into a field",
  scroll: "Scrolled the window", press_key: "Pressed a key", release: "Stopped app work",
};
const pageTool = (title: unknown): string | null => typeof title === "string" ? PAGE_TOOL.exec(title)?.[1]?.toLowerCase() ?? null : null;
/** A page tool call's title for the event log and the Work activity line: a fixed label per tool, never its arguments. */
const pageToolLabel = (tool: string): string => PAGE_TOOL_LABEL[tool] ?? "Used the work browser";
/** A page tool call (a start, update or permission request) as the private native log keeps it: the tool name and its
 * argument keys, no values, content or output (screenshots included). Hermes sends a tool_call_update without a title,
 * so `pageCalls` remembers each page call's id from its start until it completes. Every other message is unchanged. */
function withoutPageToolValues(message: any, pageCalls: Map<string, string>): any {
  const key = message?.params?.update ? "update" : message?.params?.toolCall ? "toolCall" : null;
  const call = key ? message.params[key] : null;
  const id = typeof call?.toolCallId === "string" ? call.toolCallId : null;
  const tool = pageTool(call?.title) ?? (id !== null ? pageCalls.get(id) ?? null : null);
  if (tool === null) return message;
  if (id !== null) { if (call.status === "completed" || call.status === "failed") pageCalls.delete(id); else pageCalls.set(id, tool); }
  const { sessionUpdate, toolCallId, kind, status, rawInput } = call;
  const argumentKeys = rawInput && typeof rawInput === "object" ? Object.keys(rawInput) : [];
  return { ...message, params: { ...message.params, [key!]: { sessionUpdate, toolCallId, kind, status, tool, argumentKeys } } };
}

/** Hermes' own browser and credential-vault tools (`browser_navigate`,
 * `browser_vault_fill`, …), named by the leading tool name Hermes ACP puts in a
 * tool call's title (acp_adapter/tools.py `build_tool_title`) or by an explicit
 * name field. RealBud's fenced browser reaches Hermes as MCP tools
 * (`mcp__workbrowser__…`), which never match. The profile policy and worker
 * environment keep these tools from being offered; this is the backstop. */
export function hermesNativeBrowserTool(...values: unknown[]): string | null {
  for (const value of values) {
    const match = typeof value === "string" ? /^\s*(browser_[a-z0-9_]+)(?![a-z0-9_])/i.exec(value) : null;
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/** A Cua tool Bud never runs (`CUA_NEVER_TOOLS`), named by the leading tool
 * name in a title or an explicit name field, bare or behind an MCP server
 * prefix (`mcp_computer_…`, `mcp__computer__…`, `computer.…`), also after a
 * spaced label (`Tool: computer/install_extension`). Checked for
 * every engine and every turn, fenced or not, before any auto-approval. */
// Linear on purpose: a title is model-influenced text, so no nested repeats.
// Only the bare name or the Cua `computer` server's own prefixes count: another
// server's tool that shares a name (a meeting app's `start_recording`) is not Cua.
const CUA_SERVER_PREFIXES = ["", "mcp__computer__", "mcp_computer_", "computer.", "computer/", "computer:", "computer__", "computer_"];
export function cuaNeverTool(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const head = value.trimStart().replace(/^[a-z][a-z ]{0,30}:\s+/i, "");
    const token = (/^[a-z0-9_./:-]+/i.exec(head)?.[0] ?? "").toLowerCase().replace(/[./:]+$/, "");
    for (const name of CUA_NEVER_TOOLS) {
      for (const prefix of CUA_SERVER_PREFIXES) {
        if (token === prefix + name || token.startsWith(prefix + name + ".")) return name;
      }
    }
  }
  return null;
}
export const CUA_EXTENSION_REFUSED =
  "Bud tried to install, update or reconfigure the desktop helper, or use its screen-reading extension, which RealBud does not allow, so this request was stopped.";

/** Model-visible wrap-up note for a Hermes Ask turn nearing RealBud's hard
 * call/time ceiling. Delivered through Hermes ACP's own `/steer` command,
 * which appends it to the next tool result without interrupting the turn. */
export const HERMES_WRAP_UP_NOTE =
  "RealBud: this request is close to its work limit and will be stopped soon. Do not start new searches, files or other tool calls. Reply now with what you have so far, say plainly what is unfinished, and what the person could ask next.";
const WRAP_UP_TIMEOUT = 10_000;
/** Hermes answers `/steer` with a short status line on the same session
 * stream (acp_adapter/commands.py `_cmd_steer`); it is not Bud's answer. */
const HERMES_STEER_ACK = /^\s*(?:⏩ Steer queued for the active turn:|⚠️ Steer failed:|No active turn — queued for the next turn\.)/u;

/** Hermes' own failed-turn copy (agent/turn_failure_copy.py) arrives as one
 * whole assistant message naming the engine or provider, slash commands,
 * `hermes …` hints and a raw "Provider said:"/"Details:" line. The person sees
 * plain words instead; the raw chunk stays in the private native log. A
 * model's streamed chunk is a few words, so the length floor keeps an answer
 * that merely mentions such a word from being replaced. */
const HERMES_FAILURE_COPY = /(?:^|[\s(])\/(?:retry|model|new|reasoning)\b|`hermes [a-z]|\n\n(?:Provider said|Details): /u;
export const ENGINE_FAILURE_REPLY =
  "Bud couldn't finish this step because the AI service ran into a problem. Try again, or tell me if it keeps happening.";
export function plainEngineFailure(delta: string): string | null {
  return delta.length >= 80 && HERMES_FAILURE_COPY.test(delta) ? ENGINE_FAILURE_REPLY : null;
}

export const HERMES_BROWSER_REFUSED =
  "Bud tried to use a web browser of its own, which RealBud does not allow, so this request was stopped. Website work runs in RealBud’s browser, where you sign in yourself.";

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "RealBud: nobody answered this permission request in time. Skip this action and finish what you can without it.";

  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: support.displayName, supportsMultipleInstances: true },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const listeners = new Set<RuntimeEventListener>();
      // Bound once, before any worker, so a sandbox profile can name the ports.
      // A failed bind refuses sandboxed launches below; never an open fallback.
      const brokerPorts: BrokerPortPool | null = support.networkSandbox ? await startBrokerPortPool().catch(() => null) : null;
      interface ActiveTurn {
        stop: () => void;
        interrupt: () => Promise<void>;
        turnId: string;
        asks: Map<string, (decision: { behavior: string; scope?: "once" | "session" }) => void>;
      }
      interface SessionRuntime {
        signature: string;
        lastUsed: number;
        resume: (turn: SendTurnInput, first?: boolean) => string;
        /** Stops the process and resolves once it has exited (SIGKILL after a deadline). */
        stop: () => Promise<void>;
      }
      interface RunningTurn {
        turn: SendTurnInput;
        turnId: string;
        text: string;
        /** Assistant text after the latest tool call — preferred final reply. */
        answerText: string;
        sawTool: boolean;
        promptSent: boolean;
        settled: boolean;
        cancellationRequested: boolean;
        asks: Map<string, (decision: { behavior: string; scope?: "once" | "session" }) => void>;
        interruptTimer: ReturnType<typeof setTimeout> | null;
        startedAt: number;
        /** Tool calls seen this turn, for the wrap-up note only. */
        toolCount: number;
        wrapUpTimer: ReturnType<typeof setTimeout> | null;
        wrapUpSent: boolean;
        /** Hermes' one status line answering the wrap-up `/steer`. */
        steerAckPending: boolean;
        /** ACP's token counts for this turn, when the agent reported them. */
        tokens?: { input?: number; output?: number };
        done: Promise<void>;
        resolveDone: () => void;
      }
      const active = new Map<string, ActiveTurn>();
      const warm = new Map<string, SessionRuntime>();
      const sessions = new Set<SessionRuntime>();

      const emit = (event: RuntimeEvent) => {
        for (const listener of [...listeners]) listener(event);
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      const childEnv = () => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        delete env.COMPOSIO_KEY;
        delete env.COMPOSIO_API_KEY;
        delete env.REALBUD_CUA_CONTROL_TOKEN;
        delete env.REALBUD_CUA_CONTROL_URL;
        delete env.REALBUD_DESK_KEY;
        stripServiceSecrets(env);
        support.transformEnv?.(env);
        return env;
      };

      const acpMcpServers = (turn: SendTurnInput): AcpMcpServer[] => {
        const servers: AcpMcpServer[] = [];
        if (DRIVER_KIND === "hermesAgent" && turn.integrations?.memoryProposals) {
          const capability = turn.integrations.memoryProposals;
          if (typeof capability.scope !== "string" || !capability.scope || capability.scope.length > 4096 || typeof capability.propose !== "function") {
            throw new Error("Bud’s memory proposal scope is unavailable. Start a new request.");
          }
          servers.push({ type: "http", name: "memory-proposals", url: "http://127.0.0.1/realbud-memory-proposals", headers: [] });
        }
        // A desktop task mounts workdesktop INSTEAD of the browser, and never a raw computer server beside it.
        if (turn.integrations?.desktop && turn.integrations.browser) throw new Error("This task cannot use an app window and a browser together. Start it again.");
        if (turn.integrations?.desktop) servers.push({ type: "http", name: DESKTOP_SERVER, url: "http://127.0.0.1/realbud-desktop", headers: [] });
        if (turn.integrations?.browser) servers.push({ type: "http", name: BROWSER_SERVER, url: "http://127.0.0.1/realbud-browser", headers: [] });
        // Replaced with private loopback brokers before session/new or load.
        const pages = turn.integrations?.webPages;
        if (pages && (!Array.isArray(pages.allowedUrls) || pages.allowedUrls.length > 200 || pages.allowedUrls.some(url => typeof url !== "string" || url.length > 2048))) {
          throw new Error("Bud’s page reader is unavailable. Start a new request.");
        }
        if (pages) servers.push({ type: "http", name: WEB_RESEARCH_SERVER, url: "http://127.0.0.1/realbud-web-pages", headers: [] });
        const signIn = turn.integrations?.signIn;
        if (signIn && (!Array.isArray(signIn.personUrls) || !Array.isArray(signIn.approvedSites) || signIn.personUrls.length > 200 || signIn.approvedSites.length > 200 ||
          [...signIn.personUrls, ...signIn.approvedSites].some(url => typeof url !== "string" || url.length > 2048))) throw new Error("Bud’s sign-in helper is unavailable. Start a new request.");
        if (signIn) servers.push({ type: "http", name: SIGN_IN_SERVER, url: "http://127.0.0.1/realbud-sign-in", headers: [] });
        const reminders = turn.integrations?.reminders;
        if (reminders) {
          if (typeof reminders.create !== "function" || typeof reminders.timeZone !== "function") throw new Error("Bud’s reminders are unavailable. Start a new request.");
          servers.push({ type: "http", name: REMINDERS_SERVER, url: "http://127.0.0.1/realbud-reminders", headers: [] });
        }
        const views = turn.integrations?.workspaceViews;
        if (views) {
          if (typeof views.read !== "function" || typeof views.save !== "function") throw new Error("Bud’s saved views are unavailable. Start a new request.");
          servers.push({ type: "http", name: WORKSPACE_VIEWS_SERVER, url: "http://127.0.0.1/realbud-workspace-views", headers: [] });
        }
        const workflowSettings = turn.integrations?.workflowSettings;
        if (workflowSettings) {
          if (typeof workflowSettings.read !== "function" || typeof workflowSettings.check !== "function" || typeof workflowSettings.save !== "function") throw new Error("Bud’s working rules are unavailable. Start a new request.");
          servers.push({ type: "http", name: WORKFLOW_SETTINGS_SERVER, url: "http://127.0.0.1/realbud-workflow-settings", headers: [] });
        }
        const bank = turn.integrations?.bankSource;
        if (bank) {
          if (typeof bank.listBankAccounts !== "function" || typeof bank.listBankTransactions !== "function") throw new Error("Bud’s bank feed is unavailable. Start a new request.");
          servers.push({ type: "http", name: BANK_SOURCE_SERVER, url: "http://127.0.0.1/realbud-bank-source", headers: [] });
        }
        const decisions = turn.integrations?.decisions;
        if (decisions) {
          if (typeof decisions.decide !== "function" || typeof decisions.ready !== "function" || typeof decisions.sameMember !== "function") throw new Error("Bud’s typed decisions are unavailable. Start a new request.");
          servers.push({ type: "http", name: DECIDE_SERVER, url: "http://127.0.0.1/realbud-decisions", headers: [] });
        }
        const officeConnectors = turn.integrations?.mcpConnectors;
        if (officeConnectors) {
          // The broker lists at most 100; a larger list is cut there, never a reason to stop Ask.
          if (!Array.isArray(officeConnectors.tools) || typeof officeConnectors.invoke !== "function" ||
            typeof officeConnectors.toolClass !== "function") throw new Error("Bud’s office connectors are unavailable. Start a new request.");
          if (officeConnectors.tools.length) servers.push({ type: "http", name: MCP_CONNECTORS_SERVER, url: "http://127.0.0.1/realbud-office-connectors", headers: [] });
        }
        const crm = turn.integrations?.hermiosCrm;
        if (crm) {
          if (typeof crm.scope !== "string" || !crm.scope || crm.scope.length > 4096 || !Number.isSafeInteger(crm.generation) || crm.generation < 1 ||
            typeof crm.accessToken !== "function") throw new Error("Bud’s Hermios connection is unavailable. Start a new request.");
          servers.push({ type: "http", name: HERMIOS_CRM_SERVER, url: "http://127.0.0.1/realbud-hermios-crm", headers: [] });
        }
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            type: "http",
            name: "connected-apps",
            // Replaced with the private broker before session/new or load.
            url: composio.gmailReadOnly ? "http://127.0.0.1/realbud-gmail-readonly" : composio.url || "https://backend.composio.dev/v3/mcp",
            headers: composio.gmailReadOnly ? [] : Object.entries(composio.headers ?? { "x-api-key": composio.key })
              .map(([name, value]) => ({ name, value: String(value) })),
          });
        }
        const officeMail = turn.integrations?.officeMail;
        if (officeMail) {
          // Replaced with its own private broker before session/new or load.
          servers.push({ type: "http", name: OFFICE_MAIL_SERVER, url: officeMail.url, headers: Object.entries(officeMail.headers).map(([name, value]) => ({ name, value: String(value) })) });
        }
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const computer = turn.integrations?.computer;
        const workTask = turn.integrations?.browser || turn.integrations?.desktop;
        if (computer && !workTask) {
          servers.push({
            name: "computer",
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(computer) }),
          });
        } else if (turn.integrations?.localComputer && !workTask) {
          const local = turn.integrations.localComputer;
          servers.push({ name: "computer", command: local.command, args: local.args, env: acpEnv(local.env ?? {}) });
        }
        return servers;
      };

      const signatureFor = (cwd: string, args: string[], mcpServers: AcpMcpServer[], composio?: NonNullable<SendTurnInput["integrations"]>["composio"], memoryScope?: string,
        hermiosCrm?: NonNullable<SendTurnInput["integrations"]>["hermiosCrm"]) =>
        createHash("sha256").update(JSON.stringify({ cli: config.cli, cwd, args, mcpServers,
          ...(mcpServers.some(server => server.name === "memory-proposals") ? { memoryScope } : {}),
          // A CRM mount is bound to one member and one connection generation.
          ...(mcpServers.some(server => server.name === HERMIOS_CRM_SERVER) ? { hermiosScope: hermiosCrm?.scope, hermiosGeneration: hermiosCrm?.generation } : {}),
          ...(composio?.allowedApps ? { allowedApps: composio.allowedApps } : {}),
          ...(composio?.gmailReadOnly ? { gmailReadOnly: composio.gmailReadOnly, appKey: composio.key } : {}),
          ...(mcpServers.some(server => server.name === "connected-apps" || server.name === OFFICE_MAIL_SERVER) ? { appGeneration: connectedAppsBrokerGeneration() } : {}),
        })).digest("hex");

      const replayOnFreshSession = (turn: SendTurnInput): SendTurnInput => {
        const transcript = turn.transcript ?? [];
        if (!transcript.length || turn.text.startsWith("[The user rewound this conversation")) return turn;
        return {
          ...turn,
          text: [
            "[RealBud restored this conversation after the worker restarted:]",
            "",
            ...transcript.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`),
            "",
            "[Latest user request:]",
            "",
            turn.text,
          ].join("\n"),
        };
      };

      const createRuntime = (
        firstTurn: SendTurnInput,
        cwd: string,
        args: string[],
        mcpServers: AcpMcpServer[],
        signature: string,
        modelLease?: AskModelRelayLease,
      ): SessionRuntime => {
        const { threadId } = firstTurn;
        const env = childEnv();
        // The runtime whose venv/bin hardenHermesChildEnv put first on PATH.
        const runtimeHome = DRIVER_KIND === "hermesAgent" ? ownedRuntimeHome(env.HERMES_HOME) : null;
        if (support.networkSandbox && !brokerPorts) throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
        const launch = support.networkSandbox ? support.networkSandbox(config.cli, args, env, brokerPorts!.ports) : { command: config.cli, args };
        const child = spawnCli(launch.command, launch.args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          privateFiles: support.privateWorkspace === true,
        });
        if (support.networkSandbox) trackSandboxedChild(child);
        /** Settles once the process is gone; `stop` waits on it with a kill deadline. */
        const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
        let current: RunningTurn | null = null;
        let nextId = 1;
        let sessionId: string | null = null;
        let closed = false;
        let sessionAnnounced = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let stderr = "";
        let runtime!: SessionRuntime;
        let appBroker: ConnectedAppsBroker | undefined;
        let officeMailBroker: ConnectedAppsBroker | undefined;
        let browserBroker: BrowserBroker | undefined;
        let desktopBroker: DesktopBroker | undefined;
        let memoryBroker: Awaited<ReturnType<typeof startMemoryProposalBroker>> | undefined;
        let pagesBroker: LoopbackToolServer | undefined;
        let signInBroker: LoopbackToolServer | undefined;
        let crmBroker: LoopbackToolServer | undefined;
        let remindersBroker: LoopbackToolServer | undefined;
        let viewsBroker: LoopbackToolServer | undefined;
        let settingsBroker: LoopbackToolServer | undefined;
        let bankBroker: LoopbackToolServer | undefined;
        let decideBroker: LoopbackToolServer | undefined;
        let connectorsBroker: LoopbackToolServer | undefined;
        const brokerMounts: Array<() => void> = [];
        // The CRM mount is pinned to the first turn's member scope and generation;
        // a later turn on this warm process may use it only while both still match.
        const crmMount = firstTurn.integrations?.hermiosCrm
          ? { scope: firstTurn.integrations.hermiosCrm.scope, generation: firstTurn.integrations.hermiosCrm.generation } : undefined;
        const actingTurn = () => {
          const run = current;
          return !closed && run && !run.settled && !run.cancellationRequested && run.promptSent ? run : undefined;
        };
        const currentCrmAccess = () => {
          const integration = actingTurn()?.turn.integrations?.hermiosCrm;
          return crmMount && integration && integration.scope === crmMount.scope && integration.generation === crmMount.generation &&
            typeof integration.accessToken === "function" ? integration : undefined;
        };
        // A `/steer` that reaches an idle Hermes session runs as a new prompt,
        // and one left undelivered is queued for the next turn. Neither may
        // outlive the turn it was meant for, so a steered process is retired.
        let steered = false;
        const memoryScope = DRIVER_KIND === "hermesAgent" ? firstTurn.integrations?.memoryProposals?.scope : undefined;
        const currentMemoryIntegration = () => {
          const run = current;
          if (closed || !run || run.settled || run.cancellationRequested || !run.promptSent || !memoryScope) return undefined;
          const integration = run.turn.integrations?.memoryProposals;
          return integration?.scope === memoryScope && typeof integration.propose === "function" ? integration : undefined;
        };
        const rpcPending = new Map<
          number,
          { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null }
        >();

        const eventBase = (run: RunningTurn) => base(threadId, run.turnId);
        const send = (message: unknown) => {
          try {
            child.stdin.write(JSON.stringify(message) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: message });
        };
        const request = (method: string, params: unknown, timeoutMs?: number) =>
          new Promise<any>((resolve, reject) => {
            if (closed) return reject(new Error(`${DRIVER_KIND} session is closed`));
            const id = nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(new Error(`${method} timed out`));
              }, timeoutMs);
              timer.unref?.();
            }
            rpcPending.set(id, { resolve, reject, timer });
            send({ jsonrpc: "2.0", id, method, params });
          });

        const removeRuntime = () => {
          modelLease?.revoke();
          browserBroker?.close();
          stopDesktopBroker(desktopBroker);
          appBroker?.close();
          officeMailBroker?.close();
          memoryBroker?.close();
          pagesBroker?.close();
          signInBroker?.close();
          crmBroker?.close();
          remindersBroker?.close();
          viewsBroker?.close();
          settingsBroker?.close();
          bankBroker?.close();
          decideBroker?.close();
          connectorsBroker?.close();
          for (const release of brokerMounts.splice(0)) release();
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          if (warm.get(threadId) === runtime) warm.delete(threadId);
          sessions.delete(runtime);
        };
        const terminate = () => {
          if (closed) return;
          closed = true;
          removeRuntime();
          for (const pending of rpcPending.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(new Error("ACP session closed"));
          }
          rpcPending.clear();
          killCliTree(child);
        };
        const park = () => {
          if (closed || current) return;
          runtime.lastUsed = Date.now();
          warm.set(threadId, runtime);
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(terminate, WARM_SESSION_IDLE_MS);
          idleTimer.unref?.();
          if (warm.size > MAX_WARM_SESSIONS) {
            const victim = [...warm.values()]
              .filter((candidate) => candidate !== runtime)
              .sort((a, b) => a.lastUsed - b.lastUsed)[0];
            victim?.stop();
          }
        };
        const settle = (run: RunningTurn, ok: boolean, stopReason: string | null, keepWarm: boolean) => {
          if (run.settled) return;
          // The relay token lives as long as this Hermes process. A Stop has
          // already revoked it, so that process cannot be kept warm.
          if (modelLease && run.cancellationRequested) keepWarm = false;
          run.settled = true;
          // A browser capability belongs to one job attempt, never a warm chat.
          if (browserBroker) { browserBroker.close(); keepWarm = false; }
          // So does a desktop task's: its driver session ends with the run.
          if (desktopBroker) { stopDesktopBroker(desktopBroker); keepWarm = false; }
          if (steered) keepWarm = false;
          appBroker?.cancelPending();
          officeMailBroker?.cancelPending();
          memoryBroker?.cancelPending();
          pagesBroker?.cancelPending();
          signInBroker?.cancelPending();
          crmBroker?.cancelPending();
          remindersBroker?.cancelPending();
          viewsBroker?.cancelPending();
          settingsBroker?.cancelPending();
          bankBroker?.cancelPending();
          decideBroker?.cancelPending();
          connectorsBroker?.cancelPending();
          if (run.interruptTimer) clearTimeout(run.interruptTimer);
          if (run.wrapUpTimer) clearTimeout(run.wrapUpTimer);
          run.wrapUpTimer = null;
          for (const finish of [...run.asks.values()]) finish({ behavior: "cancel" });
          const tracked = active.get(threadId);
          if (tracked?.turnId === run.turnId) active.delete(threadId);
          if (current === run) current = null;
          if (run.text.trim() || run.answerText.trim()) {
            const text = (run.sawTool ? run.answerText || run.text : run.text).trim();
            if (text) emit({ ...eventBase(run), type: "item.completed", itemType: "assistant_text", text });
          }
          // Everything the relay forwarded since the last turn settled, so a
          // background call between turns lands on the next turn, not nowhere.
          const usage = modelLease?.takeUsage();
          if (usage && run.tokens) {
            if (run.tokens.input !== undefined) usage.inputTokens = run.tokens.input;
            if (run.tokens.output !== undefined) usage.outputTokens = run.tokens.output;
          }
          emit({ ...eventBase(run), type: "turn.completed", ok, stopReason, cost: null, ...(usage && (usage.calls || run.tokens) ? { usage } : {}) });
          run.resolveDone();
          if (keepWarm && !closed) park();
          else terminate();
        };

        // Stop the whole turn: the call may already be running inside Hermes,
        // and later calls in the same turn would follow the same plan.
        const refuseHermesBrowser = (run: RunningTurn, message = HERMES_BROWSER_REFUSED) => {
          if (run.settled || run.cancellationRequested) return;
          emit({ ...eventBase(run), type: "runtime.error", message });
          void interrupt(run);
        };

        // Product Ask stops a turn at a hard call/time ceiling. Shortly before
        // it, ask Hermes once to answer with what it has. Best effort: a
        // refused or slow `/steer` never blocks or fails the turn.
        const wrapUpPoint = DRIVER_KIND === "hermesAgent" ? productTurnWrapUp() : null;
        const wrapUp = (run: RunningTurn, trigger: "tools" | "time") => {
          if (run.wrapUpSent || run.settled || run.cancellationRequested || !run.promptSent || current !== run || closed || !sessionId) return;
          run.wrapUpSent = true;
          run.steerAckPending = true;
          steered = true;
          if (run.wrapUpTimer) clearTimeout(run.wrapUpTimer);
          run.wrapUpTimer = null;
          request("session/prompt", { sessionId, prompt: [{ type: "text", text: `/steer ${HERMES_WRAP_UP_NOTE}` }] }, WRAP_UP_TIMEOUT)
            .catch((error: unknown) => {
              // Category only; the provider's error text stays in the raw log.
              const reason = error instanceof Error && /timed out$/.test(error.message) ? "timeout" : "rejected";
              appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { wrapUpNote: "not-delivered", trigger, reason } });
            });
        };
        const armWrapUp = (run: RunningTurn) => {
          if (!wrapUpPoint) return;
          const delay = Math.max(0, wrapUpPoint.afterMs - (Date.now() - run.startedAt));
          run.wrapUpTimer = setTimeout(() => wrapUp(run, "time"), delay);
          run.wrapUpTimer.unref?.();
        };

        const handleServerRequest = (message: any) => {
          const run = current;
          if (!run || run.settled || run.cancellationRequested || message.method !== "session/request_permission") {
            return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
          }
          const params = message.params ?? {};
          const options: Array<{ optionId?: string; kind?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((option) => String(option.kind ?? "").startsWith(want) && typeof option.optionId === "string")
              ?.optionId ?? null;
          const sessionAllowOption = () =>
            options.find((option) => option.optionId === "allow_session")?.optionId ??
            options.find(
              (option) =>
                String(option.kind ?? "").startsWith("allow") &&
                /session/i.test(String((option as { name?: unknown }).name ?? "")) &&
                typeof option.optionId === "string",
            )?.optionId ??
            null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...eventBase(run),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          if (cuaNeverTool(toolCall.rawInput?.name, toolCall.rawInput?.tool, toolCall.title)) {
            refuseHermesBrowser(run, CUA_EXTENSION_REFUSED);
            return send({ jsonrpc: "2.0", id: message.id, result: cancelled });
          }
          if (DRIVER_KIND === "hermesAgent" &&
            hermesNativeBrowserTool(toolCall.rawInput?.name, toolCall.rawInput?.tool, toolCall.title, toolCall.kind)) {
            refuseHermesBrowser(run);
            return send({ jsonrpc: "2.0", id: message.id, result: cancelled });
          }
          const memoryPermission = DRIVER_KIND === "hermesAgent" ? hermesMemoryPermission(toolCall) : { kind: "other" as const };
          if (memoryPermission.kind === "invalid-memory") {
            emit({ ...eventBase(run), type: "runtime.error", message: "This memory change cannot be reviewed completely here. Only one fully shown addition can be approved; replacements, removals and batches need separate full-entry review. No memory change was approved." });
            return send({ jsonrpc: "2.0", id: message.id, result: cancelled });
          }
          const rawInput = toolCall.rawInput;
          const kind = String(toolCall.kind ?? "");
          const command = typeof rawInput?.command === "string" ? rawInput.command : "";
          const actionName = typeof rawInput?.name === "string" ? rawInput.name : typeof rawInput?.tool === "string" ? rawInput.tool : "";
          const scriptRequest = [rawInput?.name, rawInput?.tool, kind, toolCall.title, command]
            .some(value => typeof value === "string" && /^\s*execute_code\b/i.test(value)) ||
            typeof rawInput?.code === "string";
          const unidentifiedCallback = !actionName && rawInput?.description !== undefined;
          const conflictingAction = [rawInput?.name, rawInput?.tool]
            .some(name => name !== undefined && name !== actionName);
          // Hermes exposes arbitrary Python via a whole-script callback. Never
          // convert it (or an unidentified action) into blanket session trust.
          // Its established, clearly identified terminal command flow retains
          // its existing session approvals; other engines are unchanged.
          const singleApproval = DRIVER_KIND === "hermesAgent" &&
            (memoryPermission.kind === "memory" || unidentifiedCallback || conflictingAction || scriptRequest ||
              typeof toolCall.kind !== "string" || kind !== "execute" || !command.trim() ||
              (Boolean(actionName) && !["terminal", "shell"].includes(actionName)));
          const onceOption = () => options.find(option => option.kind === "allow_once" && typeof option.optionId === "string")?.optionId ?? null;
          // Reviewed document scripts and plain workroom reads run without a
          // card (docs/decisions/2026-10-02-workroom-script-approvals.md).
          // Hermes sends a terminal approval as kind "execute" with rawInput
          // { command, description } and no tool name. Memory, execute_code,
          // conflicting or non-terminal names never qualify; no allow_once
          // option means the card below handles it as before.
          if (DRIVER_KIND === "hermesAgent" && memoryPermission.kind === "other" && !scriptRequest && !conflictingAction &&
            toolCall.kind === "execute" && (!actionName || ["terminal", "shell"].includes(actionName)) && onceOption() &&
            WORKROOM_AUTO_APPROVE && classifyWorkroomCommand({ command, workroom: vaultDir(), runtimeHome }) === "auto") {
            const [program, script] = shellWords(command) ?? [];
            appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: READ_PROGRAMS.has(program)
              ? { workroomCommand: "read workroom file", program }
              : { workroomCommand: "ran reviewed document script", script: script?.split("/").pop() } });
            return send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: onceOption() } } });
          }
          if (config.fullAuto && !singleApproval) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: message.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const tool = memoryPermission.kind === "memory" ? HERMES_MEMORY_APPROVAL : actionName
            ? actionName
            : kind === "execute"
              ? "shell"
              : kind === "edit"
                ? "edit"
                : kind || (typeof toolCall.title === "string" ? toolCall.title : "tool");
          // Only an unambiguous named browser action may be refined by the
          // host's separately validated job fence. Preserve hard manual review
          // when any source field identified script execution or an unknown
          // callback, even if the projected tool/URL resembles navigation.
          const providerOnce = singleApproval && memoryPermission.kind === "other" &&
            !scriptRequest && !unidentifiedCallback && !conflictingAction && typeof toolCall.kind === "string" && kind === tool &&
            ["navigate", "read", "fill"].includes(tool) &&
            [rawInput?.name, rawInput?.tool].every(name => name === undefined || name === tool);
          const summary = memoryPermission.kind === "memory" ? memoryPermission.review.description : String(
            rawInput?.command ?? rawInput?.url ?? rawInput?.label ?? toolCall.title ?? tool,
          ).slice(0, 200);
          const requestId = newId();
          const finish = (decision: { behavior: string; scope?: "once" | "session" }, resolution: "user" | "timeout" = "user") => {
            if (!run.asks.delete(requestId)) return;
            clearTimeout(timer);
            const want = decision.behavior === "allow" ? "allow" : "reject";
            const optionId =
              decision.behavior === "cancel"
                ? null
                : decision.behavior === "allow" && singleApproval
                  ? onceOption()
                  : decision.behavior === "allow" && decision.scope === "session"
                    ? sessionAllowOption() ?? optionFor("allow")
                    : optionFor(want);
            if (decision.behavior !== "cancel" && !optionId) missing(singleApproval && want === "allow" ? "allow_once" : want);
            send({
              jsonrpc: "2.0",
              id: message.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...eventBase(run),
              type: "request.resolved",
              requestId,
              behavior: optionId && decision.behavior === "allow" ? "allow" : "deny",
              source: optionId && resolution === "user" ? "user" : "system",
              resolution: resolution === "timeout" ? "timeout" : optionId ? "user" : "stopped",
            });
          };
          const timer = setTimeout(() => {
            emit({ ...eventBase(run), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish({ behavior: "deny" }, "timeout");
          }, WORKER_APPROVAL_CARD_MS);
          timer.unref?.();
          run.asks.set(requestId, finish);
          emit({
            ...eventBase(run),
            type: "request.opened",
            requestId,
            requestType: "permission",
            deadline: approvalDeadline(),
            tool,
            summary: singleApproval ? `${summary.slice(0, 165)} (approval applies once)` : summary,
            ...(singleApproval ? { approvalPolicy: providerOnce ? "provider-once" as const : "once" as const } : {}),
            ...(memoryPermission.kind === "memory" ? { memoryReview: memoryPermission.review } : {}),
            ...(rawInput !== undefined ? { params: rawInput } : {}),
          });
        };

        const handleNotification = (message: any) => {
          const run = current;
          if (!run || run.settled || message.method !== "session/update") return;
          const params = message.params ?? {};
          if (!run.promptSent || params._meta?.isReplay === true) return;
          const update = params.update ?? {};
          switch (update.sessionUpdate) {
            case "agent_message_chunk": {
              let delta = update.content?.text;
              if (typeof delta === "string" && delta) {
                if (run.steerAckPending && HERMES_STEER_ACK.test(delta)) {
                  run.steerAckPending = false;
                  break;
                }
                const plain = plainEngineFailure(delta);
                if (plain) delta = (run.text.trim() ? "\n\n" : "") + plain;
                run.text += delta;
                if (run.sawTool) run.answerText += delta;
                emit({ ...eventBase(run), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = update.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...eventBase(run), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              run.sawTool = true;
              run.answerText = "";
              const tool = pageTool(update.title);
              emit({
                ...eventBase(run),
                type: "item.started",
                itemType: "tool",
                itemId: update.toolCallId,
                // A page tool call shows only its label; the fingerprint (a digest of the real arguments, kept off
                // the event log) still tells two pages apart for the repeat watchdog.
                title: tool !== null ? pageToolLabel(tool) : String(update.rawInput?.command ?? update.title ?? "tool").slice(0, 80),
                toolFingerprint: toolFingerprint(String(update.title ?? "tool"), update.rawInput ?? update.content),
              });
              if (cuaNeverTool(update.rawInput?.name, update.rawInput?.tool, update.title)) {
                refuseHermesBrowser(run, CUA_EXTENSION_REFUSED);
                break;
              }
              if (DRIVER_KIND === "hermesAgent" && hermesNativeBrowserTool(update.rawInput?.name, update.rawInput?.tool, update.title)) {
                refuseHermesBrowser(run);
                break;
              }
              run.toolCount += 1;
              if (wrapUpPoint && run.toolCount >= wrapUpPoint.afterTools) wrapUp(run, "tools");
              break;
            }
            case "tool_call_update":
              if (update.status === "completed" || update.status === "failed") {
                emit({
                  ...eventBase(run),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: update.toolCallId,
                  ok: update.status !== "failed",
                });
              }
              break;
          }
        };

        let buffer = "";
        const pageCalls = new Map<string, string>();
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            let message: any;
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            appendNative(threadId, { dir: "in", source: SOURCE, msg: withoutPageToolValues(message, pageCalls) });
            if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
              const pending = rpcPending.get(message.id);
              if (pending) {
                rpcPending.delete(message.id);
                if (pending.timer) clearTimeout(pending.timer);
                message.error
                  ? pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
                  : pending.resolve(message.result);
              }
            } else if (message.id !== undefined && message.method) {
              handleServerRequest(message);
            } else if (message.method) {
              handleNotification(message);
            }
          }
        });

        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          if (stderr.length > 8192) stderr = stderr.slice(-8192);
        });
        child.on("error", (error) => {
          const run = current;
          if (!run || run.settled) return terminate();
          emit({ ...eventBase(run), type: "runtime.error", ...describeSpawnFailure(error, config.cli) });
          settle(run, false, "spawn_error", false);
        });
        child.on("close", (code) => {
          if (closed) return;
          closed = true;
          launch.release?.();
          removeRuntime();
          for (const pending of rpcPending.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.reject(new Error("ACP process exited"));
          }
          rpcPending.clear();
          const run = current;
          if (run && !run.settled) {
            emit({
              ...eventBase(run),
              type: "runtime.error",
              message: `${DRIVER_KIND} exited ${code} before the prompt result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
            });
            settle(run, false, "exit_before_result", false);
          }
        });

        /** RealBud's one-time review card for an external action (connected apps
         * and Hermios CRM writes): one explicit allow, never a session grant.
         * `card` is the broker's plain-line additions (exact request, phone
         * class, read offer, review id); the card also carries its deadline. A timeout or
         * a stop is never reported as the person's answer: `reviewAnswer` carries how
         * the card ended to the brokers that tell Bud; `reviewOnce` is its yes/no. */
        const reviewAnswer = (summary: string, signal: AbortSignal, card: ApprovalCardDetails = {}) => new Promise<{ allowed: boolean; resolution: ApprovalResolution }>((resolve) => {
          const run = current;
          if (!run || run.settled || run.cancellationRequested || !run.promptSent || closed || signal.aborted) { resolve({ allowed: false, resolution: "stopped" }); return; }
          const requestId = newId();
          const finish = (decision: { behavior: string; scope?: "once" | "session" }, resolution: "user" | "timeout" | "stopped" = "user") => {
            if (!run.asks.delete(requestId)) return;
            clearTimeout(timer);
            signal.removeEventListener("abort", aborted);
            // Broad/session grants cannot authorize an external action.
            const ended = run.settled || run.cancellationRequested || signal.aborted || closed;
            const allowed = resolution === "user" && decision.behavior === "allow" && decision.scope !== "session" && !ended;
            emit({ ...eventBase(run), type: "request.resolved", requestId, behavior: allowed ? "allow" : "deny", source: resolution === "user" ? "user" : "system", resolution });
            resolve({ allowed, resolution: resolution === "user" && ended ? "stopped" : resolution });
          };
          const aborted = () => finish({ behavior: "deny" }, "stopped");
          const timer = setTimeout(() => finish({ behavior: "deny" }, "timeout"), WORKER_APPROVAL_CARD_MS); timer.unref();
          run.asks.set(requestId, finish);
          signal.addEventListener("abort", aborted, { once: true });
          emit({ ...eventBase(run), type: "request.opened", requestId, requestType: "permission", tool: CONNECTED_APP_APPROVAL, summary, deadline: approvalDeadline(),
            ...(card.remote ? { remote: card.remote } : {}), ...(card.detail ? { detail: card.detail } : {}), ...(card.readOffer ? { readOffer: { ...card.readOffer } } : {}),
            ...(card.reviewId ? { reviewId: card.reviewId } : {}) });
        });
        const reviewOnce = (summary: string, signal: AbortSignal, card?: ApprovalCardDetails) => reviewAnswer(summary, signal, card).then(answer => answer.allowed);
        const ready = (async () => {
          if (memoryScope && mcpServers.some(server => server.name === "memory-proposals")) {
            memoryBroker = await startMemoryProposalBroker({
              isActive: () => Boolean(currentMemoryIntegration()),
              assertCapability: () => managedService.assertCapability("reasoning"),
              propose: async (proposal, signal) => {
                const run = current, integration = currentMemoryIntegration();
                if (!run || !integration || signal.aborted) throw new Error("This memory proposal request stopped. Review saved proposals before trying again.");
                managedService.assertCapability("reasoning");
                const result = await integration.propose(proposal, signal);
                if (signal.aborted || current !== run || currentMemoryIntegration() !== integration) throw new Error("This memory proposal request stopped. Review saved proposals before trying again.");
                managedService.assertCapability("reasoning");
                return result;
              },
            });
            if (closed) { memoryBroker.close(); throw new Error("Bud’s memory proposal session stopped."); }
            mcpServers = mcpServers.map(server => server.name === "memory-proposals" ? memoryBroker!.descriptor : server);
          }
          if (firstTurn.integrations?.browser) {
            const browser = firstTurn.integrations.browser;
            // Every mount carries its explicit grant (an Ask task's, or a saved job's own); there is no other path.
            if (!browser.grant) throw new Error("This browser work has no saved permission, so nothing was opened. Start it again.");
            // An Ask task's grant is bound to the browser selected when the person started it.
            // (A saved job's checked sign-in page keeps its own browser check in the broker.)
            const askTask = browser.grant.origin !== BROWSER_LEGACY_JOB_ORIGIN;
            const runtime = askTask ? askBrowserRuntime() : browserRuntime;
            if (askTask && browser.grant.browser.id && (await runtime.status()).selectedBrowserId !== browser.grant.browser.id) {
              throw new Error("The selected browser changed after this task was started. Start the task again from Ask.");
            }
            // A task on a mapped portal (REI) gets the pack's declared read-safe controls, so its menus and
            // listed reports read without a card while everything else asks as before, and Bud may propose
            // the path it found. Without a map (or if it cannot be read) the task runs exactly as before.
            const map = askTask && browser.grant.route === "ask" ? await portalMapForSites(browser.grant.sites, askPortalPackLoader()).catch(() => null) : null;
            const controls = map ? portalRecipeControls(map.pack) : undefined;
            // The pack's account location only binds a task that chose an account; it never blocks one that did not.
            if (controls && !browser.grant.browser.accountMarker) delete controls.accountMarker;
            browserBroker = await startBrowserBroker({
              runtime, ...(map && controls ? { portal: controls, learn: map } : {}),
              threadId, runId: browser.runId,
              checkpoint: browser.checkpoint,
              context: { allowedOrigins: browser.allowedOrigins, capabilities: browser.capabilities },
              grant: browser.grant,
              isActive: () => Boolean(current && !current.settled && !current.cancellationRequested && !closed && (browser.active?.() ?? true)),
              // The broker has already decided this step; the card carries its
              // projection (site, surface, once-only policy) and the host only shows it.
              approve: (tool, params, summary, signal, projection) => new Promise<boolean>(resolve => {
                const run = current;
                if (!run || run.settled || run.cancellationRequested || !run.promptSent || closed || signal.aborted) { resolve(false); return; }
                // A consequential step is shown with its verified facts and
                // expiry, once only, or it is not shown at all.
                let browserApproval: BrowserApprovalCard | undefined;
                try { browserApproval = browserApprovalCardFrom(params); } catch { resolve(false); return; }
                const requestId = newId();
                const finish = (decision: { behavior: string; scope?: "once" | "session" }, resolution: "user" | "timeout" | "stopped" = "user") => {
                  if (!run.asks.delete(requestId)) return;
                  clearTimeout(timer); signal.removeEventListener("abort", aborted);
                  const allowed = resolution === "user" && decision.behavior === "allow" && decision.scope !== "session" && !run.settled && !run.cancellationRequested && !closed && !signal.aborted;
                  emit({ ...eventBase(run), type: "request.resolved", requestId, behavior: allowed ? "allow" : "deny", source: resolution === "user" ? "user" : "system", resolution }); resolve(allowed);
                };
                const aborted = () => finish({ behavior: "deny" }, "stopped");
                const timer = setTimeout(() => finish({ behavior: "deny" }, "timeout"), WORKER_APPROVAL_CARD_MS); timer.unref();
                run.asks.set(requestId, finish); signal.addEventListener("abort", aborted, { once: true });
                // A phone may answer only a repeatable read or open of a page; everything else stays on the desktop.
                const phoneRead = !browserApproval && projection?.fence.surface === "portal-read" && !projection.approvalPolicy && (tool === "browser_read" || tool === "browser_navigate");
                emit({ ...eventBase(run), type: "request.opened", requestId, requestType: "permission", tool, params, summary, deadline: approvalDeadline(), remote: phoneRead ? "read" : "desktop-only",
                  ...(projection ? { fence: projection.fence, ...(projection.approvalPolicy ? { approvalPolicy: projection.approvalPolicy } : {}) } : {}),
                  ...(browserApproval ? { browserApproval, approvalPolicy: "once" as const } : {}) });
              }),
            });
            if (closed) { browserBroker.close(); throw new Error("Browser work stopped."); }
            mcpServers = mcpServers.map(server => server.name === BROWSER_SERVER ? browserBroker!.descriptor : server);
          }
          if (firstTurn.integrations?.desktop) {
            const desktop = firstTurn.integrations.desktop;
            // pick_control only with the host's binding (a person's own attended Ask, or their own Start on the card, while Jev is ready); each answer is counted on the turn.
            const binding = desktop.decisions;
            desktopBroker = await startDesktopBroker({
              runId: desktop.runId, grant: desktop.grant, step: desktop.step,
              isActive: () => Boolean(current && !current.settled && !current.cancellationRequested && !closed && (desktop.active?.() ?? true)),
              ...(binding ? { decisions: () => closed ? undefined : { sameMember: () => binding.sameMember(), ready: () => binding.ready(), lunaReady: () => binding.lunaReady(),
                decide: async (request, options) => {
                  // The host binds jev-client's decide, which takes model, image and timeoutMs; contracts type it without jev-client.
                  const result = await (binding.decide as DesktopDecisions["decide"])(request, options);
                  try { modelLease?.recordJev(result); } catch { /* counting never changes the outcome */ }
                  return result;
                } } } : {}),
              // The broker decided this step; the card carries its projection and stays on this computer (remote: desktop-only).
              approve: (tool, params, summary, signal, projection) => new Promise<boolean>(resolve => {
                const run = current;
                if (!run || run.settled || run.cancellationRequested || !run.promptSent || closed || signal.aborted) { resolve(false); return; }
                const requestId = newId();
                const finish = (decision: { behavior: string; scope?: "once" | "session" }, resolution: "user" | "timeout" | "stopped" = "user") => {
                  if (!run.asks.delete(requestId)) return;
                  clearTimeout(timer); signal.removeEventListener("abort", aborted);
                  const allowed = resolution === "user" && decision.behavior === "allow" && decision.scope !== "session" && !run.settled && !run.cancellationRequested && !closed && !signal.aborted;
                  emit({ ...eventBase(run), type: "request.resolved", requestId, behavior: allowed ? "allow" : "deny", source: resolution === "user" ? "user" : "system", resolution }); resolve(allowed);
                };
                const aborted = () => finish({ behavior: "deny" }, "stopped");
                const timer = setTimeout(() => finish({ behavior: "deny" }, "timeout"), WORKER_APPROVAL_CARD_MS); timer.unref();
                run.asks.set(requestId, finish); signal.addEventListener("abort", aborted, { once: true });
                emit({ ...eventBase(run), type: "request.opened", requestId, requestType: "permission", tool, params, summary, deadline: approvalDeadline(),
                  remote: projection.remote, fence: projection.fence, approvalPolicy: projection.approvalPolicy });
              }),
            });
            liveDesktopBrokers.set(desktopBroker, desktop.runId);
            if (closed) { stopDesktopBroker(desktopBroker); throw new Error("Desktop work stopped."); }
            mcpServers = mcpServers.map(server => server.name === DESKTOP_SERVER ? desktopBroker!.descriptor : server);
          }
          if (firstTurn.integrations?.composio) {
            const { key, url, headers, gmailReadOnly, allowedApps, managed } = firstTurn.integrations.composio;
            if (gmailReadOnly && (typeof gmailReadOnly.requestId !== "string" || !gmailReadOnly.requestId.trim())) throw new Error("Gmail review needs a fresh request identity.");
            appBroker = await startConnectedAppsBroker({
              key, url, headers, allowedApps, ...(managed ? { managed: true } : {}),
              ...(gmailReadOnly ? { readOnlyAccountId: gmailReadOnly.accountId, localTransport: createGmailReadOnlyTransport({
                apiKey: key, authConfigId: gmailReadOnly.authConfigId, userId: gmailReadOnly.userId, accountId: gmailReadOnly.accountId,
              }) } : {}),
              threadId,
              isActive: () => Boolean(current && !current.settled && !current.cancellationRequested && !closed),
              approve: reviewAnswer,
            });
            if (closed) { appBroker.close(); throw new Error("Bud's app session stopped."); }
            mcpServers = mcpServers.map(server => server.name === "connected-apps" ? appBroker!.descriptor : server);
          }
          if (firstTurn.integrations?.officeMail) {
            // The office shared mailbox: Gmail only, classified and carded like the person's own.
            const { key, url, headers, address } = firstTurn.integrations.officeMail;
            officeMailBroker = await startConnectedAppsBroker({
              key, url, headers, allowedApps: ["gmail"], managed: true, mailbox: "office", ...(address ? { officeAddress: address } : {}), threadId,
              isActive: () => Boolean(current && !current.settled && !current.cancellationRequested && !closed),
              approve: reviewAnswer,
            });
            if (closed) { officeMailBroker.close(); throw new Error("Bud's app session stopped."); }
            mcpServers = mcpServers.map(server => server.name === OFFICE_MAIL_SERVER ? officeMailBroker!.descriptor : server);
          }
          if (mcpServers.some(server => server.name === WEB_RESEARCH_SERVER)) {
            // Bounded public page reads, no approval card; receipts name the host only.
            pagesBroker = await startWebResearchBroker({
              turnId: () => actingTurn()?.turnId ?? null,
              // Only the current turn's person-given links; never page or tool text.
              allowedUrls: () => actingTurn()?.turn.integrations?.webPages?.allowedUrls ?? [],
              receipt: receipt => appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { webPages: receipt } }),
            });
            if (closed) { pagesBroker.close(); throw new Error("Bud’s page-reading session stopped."); }
            mcpServers = mcpServers.map(server => server.name === WEB_RESEARCH_SERVER ? pagesBroker!.descriptor : server);
          }
          if (mcpServers.some(server => server.name === SIGN_IN_SERVER)) {
            // Opens the work browser on a sign-in page and waits for the person; only the current turn's person-typed links and the office's sites.
            signInBroker = await startSignInBroker({
              threadId,
              personUrls: () => actingTurn()?.turn.integrations?.signIn?.personUrls ?? [],
              approvedSites: () => actingTurn()?.turn.integrations?.signIn?.approvedSites ?? [],
              isActive: () => Boolean(current && !current.settled && !current.cancellationRequested && !closed),
            });
            if (closed) { signInBroker.close(); throw new Error("Bud’s sign-in session stopped."); }
            mcpServers = mcpServers.map(server => server.name === SIGN_IN_SERVER ? signInBroker!.descriptor : server);
          }
          if (crmMount && mcpServers.some(server => server.name === HERMIOS_CRM_SERVER)) {
            // Read-only CRM; receipts carry the tool and generation, never a token.
            crmBroker = await startHermiosCrmBroker({
              generation: crmMount.generation,
              access: currentCrmAccess,
              // Writes show RealBud's connected-app card; one explicit allow each.
              approve: reviewOnce,
              receipt: receipt => appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { hermiosCrm: receipt } }),
            });
            if (closed) { crmBroker.close(); throw new Error("Bud’s Hermios session stopped."); }
            mcpServers = mcpServers.map(server => server.name === HERMIOS_CRM_SERVER ? crmBroker!.descriptor : server);
          }
          if (mcpServers.some(server => server.name === REMINDERS_SERVER)) {
            // Private Desk reminders; no card. The current turn's binding is used.
            remindersBroker = await startRemindersBroker({
              turnId: () => actingTurn()?.turnId ?? null,
              reminders: () => actingTurn()?.turn.integrations?.reminders,
              receipt: receipt => appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { reminders: receipt } }),
            });
            if (closed) { remindersBroker.close(); throw new Error("Bud’s reminders session stopped."); }
            mcpServers = mcpServers.map(server => server.name === REMINDERS_SERVER ? remindersBroker!.descriptor : server);
          }
          if (mcpServers.some(server => server.name === WORKSPACE_VIEWS_SERVER)) {
            // Saved views: a read with no card; every change shows the one-time card first.
            viewsBroker = await startWorkspaceViewsBroker({
              turnId: () => actingTurn()?.turnId ?? null,
              views: () => actingTurn()?.turn.integrations?.workspaceViews,
              approve: reviewOnce,
              receipt: receipt => appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { workspaceViews: receipt } }),
            });
            if (closed) { viewsBroker.close(); throw new Error("Bud’s saved views session stopped."); }
            mcpServers = mcpServers.map(server => server.name === WORKSPACE_VIEWS_SERVER ? viewsBroker!.descriptor : server);
          }
          if (mcpServers.some(server => server.name === WORKFLOW_SETTINGS_SERVER)) {
            // Working rules: a read with no card; every change and restore shows the one-time card first.
            settingsBroker = await startWorkflowSettingsBroker({
              turnId: () => actingTurn()?.turnId ?? null,
              settings: () => actingTurn()?.turn.integrations?.workflowSettings,
              approve: reviewAnswer,
              receipt: receipt => appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { workflowSettings: receipt } }),
            });
            if (closed) { settingsBroker.close(); throw new Error("Bud’s working rules session stopped."); }
            mcpServers = mcpServers.map(server => server.name === WORKFLOW_SETTINGS_SERVER ? settingsBroker!.descriptor : server);
          }
          if (mcpServers.some(server => server.name === BANK_SOURCE_SERVER)) {
            // Read-only bank feed; no card. The current turn's binding is used.
            bankBroker = await startBankSourceBroker({
              turnId: () => actingTurn()?.turnId ?? null,
              bank: () => actingTurn()?.turn.integrations?.bankSource,
              receipt: receipt => appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { bankSource: receipt } }),
            });
            if (closed) { bankBroker.close(); throw new Error("Bud’s bank feed session stopped."); }
            mcpServers = mcpServers.map(server => server.name === BANK_SOURCE_SERVER ? bankBroker!.descriptor : server);
          }
          if (mcpServers.some(server => server.name === DECIDE_SERVER)) {
            // Typed Jev questions; no card, answers are suggestions. The current turn's binding is used.
            decideBroker = await startDecideBroker({
              turnId: () => actingTurn()?.turnId ?? null,
              decisions: () => actingTurn()?.turn.integrations?.decisions,
              receipt: receipt => appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { decisions: receipt } }),
              // Counted on the turn's usage with its relayed model calls.
              record: result => modelLease?.recordJev(result),
            });
            if (closed) { decideBroker.close(); throw new Error("Bud’s typed decisions session stopped."); }
            mcpServers = mcpServers.map(server => server.name === DECIDE_SERVER ? decideBroker!.descriptor : server);
          }
          if (firstTurn.integrations?.mcpConnectors && mcpServers.some(server => server.name === MCP_CONNECTORS_SERVER)) {
            // Office connectors: reads with no card, writes with the one-time card; tools fixed at mount, re-checked per call.
            connectorsBroker = await startMcpConnectorBroker({
              tools: firstTurn.integrations.mcpConnectors.tools,
              turnId: () => actingTurn()?.turnId ?? null,
              connectors: () => actingTurn()?.turn.integrations?.mcpConnectors,
              approve: reviewAnswer,
              receipt: receipt => appendNative(threadId, { dir: "in", source: `${SOURCE}.realbud`, msg: { officeConnectors: receipt } }),
            });
            if (closed) { connectorsBroker.close(); throw new Error("Bud’s office connectors session stopped."); }
            mcpServers = mcpServers.map(server => server.name === MCP_CONNECTORS_SERVER ? connectorsBroker!.descriptor : server);
          }
          if (brokerPorts) {
            // A sandboxed worker reaches the brokers only through the pool ports its profile names.
            mcpServers = mcpServers.map(server => {
              const mount = "url" in server ? brokerPorts.mount(server.url) : null;
              if (!mount) return server;
              brokerMounts.push(mount.release);
              return { ...server, url: mount.url };
            });
          }
          const init = await request(
            "initialize",
            { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
            INIT_TIMEOUT,
          );
          const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
          const methodId = support.pickAuthMethod(methods);
          if (methodId) {
            try {
              await request("authenticate", { methodId }, INIT_TIMEOUT);
            } catch {
              if (support.authFailure === "fail") throw new Error(support.loginNote);
            }
          } else if (support.authFailure === "fail") {
            throw new Error(support.loginNote);
          }

          let loaded = false;
          const cursor = typeof firstTurn.resumeCursor === "string" ? firstTurn.resumeCursor : null;
          if (cursor && support.resumeAcrossProcesses !== false) {
            try {
              await request("session/load", { sessionId: cursor, cwd, mcpServers }, LOAD_SESSION_TIMEOUT);
              sessionId = cursor;
              loaded = true;
            } catch {
              /* stale cursor or unsupported load — make a new session */
            }
          }
          if (!sessionId) {
            const started = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
            sessionId = typeof started?.sessionId === "string" ? started.sessionId : null;
            if (!sessionId) throw new Error("session/new returned no sessionId");
          }
          if (support.defaultSessionMode) {
            try {
              await request(
                "session/set_mode",
                { sessionId, modeId: support.defaultSessionMode },
                SESSION_MODE_TIMEOUT,
              );
            } catch {
              // Fail closed to the provider's default approval mode. The
              // request/response is still captured in the redacted native log.
            }
          }
          return { init, loaded };
        })();

        const runPrompt = async (run: RunningTurn, first: boolean) => {
          try {
            const readyState = await ready;
            if (run.settled || current !== run || !sessionId) return;
            // Initialization/authentication can outlast a grant. Check the
            // resolved session capabilities at the actual prompt boundary,
            // including a computer mounted through the CUA fallback.
            managedService.assertCapability("reasoning");
            if (mcpServers.some(server => server.name === "computer" || server.name === BROWSER_SERVER || server.name === DESKTOP_SERVER)) managedService.assertCapability("computer-use");
            if (!sessionAnnounced) {
              sessionAnnounced = true;
              emit({
                ...eventBase(run),
                type: "session.started",
                sessionId,
                model: readyState.init?._meta?.modelState?.currentModelId ?? run.turn.model ?? null,
              });
            }
            run.promptSent = true;
            armWrapUp(run);
            const promptTurn = first && !readyState.loaded ? replayOnFreshSession(run.turn) : run.turn;
            const text = support.buildPromptText
              ? support.buildPromptText(promptTurn)
              : promptTurn.system
                ? `${promptTurn.system}\n\n${promptTurn.text}`
                : promptTurn.text;
            const result = await request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text }],
            });
            if (run.settled || current !== run) return;
            // ACP PromptResponse.usage (Hermes); `_meta` kept for older agents.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              run.tokens = {
                ...(Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 ? { input: usage.inputTokens } : {}),
                ...(Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 ? { output: usage.outputTokens } : {}),
              };
              emit({
                ...eventBase(run),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
                ...(typeof usage.cachedReadTokens === "number" ? { cachedRead: usage.cachedReadTokens } : {}),
                ...(typeof usage.thoughtTokens === "number" ? { thought: usage.thoughtTokens } : {}),
              });
            }
            const reason = result?.stopReason;
            if (reason === "end_turn") settle(run, true, null, true);
            else if (reason === "cancelled") settle(run, true, "cancelled", true);
            else settle(run, false, reason ?? "failed", false);
          } catch (error) {
            if (run.settled || current !== run) return;
            const message = error instanceof Error ? error.message : String(error);
            const needsAuth = message === support.loginNote;
            emit({ ...eventBase(run), type: "runtime.error", message, ...(needsAuth ? { setup: true } : {}) });
            settle(run, false, needsAuth ? "auth_required" : "rpc_error", false);
          }
        };

        const interrupt = async (run: RunningTurn) => {
          if (run.settled) return run.done;
          run.cancellationRequested = true;
          modelLease?.revoke();
          browserBroker?.close();
          stopDesktopBroker(desktopBroker);
          appBroker?.cancelPending();
          officeMailBroker?.cancelPending();
          memoryBroker?.cancelPending();
          pagesBroker?.cancelPending();
          signInBroker?.cancelPending();
          crmBroker?.cancelPending();
          remindersBroker?.cancelPending();
          viewsBroker?.cancelPending();
          settingsBroker?.cancelPending();
          bankBroker?.cancelPending();
          decideBroker?.cancelPending();
          connectorsBroker?.cancelPending();
          for (const finish of [...run.asks.values()]) finish({ behavior: "cancel" });
          if (sessionId && run.promptSent) {
            send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
            if (run.interruptTimer) clearTimeout(run.interruptTimer);
            run.interruptTimer = setTimeout(() => settle(run, true, "cancelled", false), CANCEL_GRACE_MS);
            run.interruptTimer.unref?.();
          } else {
            settle(run, true, "cancelled", false);
          }
          return run.done;
        };

        const resume = (turn: SendTurnInput, first = false) => {
          if (closed) throw new Error(`${DRIVER_KIND} session is closed`);
          if (current) throw new Error("a turn is already running on this thread");
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          if (warm.get(threadId) === runtime) warm.delete(threadId);
          let resolveDone!: () => void;
          const done = new Promise<void>((resolve) => {
            resolveDone = resolve;
          });
          const run: RunningTurn = {
            turn,
            turnId: newId(),
            text: "",
            answerText: "",
            sawTool: false,
            promptSent: false,
            settled: false,
            cancellationRequested: false,
            asks: new Map(),
            interruptTimer: null,
            startedAt: Date.now(),
            toolCount: 0,
            wrapUpTimer: null,
            wrapUpSent: false,
            steerAckPending: false,
            done,
            resolveDone,
          };
          current = run;
          active.set(threadId, {
            turnId: run.turnId,
            asks: run.asks,
            stop: () => settle(run, false, "interrupted", false),
            interrupt: () => interrupt(run),
          });
          emit({ ...eventBase(run), type: "turn.started" });
          void runPrompt(run, first);
          return run.turnId;
        };

        runtime = {
          signature,
          lastUsed: Date.now(),
          resume,
          stop: () => {
            const run = current;
            if (run && !run.settled) settle(run, false, "interrupted", false);
            else terminate();
            if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve();
            const pid = child.pid;
            const timer = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } }, STOP_DEADLINE_MS);
            timer.unref();
            return exited.then(() => clearTimeout(timer));
          },
        };
        sessions.add(runtime);
        return runtime;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        managedService.assertCapability("reasoning");
        if (support.networkSandbox && workerLaunchesHeld()) throw new Error(WORKERS_HELD);
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const mcpServers = acpMcpServers(turn);
        if (mcpServers.some(server => server.name === "computer" || server.name === BROWSER_SERVER || server.name === DESKTOP_SERVER)) managedService.assertCapability("computer-use");
        const args = support.spawnArgs(config, turn);
        const signature = signatureFor(cwd, args, mcpServers, turn.integrations?.composio, turn.integrations?.memoryProposals?.scope, turn.integrations?.hermiosCrm);
        let runtime = warm.get(threadId);
        // A rewind or poisoned-session recovery deliberately clears the
        // persisted cursor. Do not let the warm-process optimization undo
        // that signal by continuing the abandoned in-memory conversation.
        if (runtime && typeof turn.resumeCursor !== "string" && (turn.transcript?.length ?? 0) > 0) {
          runtime.stop();
          runtime = undefined;
        }
        if (runtime && runtime.signature !== signature) {
          runtime.stop();
          runtime = undefined;
        }
        const first = !runtime;
        if (!runtime) {
          const modelLease = DRIVER_KIND === "hermesAgent" ? createAskModelRelayLease() : undefined;
          try {
            runtime = modelLease
              ? modelLease.run(() => createRuntime(turn, cwd, args, mcpServers, signature, modelLease))
              : createRuntime(turn, cwd, args, mcpServers, signature);
          } catch (error) { modelLease?.revoke(); throw error; }
        }
        return { turnId: runtime.resume(turn, first) };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        // A version probe is not a model turn: its token is revoked before spawning.
        const probeLease = DRIVER_KIND === "hermesAgent" ? createAskModelRelayLease() : undefined;
        let env: ReturnType<typeof childEnv>;
        try { env = probeLease ? probeLease.run(childEnv) : childEnv(); }
        finally { probeLease?.revoke(); }
        const version = await new Promise<string | null>((resolve) => {
          // The same boundary as a turn: a binary in worker-writable storage
          // never runs unconfined, not even to print its version.
          let launch: { command: string; args: string[]; release?(): void };
          try { launch = support.networkSandbox ? support.networkSandbox(config.cli, ["--version"], env, [], "diagnostic") : { command: config.cli, args: ["--version"] }; }
          catch { resolve(null); return; }
          execCli(launch.command, launch.args, { timeout: 8000, env }, (err, stdout) => {
            launch.release?.();
            resolve(err ? null : stdout.trim());
          });
        });
        if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
        return { state: "available", version, authenticated: support.isAuthenticated(env) };
      };

      /** Stops every session and resolves once each process has exited. */
      const stopAll = async () => {
        await Promise.all([...sessions].map(session => session.stop()));
        if (support.networkSandbox) await stopSandboxedChildren(STOP_DEADLINE_MS);
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: support.models,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: { sessionModelSwitch: "unsupported", agentsMcp: true, computerMcp: true },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) throw new Error("no such pending request");
            finish({
              behavior: decision.behavior === "allow" ? "allow" : "deny",
              scope: decision.scope,
            });
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => stopAll(),
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          await stopAll();
          listeners.clear();
          brokerPorts?.close();
        },
      };
    },
  };
}

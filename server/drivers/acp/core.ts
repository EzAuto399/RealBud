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

import type {
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
import { readCuaConnection } from "../../local-computer.ts";
import { startBrowserBroker, type BrowserBroker } from "../../browser-broker.ts";
import { startMemoryProposalBroker } from "../../hermes-memory-proposal-broker.ts";
import { CONNECTED_APP_APPROVAL, connectedAppsBrokerGeneration, startConnectedAppsBroker, type ConnectedAppsBroker } from "../../connected-apps-broker.ts";
import { createGmailReadOnlyTransport } from "../../composio-gmail.ts";
import { toolFingerprint } from "../../tool-fingerprint.ts";
import { HERMES_MEMORY_APPROVAL, hermesMemoryPermission } from "./hermes-memory-approval.ts";

const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
import { appendNative } from "../native.ts";

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
}

const INIT_TIMEOUT = 20_000;
const NEW_SESSION_TIMEOUT = 30_000;
const LOAD_SESSION_TIMEOUT = 120_000; // history replay on a long thread is slow
const SESSION_MODE_TIMEOUT = 5_000;
const CANCEL_GRACE_MS = 2_000;
const WARM_SESSION_IDLE_MS = 10 * 60_000;
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
        stop: () => void;
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
        if (turn.integrations?.browser) servers.push({ type: "http", name: "browser", url: "http://127.0.0.1/realbud-browser", headers: [] });
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
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const computer = turn.integrations?.computer;
        if (computer && !turn.integrations?.browser) {
          servers.push({
            name: "computer",
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(computer) }),
          });
        } else if (turn.integrations?.localComputer && !turn.integrations?.browser) {
          const local = turn.integrations.localComputer;
          servers.push({ name: "computer", command: local.command, args: local.args, env: acpEnv(local.env ?? {}) });
        }
        if (turn.computer === true && !turn.integrations?.browser && !servers.some((server) => server.name === "computer")) {
          const conn = readCuaConnection();
          if (conn) {
            servers.push({
              name: "computer",
              command: conn.command,
              args: conn.args,
              env: Object.entries(conn.env).map(([name, value]) => ({ name, value })),
            });
          }
        }
        return servers;
      };

      const signatureFor = (cwd: string, args: string[], mcpServers: AcpMcpServer[], composio?: NonNullable<SendTurnInput["integrations"]>["composio"], memoryScope?: string) =>
        createHash("sha256").update(JSON.stringify({ cli: config.cli, cwd, args, mcpServers,
          ...(mcpServers.some(server => server.name === "memory-proposals") ? { memoryScope } : {}),
          ...(composio?.allowedApps ? { allowedApps: composio.allowedApps } : {}),
          ...(composio?.gmailReadOnly ? { gmailReadOnly: composio.gmailReadOnly, appKey: composio.key } : {}),
          ...(mcpServers.some(server => server.name === "connected-apps") ? { appGeneration: connectedAppsBrokerGeneration() } : {}),
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
      ): SessionRuntime => {
        const { threadId } = firstTurn;
        const child = spawnCli(config.cli, args, {
          cwd,
          env: childEnv(),
          stdio: ["pipe", "pipe", "pipe"],
          privateFiles: support.privateWorkspace === true,
        });
        let current: RunningTurn | null = null;
        let nextId = 1;
        let sessionId: string | null = null;
        let closed = false;
        let sessionAnnounced = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let stderr = "";
        let runtime!: SessionRuntime;
        let appBroker: ConnectedAppsBroker | undefined;
        let browserBroker: BrowserBroker | undefined;
        let memoryBroker: Awaited<ReturnType<typeof startMemoryProposalBroker>> | undefined;
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
          browserBroker?.close();
          appBroker?.close();
          memoryBroker?.close();
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
          run.settled = true;
          // A browser capability belongs to one job attempt, never a warm chat.
          if (browserBroker) { browserBroker.close(); keepWarm = false; }
          appBroker?.cancelPending();
          memoryBroker?.cancelPending();
          if (run.interruptTimer) clearTimeout(run.interruptTimer);
          for (const finish of [...run.asks.values()]) finish({ behavior: "cancel" });
          const tracked = active.get(threadId);
          if (tracked?.turnId === run.turnId) active.delete(threadId);
          if (current === run) current = null;
          if (run.text.trim() || run.answerText.trim()) {
            const text = (run.sawTool ? run.answerText || run.text : run.text).trim();
            if (text) emit({ ...eventBase(run), type: "item.completed", itemType: "assistant_text", text });
          }
          emit({ ...eventBase(run), type: "turn.completed", ok, stopReason, cost: null });
          run.resolveDone();
          if (keepWarm && !closed) park();
          else terminate();
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
          const finish = (decision: { behavior: string; scope?: "once" | "session" }) => {
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
              source: optionId ? "user" : "system",
            });
          };
          const timer = setTimeout(() => {
            emit({ ...eventBase(run), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish({ behavior: "deny" });
          }, 15 * 60_000);
          timer.unref?.();
          run.asks.set(requestId, finish);
          emit({
            ...eventBase(run),
            type: "request.opened",
            requestId,
            requestType: "permission",
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
              const delta = update.content?.text;
              if (typeof delta === "string" && delta) {
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
            case "tool_call":
              run.sawTool = true;
              run.answerText = "";
              emit({
                ...eventBase(run),
                type: "item.started",
                itemType: "tool",
                itemId: update.toolCallId,
                title: String(update.rawInput?.command ?? update.title ?? "tool").slice(0, 80),
                toolFingerprint: toolFingerprint(String(update.title ?? "tool"), update.rawInput ?? update.content),
              });
              break;
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
            appendNative(threadId, { dir: "in", source: SOURCE, msg: message });
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
            browserBroker = await startBrowserBroker({
              threadId, runId: browser.runId,
              checkpoint: browser.checkpoint,
              context: { allowedOrigins: browser.allowedOrigins, capabilities: browser.capabilities },
              isActive: () => Boolean(current && !current.settled && !current.cancellationRequested && !closed),
              approve: (tool, params, summary, signal) => new Promise<boolean>(resolve => {
                const run = current;
                if (!run || run.settled || run.cancellationRequested || !run.promptSent || closed || signal.aborted) { resolve(false); return; }
                const requestId = newId();
                const finish = (decision: { behavior: string; scope?: "once" | "session" }) => {
                  if (!run.asks.delete(requestId)) return;
                  clearTimeout(timer); signal.removeEventListener("abort", aborted);
                  const allowed = decision.behavior === "allow" && decision.scope !== "session" && !run.settled && !run.cancellationRequested && !closed && !signal.aborted;
                  emit({ ...eventBase(run), type: "request.resolved", requestId, behavior: allowed ? "allow" : "deny", source: "user" }); resolve(allowed);
                };
                const aborted = () => finish({ behavior: "deny" });
                const timer = setTimeout(aborted, 5 * 60_000); timer.unref();
                run.asks.set(requestId, finish); signal.addEventListener("abort", aborted, { once: true });
                emit({ ...eventBase(run), type: "request.opened", requestId, requestType: "permission", tool, params, summary });
              }),
            });
            if (closed) { browserBroker.close(); throw new Error("Browser work stopped."); }
            mcpServers = mcpServers.map(server => server.name === "browser" ? browserBroker!.descriptor : server);
          }
          if (firstTurn.integrations?.composio) {
            const { key, url, headers, gmailReadOnly, allowedApps } = firstTurn.integrations.composio;
            if (gmailReadOnly && (typeof gmailReadOnly.requestId !== "string" || !gmailReadOnly.requestId.trim())) throw new Error("Gmail review needs a fresh request identity.");
            appBroker = await startConnectedAppsBroker({
              key, url, headers, allowedApps,
              ...(gmailReadOnly ? { readOnlyAccountId: gmailReadOnly.accountId, localTransport: createGmailReadOnlyTransport({
                apiKey: key, authConfigId: gmailReadOnly.authConfigId, userId: gmailReadOnly.userId, accountId: gmailReadOnly.accountId,
              }) } : {}),
              threadId,
              isActive: () => Boolean(current && !current.settled && !current.cancellationRequested && !closed),
              approve: (summary, signal) => new Promise<boolean>((resolve) => {
                const run = current;
                if (!run || run.settled || run.cancellationRequested || !run.promptSent || closed || signal.aborted) { resolve(false); return; }
                const requestId = newId();
                const finish = (decision: { behavior: string; scope?: "once" | "session" }) => {
                  if (!run.asks.delete(requestId)) return;
                  clearTimeout(timer);
                  signal.removeEventListener("abort", aborted);
                  // Broad/session grants cannot authorize an external action.
                  const allowed = decision.behavior === "allow" && decision.scope !== "session" &&
                    !run.settled && !run.cancellationRequested && !signal.aborted && !closed;
                  emit({ ...eventBase(run), type: "request.resolved", requestId, behavior: allowed ? "allow" : "deny", source: "user" });
                  resolve(allowed);
                };
                const aborted = () => finish({ behavior: "deny" });
                const timer = setTimeout(aborted, 15 * 60_000); timer.unref();
                run.asks.set(requestId, finish);
                signal.addEventListener("abort", aborted, { once: true });
                emit({ ...eventBase(run), type: "request.opened", requestId, requestType: "permission", tool: CONNECTED_APP_APPROVAL, summary });
              }),
            });
            if (closed) { appBroker.close(); throw new Error("Bud's app session stopped."); }
            mcpServers = mcpServers.map(server => server.name === "connected-apps" ? appBroker!.descriptor : server);
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
            if (mcpServers.some(server => server.name === "computer" || server.name === "browser")) managedService.assertCapability("computer-use");
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
            const usage = result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              emit({
                ...eventBase(run),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
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
          browserBroker?.close();
          appBroker?.cancelPending();
          memoryBroker?.cancelPending();
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
          },
        };
        sessions.add(runtime);
        return runtime;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        managedService.assertCapability("reasoning");
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const mcpServers = acpMcpServers(turn);
        if (mcpServers.some(server => server.name === "computer" || server.name === "browser")) managedService.assertCapability("computer-use");
        const args = support.spawnArgs(config, turn);
        const signature = signatureFor(cwd, args, mcpServers, turn.integrations?.composio, turn.integrations?.memoryProposals?.scope);
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
        runtime ??= createRuntime(turn, cwd, args, mcpServers, signature);
        return { turnId: runtime.resume(turn, first) };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        const version = await new Promise<string | null>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
            resolve(err ? null : stdout.trim()),
          );
        });
        if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
        return { state: "available", version, authenticated: support.isAuthenticated(env) };
      };

      const stopAll = () => {
        for (const session of [...sessions]) session.stop();
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
          stopAll();
          listeners.clear();
        },
      };
    },
  };
}

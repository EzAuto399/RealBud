// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.

import type { ApprovalPolicy, MemoryApprovalReview } from '../shared/approval-policy.ts';
import type { MemoryProposalInput, MemoryProposalResult } from '../shared/hermes-memory-proposal.ts';
import type { BrowserApprovalCard } from '../shared/browser-approval-card.ts';
import type { RunUsage } from '../shared/contracts.ts';
import type { ApprovalCardMeta } from '../shared/approval-settings.ts';

/** An app read on the exact read-only allowlist that a this-task grant may
 * cover: "Allow for this task", and "Always allow reading <app>" where
 * `always` (the person may change approval settings here). `group` is the
 * app group the grant names; the server checks it again on answer. */
export interface ApprovalReadOffer { appLabel: string; always: boolean; group: string }
/** What a broker adds to its approval card. `summary` stays plain lines. */
export interface ApprovalCardDetails {
  /** What a phone may do with this card; absent means desktop only. */
  remote?: ApprovalCardMeta['remote'];
  /** The exact request, shown under an "Exact request" disclosure. */
  detail?: string;
  readOffer?: ApprovalReadOffer;
  /** The broker's own id for this card, so a phone answer lands on its receipt. */
  reviewId?: string;
}

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;

// ── model selection ────────────────────────────────────────────────────
// "Which model" is a data value carried on the request, never a service
// binding (upstream ModelSelectionWire). instanceId is the routing key.
export interface ModelSelection {
  instanceId: InstanceId;
  model: string;
}

// ── instance configuration envelope ────────────────────────────────────
// `driver` is any slug — NOT validated against known drivers; unknown
// drivers round-trip and surface as unavailable shadow snapshots so a
// config from a newer build downgrades safely.
export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

// ── canonical runtime events ───────────────────────────────────────────
// Subset of upstream's 49-member ProviderRuntimeEvent union — the ~12 types
// the recipe says to start with, sharing one base. `raw` carries the
// native protocol message when a consumer needs to see behind the
// normalization.
export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  raw?: { source: string; payload: unknown };
}

export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "session.started"; sessionId: string | null; model?: string | null }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
        /** The Modelvia requests this turn made through the model relay. */
        usage?: RunUsage;
      }
    | { type: "item.started"; itemType: "tool" | "reasoning"; title?: string; toolFingerprint?: string }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question";
        tool: string;
        summary: string;
        choices?: string[];
        params?: unknown;
        approvalPolicy?: ApprovalPolicy;
        memoryReview?: MemoryApprovalReview;
        /** ISO time the request stops waiting. */
        deadline?: string;
        remote?: ApprovalCardDetails['remote'];
        detail?: string;
        readOffer?: ApprovalReadOffer;
        reviewId?: string;
        /** A consequential browser step: the broker's verified facts and expiry. */
        browserApproval?: BrowserApprovalCard;
        fence?: {
          surface: "portal-read" | "portal-prefill" | "portal-submit";
          origin: string;
          ruleOffer: {
            surface: "portal-read" | "portal-prefill";
            origin: string;
            label: string;
          } | null;
        };
      }
    | { type: "request.resolved"; behavior: string; source: string; resolution?: ApprovalCardMeta['resolution'] }
    | { type: "thread.token-usage.updated"; input: number; output: number; cachedRead?: number; thought?: number }
    // `setup: true` marks a failure the user fixes by installing or
    // configuring something, not by retrying — the UI offers setup instead.
    | { type: "runtime.error"; message: string; setup?: boolean }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

// ── adapter contract (upstream ProviderAdapterShape, promise-flavored) ──
// The conversation runtime every provider is flattened into. streamEvents
// becomes onEvent(listener) → unsubscribe; sessions start implicitly on
// the first turn (the agentcal per-turn-process model) with resumeCursor
// carrying the provider-native continuation (e.g. a claude session id).
export interface SendTurnInput {
  threadId: ThreadId;
  text: string;
  model?: string;
  resumeCursor?: unknown;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    /** Host-selected workroom for fixed read-only Ask reads (server/workroom-read-broker.ts);
     * never a worker-supplied root. `scope` binds warm runtime reuse to one member;
     * `active` answers whether that member may still read. */
    workroom?: { root: string; scope: string; active(): boolean };
    /** Host-only proposal capability. The opaque scope binds warm runtime reuse;
     * only a private MCP descriptor is serialized to the Hermes worker. */
    memoryProposals?: {
      scope: string;
      propose(input: MemoryProposalInput, signal: AbortSignal): Promise<MemoryProposalResult>;
    };
    /** A server-bound saved job or Ask task; never a model-supplied browser or account.
     * `grant` is the task's saved grant and `active` answers whether it still holds
     * (false once Stop, expiry or the step limit ended it). */
    browser?: { runId: string; allowedOrigins: string[]; capabilities: import("../shared/contracts.ts").JobCapability[]; checkpoint?: import("../shared/browser.ts").BrowserCheckpoint;
      grant?: import("../shared/browser-task.ts").BrowserTaskGrant; active?: () => boolean };
    /** A person-started desktop task: one app window (`grant.desktop`, server/desktop-broker.ts).
     * Mounted as `workdesktop` instead of `browser`, never beside it or a raw computer server.
     * `decisions` (pick_control) only for a person's own attended Ask while Jev is ready;
     * `step` records the broker's decisions as the task's evidence. Typed without server/desktop-broker.ts
     * (as decide-broker does) so the app's types never load the Jev client. */
    desktop?: { runId: string; grant: import("../shared/browser-task.ts").BrowserTaskGrant; active?: () => boolean;
      /** `decide` is jev-client's own (it also takes model, image and timeoutMs). */
      decisions?: import("./decide-broker.ts").BudDecisions & { lunaReady(): boolean };
      step?: (step: { at: number; tool: string; outcome: string; note: string }) => void };
    composio?: {
      allowedApps?: string[];
      url?: string;
      key: string;
      /** Platform session MCP headers (e.g. x-api-key). Never echo to the worker process env. */
      headers?: Record<string, string>;
      /** Server-owned project Gmail binding. Never sent to the worker. */
      gmailReadOnly?: { authConfigId: string; userId: string; accountId: string; requestId: string };
      /** The office's managed connection service is upstream: its tools are
       * classified (read / review / blocked). Direct connections review everything. */
      managed?: boolean;
    };
    /** Mailbox mode `both` on a computer the owner allowed: the office shared
     * mailbox as its own managed session ("office-mail"), beside the person's own
     * Gmail in `composio`. Its headers select the office mailbox at the gateway,
     * which still checks this computer's grant. Mounted only for a turn whose
     * own message asks for the office mailbox. `address` is the gateway-confirmed
     * office address its cards name. Never sent to the worker. */
    officeMail?: { url: string; key: string; headers: Record<string, string>; address?: string };
    /** RealBud's own SSRF-guarded public page reader (`read_page`). `allowedUrls`
     * are the links the person wrote in this conversation's own messages
     * (`personUrls`); no other link can be read. No credentials. */
    webPages?: { allowedUrls: string[] };
    /** `open_for_sign_in` (server/browser-sign-in.ts): opens the work browser on a
     * known site's or a person-typed HTTPS address's sign-in page. `personUrls`
     * come from the person's own messages; `approvedSites` from the office. */
    signIn?: { personUrls: string[]; approvedSites: string[] };
    /** A member's own Hermios CRM, read-only (`crm_search`, `crm_get_record`).
     * `scope` (opaque, per member) and `generation` bind warm-session reuse;
     * `accessToken` must refuse any other generation. Never serialized. */
    hermiosCrm?: { scope: string; generation: number; accessToken(signal: AbortSignal): Promise<string>;
      /** Hermios workspace UUID (record-lease namespace) and membership id
       * (`expectedProfileId`); attribution labels are descriptive only. */
      workspace?: string; profileId?: string; memberName?: string; department?: string };
    /** Private Desk reminders for this member and thread (`set_reminder`). No card. */
    reminders?: import("./reminders-broker.ts").BudReminders;
    /** The person's Desk saved views (`views_*`). Changes show the one-time card. */
    workspaceViews?: import("./workspace-views-broker.ts").BudWorkspaceViews;
    /** The office's working rules (`workflow_settings_*`). Changes and restores show the one-time card. */
    workflowSettings?: import("./workflow-settings-broker.ts").BudWorkflowSettings;
    /** The office's bank feed, read-only (`bank_accounts_list`, `bank_transactions_list`). No card, no writes. */
    bankSource?: import("./bank-source-broker.ts").BudBankSource;
    /** Typed Jev questions (`decide`): suggestions only, never an approval. Bound only for a person's own attended Ask while Jev is ready. */
    decisions?: import("./decide-broker.ts").BudDecisions;
    /** The office's added connectors: reviewed, allowlisted tools of active connectors. Reads have no card; writes show the one-time card; credentials stay with the host. */
    mcpConnectors?: import("./mcp-connector-broker.ts").BudMcpConnectors;
    /** Cloud computer, reached through RealBud's REST-to-MCP adapter. */
    computer?: { kind?: "box"; boxId: string; token: string };
    /** Direct stdio connection to a Cua Driver MCP server (host or sandbox). */
    localComputer?: { command: string; args: string[]; env: Record<string, string> };
    /** Peer-agent comms: an MCP proxy (list_bots / ask_bot) that routes back
     * through the harness so this bot can message other bots. The harness
     * owns turns, permissions, and recursion limits; the proxy only forwards. */
    agents?: { command: string; args: string[]; env: Record<string, string> };
  };
  cwd?: string;
}

export interface TurnStartResult {
  turnId: TurnId;
}

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    /** True when the driver mounts turn.integrations.agents as MCP tools —
     * the harness only offers agents tooling (and prompts about it) to
     * drivers that can actually hand it to the agent. */
    agentsMcp?: boolean;
    /** True when the driver mounts turn.integrations.computer (the box's
     * screenshot/click tools). Same rule as agentsMcp: a bot must never be
     * told it has a computer whose tools its driver cannot mount — it
     * burns turns hunting for tools that aren't there. */
    computerMcp?: boolean;
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: {
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** Prefer a provider-native, expiring grant for matching steps in the
       * current work session. Providers without that scope safely fall back
       * to a one-time decision. */
      scope?: "once" | "session";
    },
  ): Promise<void>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

// ── provider snapshot (upstream ServerProviderShape, reduced) ────────────
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  version?: string | null;
}

// ── engine install descriptor ───────────────────────────────────────────
// How a user gets this engine onto their machine. Declared by the driver so
// that adding a provider stays "one file in drivers/ plus a registration":
// onboarding, the model picker, and settings all render from this instead of
// hardcoding per-engine copy in the UI.
//
// Installing is rarely the whole job — most CLIs then need an interactive
// sign-in, which is why signInCommand exists and why the UI sends people to a
// terminal rather than trying to shell out silently.
export interface EngineInstall {
  /** One-liner per platform. Omit a platform that has no such command —
   * the UI falls back to docsUrl rather than offering something that
   * cannot work there (a curl|bash line is not a Windows command). */
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  /** Docs or download page. The only route for GUI-installed engines. */
  docsUrl?: string;
  /** Interactive sign-in run after installing, when install isn't enough. */
  signInCommand?: string;
  /** `command` needs npm on PATH, so the UI can say so when Node is absent. */
  needsNode?: boolean;
}

// ── driver SPI (upstream ProviderDriver — a plain record, not a service) ─
// `create` owns ALL per-instance state; two create calls share nothing.
// Failures must reject, never throw synchronously — the registry downgrades
// a rejection to an unavailable shadow snapshot.
export interface ModelCatalog {
  default: string;
  options: Array<{ id: string; label: string }>;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  /** Cheap one-shot text call (upstream TextGeneration) — titles, summaries. */
  generateText?(prompt: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: { displayName: string; supportsMultipleInstances?: boolean };
  /** How to get this engine installed. Omit for engines that need no local
   * binary (API-key drivers), which is what makes it optional. */
  readonly install?: EngineInstall;
  /** Decode the opaque config envelope; throw on invalid (→ shadow). */
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();

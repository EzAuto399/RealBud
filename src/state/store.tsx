import { officeSources, watchOfficeSources } from "@/lib/connected-apps-refresh";
// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MausColor, MausMotion } from "@/lib/mascot";
import type { Loop, LoopRun } from "@/lib/routines";
import type { ScheduleRecovery } from "@shared/contracts";
import { mergeLoopRuns, mergeLoopClock, mergeLoopClocks, mergeScheduleRecovery, mergeJobRuns } from "@/lib/schedule-state";
import type { DeskSnapshot, JobRun } from "@/lib/desk";
import { EMPTY_JOB_DRAFT, type JobDraftState } from "@/lib/job-plan";
import { currentCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { SERVICE_UNAVAILABLE_EVENT, isLocalServiceProxyFailure, localServiceError } from "@/lib/api-error";
import { notifyDeskNeedsYou } from "@/lib/notify-desktop";
import { STREAM_COMMIT_INTERVAL_MS } from "@/lib/chat-scroll";
import { readWorkerIssues, type WorkerIssue } from "@/lib/worker-issues";
import type { AskWorkContext } from "@/lib/work-continuation";

export type { MausColor } from "@/lib/mascot";

export type PortalFenceSurface = "portal-read" | "portal-prefill" | "portal-submit";
export type PortalRuleOfferSurface = "portal-read" | "portal-prefill";

/** request.opened fence on a fenced computer permission. */
export type RequestFence = {
  surface: PortalFenceSurface;
  origin: string;
  ruleOffer: { surface: PortalRuleOfferSurface; origin: string; label: string } | null;
};

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question). */
  requestId?: string;
  /** permission asks: the tool being requested (drives the approval box) */
  tool?: string;
  /** why auto mode stopped to ask anyway */
  held?: string;
  /** the narrow grant "always allow" remembers, e.g. "Bash:git" */
  allowKey?: string;
  /** Fenced portal request from request.opened. */
  fence?: RequestFence;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen";
  text?: string;
  card?: OptionCardData;
  /** activity messages: tool name + outcome. `spoken` is the server's
   * narration of the same chip ("reading a file"), used by call mode. */
  /** `setup` marks an error fixed by installing something, not by retrying. */
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  at: number;
  /** the message this one follows; null = thread root. Edited messages
   * share a parentId with the version they replace — that's a fork. */
  parentId?: string | null;
  /** rooms: which member said this (sender attribution). */
  from?: { botId: string; name: string; color: MausColor };
  /** emoji reactions; by = "user" or a member botId. */
  reactions?: Array<{ emoji: string; by: string }>;
  /** comm chips: "Messaged @X" linking to the bot⇄bot channel. */
  comm?: { groupId: string; withBotId: string; withName: string; withColor: MausColor };
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

/** A room: several bots + you in one shared thread. */
export interface Group {
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  /** auto-created bot⇄bot channel (ask_bot exchanges mirror here) */
  dm?: boolean;
  busyBotId?: string | null;
  messages: Message[];
}

export interface ModelSelection {
  instanceId: string;
  model: string;
}

/** One of a bot's separate contexts: its own thread, transcript and
 * provider session. The bot's threadId points at the active one. */
export interface Task {
  threadId: string;
  title: string;
  createdAt: number;
}

export interface Bot {
  id: string;
  threadId: string;
  /** every context this bot has, newest first */
  tasks?: Task[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  unread: boolean;
  busy?: boolean;
  /** One server-persisted follow-up waiting behind the active turn. */
  queuedMessage?: { id: string; text: string; at: number; threadId: string; heldReason?: "connected-app-settings-changed" | "review-required" };
  modelSelection: ModelSelection;
  /** Where this bot's computer runs; unset = auto (cloud box if one exists, else local). */
  computer?: "cloud" | "vm" | "local" | "off";
  /** auto mode: the bot approves its own tool permissions */
  autoApprove?: boolean;
  /** tools this bot may always use without asking */
  alwaysAllow?: string[];
  /** speak this bot's replies aloud as they settle */
  speakReplies?: boolean;
  /** this bot's own voice id (falls back to the app-wide one) */
  voice?: string;
  pinned?: boolean;
  hidden?: boolean;
  /** The workspace's one primary coordinator. */
  chiefOfStaff?: boolean;
  messages: Message[];
  /** leaf of the visible conversation branch (see visibleMessages) */
  activeLeafId?: string | null;
}

/** The visible conversation: walk parentId links from the active leaf back
 * to the root. Falls back to the flat list for pre-branching payloads. */
export function visibleMessages(bot: Bot): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

/** All versions of a user message (itself + the forks that replaced it),
 * oldest first. Length 1 = never edited. */
export function messageVersions(bot: Bot, message: Message): Message[] {
  if (message.role !== "user" || message.kind !== "text") return [message];
  return bot.messages
    .filter(
      (m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null),
    )
    .sort((a, b) => a.at - b.at);
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  composio: {
    configured: boolean;
    apiKeyConfigured?: boolean;
    /** Older servers omit mode; the existing consumer connection remains the default. */
    mode?: "consumer" | "gmail-readonly";
    readOnlyConfigured?: boolean;
    readOnlyAuthConfigId?: string;
  };
  box: { configured: boolean };
  /** Voice (ElevenLabs). `configured` = a key is saved; `ready` = a key AND
   * a voice, which is what it takes to actually speak. The key itself is
   * never echoed back. */
  tts?: { configured: boolean; ready: boolean; voice: string };
  /** who's using the app — collected in onboarding, shown in the sidebar */
  profile?: { name: string; email: string };
}

/** How an engine gets installed — declared by its driver, mirrors
 * EngineInstall in server/contracts.ts. Absent for engines that need no
 * local binary. `command` omits platforms that have no one-liner. */
export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  models: { default: string; options: Array<{ id: string; label: string }> };
  capabilities?: { computerMcp?: boolean; agentsMcp?: boolean };
  install?: EngineInstall;
}

export type AppSettingsSection = "general" | "connections" | "voice" | "computer";

/** GET /api/hermes — how the pinned worker is doing. Never any secrets. */
export interface HermesStatus {
  pin: { product: string; tag: string; commit: string; profile: string };
  cli: { installed: boolean; versionText: string | null; matchesPin: boolean; compatible?: boolean; probeState?: "ok" | "missing" | "timeout" | "error" };
  pack: { installed: boolean; approvalsManual: boolean; workroomReady: boolean };
  homeDir: string;
  profileDir: string;
  installCommand: string | null;
  installerAvailable?: boolean;
  bootstrapPending?: boolean;
  signInCommand: string;
  detail: string;
  ready: boolean;
  lastTest?: { at: number; ok: boolean; detail: string; kind: "ping" | "recheck" } | null;
  lastPing?: { at: number; ok: boolean; detail: string; kind: "ping" | "recheck" } | null;
  model?: { attached: boolean; provider: string | null; model: string | null };
}

interface AppState {
  bots: Bot[];
  groups: Group[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  hermes: HermesStatus | null;
  /** Recent Bud / worker / phone failures, newest first. */
  workerIssues: WorkerIssue[];
  /** selected chat — a bot id OR a group id */
  selectedId: string;
  activeView: "chat" | "schedule" | "desk" | "ask" | "you";
  /** Bumped when a caller sends the user to Desk straight into Book mode. */
  deskBookNonce: number;
  loops: Loop[];
  loopRuns: LoopRun[];
  scheduleRecovery: ScheduleRecovery;
  /** Attended and prepared job receipts, newest first (SSE + hydrate). */
  jobRuns: JobRun[];
  activityLoad: { jobs: "loading" | "ready" | "error"; routines: "loading" | "ready" | "error" };
  jobDraft: JobDraftState;
  jobDraftBusy: boolean;
  askWorkContext: AskWorkContext | null;
  /** latest Desk snapshot pushed by the server (a clock loop pressed Recheck) */
  desk: DeskSnapshot | null;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  connected: boolean;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
}

type Action =
  | { type: "hydrate"; bots: Bot[]; groups: Group[] }
  | { type: "showRoutines" }
  | { type: "showDesk"; book?: boolean }
  | { type: "showAsk" }
  | { type: "stageAskContext"; context: AskWorkContext }
  | { type: "consumeAskContext"; id: string }
  | { type: "showYou" }
  | { type: "loopsHydrated"; loops: Loop[]; runs: LoopRun[]; recovery?: ScheduleRecovery }
  | { type: "scheduleRecovery"; recovery: ScheduleRecovery }
  | { type: "jobRuns"; runs: JobRun[] }
  | { type: "activityLoading" }
  | { type: "activityLoadFailed"; source: "jobs" | "routines" }
  | { type: "jobRun"; run: JobRun }
  | { type: "jobDraft"; draft: JobDraftState }
  | { type: "jobDraftBusy"; busy: boolean }
  | { type: "loopPatched"; loop: Loop }
  | { type: "loopRunPatched"; run: LoopRun }
  | { type: "markLoopRunSeen"; runId: string }
  | { type: "deskSnapshot"; snapshot: DeskSnapshot }
  | { type: "groupPatched"; group: Partial<Group> & { id: string } }
  | { type: "groupDeleted"; groupId: string }
  | { type: "createGroup"; memberIds: string[]; name?: string }
  | { type: "sendGroup"; groupId: string; text: string }
  | {
      type: "patchGroup";
      groupId: string;
      patch: Partial<Pick<Group, "name" | "bulletin" | "memberIds" | "defaultResponder">>;
    }
  | { type: "deleteGroup"; groupId: string }
  | { type: "toggleReaction"; threadId: string; messageId: string; emoji: string }
  | { type: "interruptGroup"; groupId: string }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "hermesStatus"; status: HermesStatus }
  | { type: "workerIssues"; issues: WorkerIssue[] }
  | { type: "workerIssue"; issue: WorkerIssue }
  | { type: "select"; id: string }
  | { type: "send"; botId: string; text: string; onSettled?: (error?: unknown) => void }
  | { type: "editMessage"; botId: string; messageId: string; text: string }
  | { type: "switchBranch"; botId: string; messageId: string }
  | { type: "threadActive"; threadId: string; activeLeafId: string }
  | { type: "answerCard"; botId: string; messageId: string; answer: string }
  | { type: "dismissCard"; botId: string; messageId: string }
  // permission cards answer by THREAD, so a request raised inside a room
  // can be answered the same way as one in a 1:1 chat
  | {
      type: "decideRequest";
      threadId: string;
      requestId: string;
      behavior: "allow" | "deny" | "answer";
      message?: string;
      /** Expiring provider-native grant for matching steps in this task. */
      scope?: "once" | "session";
      /** Standing site rule saved with this allow (portal read/prefill). */
      rule?: { surface: PortalRuleOfferSurface; origin: string };
      /** remember this exact grant (the server's allowKey) for the bot */
      alwaysAllow?: { botId: string; key: string };
    }
  | { type: "newTask"; botId: string }
  | { type: "switchTask"; botId: string; threadId: string }
  | { type: "renameTask"; botId: string; threadId: string; title: string }
  | { type: "deleteTask"; botId: string; threadId: string }
  | { type: "newBot" }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: Partial<Bot> & { id: string } }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleAppSettings"; open?: boolean; section?: AppSettingsSection }
  | {
      type: "updateBot";
      botId: string;
      patch: Partial<
        Pick<
          Bot,
          | "name"
          | "title"
          | "description"
          | "notifications"
          | "computer"
          | "color"
          | "mascotExpression"
          | "autoApprove"
          | "speakReplies"
          | "voice"
          | "pinned"
          | "hidden"
          | "chiefOfStaff"
        >
      >;
    };

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "jobDraft":
      return { ...state, jobDraft: action.draft };
    case "jobDraftBusy":
      return { ...state, jobDraftBusy: action.busy };
    case "hydrate": {
      const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
      const selectedId =
        state.selectedId && known(state.selectedId) ? state.selectedId : (action.bots[0]?.id ?? "");
      return { ...state, bots: action.bots, groups: action.groups, selectedId };
    }
    case "showRoutines":
      return {
        ...state,
        activeView: "schedule",
        settingsOpen: false,
        computerOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "showDesk":
      return {
        ...state,
        activeView: "desk",
        deskBookNonce: action.book ? state.deskBookNonce + 1 : state.deskBookNonce,
        settingsOpen: false,
        computerOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "consumeAskContext":
      return state.askWorkContext?.id === action.id ? { ...state, askWorkContext: null } : state;
    case "stageAskContext":
    case "showAsk": {
      const bud = state.bots.find((b) => b.id === "bud" || b.name === "Bud") ?? state.bots[0];
      return {
        ...state,
        activeView: "ask",
        askWorkContext: action.type === "stageAskContext" ? action.context : state.askWorkContext,
        selectedId: bud?.id ?? state.selectedId,
        settingsOpen: false,
        computerOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    }
    case "showYou":
      return {
        ...state,
        activeView: "you",
        settingsOpen: false,
        computerOpen: false,
        appSettingsOpen: false,
        pluginsOpen: false,
      };
    case "scheduleRecovery": {
      const recovery = mergeScheduleRecovery(state.scheduleRecovery, action.recovery);
      return { ...state, scheduleRecovery: recovery, loops: recovery.active ? state.loops.map((loop) => ({ ...loop, nextRunAt: null })) : state.loops };
    }
    case "loopsHydrated": {
      const recovery = mergeScheduleRecovery(state.scheduleRecovery, action.recovery ?? { active: false, detail: "" });
      const loops = mergeLoopClocks(state.loops, action.loops);
      return { ...state, loops: recovery.active ? loops.map((loop) => ({ ...loop, nextRunAt: null })) : loops,
        loopRuns: mergeLoopRuns(state.loopRuns, action.runs), scheduleRecovery: recovery, activityLoad: { ...state.activityLoad, routines: "ready" } };
    }
    case "activityLoading":
      return { ...state, activityLoad: { jobs: "loading", routines: "loading" } };
    case "activityLoadFailed":
      return { ...state, activityLoad: { ...state.activityLoad, [action.source]: "error" } };
    case "jobRuns":
      return { ...state, jobRuns: mergeJobRuns(state.jobRuns, action.runs), activityLoad: { ...state.activityLoad, jobs: "ready" } };
    case "jobRun":
      return { ...state, jobRuns: mergeJobRuns(state.jobRuns, [action.run]) };
    case "loopPatched": {
      const exists = state.loops.some((loop) => loop.id === action.loop.id);
      return {
        ...state,
        loops: exists
          ? state.loops.map((loop) => (loop.id === action.loop.id ? mergeLoopClock(loop, action.loop) : loop))
          : [action.loop, ...state.loops],
      };
    }
    case "loopRunPatched":
      return { ...state, loopRuns: mergeLoopRuns(state.loopRuns, [action.run]) };
    case "deskSnapshot":
      return { ...state, desk: action.snapshot };
    case "groupPatched": {
      const exists = state.groups.some((g) => g.id === action.group.id);
      const groups = exists
        ? state.groups.map((g) => (g.id === action.group.id ? { ...g, ...action.group, messages: action.group.messages ?? g.messages } : g))
        : [{ ...(action.group as Group), messages: action.group.messages ?? [] }, ...state.groups];
      return { ...state, groups };
    }
    case "groupDeleted": {
      const groups = state.groups.filter((g) => g.id !== action.groupId);
      const selectedId = state.selectedId === action.groupId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, groups, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "configStatus":
      return { ...state, config: action.config };
    case "hermesStatus":
      return { ...state, hermes: action.status };
    case "workerIssues":
      return { ...state, workerIssues: action.issues };
    case "workerIssue": {
      const issues = [action.issue, ...state.workerIssues.filter((row) => row.id !== action.issue.id)].slice(0, 20);
      return { ...state, workerIssues: issues };
    }
    case "select": {
      if (state.groups.some((g) => g.id === action.id)) {
        return {
          ...state,
          activeView: "chat",
          selectedId: action.id,
          groups: state.groups.map((g) => (g.id === action.id ? { ...g, unread: false } : g)),
        };
      }
      return updateBot(
        withMascotMotion({ ...state, activeView: "chat", selectedId: action.id }, action.id, "switch"),
        action.id,
        (b) => ({ ...b, unread: false }),
      );
    }
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard":
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, { answered: action.answer }),
        action.botId,
        "working",
      );
    case "dismissCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "decideRequest":
      return state; // the server's request.resolved patch settles the card
    case "botAdded":
      return withMascotMotion({
        ...state,
        bots: [action.bot, ...state.bots],
        activeView: "chat",
        selectedId: action.bot.id,
      }, action.bot.id, "arrive");
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bots, selectedId };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({ ...b, unread: true }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const animated = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      const next = action.bot.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.bot.id ? b : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      return updateBot(next, action.bot.id, (b) => ({ ...b, ...action.bot, messages: b.messages }));
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        // room thread — plain linear append, no branching/mascot machinery
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        if (group.messages.some((m) => m.id === action.message.id)) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id ? { ...g, messages: [...g.messages, action.message] } : g,
          ),
        };
      }
      // every server-side append chains onto (and becomes) the active leaf
      const next = updateBot(state, bot.id, (b) => {
        if (b.messages.some((m) => m.id === action.message.id)) {
          return { ...b, activeLeafId: action.message.id };
        }
        let messages = [...b.messages, action.message];
        // base64 screen frames are big; a long computer-use session would
        // grow memory without bound. Keep the newest few frames' pixels and
        // strip the rest (the message row survives as a placeholder).
        if (action.message.kind === "screen") {
          const withPng = messages.filter((m) => m.kind === "screen" && m.png);
          const excess = withPng.length - MAX_KEPT_SCREEN_FRAMES;
          if (excess > 0) {
            const dropIds = new Set(withPng.slice(0, excess).map((m) => m.id));
            messages = messages.map((m) => (dropIds.has(m.id) ? { ...m, png: undefined } : m));
          }
        }
        return { ...b, messages, activeLeafId: action.message.id };
      });
      const motion =
        action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      return animated;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) {
        const group = state.groups.find((g) => g.threadId === action.threadId);
        if (!group) return state;
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === group.id
              ? { ...g, messages: g.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
              : g,
          ),
        };
      }
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "screenFrame":
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    // bot settings, the computer panel, and app settings share the right slot
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        appSettingsSection: action.section ?? state.appSettingsSection,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression");
      const animated = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      const next = action.patch.chiefOfStaff
        ? {
            ...animated,
            bots: animated.bots.map((b) =>
              b.id === action.botId ? b : { ...b, chiefOfStaff: false },
            ),
          }
        : animated;
      return updateBot(next, action.botId, (b) => ({ ...b, ...action.patch }));
    }
    case "threadActive": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(state, bot.id, (b) => ({
        ...b,
        activeLeafId: action.activeLeafId,
      }));
    }
    // optimistic leaf move; the server's thread frame confirms it later
    case "switchBranch": {
      const bot = state.bots.find((b) => b.id === action.botId);
      if (!bot) return state;
      let cur = action.messageId;
      for (;;) {
        const children = bot.messages.filter((m) => m.parentId === cur);
        if (!children.length) break;
        cur = children.reduce((a, b) => (b.at >= a.at ? b : a)).id;
      }
      return updateBot(state, action.botId, (b) => ({ ...b, activeLeafId: cur }));
    }
    // optimistic room edits; the server's group frame confirms them later
    case "patchGroup":
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.groupId ? { ...g, ...action.patch } : g)),
      };
    case "toggleReaction": {
      const toggle = (m: Message): Message => {
        if (m.id !== action.messageId) return m;
        const reactions = m.reactions ?? [];
        const at = reactions.findIndex((r) => r.emoji === action.emoji && r.by === "user");
        const next = at >= 0 ? reactions.filter((_, i) => i !== at) : [...reactions, { emoji: action.emoji, by: "user" }];
        return { ...m, reactions: next.length ? next : undefined };
      };
      return {
        ...state,
        bots: state.bots.map((b) =>
          b.threadId === action.threadId ? { ...b, messages: b.messages.map(toggle) } : b,
        ),
        groups: state.groups.map((g) =>
          g.threadId === action.threadId ? { ...g, messages: g.messages.map(toggle) } : g,
        ),
      };
    }
    // handled entirely by the async wrapper
    case "send":
    case "editMessage":
      return withMascotMotion(state, action.botId, "working");
    case "newTask":
    case "switchTask":
    case "renameTask":
    case "deleteTask":
      return state;
    case "newBot":
    case "duplicateBot":
    case "interrupt":
    case "createGroup":
    case "sendGroup":
    case "deleteGroup":
    case "interruptGroup":
    case "markLoopRunSeen":
      return state;
  }
}

/** Newest screen frames whose pixels stay in memory per thread. */
const MAX_KEPT_SCREEN_FRAMES = 8;
const initialState: AppState = {
  bots: [],
  groups: [],
  instances: [],
  config: null,
  hermes: null,
  workerIssues: [],
  selectedId: "",
  activeView: "desk",
  deskBookNonce: 0,
  loops: [],
  loopRuns: [],
  scheduleRecovery: { active: false, detail: "" },
  jobRuns: [],
  activityLoad: { jobs: "loading", routines: "loading" },
  jobDraft: EMPTY_JOB_DRAFT,
  jobDraftBusy: false,
  askWorkContext: null,
  desk: null,
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  appSettingsSection: "general",
  screens: {},
  provisioning: {},
  connected: false,
  error: null,
  mascotMotion: null,
};

// ── API client ─────────────────────────────────────────────────────────
let sessionToken = "";

export async function ensureSession(force = false): Promise<string> {
  if (sessionToken && !force) return sessionToken;
  sessionToken = "";
  const res = await fetch("/api/session");
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "session refused");
  sessionToken = String(body.token ?? "");
  return sessionToken;
}

export async function api(path: string, init?: RequestInit, opts?: { timeoutMs?: number }): Promise<any> {
  const unavailable = (cause?: unknown): never => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(SERVICE_UNAVAILABLE_EVENT));
    throw localServiceError(cause);
  };
  const call = async () => {
    const token = await ensureSession().catch(() => "");
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (token) headers.set("x-realbud-session", token);
    // A hung service must surface as a failure the PM can retry, never as a
    // permanent "Saving…". Callers with a known budget pass it; worker calls
    // (Recheck can take a minute) keep the default of no client-side limit.
    const signal = init?.signal ?? (opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined);
    return fetch(path, { ...init, headers, signal });
  };
  const request = async () => {
    try {
      return await call();
    } catch (cause) {
      // Leaving a view cancels its read; that is not a service outage.
      if (init?.signal?.aborted) throw cause;
      return unavailable(cause);
    }
  };
  let res = await request();
  // a harness restart mints a new session token; re-handshake once and retry
  // so the desk survives a server bounce without a blank page
  if (res.status === 401) {
    await ensureSession(true).catch(() => "");
    res = await request();
  }
  const body = await res.json().catch(() => ({}));
  if (isLocalServiceProxyFailure(res.status, body.error)) unavailable();
  if (!res.ok) throw Object.assign(new Error(body.error ?? `${res.status} ${res.statusText}`), { status: res.status });
  return body;
}

/** Per-frame stream state lives in its OWN context: token frames update only
 * the components that read this hook (the chat's streaming tail), while every
 * useStore consumer — sidebar, mascots, pickers, the settled transcript —
 * keeps its render tree untouched during a stream. */
interface StreamState {
  /** in-flight assistant text per threadId */
  streaming: Record<string, string>;
  /** in-flight extended thinking per threadId (ephemeral) */
  reasoning: Record<string, string>;
}
const EMPTY_STREAM: StreamState = { streaming: {}, reasoning: {} };
const StreamContext = createContext<StreamState>(EMPTY_STREAM);

export function useStreaming() {
  return useContext(StreamContext);
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  /** Re-fetch engine availability — after an install, without a restart. */
  refreshInstances: () => Promise<void>;
  /** Re-probe the pinned Hermes worker (version, pack, approvals). */
  refreshHermes: () => Promise<void>;
  /** Reload activity without dropping the last usable results. */
  refreshActivity: () => Promise<void>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const activityRequest = useRef(0);
  const refreshActivity = useCallback(async () => {
    const request = ++activityRequest.current;
    const current = () => request === activityRequest.current;
    rawDispatch({ type: "activityLoading" });
    await Promise.allSettled([
      api("/api/job-runs", undefined, { timeoutMs: 15_000 })
        .then(({ runs }) => current() && rawDispatch({ type: "jobRuns", runs: runs ?? [] }))
        .catch(() => current() && rawDispatch({ type: "activityLoadFailed", source: "jobs" })),
      api("/api/loops", undefined, { timeoutMs: 15_000 })
        .then(({ loops, runs, recovery }) => current() && rawDispatch({ type: "loopsHydrated", loops, runs: runs ?? [], recovery }))
        .catch(() => current() && rawDispatch({ type: "activityLoadFailed", source: "routines" })),
    ]);
  }, []);
  // per-frame stream-delta batching (see the "runtime" SSE case); stream
  // state is intentionally OUTSIDE the reducer so token frames re-render
  // only StreamContext consumers
  const [stream, setStream] = useState<StreamState>(EMPTY_STREAM);
  const deltaBuffer = useRef(new Map<string, { text: string; reasoning: string }>());
  const deltaFlush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedExternalRequests = useRef(new Set<string>());
  const clearStream = (threadId: string) => {
    // Drop the thread's un-flushed deltas too: the settled message that
    // triggered this clear already contains them. Without this, the pending
    // rAF re-creates a "ghost" stream bubble holding the tail fragment —
    // it renders below any card/chip that settled next (so a permission
    // card looks glued to the top), keeps the caret blinking while the bot
    // is actually waiting, and the next block's deltas append onto the
    // duplicated tail instead of starting a fresh bubble.
    deltaBuffer.current.delete(threadId);
    setStream((prev) => {
      if (!(threadId in prev.streaming) && !(threadId in prev.reasoning)) return prev;
      const { [threadId]: _s, ...streaming } = prev.streaming;
      const { [threadId]: _r, ...reasoning } = prev.reasoning;
      return { streaming, reasoning };
    });
  };
  const flushDeltas = () => {
    if (deltaFlush.current !== null) {
      clearTimeout(deltaFlush.current);
      deltaFlush.current = null;
    }
    const buf = deltaBuffer.current;
    if (buf.size === 0) return;
    const entries = [...buf];
    buf.clear();
    setStream((prev) => {
      const streaming = { ...prev.streaming };
      const reasoning = { ...prev.reasoning };
      for (const [threadId, d] of entries) {
        if (d.text) streaming[threadId] = (streaming[threadId] ?? "") + d.text;
        if (d.reasoning) reasoning[threadId] = (reasoning[threadId] ?? "") + d.reasoning;
      }
      return { streaming, reasoning };
    });
  };

  // debounced PATCH per bot for text-field edits (name/title/description)
  const patchTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, unknown> }>());

  const dispatch = useMemo(() => {
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
    };
    // fire-and-forget card persistence; the route is optional server-side
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };

    const sending = new Set<string>();
    const turnPolls = new Map<string, symbol>();
    const pollTurnUntilSettled = async (botId: string) => {
      const generation = Symbol(botId);
      turnPolls.set(botId, generation);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        if (turnPolls.get(botId) !== generation) return;
        try {
          const { bots, groups } = await api("/api/bots");
          rawDispatch({ type: "hydrate", bots, groups: groups ?? [] });
          const bot = (bots as Bot[]).find((candidate) => candidate.id === botId);
          if (!bot?.busy) break;
        } catch {
          // The bounded poll is only the restart fallback; the SSE reconnect
          // and the next API retry continue owning the visible offline state.
        }
      }
      if (turnPolls.get(botId) === generation) turnPolls.delete(botId);
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      if (action.type === "send") {
        if (sending.has(action.botId)) {
          action.onSettled?.(new Error("A request is already being submitted. Your draft is kept."));
          return;
        }
        sending.add(action.botId);
      }
      rawDispatch(action);
      switch (action.type) {
        case "markLoopRunSeen":
          api(`/api/loop-runs/${action.runId}/seen`, { method: "POST" }).catch(showError);
          break;
        case "send":
          api(`/api/bots/${action.botId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          })
            .then(() => {
              action.onSettled?.();
              void pollTurnUntilSettled(action.botId);
            }, (error) => {
              action.onSettled?.(error);
              showError(error);
            })
            .finally(() => sending.delete(action.botId));
          break;
        case "editMessage":
          api(`/api/bots/${action.botId}/messages/${action.messageId}/edit`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "switchBranch":
          api(`/api/bots/${action.botId}/active-branch`, {
            method: "POST",
            body: JSON.stringify({ messageId: action.messageId }),
          }).catch(showError);
          break;
        case "decideRequest": {
          const respond = () =>
            api(`/api/threads/${action.threadId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: action.requestId,
                behavior: action.behavior,
                message: action.message,
                scope: action.scope,
                rule: action.rule,
              }),
            }).catch(showError);
          if (action.alwaysAllow) {
            const bot = stateRef.current.bots.find((b) => b.id === action.alwaysAllow!.botId);
            // save the grant BEFORE releasing the bot: it may ask again
            // within milliseconds, and a grant that hasn't landed yet
            // would make "always allow" ask a second time. A failed save
            // still lets this one through — losing a preference must not
            // strand the turn — but it says so.
            const save = bot && (bot.id === "bud" || bot.name === "Bud")
              ? api("/api/rules", {
                  method: "POST",
                  body: JSON.stringify({ key: action.alwaysAllow.key, decision: "allow" }),
                })
              : api(`/api/bots/${action.alwaysAllow.botId}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    alwaysAllow: [...new Set([...(bot?.alwaysAllow ?? []), action.alwaysAllow.key])],
                  }),
                });
            void save.catch(showError).finally(respond);
            break;
          }
          void respond();
          break;
        }
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            const behavior =
              action.answer === "Allow" ? "allow" : action.answer === "Deny" ? "deny" : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: behavior === "answer" ? action.answer : undefined,
              }),
            }).catch(showError);
          } else {
            persistCard(action.botId, action.messageId, { answered: action.answer });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: `${source.name} copy`,
                  title: source.title,
                  description: source.description,
                  notifications: source.notifications,
                  modelSelection: source.modelSelection,
                  ...(source.computer ? { computer: source.computer } : {}),
                }),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          api(`/api/bots/${action.botId}`, { method: "DELETE" }).catch(showError);
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          const group = stateRef.current.groups.find((g) => g.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          } else if (group?.unread) {
            api(`/api/groups/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          }
          break;
        }
        case "createGroup":
          api(`/api/groups`, {
            method: "POST",
            body: JSON.stringify({ memberIds: action.memberIds, name: action.name }),
          })
            .then(({ group }) => {
              rawDispatch({ type: "groupPatched", group });
              rawDispatch({ type: "select", id: group.id });
            })
            .catch(showError);
          break;
        case "sendGroup":
          api(`/api/groups/${action.groupId}/messages`, {
            method: "POST",
            body: JSON.stringify({ text: action.text }),
          }).catch(showError);
          break;
        case "patchGroup":
          api(`/api/groups/${action.groupId}`, {
            method: "PATCH",
            body: JSON.stringify(action.patch),
          }).catch(showError);
          break;
        case "deleteGroup":
          api(`/api/groups/${action.groupId}`, { method: "DELETE" }).catch(showError);
          break;
        case "toggleReaction":
          api(`/api/threads/${action.threadId}/messages/${action.messageId}/reactions`, {
            method: "POST",
            body: JSON.stringify({ emoji: action.emoji, by: "user" }),
          }).catch(showError);
          break;
        case "setModel":
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection }),
          }).catch(showError);
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        // tasks: the server answers with the bot AND the live transcript,
        // because switching changes which conversation is on screen
        case "newTask":
          api(`/api/bots/${action.botId}/tasks`, { method: "POST", body: "{}" })
            .then((r: any) => r?.bot && dispatch({ type: "botPatched", bot: r.bot }))
            .catch(showError);
          break;
        case "switchTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "POST" })
            .then((r: any) => r?.bot && dispatch({ type: "botPatched", bot: r.bot }))
            .catch(showError);
          break;
        case "renameTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, {
            method: "PATCH",
            body: JSON.stringify({ title: action.title }),
          }).catch(showError);
          break;
        case "deleteTask":
          api(`/api/bots/${action.botId}/tasks/${action.threadId}`, { method: "DELETE" })
            .then((r: any) => r?.bot && dispatch({ type: "botPatched", bot: r.bot }))
            .catch(showError);
          break;
        case "interruptGroup":
          api(`/api/groups/${action.groupId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "updateBot": {
          const timers = patchTimers.current;
          const pending = timers.get(action.botId);
          const patch = { ...pending?.patch, ...action.patch };
          if (pending) clearTimeout(pending.timer);
          timers.set(action.botId, {
            patch,
            timer: setTimeout(() => {
              timers.delete(action.botId);
              api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify(patch) }).catch(showError);
            }, 400),
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, []);

  // ── initial load + SSE fold ──────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const stopOfficeSources = watchOfficeSources();
    const loadAll = () => {
      void refreshActivity();
      api("/api/bots")
        .then(({ bots, groups }) => alive && rawDispatch({ type: "hydrate", bots, groups: groups ?? [] }))
        .catch(() => {});
      api("/api/instances")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
      api("/api/config")
        .then((config) => alive && rawDispatch({ type: "configStatus", config }))
        .catch(() => {});
      api("/api/hermes")
        .then((status) => alive && rawDispatch({ type: "hermesStatus", status }))
        .catch(() => {});
      api("/api/worker-issues")
        .then((body) => alive && rawDispatch({ type: "workerIssues", issues: readWorkerIssues(body) }))
        .catch(() => {});
    };
    const onFrame = (raw: MessageEvent) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.data);
      } catch {
        return;
      }
      switch (frame.kind) {
        case "office-sources":
          try { officeSources.accept(frame.access); } catch { officeSources.invalidate(); }
          break;
        case "office-sources-changed":
          window.dispatchEvent(new CustomEvent("realbud:connected-apps-refresh"));
          break;
        case "external.open": {
          const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
          if (!requestId || openedExternalRequests.current.has(requestId)) break;
          let url: URL;
          try {
            url = new URL(String(frame.url));
          } catch {
            break;
          }
          if (url.protocol !== "https:") break;
          openedExternalRequests.current.add(requestId);
          if (openedExternalRequests.current.size > 100) {
            const oldest = openedExternalRequests.current.values().next().value;
            if (oldest) openedExternalRequests.current.delete(oldest);
          }
          if (window.ogb?.openExternal) void window.ogb.openExternal(url.toString());
          else window.open(url.toString(), "_blank", "noopener,noreferrer");
          if (frame.autoRefresh) {
            window.dispatchEvent(
              new CustomEvent("realbud:connected-apps-refresh", {
                detail: { service: typeof frame.service === "string" ? frame.service : "" },
              }),
            );
          }
          break;
        }
        case "message": {
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          // a settled assistant bubble replaces the in-flight stream
          if (frame.message?.role === "bot" && frame.message?.kind === "text") {
            clearStream(frame.threadId);
            // Auto-speak lives HERE rather than in the chat view so a bot
            // you switched away from still reads its answer out — which is
            // the whole point of listening while you do something else. A
            // Auto-speak is disabled during any call. Call mode owns both the
            // singleton speaker and microphone ordering for its whole lifetime.
            const owner = stateRef.current.bots.find((b) => b.threadId === frame.threadId);
            if (owner?.speakReplies && currentCall() === null && frame.message.text?.trim()) {
              void speaker.speak(frame.message.text, {
                botId: owner.id,
                messageId: frame.message.id,
                voiceId: owner.voice,
              });
            }
          }
          break;
        }
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "thread":
          rawDispatch({ type: "threadActive", threadId: frame.threadId, activeLeafId: frame.activeLeafId });
          // a rewind also invalidates any half-streamed text from the old branch
          clearStream(frame.threadId);
          break;
        case "bot": {
          const bot = frame.bot as Partial<Bot> & { id: string };
          // reading the selected chat clears its badge immediately
          if (bot.unread && bot.id === stateRef.current.selectedId) {
            bot.unread = false;
            fetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          // Server bot frames are complete snapshots. JSON omits an absent
          // queue, but the reducer merges patches: explicitly clear the old
          // slot when a follow-up has started or been discarded.
          rawDispatch({ type: "botPatched", bot: { ...bot, queuedMessage: bot.queuedMessage } });
          break;
        }
        case "group": {
          const group = frame.group as Partial<Group> & { id: string };
          // reading the selected room clears its badge immediately
          if (group.unread && group.id === stateRef.current.selectedId) {
            group.unread = false;
            fetch(`/api/groups/${group.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "groupPatched", group });
          break;
        }
        case "group.deleted":
          rawDispatch({ type: "groupDeleted", groupId: frame.groupId });
          break;
        case "loop":
          rawDispatch({ type: "loopPatched", loop: frame.loop });
          break;
        case "loops.recovery":
          rawDispatch({ type: "scheduleRecovery", recovery: frame.recovery });
          break;
        case "loop.run":
          rawDispatch({ type: "loopRunPatched", run: frame.run });
          break;
        case "job.run":
          rawDispatch({ type: "jobRun", run: frame.run });
          break;
        case "desk":
          rawDispatch({ type: "deskSnapshot", snapshot: frame.snapshot });
          notifyDeskNeedsYou(frame.snapshot);
          break;
        case "channels":
          // Phone pairing lives in You/Desk local state; fan out so Pair chat
          // flips without a full reload once the first phone message lands.
          window.dispatchEvent(new CustomEvent("realbud:channels", { detail: frame.channels }));
          break;
        case "worker.issue":
          if (frame.issue) rawDispatch({ type: "workerIssue", issue: frame.issue });
          break;
        case "runtime": {
          const event = frame.event;
          if (event.type === "content.delta") {
            // Batch token deltas to ~30fps. A 60fps token loop makes live
            // Markdown parsing and bottom-follow compete with wheel scrolling;
            // 32ms stays visually fluid while leaving a frame for input.
            const buf = deltaBuffer.current;
            const entry = buf.get(event.threadId) ?? { text: "", reasoning: "" };
            if (event.streamKind === "assistant_text") entry.text += event.delta;
            else if (event.streamKind === "reasoning_text") entry.reasoning += event.delta;
            buf.set(event.threadId, entry);
            if (deltaFlush.current === null) {
              deltaFlush.current = setTimeout(() => {
                deltaFlush.current = null;
                flushDeltas();
              }, STREAM_COMMIT_INTERVAL_MS);
            }
          } else if (event.type === "turn.completed") {
            // flush any buffered tail before clearing so no tokens are lost
            flushDeltas();
            clearStream(event.threadId);
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "bot.deleted":
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: {
              xai: frame.xai,
              composio: frame.composio,
              box: frame.box,
              tts: frame.tts,
              profile: frame.profile,
            },
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const scheduleReconnect = () => {
      if (!alive || retryTimer) return;
      const delay = Math.min(500 * 2 ** retryCount, 5_000);
      retryCount += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect(true);
      }, delay);
    };
    const connect = async (forceSession = false) => {
      let token = "";
      try {
        token = await ensureSession(forceSession);
      } catch {
        scheduleReconnect();
        return;
      }
      if (!alive) return;
      es?.close();
      const source = new EventSource(token ? `/api/events?session=${encodeURIComponent(token)}` : "/api/events");
      es = source;
      source.onopen = () => {
        if (es !== source) return;
        retryCount = 0;
        rawDispatch({ type: "connected", value: true });
        loadAll();
      };
      source.onerror = () => {
        // A close event from the replaced stream can arrive after the new
        // stream is already open. It must never close that newer connection.
        if (es !== source) {
          source.close();
          return;
        }
        rawDispatch({ type: "connected", value: false });
        source.close();
        es = null;
        scheduleReconnect();
      };
      source.onmessage = onFrame;
    };
    const onServiceUnavailable = () => {
      rawDispatch({ type: "connected", value: false });
      const stale = es;
      es = null;
      stale?.close();
      scheduleReconnect();
    };
    window.addEventListener(SERVICE_UNAVAILABLE_EVENT, onServiceUnavailable);
    void connect();
    return () => {
      alive = false;
      stopOfficeSources();
      activityRequest.current += 1;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      window.removeEventListener(SERVICE_UNAVAILABLE_EVENT, onServiceUnavailable);
    };
  }, [refreshActivity]);

  // Re-probe the engines on demand. A CLI installed while the app is running
  // is invisible until something asks again — the setup screens expose this
  // as "Check again" so the user isn't told to restart when a refresh will do.
  const refreshInstances = useCallback(async () => {
    try {
      const { instances } = await api("/api/instances");
      rawDispatch({ type: "instances", instances });
    } catch {
      /* offline or server down — the existing list stays */
    }
  }, []);

  const refreshHermes = useCallback(async () => {
    try {
      const [status, issuesBody] = await Promise.all([api("/api/hermes"), api("/api/worker-issues")]);
      rawDispatch({ type: "hermesStatus", status });
      rawDispatch({ type: "workerIssues", issues: readWorkerIssues(issuesBody) });
    } catch {
      /* offline or server down — the existing status stays */
    }
  }, []);

  // Installing a CLI or signing one in happens in a terminal, outside this
  // window — so the moment the user comes back is exactly when our engine
  // snapshot is most likely stale. Re-probe on focus, throttled so that
  // ordinary alt-tabbing doesn't spawn a `--version` call per switch.
  const lastFocusProbe = useRef(0);
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe.current < 3000) return;
      lastFocusProbe.current = now;
      void refreshInstances();
      void refreshHermes();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshInstances, refreshHermes]);

  const value = useMemo(
    () => ({ state, dispatch, refreshInstances, refreshHermes, refreshActivity }),
    [state, dispatch, refreshInstances, refreshHermes, refreshActivity],
  );
  return (
    <StoreContext.Provider value={value}>
      <StreamContext.Provider value={stream}>{children}</StreamContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

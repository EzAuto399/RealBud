import { useConversationFollow, useWorkspaceScroll } from "@/lib/workspace-view-state";
import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { AskPhoneContinueCard } from "./AskPhoneContinueCard";
import { AskScheduleCard } from "./AskScheduleCard";
import { useChannelHandoff } from "@/lib/channel-handoff";
import { usePhoneConnections } from "@/lib/phone-connections";
import { phonePaired } from "@/lib/phone-label";
import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crown,
  Loader2,
  Monitor,
  Pencil,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import {
  api,
  useStore,
  useStreaming,
  formatTime,
  messageVersions,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
} from "@/state/store";
import { askNextActions, isProductAskEmptyThread, type AskNext } from "@/lib/ask-next";
import { activeAttendedRun, attendedHeaderLabel, runStatusSuffix } from "@/lib/job-run";
import type { JobRun, Recipe } from "@/lib/desk";
import { toolLabel } from "@/lib/tool-label";

import { selectedConnectedAppsConfigured } from "./GmailReadOnlySetup";
import { morningBrief } from "@/lib/morning-brief";
import { fmtDateTime } from "@/lib/au";
import { EngineSetup } from "./EngineSetup";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { pendingApprovals } from "./PendingApproval";
import { ModelPicker } from "./ModelPicker";
import { TaskPicker } from "./TaskPicker";
import { ReactionBar, ReactionChips } from "./Reactions";
import { SpeakButton } from "./SpeakButton";
import { CallButton, CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import { scrollChatToEnd } from "@/lib/chat-scroll";
import { useStreamPreview } from "@/lib/use-stream-preview";
import { budAvailability } from "@/lib/bud-setup";
import { PmTaskStarters } from "./PmTaskStarters";
import { AskMessage } from "./AskMessage";
import { channelMessage } from "@/lib/channel-message";
import { AskReadiness } from "./AskReadiness";
import { AskContext } from "./AskContext";
import { hasUnfinishedJobDraft, repeatableJobDescription } from "@/lib/work-continuation";
import { EMPTY_JOB_DRAFT } from "@/lib/job-plan";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** "Today" / "Yesterday" / "Mon, Aug 11" — real dates, not a hardcoded label. */
function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-AU", { weekday: "short", month: "short", day: "numeric" });
}

function DaySeparator({ at }: { at: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at)} {formatTime(at)}
    </div>
  );
}

/** Hover/focus-revealed copy control shared by user + bot bubbles. */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label="Copy message"
      title="Copy message"
      className={cn(
        "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
        className,
      )}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

/** Live extended thinking: shimmer label + collapsible reasoning text.
 * Ephemeral — rendered only while the turn runs, dropped when it settles. */
function ThinkingStrip({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && tailRef.current) scrollChatToEnd(tailRef.current);
  }, [text, open]);
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] min-w-[200px]">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] hover:bg-raised/40"
        >
          <Brain size={13} className="text-ink-secondary" />
          <span className={cn(active ? "thinking-shimmer animate-shimmer" : "text-ink-secondary")}>
            {active ? "Thinking…" : "Thought process"}
          </span>
          <ChevronDown size={12} className={cn("text-ink-secondary transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div
            ref={tailRef}
            className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-hairline/30 bg-panel px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary"
          >
            {text}
          </div>
        ) : (
          active && (
            <div className="mt-0.5 truncate pl-6 text-[12px] text-ink-secondary/70">
              {text.slice(-120).split("\n").pop()}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
function ErrorRow({
  message,
  onRetry,
  setupInstance,
  retrying = false,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
  retrying?: boolean;
}) {
  const inFlight = Boolean(retrying);
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{message}</span>
        </div>
        {setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : (
          onRetry && (
            <button
              type="button"
              disabled={inFlight}
              aria-busy={inFlight}
              onClick={() => {
                if (inFlight) return;
                onRetry();
              }}
              className="pm-control mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 text-[12.5px] hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {inFlight ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {inFlight ? "Retrying…" : "Retry"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text bubble instead. */
class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="min-w-0 rounded-lg bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words text-ink">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
  productAsk = false,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  productAsk?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className={productAsk ? "ask-request ask-message-editor" : "w-full max-w-[70%] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3"}>
      {productAsk && <p className="ask-edit-hint">Sending starts a new version from here. Your original stays saved.</p>}
      <textarea
        aria-label="Edit request"
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className={productAsk ? "ask-text-button" : "rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"}
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className={productAsk ? "ask-button ask-button-primary" : "rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"}
        >
          {productAsk ? "Send edited request" : "Send"}
        </button>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  editing,
  isLastBotText,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onMakeRepeatable,
  onSendToPhone,
  onSendSummary,
  phoneHandoffBusy,
  productAsk = false,
  versionFocus,
}: {
  bot: Bot;
  message: Message;
  editing: boolean;
  isLastBotText: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  onMakeRepeatable?: () => void;
  onSendToPhone?: () => void;
  onSendSummary?: () => void;
  phoneHandoffBusy?: boolean;
  productAsk?: boolean;
  versionFocus?: RefObject<string | null>;
}) {
  const { dispatch } = useStore();
  const user = message.role === "user";
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const versionsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (versionFocus?.current === message.id && versionsRef.current) {
      versionsRef.current.focus();
      versionFocus.current = null;
    }
  }, [message.id, versionFocus]);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing && productAsk) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing, productAsk]);
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const collapsible =
    user && !expanded && (text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={productAsk ? channelMessage(text)?.body ?? text : text} productAsk={productAsk} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) {
      if (productAsk && versionFocus) versionFocus.current = v.id;
      dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
    }
  };

  if (productAsk) return (
    <AskMessage key={message.id} text={text} at={message.at} user={user} editButtonRef={editButtonRef} versionsRef={versionsRef}
      versions={user && versions.length > 1 ? {
        current: versionIndex + 1, total: versions.length,
        onPrevious: versionIndex > 0 && !bot.busy ? () => switchTo(versions[versionIndex - 1]) : undefined,
        onNext: versionIndex < versions.length - 1 && !bot.busy ? () => switchTo(versions[versionIndex + 1]) : undefined,
      } : undefined}
      onEdit={user && message.kind === "text" && !bot.busy ? onStartEdit : undefined}
      onMakeRepeatable={!user && isLastBotText && !bot.busy && text.trim() ? onMakeRepeatable : undefined}
      onSendToPhone={!user && isLastBotText && !bot.busy && text.trim() ? onSendToPhone : undefined}
      onSendSummary={!user && isLastBotText && !bot.busy ? onSendSummary : undefined}
      phoneHandoffBusy={phoneHandoffBusy}>
      <MessageBoundary key={text} fallbackText={text}><ChatMarkdown text={text} /></MessageBoundary>
    </AskMessage>
  );

  return (
    <div className={cn("group animate-msg-in flex w-full flex-col", user ? "items-end" : "items-start")}>
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {/* editing rewinds the thread, so it waits for the turn to end —
            same rule as the version switcher below */}
        {user && message.kind === "text" && !bot.busy && (
          <button
            onClick={onStartEdit}
            aria-label="Edit message"
            className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            title="Edit message"
          >
            <Pencil size={14} />
          </button>
        )}
        {user && message.kind === "text" && !productAsk && <ReactionBar threadId={bot.threadId} message={message} />}
        {user && <CopyButton text={text} />}
        <div
          className={cn(
            "min-w-0 rounded-lg px-4 py-2.5 text-[15px] leading-relaxed",
            productAsk && !user ? "max-w-[90%]" : "max-w-[70%]",
            user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
          )}
          title={fmtDateTime(message.at)}
        >
          {user ? (
            <>
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
              >
                {text}
              </div>
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show full message
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show less
                </button>
              )}
            </>
          ) : (
            <MessageBoundary fallbackText={text}>
              <ChatMarkdown text={text} />
            </MessageBoundary>
          )}
        </div>
        {!user && (
          <div className="flex flex-col gap-0.5 self-end pb-0.5">
            <CopyButton text={text} />
            {message.kind === "text" && !productAsk && (
              <SpeakButton text={text} botId={bot.id} messageId={message.id} voiceId={bot.voice} />
            )}
            {isLastBotText && !bot.busy && onRegenerate && !productAsk && (
              <button
                onClick={onRegenerate}
                aria-label="Regenerate response"
                title="Regenerate response"
                className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
        )}
        {!user && message.kind === "text" && !productAsk && <ReactionBar threadId={bot.threadId} message={message} />}
        <span
          className={cn(
            "self-end pb-1 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100",
            user ? "order-first mr-1" : "ml-1",
          )}
        >
          {formatTime(message.at)}
        </span>
      </div>
      {!productAsk && <ReactionChips threadId={bot.threadId} message={message} align={user ? "right" : "left"} />}
      {versions.length > 1 && !productAsk && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Previous version"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next version"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
function ActivityChip({ message }: { message: Message }) {
  const { dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={`Open the conversation with ${comm.withName}`}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <MausAvatar color={comm.withColor} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  const failed = tool.ok === false;
  const spoken = tool.spoken?.trim();
  const label = spoken || toolLabel(tool.name);
  const title = spoken && spoken !== tool.name ? `${tool.name} · ${spoken}` : tool.name;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
          failed ? "text-danger" : "text-ink-secondary",
        )}
      >
        {tool.ok === undefined ? (
          <Loader2 size={13} className="animate-spin" />
        ) : failed ? (
          <X size={13} />
        ) : (
          <Check size={13} className="text-success" />
        )}
        <span className="max-w-[480px] truncate" title={title}>
          {label}
        </span>
      </div>
    </div>
  );
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="max-w-[70%] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  // The text stream stays responsive while expensive Markdown parsing is
  // capped below the transport cadence.
  const preview = useStreamPreview(text);
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[70%] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <MessageBoundary fallbackText={preview}>
          <ChatMarkdown text={preview} streaming />
        </MessageBoundary>
        <span className="animate-caret ml-0.5 inline-block h-[14px] w-[2px] bg-ink align-middle" />
      </div>
    </div>
  );
}

/** The only Ask subtree subscribed to token frames. Keeping this subscription
 * out of ChatView means the header, transcript, actions, and composer do not
 * re-render for every streamed chunk. */
function ChatStreamTail({
  threadId,
  busy,
  productAsk,
  since,
  onGrowth,
}: {
  threadId: string;
  busy: boolean;
  productAsk: boolean;
  since: number;
  onGrowth: () => void;
}) {
  const stream = useStreaming();
  const streaming = stream.streaming[threadId];
  const reasoning = stream.reasoning[threadId];

  useEffect(() => onGrowth(), [busy, onGrowth, reasoning, streaming]);

  return (
    <>
      {reasoning && busy && !productAsk && <ThinkingStrip text={reasoning} active={!streaming} />}
      {streaming ? (
        <StreamingBubble text={streaming} />
      ) : (
        busy && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms] motion-reduce:animate-none" />
                <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms] motion-reduce:animate-none" />
                <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms] motion-reduce:animate-none" />
              </span>
              <WorkingTimer since={since} />
            </div>
          </div>
        )
      )}
    </>
  );
}

/** "Working for 12s" that ticks by mutating textContent on an interval —
 * no React commit per second while a turn streams (upstream trick). */
function WorkingTimer({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = `Working for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} className="text-[12.5px] text-ink-secondary" />;
}

/** The settled transcript, memoized as one unit: during streaming every
 * frame re-renders ChatView, but all of these props keep their identity
 * (bot/messages only change on real message events), so the whole list —
 * every markdown tree, every code block — bails out of React work and only
 * the streaming tail below it commits. This is the t3code structural-sharing
 * idea at component granularity. */
type AskChipRowProps = {
  next: AskNext[];
  disabled?: boolean;
  align?: "center" | "start";
  onAsk: (text: string) => void;
  onRecheck: () => void;
  onDesk: () => void;
  onYou: () => void;
  onYouJobs?: () => void;
  onRoutines?: () => void;
  onInterrupt?: () => void;
  onAttend?: (recipeId: string) => void;
  onApprove?: (recipeId: string, attach: boolean) => void;
  onSetSite?: (recipeId: string) => void;
  onConnectSetup?: (connectLabel?: string) => void;
};

function AskChipRow({
  next,
  disabled,
  align = "center",
  onAsk,
  onRecheck,
  onDesk,
  onYou,
  onYouJobs,
  onRoutines,
  onInterrupt,
  onAttend,
  onApprove,
  onSetSite,
  onConnectSetup,
}: AskChipRowProps) {
  if (next.length === 0) return null;
  return (
    <div
      className={cn(
        "grid w-full max-w-[48rem] gap-2 sm:grid-cols-2",
        next.length > 2 && "lg:grid-cols-3",
        align === "center" && "mx-auto",
      )}
      role="list"
      aria-label="Next actions"
    >
      {next.map((row) => {
        const primary =
          row.kind === "approve" || row.kind === "attend" || row.kind === "set-site" || row.kind === "connect-setup" || row.id === "check-app-connection";
        return (
          <button
            key={row.id}
            type="button"
            disabled={Boolean(disabled) && row.kind !== "interrupt" && row.kind !== "routines"}
            onClick={() => {
              if (row.kind === "ask") onAsk(row.text);
              else if (row.kind === "recheck") onRecheck();
              else if (row.kind === "desk") onDesk();
              else if (row.kind === "routines") onRoutines?.();
              else if (row.kind === "interrupt") onInterrupt?.();
              else if (row.kind === "you-jobs") onYouJobs?.();
              else if (row.kind === "connect-setup") onConnectSetup?.(row.connectLabel);
              else if (row.kind === "attend") onAttend?.(row.recipeId);
              else if (row.kind === "approve") onApprove?.(row.recipeId, row.attach);
              else if (row.kind === "set-site") onSetSite?.(row.recipeId);
              else onYou();
            }}
            className={cn(
              "pm-control rounded-lg px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-40",
              primary
                ? "border border-agency/30 bg-agency text-white hover:bg-agency-hover"
                : "border border-line bg-sheet hover:border-agency/35 hover:bg-raised",
            )}
          >
            <span className={cn("block text-[13px] font-medium", primary ? "text-white" : "text-ink")}>{row.label}</span>
            <span
              className={cn(
                "mt-0.5 block text-[11.5px] leading-relaxed",
                primary ? "text-white/85" : "text-ink-muted",
              )}
            >
              {row.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A reply's sign-in follow-up must be visible without opening the task menu. */
export function AskNextActionPanel({
  next, panelRef, expanded, children, trailing, ...actions
}: AskChipRowProps & {
  panelRef?: RefObject<HTMLDetailsElement | null>;
  expanded?: boolean;
  children?: ReactNode;
  /** Compact actions (Schedule / Continue on phone) sit on the summary row. */
  trailing?: ReactNode;
}) {
  const connection = next.filter(row => row.id === "check-app-connection");
  const tasks = next.filter(row => row.id !== "check-app-connection");
  return <>
    {connection.length ? <div className="mx-auto w-full max-w-[900px] shrink-0 px-5 py-2" aria-label="Connection follow-up">
      <AskChipRow {...actions} next={connection} />
    </div> : null}
    <details ref={panelRef} className="ask-next-actions mx-auto w-full max-w-[900px] shrink-0" open={expanded || undefined}>
      <summary className="ask-next-summary">
        <span>Tasks, book &amp; saved jobs</span>
        <span className="ask-next-summary-end">
          {trailing ? <span className="ask-next-trailing" onClick={event => { event.preventDefault(); event.stopPropagation(); }}>{trailing}</span> : null}
          <ChevronDown size={14} aria-hidden />
        </span>
      </summary>
      <div className="ask-next-body">
        <AskChipRow {...actions} next={tasks} />
        {children}
      </div>
    </details>
  </>;
}

const MessagesList = memo(function MessagesList({
  bot,
  messages,
  editingId,
  lastBotTextId,
  canRetryLast,
  retrying = false,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  productAsk = false,
  askWorkerReady = true,
  askNext = [],
  askActionsDisabled = false,
  onAskStarter,
  onAskExample,
  onMakeRepeatable,
  onSendToPhone,
  onSendSummary,
  phoneHandoffBusy,
  onAskRecheck,
  onAskDesk,
  onAskYou,
  onAskRoutines,
  onAskYouJobs,
  onAskInterrupt,
  onAskAttend,
  onAskApprove,
  onAskSetSite,
  onAskConnectSetup,
}: {
  bot: Bot;
  messages: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  canRetryLast: boolean;
  retrying?: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  productAsk?: boolean;
  askWorkerReady?: boolean;
  askNext?: AskNext[];
  askActionsDisabled?: boolean;
  onAskStarter?: (text: string) => void;
  onAskExample?: (text: string) => void;
  onMakeRepeatable?: (messageId: string) => void;
  onSendToPhone?: (messageId: string) => void;
  onSendSummary?: () => void;
  phoneHandoffBusy?: boolean;
  onAskRecheck?: () => void;
  onAskDesk?: () => void;
  onAskYou?: () => void;
  onAskRoutines?: () => void;
  onAskYouJobs?: () => void;
  onAskInterrupt?: () => void;
  onAskAttend?: (recipeId: string) => void;
  onAskApprove?: (recipeId: string, attach: boolean) => void;
  onAskSetSite?: (recipeId: string) => void;
  onAskConnectSetup?: (connectLabel?: string) => void;
}) {
  const askEmpty = productAsk && isProductAskEmptyThread(messages);
  const versionFocus = useRef<string | null>(null);
  const showEmpty = (messages.length === 0 || askEmpty) && !bot.busy;
  return (
    <>
      {showEmpty && (
        <div className={cn("flex flex-1 flex-col items-center justify-center gap-3 text-center", productAsk ? "ask-welcome py-6" : "py-24")}>
          {productAsk ? (
              <>
                <div className="ask-welcome-mark"><MausAvatar color="green" state="idle" size={44} trackPointer={false} /></div>
                <p className="ask-eyebrow">A little less admin. More room for your day.</p>
                <h2 className="ask-welcome-title">What can I take off your plate?</h2>
                <div className="ask-welcome-description">
                  Give Bud an outcome. Get back prepared work you can review, refine and use again.
                </div>
                <PmTaskStarters onChoose={(text) => onAskExample?.(text)} disabled={askActionsDisabled} />
                {askWorkerReady ? <details className="mt-2 w-full max-w-[48rem] text-left">
                  <summary className="cursor-pointer py-2 text-[14px] text-ink-muted">Desk and saved jobs</summary>
                  <AskChipRow
                    next={askNext}
                    disabled={askActionsDisabled}
                    onAsk={(text) => onAskStarter?.(text)}
                    onRecheck={() => onAskRecheck?.()}
                    onDesk={() => onAskDesk?.()}
                    onYou={() => onAskYou?.()}
                    onYouJobs={() => onAskYouJobs?.()}
                    onRoutines={() => onAskRoutines?.()}
                    onInterrupt={() => onAskInterrupt?.()}
                    onAttend={(recipeId) => onAskAttend?.(recipeId)}
                    onApprove={(recipeId, attach) => onAskApprove?.(recipeId, attach)}
                    onSetSite={(recipeId) => onAskSetSite?.(recipeId)}
                    onConnectSetup={(label) => onAskConnectSetup?.(label)}
                  />
                </details> : null}
              </>
          ) : (
            <>
              <MausAvatar color={bot.color} state="idle" size={64} motion="none" motionKey={0} />
              <div className="text-[17px] font-semibold text-ink">{bot.name}</div>
              <div className="max-w-[360px] text-[14px] text-ink-secondary">
                {bot.description || "Send a message to start the conversation."}
              </div>
            </>
          )}
        </div>
      )}
      {!askEmpty &&
        messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString();
        const row = (() => {
          switch (m.kind) {
            case "options":
              // a live permission ask gets the approval box; questions and
              // the onboarding quiz keep the list card
              return m.card?.requestId && m.card.tool ? (
                <ApprovalCard bot={bot} message={m} productAsk={productAsk} />
              ) : (
                <OptionCard botId={bot.id} message={m} />
              );
            case "activity":
              // a failed turn is an error, not a tool run — render it as one
              return m.tool?.name.startsWith("error:") ? (
                <ErrorRow
                  message={m.tool.name.slice(6).trim()}
                  onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
                  retrying={retrying}
                  setupInstance={m.tool.setup ? engine : undefined}
                />
              ) : (
                <ActivityChip message={m} />
              );
            case "screen":
              return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
                  onRegenerate={onRegenerate}
                  onMakeRepeatable={onMakeRepeatable ? () => onMakeRepeatable(m.id) : undefined}
                  onSendToPhone={onSendToPhone ? () => onSendToPhone(m.id) : undefined}
                  onSendSummary={onSendSummary}
                  phoneHandoffBusy={phoneHandoffBusy}
                  productAsk={productAsk}
                  versionFocus={versionFocus}
                />
              );
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents">
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
      })}
    </>
  );
});

export function ChatView({ bot, productAsk = false }: { bot: Bot; productAsk?: boolean }) {
  const { state, dispatch, refreshHermes } = useStore();
  const scrollRef = useWorkspaceScroll(`ask-${bot.threadId}`);
  const [askAction, setAskAction] = useState<"recheck" | "attend" | "approve" | "set-site" | null>(null);
  const [askActionNotice, setAskActionNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [focusRecipeId, setFocusRecipeId] = useState<string | null>(null);
  const [setSiteRecipeId, setSetSiteRecipeId] = useState<string | null>(null);
  const [setSiteUrl, setSetSiteUrl] = useState("");
  const [phoneContinueOpen, setPhoneContinueOpen] = useState(false);
  const [scheduleContinueOpen, setScheduleContinueOpen] = useState(false);
  const [composerStarter, setComposerStarter] = useState<{ id: number; text: string } | undefined>();
  const taskPanelRef = useRef<HTMLDetailsElement>(null);
  const chooseExample = useCallback((text: string) => {
    setComposerStarter((last) => ({ id: (last?.id ?? 0) + 1, text }));
    if (taskPanelRef.current) taskPanelRef.current.open = false;
  }, []);

  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);
  const makeRepeatable = (messageId: string) => {
    if (state.jobDraftBusy || hasUnfinishedJobDraft(state.jobDraft)) {
      setAskActionNotice({ ok: false, text: "Your unfinished job plan is kept. Save or close it on Schedule before making another." });
      return;
    }
    const index = messages.findIndex((message) => message.id === messageId);
    const answer = messages[index]?.text;
    const request = messages.slice(0, index).reverse().find((message) => message.role === "user" && message.kind === "text")?.text;
    if (!answer || !request || bot.busy) return;
    dispatch({ type: "jobDraft", draft: { ...EMPTY_JOB_DRAFT, text: repeatableJobDescription(request, answer) } });
    location.hash = "bud-job-builder";
    dispatch({ type: "showRoutines" });
  };
  const { channels: phoneChannels, refresh: refreshPhone } = usePhoneConnections(productAsk);
  const phoneReady = phonePaired(phoneChannels);
  const { busy: phoneHandoffBusy, notice: phoneHandoffNotice, send: sendPhoneHandoff } = useChannelHandoff();
  useEffect(() => {
    if (phoneHandoffNotice) setAskActionNotice(phoneHandoffNotice);
  }, [phoneHandoffNotice]);
  useEffect(() => {
    if (!productAsk) return;
    void refreshPhone();
  }, [productAsk, refreshPhone]);
  const sendReplyToPhone = useCallback(
    (messageId: string) => {
      void sendPhoneHandoff({ mode: "result", messageId });
    },
    [sendPhoneHandoff],
  );
  const sendSummaryToPhone = useCallback(() => {
    void sendPhoneHandoff({ mode: "summary" });
  }, [sendPhoneHandoff]);
  useEffect(() => {
    if (!productAsk) return;
    void api("/api/desk")
      .then((snapshot) => dispatch({ type: "deskSnapshot", snapshot }))
      .catch(() => {});
  }, [productAsk, dispatch]);

  const askBrief = productAsk && state.desk ? morningBrief(state.desk) : null;
  const askMiss = Boolean(askBrief?.headline.startsWith("Recheck missed"));
  const askNeedsYou = askBrief?.needsYou ?? 0;
  const availability = budAvailability(state.hermes, state.connected, Boolean(state.desk?.recovery?.active));
  const askWorkerReady = availability.ready;
  const askWorkroomReady = Boolean(state.hermes?.cli.installed && (state.hermes.cli.compatible ?? state.hermes.cli.matchesPin) && state.hermes.pack.installed && state.hermes.pack.approvalsManual && state.hermes.pack.workroomReady);
  const askWaitingForYou = productAsk && pendingApprovals(messages).length > 0;
  const askEmptyThread = productAsk && isProductAskEmptyThread(messages);
  const [savedRecipes, setSavedRecipes] = useState<Recipe[]>([]);
  const attendedRun = useMemo(() => activeAttendedRun(state.jobRuns), [state.jobRuns]);
  const lastBotText = useMemo(
    () => [...messages].reverse().find((message) => message.role === "bot" && message.kind === "text")?.text ?? null,
    [messages],
  );
  useEffect(() => {
    if (!productAsk || !lastBotText) return;
    const needsRecipes =
      lastBotText.includes("is already a saved job") ||
      /Approve the plan/i.test(lastBotText) ||
      /Here's the plan/i.test(lastBotText) ||
      /Run beside me/i.test(lastBotText);
    if (!needsRecipes) return;
    let alive = true;
    void api("/api/recipes")
      .then((body: { recipes?: Recipe[] }) => {
        if (alive && Array.isArray(body.recipes)) setSavedRecipes(body.recipes);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [lastBotText, productAsk]);
  const askStatus = attendedRun
    ? {
        label: `${attendedHeaderLabel(attendedRun.jobTitle)}${runStatusSuffix(state.connected)}`,
        className: "border-agency/25 bg-agency/10 text-agency",
      }
    : askWaitingForYou
    ? { label: "Waiting for you", className: "border-hold/25 bg-hold/10 text-hold" }
    : availability.target === "you-recovery"
    ? { label: availability.label, className: "border-warning/30 bg-warning/10 text-warning" }
    : bot.busy
    ? { label: state.connected ? "Working" : "Reconnecting", className: "border-agency/25 bg-agency/10 text-agency" }
    : { label: availability.label, className: askWorkerReady ? "border-agency/25 bg-agency/10 text-agency" : "border-hold/25 bg-hold/10 text-hold" };
  const sendAsk = useCallback((text: string) => dispatch({ type: "send", botId: bot.id, text }), [bot.id, dispatch]);
  const goDesk = useCallback(() => dispatch({ type: "showDesk" }), [dispatch]);
  const scheduleChatHint = useMemo(() => {
    if (lastBotText?.includes("**Schedule work**")) {
      const request = [...messages].reverse().find((message) => message.role === "user" && message.kind === "text")?.text;
      if (request && !/^(?:what|show|list)/i.test(request.trim())) return request.trim();
    }
    if (state.jobDraft?.text?.trim() && !state.jobDraft.saved) return state.jobDraft.text.trim();
    return null;
  }, [lastBotText, messages, state.jobDraft?.saved, state.jobDraft?.text]);
  const openScheduleWorkspace = useCallback((intent: "map" | "job-from-chat") => {
    if (intent === "job-from-chat") {
      if (lastBotText?.includes("**Schedule work**") && !state.jobDraftBusy && !hasUnfinishedJobDraft(state.jobDraft)) {
        const request = [...messages].reverse().find((message) => message.role === "user" && message.kind === "text")?.text;
        if (request && !/^(?:what|show|list)/i.test(request.trim())) {
          dispatch({ type: "jobDraft", draft: { ...EMPTY_JOB_DRAFT, text: request } });
        }
      }
      location.hash = focusRecipeId ? `job-${focusRecipeId}` : "bud-job-builder";
    } else {
      location.hash = focusRecipeId ? `job-${focusRecipeId}` : "schedule-week";
    }
    dispatch({ type: "showRoutines" });
  }, [dispatch, focusRecipeId, lastBotText, messages, state.jobDraft, state.jobDraftBusy]);
  const goRoutines = useCallback(() => {
    setPhoneContinueOpen(false);
    setScheduleContinueOpen(true);
  }, []);
  const goYouJobs = goRoutines;
  const stopTurn = useCallback(() => dispatch({ type: "interrupt", botId: bot.id }), [bot.id, dispatch]);
  const goYouSetup = useCallback(() => {
    if (availability.target === "you-recovery") { location.hash = availability.target; dispatch({ type: "showYou" }); return; }
    setScheduleContinueOpen(false);
    openWorkspaceSetup("bud");
  }, [availability.target, dispatch]);
  const askNext = useMemo(
    () => askNextActions({
      miss: askMiss,
      needsYou: askNeedsYou,
      workerReady: askWorkerReady,
      workerSetupComplete: askWorkroomReady,
      lastRunAt: askBrief?.lastRunAt ?? null,
      addresses: askBrief?.addresses ?? [],
      lastBotText,
      attendedRunActive: Boolean(attendedRun),
      threadIdle: !bot.busy,
      recipes: savedRecipes,
      composioConfigured: Boolean(state.config?.composio?.configured),
      focusRecipeId,
    }),
    [askBrief?.addresses, askBrief?.lastRunAt, askMiss, askNeedsYou, askWorkerReady, askWorkroomReady, attendedRun, bot.busy, focusRecipeId, lastBotText, savedRecipes, state.config?.composio?.configured],
  );
  const runAskRecheck = useCallback(async () => {
    if (askAction || bot.busy) return;
    setAskAction("recheck");
    setAskActionNotice(null);
    try {
      const snapshot = await api("/api/desk/check", { method: "POST", body: "{}" });
      dispatch({ type: "deskSnapshot", snapshot });
      const brief = morningBrief(snapshot);
      setAskActionNotice({ ok: true, text: `${brief.headline} Bud put only prepared decisions on Desk.` });
      await refreshHermes();
    } catch (cause) {
      setAskActionNotice({
        ok: false,
        text: cause instanceof Error ? cause.message : "Bud could not finish that check. Nothing was sent or changed.",
      });
    } finally {
      setAskAction(null);
    }
  }, [askAction, bot.busy, dispatch, refreshHermes]);
  const runAskAttend = useCallback(async (recipeId: string) => {
    if (askAction || bot.busy) return;
    setAskAction("attend");
    setAskActionNotice(null);
    try {
      const body = (await api(`/api/recipes/${recipeId}/attend`, { method: "POST" })) as { run?: JobRun };
      if (!body.run) throw new Error("Bud could not start that run.");
      dispatch({ type: "jobRun", run: body.run });
      setFocusRecipeId(recipeId);
      setAskActionNotice({
        ok: true,
        text: `Running ${body.run.jobTitle} beside you — answer Bud's requests in Ask; sign in when the page asks.`,
      });
      dispatch({ type: "showAsk" });
    } catch (cause) {
      setAskActionNotice({
        ok: false,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAskAction(null);
    }
  }, [askAction, bot.busy, dispatch]);
  const runAskApprove = useCallback(async (recipeId: string, attach: boolean) => {
    if (askAction || bot.busy) return;
    setAskAction("approve");
    setAskActionNotice(null);
    try {
      const approved = (await api(`/api/recipes/${recipeId}`, {
        method: "PATCH",
        body: JSON.stringify({ planApproved: true, status: "active" }),
      })) as { recipes?: Recipe[] };
      let recipes = approved.recipes ?? [];
      if (attach) {
        const attached = (await api(`/api/recipes/${recipeId}`, {
          method: "PATCH",
          body: JSON.stringify({ attach: true }),
        })) as { recipes?: Recipe[] };
        recipes = attached.recipes ?? recipes;
      }
      if (Array.isArray(recipes)) setSavedRecipes(recipes);
      setFocusRecipeId(recipeId);
      setAskActionNotice({
        ok: true,
        text: attach
          ? "Plan approved and site attached. Press Run beside me now when you are at the screen."
          : "Plan approved here. Add the portal site below, then Run beside me.",
      });
    } catch (cause) {
      setAskActionNotice({
        ok: false,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAskAction(null);
    }
  }, [askAction, bot.busy]);
  const openAskSetSite = useCallback((recipeId: string) => {
    setSetSiteRecipeId(recipeId);
    setSetSiteUrl("");
    setAskActionNotice(null);
  }, []);
  const runAskSetSite = useCallback(async () => {
    if (!setSiteRecipeId || askAction || bot.busy) return;
    const raw = setSiteUrl.trim();
    if (!raw) {
      setAskActionNotice({ ok: false, text: "Paste the portal address first — for example vantagestrata.com.au." });
      return;
    }
    setAskAction("set-site");
    setAskActionNotice(null);
    try {
      const body = (await api(`/api/recipes/${setSiteRecipeId}`, {
        method: "PATCH",
        body: JSON.stringify({
          allowedOrigins: [raw],
          ensurePortal: true,
          planApproved: true,
          attach: true,
          status: "active",
        }),
      })) as { recipes?: Recipe[] };
      if (Array.isArray(body.recipes)) setSavedRecipes(body.recipes);
      setFocusRecipeId(setSiteRecipeId);
      setSetSiteRecipeId(null);
      setSetSiteUrl("");
      setAskActionNotice({
        ok: true,
        text: "Portal site saved, plan approved, and attached. Press Run beside me now.",
      });
    } catch (cause) {
      setAskActionNotice({
        ok: false,
        text: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setAskAction(null);
    }
  }, [askAction, bot.busy, setSiteRecipeId, setSiteUrl]);
  const openAskConnectSetup = useCallback((connectLabel?: string) => {
    if (selectedConnectedAppsConfigured(state.config?.composio) && connectLabel && !bot.busy) {
      sendAsk(`connect ${connectLabel}`);
      return;
    }
    setScheduleContinueOpen(false);
    openWorkspaceSetup("apps");
  }, [sendAsk, state.config?.composio, bot.busy]);

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, messageId, text });
    },
    [bot.id, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text"),
    [messages],
  );
  const retryLock = useRef(false);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    if (bot.busy) {
      setRetrying(true);
      return;
    }
    retryLock.current = false;
    setRetrying(false);
  }, [bot.busy]);
  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (retryLock.current || bot.busy || !lastUserMessage?.text) return;
    retryLock.current = true;
    setRetrying(true);
    dispatch({ type: "editMessage", botId: bot.id, messageId: lastUserMessage.id, text: lastUserMessage.text });
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useConversationFollow(bot.threadId);
  const touchY = useRef(0);

  const followLatest = useCallback(() => {
    if (!follow || !scrollRef.current) return;
    // Welcome content is read from the top. Conversation follow behaviour
    // starts only when there is work to follow.
    if (productAsk && askEmptyThread && !bot.busy) scrollRef.current.scrollTop = 0;
    else scrollChatToEnd(scrollRef.current);
  }, [follow, productAsk, askEmptyThread, bot.busy]);
  useEffect(() => {
    followLatest();
  }, [bot.id, bot.busy, followLatest, messages.length]);

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home break
  // follow like an upward wheel; the at-end onScroll check re-arms it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      if (e.key === "PageUp" || (e.key === "Home" && !(e.target instanceof HTMLTextAreaElement))) setFollow(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const jumpToLatest = () => {
    setFollow(true);
    if (scrollRef.current) {
      scrollChatToEnd(scrollRef.current, {
        animate: true,
        reducedMotion: Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
      });
    }
  };

  // on Windows the frameless window's min/max/close overlay sits at the
  // top-right: the header becomes the drag strip and clears room for it
  const isWin = window.ogb?.platform === "win32";
  const drag = isWin ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
  const noDrag = isWin ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

  return (
    <main className={cn("relative flex h-full min-w-0 flex-1 flex-col bg-paper", productAsk && "ask-workspace")}>
      {/* Call mode covers the thread while the bot is on the line */}
      <CallOverlay bot={bot} />
      {/* Header */}
      <div
        className={cn("flex items-center justify-between border-b border-line px-5 py-3", productAsk && "ask-header", isWin && "pr-[148px]")}
        style={drag}
      >
        {productAsk ? (
          <div className="ask-header-title" style={noDrag}>
            <div className="flex items-center gap-2.5">
              <h1 className="pm-screen-title text-ink">Ask Bud</h1>
              <span className={cn("ask-status", askStatus.className)}>
                <span className="ask-status-dot" aria-hidden />
                {askStatus.label}
              </span>
              {bot.busy && !askWaitingForYou && <Loader2 size={14} className="animate-spin text-ink-muted" />}
            </div>
            <p className="ask-header-description">Your work, a few steps ahead.</p>
          </div>
        ) : (
        <button
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-raised/50"
          title="Bot settings"
          style={noDrag}
        >
          <MausAvatar
            color={bot.color}
            state={stateForBot({ ...bot, messages })}
            size={28}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
          <span className="text-[15px] font-semibold text-ink">{bot.name}</span>
          {bot.chiefOfStaff && (
            <span className="flex items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
              <Crown size={11} /> Chief of Staff
            </span>
          )}
          {bot.busy && <Loader2 size={14} className="animate-spin text-ink-secondary" />}
        </button>
        )}
        <div className="flex items-center gap-2" style={noDrag}>
          {productAsk && <AskContext desk={state.desk} missed={askMiss} onDesk={goDesk} />}
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              title="Stop this turn"
            >
              <Square size={12} className="fill-current" />
              Stop
            </button>
          )}
          {!productAsk && <TaskPicker bot={bot} />}
          {!productAsk && <ModelPicker bot={bot} />}
          {!productAsk && <CallButton bot={bot} />}
          {!productAsk && (
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Bot's computer"
          >
            <Monitor size={18} />
          </button>
          )}
        </div>
      </div>

      {!productAsk && askMiss ? (
        <p className="border-b border-line px-5 py-2 text-[12.5px] text-hold">{askBrief?.headline}</p>
      ) : null}

      {/* The one reason Bud is blocked (offline, install, workroom, readiness)
          lives in the composer strip beside its action — see Composer.
          A second banner here only pushed the thread down. */}

      {/* Messages */}
      <div
        ref={scrollRef}
        className={cn("flex-1 overflow-y-auto px-5 [overflow-anchor:none]", productAsk && "ask-thread")}
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        <div
          className={cn("mx-auto flex max-w-[900px] flex-col gap-3 pb-4", productAsk && "ask-thread-content")}
          role="log"
          aria-live="polite"
          aria-label={`Conversation with ${bot.name}`}
        >
          <MessagesList
            bot={bot}
            messages={messages}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            canRetryLast={Boolean(lastUserMessage)}
            retrying={retrying}
            engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
            productAsk={productAsk}
            askWorkerReady={askWorkerReady}
            askNext={askNext}
            askActionsDisabled={Boolean(askAction) || bot.busy}
            onAskStarter={sendAsk}
            onAskExample={chooseExample}
            onMakeRepeatable={makeRepeatable}
            onSendToPhone={productAsk && phoneReady ? sendReplyToPhone : undefined}
            onSendSummary={productAsk && phoneReady ? sendSummaryToPhone : undefined}
            phoneHandoffBusy={phoneHandoffBusy}
            onAskRecheck={() => void runAskRecheck()}
            onAskDesk={goDesk}
            onAskYou={goYouSetup}
            onAskRoutines={goRoutines}
            onAskYouJobs={goYouJobs}
            onAskInterrupt={stopTurn}
            onAskAttend={(recipeId) => void runAskAttend(recipeId)}
            onAskApprove={(recipeId, attach) => void runAskApprove(recipeId, attach)}
            onAskSetSite={openAskSetSite}
            onAskConnectSetup={openAskConnectSetup}
          />
          {provisioning && !productAsk && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                Setting up this bot's computer…
              </div>
            </div>
          )}
          <ChatStreamTail
            threadId={bot.threadId}
            busy={Boolean(bot.busy)}
            productAsk={productAsk}
            since={lastUserMessage?.at ?? Date.now()}
            onGrowth={followLatest}
          />
        </div>
      </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to latest messages"
          className={cn("animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover", productAsk ? "ask-jump-latest" : "bottom-24")}
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      {/* keyed by bot: a draft belongs to the conversation it was typed in,
          so switching bots starts from an empty composer instead of carrying
          the previous bot's half-written message over. ArrowUp-to-edit is
          gated on busy like the pencil button — editing rewinds the thread,
          which a live turn forbids (the server 409s it). */}
      {productAsk && askActionNotice ? (
        <div
          role={askActionNotice.ok ? "status" : "alert"}
          className={cn(
            "mx-auto flex w-full max-w-[900px] shrink-0 flex-col gap-2 border-t px-5 py-2 text-[12.5px] sm:flex-row sm:items-center sm:justify-between",
            askActionNotice.ok ? "border-agency/20 text-agency" : "border-danger/20 text-danger",
          )}
        >
          <p className="min-w-0 flex-1 leading-5">{askActionNotice.text}</p>
          {!askActionNotice.ok && /Connected apps key|ak_|provider connection|app access/i.test(askActionNotice.text) ? (
            <button
              type="button"
              className="pm-control h-9 shrink-0 rounded-md border border-danger/30 bg-sheet px-3 text-[12.5px] font-medium text-ink hover:bg-raised"
              onClick={() => openAskConnectSetup()}
            >
              Open Connections
            </button>
          ) : null}
        </div>
      ) : null}

      {productAsk && setSiteRecipeId ? (
        <form
          className="mx-auto flex w-full max-w-[900px] shrink-0 flex-wrap items-end gap-2 border-t border-line px-5 py-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            void runAskSetSite();
          }}
        >
          <label className="min-w-[12rem] flex-1 text-left">
            <span className="mb-1 block text-[11.5px] font-medium text-ink-muted">Portal site</span>
            <input
              value={setSiteUrl}
              onChange={(event) => setSetSiteUrl(event.target.value)}
              placeholder="vantagestrata.com.au"
              autoComplete="off"
              aria-label="Portal site hostname"
              className="w-full rounded-lg border border-line bg-sheet px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted focus:border-agency/40"
            />
          </label>
          <button
            type="submit"
            disabled={Boolean(askAction) || bot.busy}
            className="rounded-lg bg-agency px-3.5 py-2 text-[13px] font-medium text-white hover:bg-agency-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save, approve, attach
          </button>
          <button
            type="button"
            onClick={() => {
              setSetSiteRecipeId(null);
              setSetSiteUrl("");
            }}
            className="rounded-lg border border-line bg-sheet px-3 py-2 text-[13px] text-ink-muted hover:bg-raised"
          >
            Cancel
          </button>
        </form>
      ) : null}

      {productAsk && !askEmptyThread && askWorkerReady && (!bot.busy || Boolean(attendedRun)) ? (
        <AskNextActionPanel
            panelRef={taskPanelRef}
            expanded={Boolean(attendedRun) || askNext.some((row) => ["approve", "attend", "set-site", "connect-setup"].includes(row.kind))}
            next={askNext}
            disabled={Boolean(askAction) || bot.busy}
            align="start"
            onAsk={sendAsk}
            onRecheck={() => void runAskRecheck()}
            onDesk={goDesk}
            onYou={goYouSetup}
            onYouJobs={goYouJobs}
            onRoutines={goRoutines}
            onInterrupt={stopTurn}
            onAttend={(recipeId) => void runAskAttend(recipeId)}
            onApprove={(recipeId, attach) => void runAskApprove(recipeId, attach)}
            onSetSite={openAskSetSite}
            onConnectSetup={openAskConnectSetup}
            trailing={
              <>
                <button type="button" className="min-h-8 text-[12px] text-ink-secondary hover:text-ink" aria-expanded={scheduleContinueOpen} onClick={goRoutines}>Schedule work</button>
                <button type="button" className="pm-control min-h-8 text-[12px] text-ink-secondary" aria-expanded={phoneContinueOpen} onClick={() => setPhoneContinueOpen(true)}>Continue on phone</button>
              </>
            }
          >
          <div className="px-1 pb-2 pt-1">
            <PmTaskStarters onChoose={chooseExample} disabled={Boolean(askAction) || bot.busy} />
          </div>
        </AskNextActionPanel>
      ) : productAsk ? (
        <div className="mx-auto flex w-full max-w-[900px] shrink-0 justify-end gap-3 px-5 py-0.5">
          <button type="button" className="min-h-8 text-[12px] text-ink-secondary hover:text-ink" aria-expanded={scheduleContinueOpen} onClick={goRoutines}>Schedule work</button>
          <button type="button" className="pm-control min-h-8 text-[12px] text-ink-secondary" aria-expanded={phoneContinueOpen} onClick={() => setPhoneContinueOpen(true)}>Continue on phone</button>
          {!askWorkerReady ? <button type="button" className="min-h-8 text-[12px] text-agency" onClick={goYouSetup}>Set up Bud</button> : null}
        </div>
      ) : null}

      <Composer
        key={bot.id}
        bot={bot}
        productAsk={productAsk}
        askReady={!productAsk || askWorkerReady}
        askBlockedDetail={productAsk ? availability.detail : undefined}
        askSetupLabel={availability.action ?? undefined}
        onAskSetup={productAsk && availability.action ? goYouSetup : undefined}
        readiness={productAsk ? <AskReadiness onSetup={goYouSetup} /> : undefined}
        starter={productAsk ? composerStarter : undefined}
        onConnectApp={productAsk ? openAskConnectSetup : undefined}
        onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
      />

      {productAsk ? (
        <>
          <AskPhoneContinueCard
            open={phoneContinueOpen}
            onClose={() => setPhoneContinueOpen(false)}
            onSendLatest={() => void sendPhoneHandoff({ mode: "result" })}
            onSendSummary={() => void sendPhoneHandoff({ mode: "summary" })}
            sendBusy={phoneHandoffBusy}
            onManage={() => {
              setPhoneContinueOpen(false);
              openWorkspaceSetup("phone");
            }}
          />
          <AskScheduleCard
            open={scheduleContinueOpen}
            chatHint={scheduleChatHint}
            onClose={() => setScheduleContinueOpen(false)}
            onOpenSchedule={openScheduleWorkspace}
          />
        </>
      ) : null}

    </main>
  );
}

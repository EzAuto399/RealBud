import { Component, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  BookOpen,
  Brain,
  Check,
  CircleCheck,
  CircleX,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crown,
  FileSearch,
  FileUp,
  Link2,
  ListChecks,
  Loader2,
  Monitor,
  PanelTop,
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
import type { DeskSnapshot } from "@/lib/desk";
import type { Loop, LoopRun } from "@/lib/routines";
import {
  workerSetupStep,
  workerVerified,
  WORKER_VERIFICATION_EVENT,
  WORKER_VERIFICATION_KEY,
  type GoLiveStep,
} from "@/lib/onboarding";
import { EngineSetup } from "./EngineSetup";
import { MausAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { TaskPicker } from "./TaskPicker";
import { PropertyPicker } from "./PropertyPicker";
import { ReactionBar, ReactionChips } from "./Reactions";
import { SpeakButton } from "./SpeakButton";
import { CallButton, CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import type { AskActionProposal } from "@shared/ask-actions";
import { presentAskActivity } from "@/lib/ask-presentation";
import { describeSessionHeal } from "@/lib/session-heal";
import { SessionHealCard } from "./SessionHealCard";
import { foldAskSpentConnects } from "@/lib/ask-thread";
import { askUserTurnStatus, followingAskAction } from "@/lib/ask-turn-status";
import { AskActionCard, AskSpentConnectGroup } from "./AskActionCard";
import { AskIntakeResult, type AskIntakeResultData } from "./AskIntakeResult";
import { PropertyIntakeRoutePicker } from "./PropertyIntakeRoutePicker";

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
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
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
    if (open) tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
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
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
}) {
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
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              <RefreshCw size={12} /> Retry
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
        <div className="max-w-[70%] rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
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
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
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
    <div className="w-full max-w-[70%] rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
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
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  followingAction,
  editing,
  isLastBotText,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  productAsk = false,
}: {
  bot: Bot;
  message: Message;
  followingAction?: AskActionProposal;
  editing: boolean;
  isLastBotText: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  productAsk?: boolean;
}) {
  const { dispatch } = useStore();
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const collapsible =
    user && !expanded && (text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSE_LINES);

  if (user && editing) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  if (!user && productAsk) {
    return (
      <div className="group animate-msg-in flex w-full justify-start">
        <article
          className="pm-assistant-response w-full max-w-[760px] border-l-2 border-agency bg-sheet px-4 py-3 text-[15px] leading-relaxed text-ink"
          aria-label="Bud's response"
        >
          <MessageBoundary fallbackText={text}>
            <ChatMarkdown text={text} />
          </MessageBoundary>
          <footer className="mt-3 flex items-center gap-2 border-t border-line/70 pt-2 text-[12px] text-ink-muted">
            <span className="font-medium text-agency">Bud</span>
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(message.at).toISOString()}>{formatTime(message.at)}</time>
            <CopyButton text={text} className="ml-auto opacity-100" />
          </footer>
        </article>
      </div>
    );
  }

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
            "max-w-[70%] rounded-lg px-4 py-2.5 text-[15px] leading-relaxed",
            user ? "whitespace-pre-wrap bg-bubble-user text-ink" : "bg-card text-ink",
          )}
          title={new Date(message.at).toLocaleString()}
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
      {user && productAsk && message.requestState ? (() => {
        const turn = askUserTurnStatus(message, followingAction);
        return (
          <div
            role={turn.tone === "hold" ? "alert" : "status"}
            className={cn(
              "mt-1 inline-flex max-w-[70%] items-center gap-1.5 pr-1 text-[12px]",
              turn.tone === "hold" ? "text-hold" : turn.tone === "agency" ? "copy-pulse text-agency" : "text-ink-muted",
            )}
            title={message.requestStatusDetail}
          >
            {turn.tone === "hold" ? <AlertTriangle size={12} /> : message.requestState === "settled" ? <CircleCheck size={12} /> : <Loader2 size={12} className="animate-spin" />}
            {turn.label}
          </div>
        );
      })() : null}
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
function ActivityChip({ message, productAsk = false }: { message: Message; productAsk?: boolean }) {
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
  if (productAsk) {
    const presentation = presentAskActivity(tool.name, tool.ok);
    if (presentation.kind === "suppressed") return null;
    const ActivityIcon =
      presentation.kind === "intake"
        ? BookOpen
        : presentation.kind === "evidence"
          ? FileSearch
          : presentation.kind === "connection"
            ? Link2
            : presentation.kind === "handoff"
              ? PanelTop
              : ListChecks;
    const StateIcon = presentation.status === "working" ? Loader2 : presentation.status === "done" ? CircleCheck : CircleX;
    const stateLabel = presentation.status === "working" ? "Working" : presentation.status === "done" ? "Done" : "Stopped";
    return (
      <div className="flex w-full justify-start">
        <div
          className={cn(
            "flex w-full max-w-[760px] items-start gap-3 border-l-2 bg-paper/70 px-3 py-2",
            presentation.status === "failed" ? "border-danger" : "border-line",
          )}
          role="status"
          aria-label={`${presentation.title}. ${stateLabel}.`}
        >
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded border border-line bg-sheet text-agency">
            <ActivityIcon size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-ink">{presentation.title}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{presentation.detail}</div>
          </div>
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-[12px] font-medium", presentation.status === "failed" ? "text-danger" : "text-ink-muted")}>
            <StateIcon size={12} className={presentation.status === "working" ? "animate-spin" : undefined} />
            {stateLabel}
          </span>
        </div>
      </div>
    );
  }
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
        <span className="max-w-[480px] truncate font-mono">{tool.name}</span>
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

function StreamingBubble({ text, productAsk = false }: { text: string; productAsk?: boolean }) {
  // markdown re-parses on a deferred value: when tokens arrive faster than
  // the parser keeps up, React lags the parse instead of janking the frame
  const deferred = useDeferredValue(text);
  const preparingAction = productAsk && (
    deferred.trimStart().startsWith("{") ||
    /^```(?:json)?\s*(?:\{|$)/i.test(deferred.trimStart()) ||
    deferred.includes("realbud.propose-action.v1")
  );
  return (
    <div className="flex w-full justify-start">
      <div className={cn(
        "text-[15px] leading-relaxed text-ink",
        productAsk
          ? "pm-assistant-response w-full max-w-[760px] border-l-2 border-agency bg-sheet px-4 py-3"
          : "max-w-[70%] rounded-2xl bg-card px-4 py-2.5",
      )}>
        {preparingAction ? (
          <span className="inline-flex items-center gap-2 text-[13.5px] text-ink-muted">
            <Loader2 size={14} className="animate-spin text-agency" /> Preparing a change for your review…
          </span>
        ) : (
          <MessageBoundary fallbackText={deferred}>
            <ChatMarkdown text={deferred} streaming />
          </MessageBoundary>
        )}
        <span className="animate-caret ml-0.5 inline-block h-[14px] w-[2px] bg-ink align-middle" />
      </div>
    </div>
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
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  editingId,
  lastBotTextId,
  canRetryLast,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  productAsk = false,
  onAskStarter,
  hideAskStarters = false,
}: {
  bot: Bot;
  messages: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  productAsk?: boolean;
  onAskStarter?: (text: string) => void;
  hideAskStarters?: boolean;
}) {
  return (
    <>
      {messages.length === 0 && !bot.busy && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          {productAsk ? (
            <>
              <h2 className="pm-case-title text-ink">Ask about the book</h2>
              <div className="max-w-[360px] text-[14px] text-ink-muted">
                Scoped to your portfolio. Ask what needs you, or put courtesy on Desk for one Allow.
              </div>
              {!hideAskStarters ? (
              <div className="mt-2 flex max-w-[28rem] flex-wrap justify-center gap-2">
                {["What needs me?", "Move the morning check to 8:00 am", "Add a property", "Draft an owner update"].map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    onClick={() => onAskStarter?.(starter)}
                    className="rounded border border-line bg-sheet px-3 py-1.5 text-[13px] text-ink hover:bg-raised"
                  >
                    {starter}
                  </button>
                ))}
              </div>
              ) : null}
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
      {foldAskSpentConnects(messages).map((item) => {
        if (item.kind === "spent-group") {
          return (
            <div key={item.messages.map((message) => message.id).join(":")} className="contents">
              {item.newDay ? <DaySeparator at={item.messages[0]!.at} /> : null}
              <AskSpentConnectGroup messages={item.messages} />
            </div>
          );
        }
        const m = item.message;
        const row = (() => {
          switch (m.kind) {
            case "action":
              return <AskActionCard botId={bot.id} threadId={bot.threadId} message={m} />;
            case "options":
              // a live permission ask gets the approval box; questions and
              // the onboarding quiz keep the list card
              return m.card?.requestId && m.card.tool ? (
                <ApprovalCard bot={bot} message={m} />
              ) : (
                <OptionCard botId={bot.id} message={m} />
              );
            case "activity":
              // a failed turn is an error, not a tool run — render it as one
              return m.tool?.name.startsWith("error:") ? (
                <ErrorRow
                  message={m.tool.name.slice(6).trim()}
                  onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
                  setupInstance={m.tool.setup ? engine : undefined}
                />
              ) : (
                <ActivityChip message={m} productAsk={productAsk} />
              );
            case "screen":
              return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  followingAction={followingAskAction(messages, m.id)}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
                  onRegenerate={onRegenerate}
                  productAsk={productAsk}
                />
              );
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents">
            {item.newDay ? <DaySeparator at={m.at} /> : null}
            {row}
          </div>
        );
      })}
    </>
  );
});

export function ChatView({
  bot,
  productAsk = false,
  onOpenSetupJourney,
}: {
  bot: Bot;
  productAsk?: boolean;
  onOpenSetupJourney?: () => void;
}) {
  const { state, dispatch, recoverSession } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [, setVerificationVersion] = useState(0);

  useEffect(() => {
    if (!productAsk) return;
    const refresh = () => setVerificationVersion((value) => value + 1);
    const onStorage = (event: StorageEvent) => {
      if (event.key === WORKER_VERIFICATION_KEY) refresh();
    };
    window.addEventListener(WORKER_VERIFICATION_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(WORKER_VERIFICATION_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [productAsk]);

  useEffect(() => {
    if (!productAsk) return;
    let cancelled = false;
    void api("/api/desk")
      .then((snapshot: DeskSnapshot) => {
        if (!cancelled) dispatch({ type: "deskSnapshot", snapshot });
      })
      .catch(() => {});
    void api("/api/loops")
      .then((payload: { loops?: Loop[]; runs?: LoopRun[] }) => {
        if (!cancelled && payload.loops) {
          dispatch({ type: "loopsHydrated", loops: payload.loops, runs: payload.runs ?? [] });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [productAsk, dispatch]);

  const sendAskTurn = useCallback((text: string) => {
    if (bot.busy || !text.trim()) return;
    dispatch({ type: "send", botId: bot.id, text });
  }, [bot.busy, bot.id, dispatch]);

  const askWorkerStep = productAsk
    ? workerSetupStep({ worker: state.hermes, workerIsVerified: workerVerified(state.hermes) })
    : null;
  const askChatReady = !productAsk || askWorkerStep?.state === "done";

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const reasoning = stream.reasoning[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const messages = useMemo(() => visibleMessages(bot), [bot]);
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
  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const touchY = useRef(0);

  useEffect(() => setFollow(true), [bot.id]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bot.id, messages.length, streaming, reasoning, bot.busy, follow, state.desk, state.loops, state.loopRuns]);

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home break
  // follow like an upward wheel; the at-end onScroll check re-arms it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || (e.key === "Home" && !(e.target instanceof HTMLTextAreaElement))) setFollow(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const jumpToLatest = () => {
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  // on Windows the frameless window's min/max/close overlay sits at the
  // top-right: the header becomes the drag strip and clears room for it
  const isWin = window.ogb?.platform === "win32";
  const drag = isWin ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
  const noDrag = isWin ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Call mode covers the thread while the bot is on the line */}
      <CallOverlay bot={bot} />
      {/* Header */}
      <div
        className={cn("flex items-center justify-between border-b border-line px-5 py-3", isWin && "pr-[148px]")}
        style={drag}
      >
        {productAsk ? (
          <div className="flex flex-wrap items-center gap-2.5 px-1.5 py-1" style={noDrag}>
            <h1 className="pm-screen-title text-ink">Ask Bud</h1>
            {bot.busy && <Loader2 size={14} className="animate-spin text-ink-muted" />}
            {!state.connected && askChatReady && (
              <span className="flex items-center gap-1.5 rounded border border-hold/35 bg-hold/10 px-2 py-1 text-[12px] font-medium text-hold" role="status">
                <RefreshCw size={12} className="animate-spin" /> Reconnecting to Bud…
              </span>
            )}
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

      {productAsk && !askChatReady && askWorkerStep ? (
        <AskWorkerSetup
          step={askWorkerStep}
          onContinue={() => {
            if (onOpenSetupJourney) onOpenSetupJourney();
            else dispatch({ type: "showYou", focus: "worker", returnTo: "ask" });
          }}
        />
      ) : null}

      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-5">
          {describeSessionHeal(state.error).kind === "other" ? (
            <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {state.error}
            </div>
          ) : (
            <SessionHealCard
              copy={describeSessionHeal(state.error)}
              onRetry={() => void recoverSession()}
              onDismiss={() => dispatch({ type: "error", message: null })}
            />
          )}
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 [overflow-anchor:none]"
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
          className="mx-auto flex max-w-[900px] flex-col gap-3 pb-4"
          role="log"
          aria-live="polite"
          aria-label={`Conversation with ${bot.name}`}
        >
          <MessagesList
            bot={bot}
            messages={messages}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            canRetryLast={!bot.busy && Boolean(lastUserMessage)}
            engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
            productAsk={productAsk}
            onAskStarter={sendAskTurn}
          />
          {provisioning && !productAsk && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                Setting up this bot's computer…
              </div>
            </div>
          )}
          {reasoning && bot.busy && <ThinkingStrip text={reasoning} active={!streaming} />}
          {streaming ? (
            <StreamingBubble text={streaming} productAsk={productAsk} />
          ) : (
            bot.busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                  </span>
                  <WorkingTimer since={lastUserMessage?.at ?? Date.now()} />
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to latest messages"
          className="animate-pop-in absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      {/* keyed by bot: a draft belongs to the conversation it was typed in,
          so switching bots starts from an empty composer instead of carrying
          the previous bot's half-written message over. ArrowUp-to-edit is
          gated on busy like the pencil button — editing rewinds the thread,
          which a live turn forbids (the server 409s it). */}
      <Composer
        key={bot.id}
        bot={bot}
        productAsk={productAsk}
        askLead={productAsk && askChatReady ? <AskIntakeBar /> : undefined}
        onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
      />

    </main>
  );
}

export const ASK_WORKER_SETUP_DETAIL =
  "Named routines still run from Ask. Prepare Bud to read cards and draft notes.";

export function askSetupActionMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.kind === "action" && Boolean(message.action)).slice(-5);
}

function AskWorkerSetup({ step, onContinue }: {
  step: GoLiveStep;
  onContinue: () => void;
}) {
  const checking = step.state === "checking";
  return (
    <div className="mx-auto w-full max-w-[900px] px-5 pb-2">
      <section
        aria-labelledby="ask-worker-setup-title"
        className="flex flex-wrap items-center gap-3 border border-agency/30 bg-selected/45 px-3 py-2.5"
      >
        <div className="min-w-0 flex-1">
          <h2 id="ask-worker-setup-title" className="text-[13px] font-semibold text-ink">
            {checking ? "Checking Bud" : step.title}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">{ASK_WORKER_SETUP_DETAIL}</p>
        </div>
        {checking ? (
          <span className="flex items-center gap-1.5 text-[12px] text-ink-muted" role="status">
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            Checking
          </span>
        ) : (
          <button
            type="button"
            onClick={onContinue}
            className="pm-control pm-tactile rounded bg-agency px-3 text-[12.5px] font-semibold text-white hover:bg-agency-hover"
          >
            Prepare Bud
          </button>
        )}
      </section>
    </div>
  );
}

function AskProposeBar() {
  const { dispatch } = useStore();
  const [snap, setSnap] = useState<DeskSnapshot | null>(null);
  const [propertyId, setPropertyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    void api("/api/desk").then((next: DeskSnapshot) => {
      setSnap(next);
      setPropertyId((id) => id || next.properties[0]?.id || "");
      setLoadFailed(false);
    }).catch(() => setLoadFailed(true));
  }, []);

  if (loadFailed) {
    return <div className="mt-2.5 border-t border-line pt-2.5 text-[12px] text-danger">The property picker could not load. Reopen Add book to retry.</div>;
  }
  if (!snap?.properties.length) return null;

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
      <span className="text-[12px] text-ink-secondary">Put courtesy on Desk</span>
      <PropertyPicker
        properties={snap.properties}
        value={propertyId}
        onChange={setPropertyId}
        disabled={busy}
        dropUp
      />
      <button
        disabled={busy || !propertyId}
        onClick={() => {
          setBusy(true);
          setError("");
          void api("/api/desk/propose", {
            method: "POST",
            body: JSON.stringify({ propertyId, kind: "courtesy-rent", expectedRevision: snap.revision }),
          })
            .then((next: DeskSnapshot) => {
              setSnap(next);
              dispatch({ type: "deskSnapshot", snapshot: next });
            })
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setBusy(false));
        }}
        className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-40"
      >
        {busy ? "Putting…" : "Put on Desk"}
      </button>
      {error && <span className="text-[12px] text-danger">{error}</span>}
    </div>
  );
}

/** Common files go through Bud below; deterministic quick paste remains
 * available when the PM has no model attached yet. Both paths stage Desk
 * cards only. */
export function AskIntakeBar() {
  const { dispatch } = useStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AskIntakeResultData | null>(null);
  const [error, setError] = useState("");
  const open = drawerOpen || Boolean(result);

  const send = () => {
    setBusy(true);
    setError("");
    void api("/api/desk/propose-book", { method: "POST", body: JSON.stringify({ text }) })
      .then((res) => {
        if (res.ok === false) throw new Error(res.error ?? "could not stage the list");
        setResult({ created: res.created ?? 0, skipped: res.skipped ?? 0, unparsed: res.unparsed ?? [] });
        setText("");
        return api("/api/desk").then((next: DeskSnapshot) => dispatch({ type: "deskSnapshot", snapshot: next }));
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <div className="mb-1.5">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="text-[12px] font-medium text-ink-muted hover:text-ink hover:underline"
        >
          Add book
        </button>
      </div>
    );
  }

  return (
    <div className="mb-2">
      <div className="relative z-10 overflow-visible border border-line bg-sheet px-3 py-2.5">
        <div className="flex flex-wrap items-start gap-2.5">
          <FileUp size={16} className="mt-0.5 shrink-0 text-agency" />
          <div className="min-w-[15rem] flex-1">
            <div className="text-[13px] font-semibold text-ink">Add book</div>
            <p className="mt-0.5 text-[12px] text-ink-muted">PMS export, files, or a pasted list.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setDrawerOpen(false);
              setRoutesOpen(false);
              setExpanded(false);
              setError("");
            }}
            className="pm-tactile rounded border border-hairline/60 px-2.5 py-1 text-[12px] font-medium text-ink-muted hover:bg-raised"
          >
            Close
          </button>
          <button
            type="button"
            aria-expanded={routesOpen}
            aria-controls="ask-property-intake-routes"
            onClick={() => {
              setRoutesOpen((value) => !value);
              setError("");
            }}
            className="pm-tactile rounded border border-hairline/60 px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised"
          >
            {routesOpen ? "Hide options" : "Import options"}
          </button>
        </div>
        {routesOpen ? (
          <div id="ask-property-intake-routes" className="mt-2.5">
            <PropertyIntakeRoutePicker
              onChoosePmsExport={() => dispatch({ type: "showDesk" })}
              onChooseFiles={() => {
                const attach = document.getElementById("ask-attach-files") as HTMLButtonElement | null;
                if (attach) attach.click();
                else document.getElementById("ask-bud-composer")?.focus();
              }}
              onChoosePaste={() => {
                setExpanded(true);
                requestAnimationFrame(() => document.getElementById("ask-quick-property-text")?.focus());
              }}
              onOpenConnections={() => dispatch({ type: "openAskConnect", target: "connections", service: "Property book" })}
            />
          </div>
        ) : null}
        {expanded ? (
          <div id="ask-quick-property-paste" className="mt-2.5 border-t border-line pt-2.5">
            <label htmlFor="ask-quick-property-text" className="sr-only">Properties to stage, one per line</label>
            <textarea
              id="ask-quick-property-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={3}
              placeholder={"One property per line:\n12 Oak St, Dickson ACT, Jordan Blake, 0400 555 666, 580"}
              className="w-full resize-y rounded-lg border border-hairline/60 bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-agency"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || !text.trim()}
                onClick={send}
                className="pm-tactile rounded-lg border border-hairline/60 px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
              >
                {busy ? "Reading…" : "Stage properties on Desk"}
              </button>
              <span className="text-[12px] text-ink-muted">Works without a model: address, tenant, phone, weekly rent.</span>
            </div>
          </div>
        ) : null}
        <AskProposeBar />
        {result ? <AskIntakeResult result={result} onReview={() => dispatch({ type: "showDesk" })} /> : null}
        {error ? <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div> : null}
      </div>
    </div>
  );
}

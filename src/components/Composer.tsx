import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Clock, Mic, Paperclip, Square, Users, X } from "lucide-react";
import { useStore, visibleMessages, type Bot, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  composerOutboxStore,
  getComposerOutbox,
  setComposerOutbox,
  useComposerDraft,
} from "@/lib/drafts";
import { MausAvatar } from "./Avatar";
import { ComposerAttachments } from "./ComposerAttachments";
import {
  composeMessage,
  fileAttachment,
  isLongPaste,
  pasteAttachment,
  type Attachment,
} from "@/lib/composer-attachments";
import { normalizeState } from "@/lib/mascot";
import { groupComposerHint } from "@/lib/group-routing";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { useDesktopCapabilities } from "./DesktopCapabilities";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot };

async function composerPayloadDigest(text: string, attachments: Attachment[]): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify({ text, attachments }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function Composer({
  bot,
  group,
  members,
  onEditLast,
  productAsk = false,
  askLead,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  /** Ask never offers "Always allow": approvals stay manual, per turn. */
  productAsk?: boolean;
  /** Ask-only lead (Add book). Lives with the composer, not above the thread. */
  askLead?: ReactNode;
}) {
  const { state, dispatch, sendMessage } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers members plus @everyone; explicit mentions override the room's
  // configured default responder.
  const busy = group ? Boolean(group.busyBotId) : Boolean(bot?.busy);
  // a pending approval blocks the prompt until it is answered
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  const approvalBot = group
    ? members?.find((b) => b.id === approval?.message.from?.botId) ??
      members?.find((b) => b.id === group.busyBotId)
    : bot;
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ?? "A bot")
    : (bot?.name ?? "The bot");
  // Per-thread draft: switching bots unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const draftId = group ? `group:${group.id}` : `bot:${bot?.id ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(draftId);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const addAttachments = useCallback(
    (next: Attachment[]) => setAttachments((prev) => {
      const existingFiles = prev.filter((item) => item.kind === "file").length;
      let fileSlots = Math.max(0, 10 - existingFiles);
      const accepted = next.filter((item) => item.kind !== "file" || fileSlots-- > 0);
      if (accepted.length !== next.length) setAttachmentError("Attach no more than 10 files at once.");
      return [...prev, ...accepted];
    }),
    [setAttachments, setAttachmentError],
  );
  const removeAttachment = useCallback(
    (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
    [setAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          { id: "__everyone__", name: "everyone" },
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) return [];
    return pool.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 6);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members]);
  const pickerOpen = candidates.length > 0;

  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);

  // grow the textarea with its content (capped by max-h in the className)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    setText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  // One message may be queued while the bot works; it auto-sends the moment
  // the turn settles. Enter during a turn queues instead of silently dying.
  const [queued, setQueued] = useState<{ text: string; attachments: Attachment[] } | null>(null);
  // a chip on its own is a message: the send control has to appear for it
  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  const send = async () => {
    const t = composeMessage(text, attachments);
    if (!t) return;
    if (busy) {
      if (group) {
        setQueued({ text: t, attachments });
        setText("");
        setAttachments([]);
      }
      return;
    }
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, text: t });
      track("message_sent", { room: true });
    } else if (bot) {
      if (sending) return;
      const files = attachments
        .filter((a) => a.kind === "file")
        .map(({ path, name, size }) => ({ path, name, size }));
      setSending(true);
      setSendError(null);
      try {
        const payloadDigest = await composerPayloadDigest(t, attachments);
        const outboxStore = composerOutboxStore();
        const prior = getComposerOutbox(outboxStore, draftId);
        const requestId = prior?.payloadDigest === payloadDigest
          ? prior.requestId
          : `ask_${globalThis.crypto.randomUUID()}`;
        setComposerOutbox(outboxStore, draftId, { requestId, payloadDigest });
        await sendMessage({ botId: bot.id, text: t, attachments: files, requestId });
        setComposerOutbox(outboxStore, draftId, null);
        setText("");
        setAttachments([]);
        track("message_sent", { driver: bot.modelSelection?.instanceId });
      } catch (error) {
        setSendError(error instanceof Error ? error.message : "Bud did not acknowledge that message. Your draft is still here; try again.");
      } finally {
        setSending(false);
      }
      return;
    }
    setText("");
    setAttachments([]);
  };
  useEffect(() => {
    if (!busy && queued) {
      if (group) dispatch({ type: "sendGroup", groupId: group.id, text: queued.text });
      track("message_sent", { queued: true });
      setQueued(null);
    }
  }, [busy, queued, group, dispatch]);

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 2) {
        setSpeechError("Dictation is only available on macOS for now.");
      } else if (code === 1) {
        setSpeechError(
          "Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording]);

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.ogb) {
      setSpeechError("Dictation isn't available in this build.");
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  const chooseFiles = async () => {
    if (!window.ogb?.chooseFiles) {
      setAttachmentError("File selection is available in the RealBud desktop app. You can also drop files here.");
      return;
    }
    setAttachmentError(null);
    try {
      const selected = await window.ogb.chooseFiles();
      addAttachments(selected.map((file) => fileAttachment(file.name, file.path, file.size)));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Those files could not be attached.");
    }
  };

  return (
    <div className="px-5 pb-5 pt-2">
      {speechError && (
        <div className="mx-auto mb-2 max-w-[900px] rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      {attachmentError && (
        <div className="mx-auto mb-2 flex max-w-[900px] items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{attachmentError}</span>
          <button onClick={() => setAttachmentError(null)} aria-label="Dismiss attachment error" className="shrink-0 rounded p-0.5">
            <X size={12} />
          </button>
        </div>
      )}
      {sendError && (
        <div role="alert" className="mx-auto mb-2 flex max-w-[900px] items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{sendError}</span>
          <button onClick={() => setSendError(null)} aria-label="Dismiss send error" className="shrink-0 rounded p-0.5">
            <X size={12} />
          </button>
        </div>
      )}
      <div className="relative mx-auto max-w-[900px]">
        {askLead}
        {queued && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12.5px] text-ink-secondary">
            <Clock size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Queued — sends when {busyName} finishes: “{queued.text}”
            </span>
            <button
              onClick={() => setQueued(null)}
              aria-label="Discard queued message"
              className="rounded p-0.5 hover:bg-raised hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
        )}
        {pickerOpen && (
          <div
            role="listbox"
            aria-label="Tag a bot"
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {candidates.map((peer, i) => (
              <button
                key={peer.id}
                role="option"
                aria-selected={i === highlight}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                {peer.bot ? (
                  <MausAvatar
                    color={peer.bot.color}
                    state={normalizeState(peer.bot.mascotExpression) ?? "happy"}
                    size={24}
                  />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                    <Users size={14} aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{peer.name}</span>
                <span className="shrink-0 text-xs text-ink-secondary">{peer.bot ? "Agent" : "Room"}</span>
              </button>
            ))}
          </div>
        )}
        {/* An approval takes over the composer: you answer it before you
            can type again, so a waiting bot is impossible to miss. */}
        {approval && (
          <div className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card">
            <PendingApprovalPanel pending={approval} count={approvals.length} index={0} />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
              alwaysAllowable={!productAsk}
              onCancelTurn={() => {
                if (group) dispatch({ type: "interruptGroup", groupId: group.id });
                else if (bot) dispatch({ type: "interrupt", botId: bot.id });
              }}
            />
          </div>
        )}
        <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
        />
        <div className="flex items-end gap-2 rounded-lg border border-line bg-sheet py-2 pl-3 pr-2">
        {!group && window.ogb?.chooseFiles && (
          <button
            id={productAsk ? "ask-attach-files" : undefined}
            onClick={() => void chooseFiles()}
            disabled={Boolean(approval)}
            aria-label="Attach files or images"
            title="Attach files or images"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <Paperclip size={17} />
          </button>
        )}
        <textarea
          id={productAsk ? "ask-bud-composer" : undefined}
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
          }}
          onPaste={(e) => {
            // a wall of text becomes a chip instead of burying the input
            const pasted = e.clipboardData.getData("text/plain");
            if (!isLongPaste(pasted)) return;
            e.preventDefault();
            // Preserve native paste replacement semantics: if text was
            // selected, the attachment replaces that selection.
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;
            if (start !== end) {
              setText(`${text.slice(0, start)}${text.slice(end)}`);
              setCaret(start);
            }
            setAttachments((prev) => [...prev, pasteAttachment(pasted)]);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            // an empty composer + ArrowUp = edit your last message (like a chat app)
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            // Shift+Enter inserts a newline; plain Enter sends
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
            if (e.key === "Escape" && recording) setRecording(false);
          }}
          disabled={Boolean(approval) || sending}
          placeholder={
            approval
              ? "Answer the approval above to continue"
              : recording
              ? "Listening…"
              : sending
                ? "Waiting for RealBud to save this message…"
                : busy
                ? group
                  ? `${busyName} is working — Enter queues your message`
                  : `${busyName} is working — your draft stays here`
                : group
                  ? `Message ${group.name} — ${groupComposerHint(group, members ?? [])}`
                  : productAsk
                    ? "Ask Bud, paste a list, or attach a file or screenshot"
                    : `Message ${bot?.name ?? ""}`
          }
          aria-label={productAsk ? "Message Bud about the book" : `Message ${group ? group.name : (bot?.name ?? "")}`}
          className="max-h-40 w-full resize-none self-center bg-transparent py-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        {busy && (
          <button
            onClick={() => {
              if (group) dispatch({ type: "interruptGroup", groupId: group.id });
              else if (bot) dispatch({ type: "interrupt", botId: bot.id });
            }}
            aria-label="Stop this turn"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            title="Stop"
          >
            <Square size={14} className="fill-current" />
          </button>
        )}
        {!busy && !hasContent && !productAsk && capabilities.dictation.available && (
          <button
            onClick={toggleMic}
            aria-label={recording ? "Stop dictation" : "Start dictation"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={recording ? "Stop dictation (Esc)" : "Dictate"}
          >
            <Mic size={18} />
          </button>
        )}
        {hasContent && (
          <button
            onClick={() => void send()}
            disabled={sending || (busy && !group)}
            aria-label={sending ? "Saving message" : busy ? group ? "Queue message" : "Draft saved while Bud works" : "Send message"}
            title={sending ? "Waiting for RealBud" : busy ? group ? "Queue — sends when the bot finishes" : "Bud is working; this draft is saved" : "Send"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full text-white disabled:cursor-not-allowed disabled:opacity-55",
              busy ? "bg-raised text-ink-secondary hover:bg-raised-hover" : "bg-accent hover:brightness-110",
            )}
          >
            {busy ? <Clock size={15} /> : <ArrowUp size={17} />}
          </button>
        )}
        </div>
      </div>
    </div>
  );
}

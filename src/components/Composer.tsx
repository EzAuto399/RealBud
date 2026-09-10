import { WorkContextCard } from "./WorkContextCard";
import { isAskProductControl } from "@shared/ask-controls";
import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Clock, CornerDownRight, Loader2, Mic, Paperclip, Pencil, ShieldCheck, Square, Users, X } from "lucide-react";
import { api, useStore, visibleMessages, type Bot, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { useComposerDraft } from "@/lib/drafts";
import { MausAvatar } from "./Avatar";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerOfficeSourceChips, ComposerOfficeToolkit } from "./ComposerOfficeToolkit";
import {
  composeMessage,
  fileAttachment,
  isLongPaste,
  pasteAttachment,
  type Attachment,
} from "@/lib/composer-attachments";
import { normalizeState } from "@/lib/mascot";
import { ASK_ATTACH_ACCEPT } from "@/lib/ask-attach";
import { persistAskFile, persistAskFiles } from "@/lib/ask-attach-client";
import { KEY_ON_YOU, looksLikeProviderKey } from "@/lib/looks-like-secret";
import { groupComposerHint } from "@/lib/group-routing";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { canUseTaskStarter } from "@/lib/pm-task-starters";
import { mergeWorkContext } from "@/lib/work-continuation";
import { askMessageSizeError } from "@shared/ask-message";

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

export function Composer({
  bot,
  group,
  members,
  onEditLast,
  productAsk = false,
  askReady = true,
  askBlockedDetail,
  askSetupLabel = "Set up Bud",
  onAskSetup,
  readiness,
  starter,
  onConnectApp,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  /** Always allow writes a standing rule. You → Bud's rules can revoke it. */
  productAsk?: boolean;
  /** Product Ask: false blocks send until Bud is ready. */
  askReady?: boolean;
  /** The one specific reason Bud is blocked, shown once beside the setup action. */
  askBlockedDetail?: string;
  /** Product Ask setup button. Defaults to "Set up Bud". */
  askSetupLabel?: string;
  onAskSetup?: () => void;
  readiness?: ReactNode;
  starter?: { id: number; text: string };
  /** Opens the in-Ask key/sign-in flow — never navigates to You. */
  onConnectApp?: (label?: string) => void;
}) {
  const { state, dispatch } = useStore();
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
  const [text, setText, attachments, setAttachments, clearAccepted, recoverQueued] = useComposerDraft(
    group ? `group:${group.id}` : `bot:${bot?.id ?? ""}`,
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => setAttachments((prev) => [...prev, ...next]),
    [setAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
    [setAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speechNeedsSettings, setSpeechNeedsSettings] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
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

  // Rooms retain their old in-renderer queue. A 1:1 Bud follow-up is owned by
  // the server so it survives reloads and can be atomically replaced/drained.
  const [groupQueued, setGroupQueued] = useState<string | null>(null);
  const queuedItem = !group && bot && bot.queuedMessage?.threadId === bot.threadId ? bot.queuedMessage : null;
  const queued = group ? groupQueued : (queuedItem?.text ?? null);
  const queuedHeld = Boolean(queuedItem?.heldReason);
  const [actionPending, setActionPending] = useState<"send" | "steer" | "queue" | "edit-queue" | "delete-queue" | null>(null);
  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  const askBlocked = productAsk && !askReady && !(attachments.length === 0 && isAskProductControl(text));
  const interactionBlocked = Boolean(approval) || askBlocked || Boolean(actionPending);
  const lastWorkContext = useRef<string | null>(null);
  useEffect(() => {
    const context = productAsk ? state.askWorkContext : null;
    if (!context || context.id === lastWorkContext.current) return;
    // Keep the handoff pending while an approval or composer operation owns
    // input. Consuming it early would lose the selected work.
    if (approval || actionPending) return;
    lastWorkContext.current = context.id;
    const merged = mergeWorkContext(text, attachments, context);
    setText(merged.text);
    setAttachments(merged.attachments);
    setSpeechError(text.trim() && text !== context.instruction ? "Case or work context attached. Your existing request is kept; review it before sending." : null);
    dispatch({ type: "consumeAskContext", id: context.id });
    inputRef.current?.focus();
  }, [productAsk, state.askWorkContext, approval, actionPending, text, attachments, setText, setAttachments, dispatch]);
  const lastStarter = useRef<number | null>(null);
  useEffect(() => {
    if (!starter || lastStarter.current === starter.id) return;
    lastStarter.current = starter.id;
    if (!canUseTaskStarter(text, attachments.length) || approval || actionPending) {
      setSpeechError("Your existing draft is kept. Finish or clear it before choosing another example.");
      inputRef.current?.focus();
      return;
    }
    setText(starter.text);
    setSpeechError(null);
    inputRef.current?.focus();
  }, [starter, text, attachments.length, approval, actionPending, setText]);

  const checkedMessage = () => {
    if (askBlocked || approval || actionPending) return null;
    const message = composeMessage(text, attachments);
    if (!message) return null;
    const sizeError = askMessageSizeError(message);
    if (sizeError) {
      setSpeechError(`${sizeError} Your draft and attachments are kept.`);
      return null;
    }
    if (productAsk && looksLikeProviderKey(message)) {
      setSpeechError(KEY_ON_YOU);
      return null;
    }
    return message;
  };

  const submitWhileBusy = async (mode: "steer" | "queue") => {
    if (!bot || actionPending) return;
    const message = checkedMessage();
    if (!message) return;
    setActionPending(mode);
    setSpeechError(null);
    try {
      await api(`/api/bots/${bot.id}/${mode === "steer" ? "steer" : "queued-message"}`, {
        method: mode === "steer" ? "POST" : "PUT",
        body: JSON.stringify({ text: message }),
      });
      clearAccepted(text, attachments);
      track("message_sent", { driver: bot.modelSelection?.instanceId, [mode]: true });
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionPending(null);
    }
  };

  const send = () => {
    const message = checkedMessage();
    if (!message) return;
    if (busy) {
      if (group) {
        setGroupQueued(message);
        setText("");
        setAttachments([]);
      } else {
        void submitWhileBusy("steer");
      }
      return;
    }
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, text: message });
      track("message_sent", { room: true });
    } else if (bot) {
      setActionPending("send");
      setSpeechError(null);
      dispatch({ type: "send", botId: bot.id, text: message, onSettled: (error) => {
        if (error) {
          setSpeechError("The request was not confirmed. Your draft and attachments are kept. Check the conversation before trying again.");
        } else {
          clearAccepted(text, attachments);
          track("message_sent", { driver: bot.modelSelection?.instanceId });
        }
        setActionPending(null);
      } });
      return;
    }
    setText("");
    setAttachments([]);
  };

  useEffect(() => {
    if (!group || busy || !groupQueued) return;
    if (productAsk && !askReady) {
      setGroupQueued(null);
      return;
    }
    if (productAsk && looksLikeProviderKey(groupQueued)) {
      setSpeechError(KEY_ON_YOU);
      setGroupQueued(null);
      return;
    }
    dispatch({ type: "sendGroup", groupId: group.id, text: groupQueued });
    track("message_sent", { queued: true });
    setGroupQueued(null);
  }, [busy, groupQueued, group, dispatch, productAsk, askReady]);

  const editQueued = async () => {
    if (actionPending || !queued) return;
    if (group) {
      recoverQueued({ id: group.id, text: queued });
      setGroupQueued(null);
      inputRef.current?.focus();
      return;
    }
    if (!bot || !queuedItem) return;
    setActionPending("edit-queue");
    // A paused item cannot auto-dispatch. Preserve it in the local draft
    // before removal, so a lost DELETE reply cannot lose the instruction.
    if (queuedHeld) recoverQueued(queuedItem);
    try {
      await api(`/api/bots/${bot.id}/queued-message`, {
        method: "DELETE",
        body: JSON.stringify({ id: queuedItem.id }),
      });
      if (!queuedHeld) recoverQueued(queuedItem);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (error) {
      setSpeechError(queuedHeld
        ? "The paused follow-up is restored in your draft, but removal from the saved queue was not confirmed. Check the queue before sending."
        : error instanceof Error ? error.message : String(error));
    } finally {
      setActionPending(null);
    }
  };

  const deleteQueued = async () => {
    if (actionPending || !queued) return;
    if (group) {
      setGroupQueued(null);
      return;
    }
    if (!bot || !queuedItem) return;
    setActionPending("delete-queue");
    try {
      await api(`/api/bots/${bot.id}/queued-message`, {
        method: "DELETE",
        body: JSON.stringify({ id: queuedItem.id }),
      });
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionPending(null);
    }
  };

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

  const pickFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = Array.from(list);
    const onDisk: Attachment[] = [];
    const needUpload: File[] = [];
    for (const file of files) {
      let path = "";
      try {
        path = window.ogb?.getPathForFile?.(file) ?? "";
      } catch {
        /* browser Vite has no disk path */
      }
      if (path) onDisk.push(fileAttachment(file.name, path, file.size));
      else needUpload.push(file);
    }
    const uploaded = needUpload.length ? await persistAskFiles(needUpload) : { attachments: [], rejectedNames: [] };
    if (onDisk.length || uploaded.attachments.length) {
      addAttachments([...onDisk, ...uploaded.attachments]);
    }
    setAttachError(
      uploaded.rejectedNames.length
        ? `${uploaded.rejectedNames.join(", ")} — attach a PDF, image, or text file under 8 MB.`
        : null,
    );
    if (fileRef.current) fileRef.current.value = "";
  };

  const holdingSpeak = useRef(false);

  const speakUnavailableMessage = () =>
    capabilities.dictation.available
      ? "Dictation isn't available in this window. Open the RealBud Mac app."
      : "Dictation is built into the RealBud Mac app (Microphone + Speech Recognition).";

  const clearSpeechIssue = () => {
    setSpeechError(null);
    setSpeechNeedsSettings(false);
  };

  // After the PM flips Microphone in System Settings, clear the issue quietly.
  useEffect(() => {
    if (!speechNeedsSettings) return;
    const onFocus = () => {
      void (async () => {
        const { micAccessGranted } = await import("@/lib/boot-heal");
        if (await micAccessGranted()) clearSpeechIssue();
      })();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [speechNeedsSettings]);

  const beginSpeak = () => {
    if (!capabilities.dictation.available || !window.ogb?.speechStart) {
      setSpeechError(speakUnavailableMessage());
      setSpeechNeedsSettings(false);
      holdingSpeak.current = false;
      return;
    }
    if (recording) return;
    baseText.current = text.trim();
    clearSpeechIssue();
    void (async () => {
      try {
        if (window.ogb?.permRequestMic) {
          const granted = await window.ogb.permRequestMic();
          if (!granted) {
            holdingSpeak.current = false;
            setSpeechNeedsSettings(true);
            setSpeechError("Allow the microphone, then hold Speak again.");
            return;
          }
        }
        // Hold-to-speak: finger may have lifted while the permission sheet was up.
        if (productAsk && !holdingSpeak.current) return;
        setRecording(true);
      } catch {
        holdingSpeak.current = false;
        setSpeechNeedsSettings(true);
        setSpeechError("Dictation could not start. Check Microphone and Speech Recognition.");
      }
    })();
  };

  const endSpeak = () => {
    holdingSpeak.current = false;
    if (!recording) return;
    if (window.ogb?.speechFinish) void window.ogb.speechFinish();
    else setRecording(false);
  };

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.ogb?.speechStart) {
      setSpeechError(speakUnavailableMessage());
      return;
    }
    if (recording) {
      setRecording(false);
      return;
    }
    holdingSpeak.current = true;
    beginSpeak();
  };

  return (
    <div className={cn("px-5 pb-5 pt-2", productAsk && "ask-composer")}>
      {(speechError || attachError) && (
        <div className="mx-auto mb-2 flex max-w-[900px] flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{speechError ?? attachError}</span>
          {speechNeedsSettings && window.ogb?.permOpenSettings ? (
            <button
              type="button"
              className="shrink-0 rounded border border-warning/40 bg-sheet px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised"
              onClick={() => void window.ogb?.permOpenSettings?.("mic")}
            >
              Open Microphone settings
            </button>
          ) : null}
          {speechError ? (
            <button
              type="button"
              className="shrink-0 text-[12px] font-medium text-ink-muted underline-offset-2 hover:text-ink hover:underline"
              onClick={clearSpeechIssue}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      )}
      <div className={cn("relative mx-auto max-w-[900px]", productAsk && "ask-composer-frame")}>
        {readiness}
        {queued && (
          <div role={queuedHeld ? "status" : undefined} className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12.5px] text-ink-secondary">
            <Clock size={13} className="shrink-0" />
            {queuedHeld ? <div className="min-w-0 flex-1">
              <p className="font-medium text-hold">{queuedItem?.heldReason === "connected-app-settings-changed" ? "Paused — app settings changed" : "Paused — review required"}</p>
              <p className="truncate">“{queued}”</p>
              <p className="text-[12px]">Edit queued to review, then send again.</p>
            </div> : <span className="min-w-0 flex-1 truncate">
              Queued — {busy ? `starts when ${busyName} finishes` : "ready to start"}: “{queued}”
            </span>}
            <div className="group relative shrink-0">
              <button
                type="button"
                onClick={() => void editQueued()}
                disabled={Boolean(actionPending)}
                aria-label="Edit queued follow-up"
                title="Edit queued follow-up"
                className={cn("flex items-center justify-center gap-1.5 rounded hover:bg-raised hover:text-ink disabled:opacity-50", queuedHeld ? "min-h-11 px-2" : "size-6")}
              >
                {actionPending === "edit-queue" ? <Loader2 size={13} className="animate-spin" /> : <Pencil size={13} />}
                {queuedHeld ? <span>Edit queued</span> : null}
              </button>
              <span role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 whitespace-nowrap rounded bg-ink px-2 py-1 text-[11px] text-paper opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                Edit follow-up
              </span>
            </div>
            <div className="group relative shrink-0">
              <button
                type="button"
                onClick={() => void deleteQueued()}
                disabled={Boolean(actionPending)}
                aria-label="Discard queued follow-up"
                title="Discard queued follow-up"
                className={cn("flex items-center justify-center rounded hover:bg-raised hover:text-ink disabled:opacity-50", queuedHeld ? "size-11" : "size-6")}
              >
                {actionPending === "delete-queue" ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
              </button>
              <span role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-30 mb-1.5 whitespace-nowrap rounded bg-ink px-2 py-1 text-[11px] text-paper opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                Discard follow-up
              </span>
            </div>
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
            <PendingApprovalPanel pending={approval} count={approvals.length} index={0} productAsk={productAsk} />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
              productAsk={productAsk}
              alwaysAllowable={true}
              onCancelTurn={() => {
                if (group) dispatch({ type: "interruptGroup", groupId: group.id });
                else if (bot) dispatch({ type: "interrupt", botId: bot.id });
              }}
            />
          </div>
        )}
        {productAsk && attachments.filter(item => item.id.startsWith("desk-case-") || item.id.startsWith("job-result-")).map(item => <WorkContextCard key={item.id} title={item.kind === "paste" ? item.label || "Attached work" : "Attached work"} status="Reference attached" detail="Continue this work below. Bud must recheck facts before taking action.">
          <button type="button" className="pm-control" aria-label={`Remove work context: ${item.kind === "paste" ? item.label || "Attached work" : "Attached work"}`} onClick={() => removeAttachment(item.id)}>Remove from this request</button>
        </WorkContextCard>)}
        <ComposerAttachments
          items={productAsk ? attachments.filter(item => !item.id.startsWith("desk-case-") && !item.id.startsWith("job-result-")) : attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          persist={persistAskFile}
        />
        {productAsk ? <ComposerOfficeSourceChips /> : null}
        {askBlocked && !readiness ? (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hold/30 bg-hold/10 px-3 py-2.5">
            <p className="text-[13px] text-hold">
              {askBlockedDetail ?? "Bud is not ready yet. Open Set up Bud here before starting tool work."}
            </p>
            {onAskSetup ? (
              <button
                type="button"
                onClick={onAskSetup}
                className="pm-control shrink-0 rounded bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover"
              >
                {askSetupLabel}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className={cn("flex items-end gap-2 rounded-lg border border-line bg-sheet py-2 pl-3 pr-2", productAsk && "ask-composer-input")}>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ASK_ATTACH_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void pickFiles(event.target.files)}
        />
        {productAsk ? (
          <ComposerOfficeToolkit
            disabled={Boolean(approval) || Boolean(actionPending)}
            productAsk
            onAttachFiles={() => fileRef.current?.click()}
            onConnectApp={onConnectApp}
          />
        ) : (
          <button
            type="button"
            disabled={interactionBlocked}
            onClick={() => fileRef.current?.click()}
            aria-label="Attach a PDF, image, or text file"
            title="Attach"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <Paperclip size={18} />
          </button>
        )}
        <textarea
          ref={inputRef}
          rows={productAsk ? 2 : 1}
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
            // IME owns Enter, arrows, Tab and Escape while choosing characters.
            // Some browsers report the final composition key as keyCode 229.
            if (askBlocked || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
              send();
            }
            if (e.key === "Escape" && recording) {
              holdingSpeak.current = false;
              setRecording(false);
            }
          }}
          disabled={Boolean(approval) || Boolean(actionPending)}
          placeholder={
            askBlocked
                ? "What would you like Bud to prepare? You can draft while we connect."
              : approval
              ? productAsk
                ? "Answer the request above to continue"
                : "Answer the approval above to continue"
              : actionPending === "send"
                ? "Starting your work…"
              : actionPending === "steer"
                ? "Applying your new direction…"
                : actionPending === "queue"
                  ? "Saving the follow-up…"
              : recording
              ? "Listening…"
              : busy
                ? group
                  ? `${busyName} is working — Enter queues your message`
                  : `${busyName} is working — Enter steers now; use the clock to queue`
                : group
                  ? `Message ${group.name} — ${groupComposerHint(group, members ?? [])}`
                  : productAsk
                    ? "Describe the outcome. Add a property, files or any details Bud should use…"
                    : `Message ${bot?.name ?? ""}`
          }
          aria-label={productAsk ? "Tell Bud what outcome you need" : `Message ${group ? group.name : (bot?.name ?? "")}`}
          className="max-h-40 w-full resize-none self-center rounded bg-transparent py-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus-visible:outline-agency disabled:opacity-60"
        />
        {busy && (
          <button
            onClick={() => {
              if (group) dispatch({ type: "interruptGroup", groupId: group.id });
              else if (bot) dispatch({ type: "interrupt", botId: bot.id });
            }}
            disabled={Boolean(actionPending)}
            aria-label="Stop this turn"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            title="Stop"
          >
            <Square size={14} className="fill-current" />
          </button>
        )}
        {capabilities.dictation.available && (!busy || recording) && (
          <button
            type="button"
            onClick={productAsk ? undefined : toggleMic}
            onPointerDown={
              productAsk
                ? (event) => {
                    if (event.button !== 0 || approval || actionPending) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    holdingSpeak.current = true;
                    beginSpeak();
                  }
                : undefined
            }
            onPointerUp={productAsk ? () => endSpeak() : undefined}
            onPointerCancel={productAsk ? () => endSpeak() : undefined}
            onLostPointerCapture={productAsk ? () => endSpeak() : undefined}
            disabled={Boolean(approval) || Boolean(actionPending)}
            aria-label={
              productAsk
                ? recording
                  ? "Release to stop speaking"
                  : "Hold to speak into the message"
                : recording
                  ? "Stop dictation"
                  : "Dictate into the message"
            }
            aria-pressed={recording}
            className={cn(
              "flex shrink-0 items-center justify-center select-none touch-none",
              productAsk
                ? "ask-dictate"
                : "size-8 rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
              "disabled:opacity-40",
            )}
            title={
              productAsk
                ? recording
                  ? "Release to finish"
                  : "Hold to speak"
                : recording
                  ? "Stop dictation (Esc)"
                  : "Dictate"
            }
          >
            <Mic size={18} />
            {productAsk ? <span>{recording ? "Release" : "Hold to speak"}</span> : null}
          </button>
        )}
        {hasContent && !askBlocked && busy && !group && (
          <>
            <div className="group relative shrink-0">
              <button
                type="button"
                onClick={() => void submitWhileBusy("steer")}
                disabled={Boolean(actionPending)}
                aria-label="Steer Bud now"
                title="Steer now"
                className={cn("flex items-center justify-center gap-1.5 bg-accent text-white hover:brightness-110 disabled:opacity-50", productAsk ? "pm-control rounded px-2.5 text-[13px]" : "size-8 rounded-full")}
              >
                {actionPending === "steer" ? <Loader2 size={15} className="animate-spin" /> : <CornerDownRight size={16} />}
                {productAsk ? <span>Steer now</span> : null}
              </button>
              <span role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-30 mb-2 whitespace-nowrap rounded bg-ink px-2 py-1 text-[11px] text-paper opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                Steer now · replaces the active direction
              </span>
            </div>
            <div className="group relative shrink-0">
              <button
                type="button"
                onClick={() => void submitWhileBusy("queue")}
                disabled={Boolean(actionPending)}
                aria-label={queuedItem ? "Replace queued follow-up" : "Queue a follow-up"}
                title={queuedItem ? "Replace queued follow-up" : "Queue follow-up"}
                className={cn("flex items-center justify-center gap-1.5 bg-raised text-ink-secondary hover:bg-raised-hover hover:text-ink disabled:opacity-50", productAsk ? "pm-control rounded px-2.5 text-[13px]" : "size-8 rounded-full")}
              >
                {actionPending === "queue" ? <Loader2 size={15} className="animate-spin" /> : <Clock size={15} />}
                {productAsk ? <span>Do next</span> : null}
              </button>
              <span role="tooltip" className="pointer-events-none absolute bottom-full right-0 z-30 mb-2 whitespace-nowrap rounded bg-ink px-2 py-1 text-[11px] text-paper opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                {queuedItem ? "Replace follow-up · runs next" : "Queue follow-up · runs next"}
              </span>
            </div>
          </>
        )}
        {(hasContent || productAsk) && (group || !busy) && (
          <button
            onClick={send}
            disabled={interactionBlocked || !hasContent}
            aria-label={busy ? "Queue work for Bud" : productAsk ? "Start this work" : "Send message"}
            title={busy ? "Queue — starts when Bud finishes" : productAsk ? "Start work" : "Send"}
            className={cn(
              "flex shrink-0 items-center justify-center gap-1.5 text-white disabled:opacity-50",
              productAsk ? "pm-decision ask-send rounded px-3 text-[14px]" : "size-8 rounded-full",
              busy ? "bg-raised text-ink-secondary hover:bg-raised-hover" : "bg-accent hover:brightness-110",
            )}
          >
            {busy ? <Clock size={15} /> : <ArrowUp size={17} />}
            {productAsk ? <span>Start work</span> : null}
          </button>
        )}
        </div>
      </div>
      {productAsk && <div className="ask-composer-help">
        <span><ShieldCheck size={13} aria-hidden />Sends, payments and statutory actions need your review.</span>
        <span className="ask-keyboard-hint">{approval ? "Review the request above to continue" : `${busy ? "Enter to steer" : "Enter to start"} · Shift + Enter for a new line${capabilities.dictation.available ? " · Hold Speak to dictate" : ""}`}</span>
      </div>}
    </div>
  );
}

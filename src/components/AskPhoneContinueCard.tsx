import { useEffect, useId, useRef } from "react";
import { Smartphone, X } from "lucide-react";
import { useDialogKeyboard } from "@/lib/use-dialog-keyboard";
import { usePhoneConnections } from "@/lib/phone-connections";
import { phoneContinuePair, phoneNeedsPair, phonePaired } from "@/lib/phone-label";
import { CHANNEL_PLATFORM_LABEL } from "@/lib/telegram-channel";
import { relativeAgo } from "@/lib/au";
import { ChannelMark } from "./ChannelMark";

/**
 * Composer-anchored card for “Continue on phone”.
 * When already paired, can push the latest reply/summary and explains
 * continuing the same Bud thread either side.
 */
export function AskPhoneContinueCard({
  open,
  onClose,
  onManage,
  onSendLatest,
  onSendSummary,
  sendBusy = false,
}: {
  open: boolean;
  onClose: () => void;
  /** Opens the full phone connections setup (connect / disconnect / pair). */
  onManage: () => void;
  onSendLatest?: () => void;
  onSendSummary?: () => void;
  sendBusy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { channels, error, refresh } = usePhoneConnections(open);
  useDialogKeyboard(ref, onClose);
  useEffect(() => {
    if (!open) return;
    void refresh();
    ref.current?.focus();
  }, [open, refresh]);
  if (!open) return null;

  const pair = phoneContinuePair(channels);
  const needsPair = phoneNeedsPair(channels);
  const ready = phonePaired(channels);

  return (
    <div
      className="ask-phone-continue"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ask-phone-continue-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-agency/10 text-agency" aria-hidden>
              <Smartphone size={16} />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-[15px] font-semibold text-ink">
                Continue on your phone
              </h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                Same Bud conversation — work either side, or send a reply/summary to your phone.
              </p>
            </div>
          </div>
          <button type="button" aria-label="Close" className="pm-control flex size-9 shrink-0 items-center justify-center rounded" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>
        ) : null}

        {!error && channels == null ? (
          <p className="mt-3 text-[12.5px] text-ink-muted">Checking phone connections…</p>
        ) : null}

        {pair ? (
          <div className="mt-3 rounded-lg border border-agency/25 bg-agency/5 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <ChannelMark channel={pair.label as "Telegram" | "Discord" | "Slack"} />
              <span className="text-[13px] font-medium text-ink">{pair.label}</span>
              <span className="rounded-full bg-agency/15 px-2 py-0.5 text-[11px] font-medium text-agency">
                Paired{pair.pairedName ? ` · ${pair.pairedName}` : ""}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-ink-muted">
              @{pair.botUsername || "bot"}
              {pair.lastMessageAt ? ` · last message ${relativeAgo(pair.lastMessageAt)}` : ""}
            </p>
          </div>
        ) : null}

        {ready && pair ? (
          <ol className="mt-3 list-decimal space-y-1.5 pl-4 text-[13px] leading-5 text-ink">
            <li>
              Message <span className="font-medium">@{pair.botUsername || "your bot"}</span> — replies come back to the phone and appear here in Ask.
            </li>
            <li>
              On phone: <code className="rounded bg-raised px-1 text-[12px]">/continue</code> latest reply,{" "}
              <code className="rounded bg-raised px-1 text-[12px]">/summary</code> short handoff,{" "}
              <code className="rounded bg-raised px-1 text-[12px]">/status</code> progress.
            </li>
            <li>Keep this Mac awake with RealBud open.</li>
          </ol>
        ) : null}

        {!ready && needsPair && channels ? (
          <div className="mt-3 space-y-2 text-[13px] leading-5 text-ink">
            <p>
              <span className="font-medium">{CHANNEL_PLATFORM_LABEL[needsPair]}</span> is connected but not paired yet.
              Create a pairing code, then send it from your phone.
            </p>
          </div>
        ) : null}

        {!ready && !needsPair && channels ? (
          <p className="mt-3 text-[13px] leading-5 text-ink">
            Pair Telegram, Discord or Slack so you can send a task from your phone and pick it up here.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {ready ? (
            <>
              <button type="button" className="pm-control min-h-10 px-3 text-[13px] text-ink-secondary" onClick={onManage}>
                Manage connections
              </button>
              {onSendSummary ? (
                <button type="button" className="pm-control min-h-10 px-3 text-[13px] text-ink-secondary" disabled={sendBusy} onClick={onSendSummary}>
                  {sendBusy ? "Sending…" : "Send summary"}
                </button>
              ) : null}
              {onSendLatest ? (
                <button type="button" className="ask-button min-h-10 px-4 text-[13px]" disabled={sendBusy} onClick={onSendLatest}>
                  {sendBusy ? "Sending…" : "Send latest reply"}
                </button>
              ) : (
                <button type="button" className="ask-button min-h-10 px-4 text-[13px]" onClick={onClose}>
                  Got it — back to Ask
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" className="pm-control min-h-10 px-3 text-[13px] text-ink-secondary" onClick={onClose}>
                Not now
              </button>
              <button
                type="button"
                className="ask-button min-h-10 px-4 text-[13px]"
                onClick={() => {
                  onClose();
                  onManage();
                }}
              >
                {needsPair ? "Create pairing code" : "Set up phone"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

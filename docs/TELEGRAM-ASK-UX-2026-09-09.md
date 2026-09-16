# Telegram conversation experience in Ask

The saved `[Telegram · Yoda]` label used to appear inside the request under “You”. Ask now separates channel, sender, timestamp, message content, and actions. Telegram gets a local blue paper-plane mark beside the sender, with a readable “via Telegram” label. This follows the existing office palette and message layout.

## Interaction changes

- Copy copies the message body, including the full text of a collapsed request. The transport label remains in saved history.
- Edit & resend explains its consequence before sending: a new request version starts from that point, preserving the original. The editor contains the message body. Cancel and Escape restore focus to the originating action and retain the separate composer draft.
- Request version controls are available in Ask, including their boundaries and busy-state disabling. Switching keeps keyboard focus at the controls; the chosen version survives reload through the existing branch API.
- Copy failure opens a collapsed request for manual selection and offers an explicit retry. A synchronous guard prevents overlapping clipboard operations; unmounted components ignore completion.
- Stamp-only historical messages say “No message text was saved.” Empty Copy and Edit actions are omitted.
- Long names wrap, bidirectional sender text is isolated, and mobile message actions have 44px targets. Expansion controls identify their content; copy results are announced without duplicate visible success text.
- Discord and Slack's existing transcript labels receive the same sender/body separation, with a generic channel mark. Telegram has the requested brand cue.

## Boundaries

This is a presentation change to existing transcript labels, not a new identity-verification mechanism. A leading label is not evidence of authentication and grants no permission. There is no history migration, channel configuration change, new send path, remote asset dependency, or new package dependency. Actual relay behavior and approval checks remain in server code.

## Verification

- Build and TypeScript checks: `pnpm build`.
- 29 tests across message parsing, rendering, Ask controls, and the existing branch API.
- Built-app walkthrough with a fictional transcript and an isolated local data directory: channel rendering, full-body copy, edit/cancel focus, composer draft retention, clipboard error/retry, empty content, version switching/focus/persistence, and mobile layout at 390px and 320px.
- Browser traffic restricted to the local fixture server. No Telegram messages or model requests.
- Evidence: `outputs/telegram-ask-ux-2026-09-09/browser/result.json`, desktop/mobile screenshots, build/test logs, and the change-only diff against the start-of-task files.

This verifies the local source and browser build. The installed desktop app has not been repackaged or updated; live Telegram delivery and a full accessibility audit are outside this proof.

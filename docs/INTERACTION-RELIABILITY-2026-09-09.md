# Interrupted interaction fixes

This pass implements the review-card and keyboard improvements from the reliability review. It does not claim to close the separate live-mail, property-matching, physical-device or worker-quality scenarios.

## What changed

- Telegram, Discord and Slack share one review-card identity and recovery contract. Each phone review is bound to the paired channel and the exact draft, property address and book mode shown at delivery.
- Cards include the recipient, channel and full wording, with the existing explanation that Allow approves wording for the PM to copy and sends nothing. Wording too long for a complete card has no phone approval controls; the existing full-draft review is on Desk.
- An edit replaces the card identity. A button from an older card, a pre-restart card, an undelivered card or a previous pairing cannot approve the current draft. A stale reply requests an updated card from current Desk state, respecting quiet hours.
- Text replies use the code printed on the card. Bare yes/no asks the user to use that card's buttons or exact reply; it cannot accidentally approve the next waiting draft. Ordinary conversation remains on the existing Ask path.
- Overlapping Desk notifications share one delivery pass. Changes during delivery are checked again, and late completions cannot overwrite a replacement pairing/binding. Failed delivery retains its identity for a later attempt; duplicate deliveries cannot approve another draft.
- Telegram checks provider acceptance as well as HTTP success. Decision delivery errors now reach the shared owner, and review-card requests have a 15-second transport deadline. Diagnostics contain no draft bodies, contacts, codes or provider payloads.
- A decision already saved by Desk remains successful if its subsequent notification update fails. No new permission or external action is granted by a review card.
- Composer, inline request editing, the Add panel and setup dialogs leave composition keys to the input method. Enter, Escape and candidate-selection keys cannot accidentally send, cancel or choose a mention while composing. The legacy final-key code 229 is handled too.

## Verification

The initial reproduction had three failing cases: changed wording accepted through an old card, acceptance without delivery, and duplicate pushes during overlapping updates. The before snapshots and failure log are kept in `outputs/interaction-reliability-2026-09-09/`.

The targeted suite passed 91 tests across nine files. It covers the three messaging adapters, paired account checks, simultaneous decisions, duplicate coded replies, changed recipients/properties/wording, unrelated revision changes, quiet hours, failed delivery, recovery after rebinding, notification failure, and real Desk edit/approval persistence. The persisted wording is compared with the actual reviewed text, including Desk's existing courtesy disclaimer.

The production build passed with the existing bundle-size warnings. The built-browser walkthrough passed at desktop, 320px and 390px sizes: composition Enter/Escape, zero message writes from those key checks, setup and draft preservation, copy failure/retry, request versions and focus, and mobile controls. Browser composition events are simulated; they are not a physical keyboard/IME or microphone certification.

Evidence: `reproduction.log`, `final-tests.log`, `build.log`, and `browser/result.json` in the output directory. No live messages, mailbox reads, customer changes or payments were performed. The installed desktop app has not been rebuilt or replaced.

## Remaining gates

The broader matrix in `RELIABILITY-REVIEW-2026-09-09.md` remains useful for the next rounds: ambiguous property matching, newer or contradictory email evidence, real worker behavior on adversarial attachments, physical sleep/wake and microphone interruptions, and office-user accessibility testing. This change does not establish those results.

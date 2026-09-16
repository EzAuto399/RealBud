# Phone and desktop continuation — 7 September 2026

This pass improves the existing RealBud messaging bridge and responsive workspace. It does not create a native mobile app, expose the local server to the network, or prove a live customer account connection.

## Implemented

- New Telegram/Discord/Slack pairings require an expiring code generated in You → Bud on your phone after connecting the bot. The authenticated local API validates platform and connected/unpaired state. Only a SHA-256 digest is persisted with private file permissions; the code is shown once. Codes rotate, expire after ten minutes, and clear on pairing/reconnect/disconnect. Existing paired accounts remain paired.
- Paired users can send `/continue` to retrieve the latest saved assistant response from the active Ask conversation branch, `/status` to see working/available state and `/help` for the workflow. Responses are bounded for all three messaging platforms. Busy state labels earlier saved work explicitly. These commands do not invoke the model or approve an external action.
- Phone requests received while Bud is busy are saved to the existing transcript before entering the waiting slot. Replacing a waiting follow-up is explicit and keeps both messages in Ask. Completion of a desktop-originated turn now drains the waiting phone request even when no phone reply was pending for the finished turn.
- Telegram ignores already-consumed update IDs before handling messages or approval callbacks, preventing ordinary repeated delivery from dispatching the same update twice.
- Narrow layouts below 600px use labelled bottom navigation, leaving the full width for work. The main destinations are Desk, Ask, Schedule and You. Phone settings describe the shared conversation, current commands and the need for the Mac to stay awake. Configuration and pairing failures remain visible and retryable.

## Verification

- Focused tests: **87 passed across 7 files**. Pairing, continuation, all three adapters, authenticated channel API and UI status copy. Covered missing/wrong/expired/rotated/platform-mismatched codes, private digest storage, corrupted state, normal requests versus commands, empty/busy state, bounded results, repeated Telegram updates, durable waiting request text and dispatch after desktop completion.
- Browser checks: all four navigation destinations at 390/600/900/1440px without horizontal page overflow; simulated connected-but-unpaired UI reveals the code; no browser runtime errors. Viewed screenshots and corrected a navigation label collision before the final browser pass.
- The first full suite overlapped a change from all stored messages to the active conversation branch; its two test-double failures were retained. The final suite ran after that change settled: **1,197 passed, 8 skipped, 140 files passed**.
- Production UI/server builds passed. Developer ID signed arm64 app and DMG were generated; deep/strict app signature verification and native renderer/capabilities/embedded-server/clean-shutdown smoke passed. Notarization was not performed. Exact logs and package hashes are recorded in `outputs/cross-device-2026-09-07/`.

## Real-phone acceptance still required

1. In the candidate app, open You → Bud on your phone. Connect the intended messaging bot using its secure token field. Generate a code on the Mac, then send the exact `/pair …` command privately from the intended account. Confirm the displayed paired name.
2. Prepare one fictional maintenance brief on desktop. On the phone, send `/continue`; verify the same reply is returned. Send a correction on the phone and inspect its attribution and result in Ask.
3. While a desktop task is working, send one phone follow-up. Check the saved/waiting message and that it runs when the desktop task finishes.
4. Restart RealBud with a waiting request. Confirm the request remains in Ask and resume it explicitly. Automatic queued channel dispatch across process restart is not implemented.
5. Disconnect the messaging app; verify the old account cannot obtain further responses. Reconnect and pair again with a newly generated code.

No real channel messages were sent by the automated verification. Pairing belongs to the account owner; no credentials were retrieved or copied from unrelated accounts.

## Remaining gaps

- Remote phone-browser access requires a separately designed authenticated deployment/relay; the browser responsive checks alone do not make localhost accessible from a phone.
- No native iOS/Android application, phone camera/document capture, push notifications or cross-device unsent-draft synchronization was added.
- The Mac must stay awake and online. Request text survives restart, but pending relays are not a durable delivery outbox; uncertain provider delivery cannot be called exactly-once. `/continue` retrieves saved output after reconnection.
- The existing waiting slot uses latest-follow-up replacement, not an unlimited queue. Both messages persist, and replacement is disclosed. The PM must resume earlier independent work explicitly.
- Existing paired accounts are preserved; this pass does not retrospectively prove the ownership of historical first-contact pairings. Disconnect/re-pair if ownership is uncertain.
- Live office data, actual provider OAuth/permissions, real phone network behavior, mobile usability with an independent PM and large real-worker batches remain acceptance gates.

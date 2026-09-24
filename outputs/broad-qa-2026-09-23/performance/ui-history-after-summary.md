# Chat history fix — verified locally, 2026-09-23

The initial render now mounts the latest 200 messages. Load earlier adds 200
without deleting, replacing or trimming the complete in-memory or saved history.
Pending decisions, error rows, active browser task cards and the selected
edit/version target remain available. Request-version groups are indexed once
per message-array change instead of scanning the whole history for each bubble.

| 10,000 active messages, 1 KiB each | Before | After |
| --- | ---: | ---: |
| Open and render | 4,980 ms | 1,111 ms |
| Type an unsent draft | 4,723 ms | 37 ms |
| Switch to Desk | 23,352 ms | 132 ms |
| Mounted DOM elements | 285,225 | 6,128 |
| Browser JS heap sample | 194.3 MiB | 33.3 MiB |
| Scroll to top / end | 367 / 464 ms | 28 / 30 ms |

These are one run per size in headless macOS Chrome with the built renderer and
synthetic history, not an SLA or installed Electron/Windows proof. Both runs
used the same 100/1,000/10,000-message timing datasets and probes. The fixture
makes no product changes; the after build includes the ChatView/history fix.
Original measurements and screenshots remain in `ui-history.json` and
`ui-history-{100,1000,10000}.png`; the new evidence is separate in
`ui-history-after.json` and `ui-history-after-{100,1000,10000}.png`.

Additional behavior checks passed:
- All 1,000 messages become reachable exactly once through Load earlier, with
  original message data unchanged; same-day content-anchor shift was 0.25 px.
- Old pending approvals and errors remain rendered. The full pending approval
  still disables the composer even though it predates the recent page.
- Selecting an old root request version changes the active branch, resets
  paging and retains keyboard focus on the selected version. All 800 source
  messages in both branches remain unchanged.
- Zero renderer page errors; branch/focus screenshot visually inspected.

`ui-history-unit-tests.json`: 21 passed, 0 failed across
`src/lib/chat-history.test.ts`, `src/components/ChatView.test.ts`, and
`src/lib/chat-scroll.test.ts`. Renderer typecheck passed in
`ui-history-typecheck.log`. Independent review found no remaining defects after
fixing the conditional date-separator anchor and memo callback identity.
Root's final full build/typechecks also passed before the after measurement.

Final visual follow-up: a screenshot found the floating Jump to latest control
overlapping Load earlier. The paging control now reserves vertical room. After
root rebuilt, `ui-history-visual.json` passed the branch/approval/focus checks
again and measured a 22 px gap between the two controls. The final screenshot
is `ui-history-visual-branches.png` and was visually inspected. The original
before/after timings and their timestamps remain unchanged; this follow-up did
not repeat timing measurements.

Product files: `src/components/ChatView.tsx`, `src/lib/chat-history.ts`, and its
unit tests. The after and visual receipts each contain the matching SHA-256
source digests for their respective builds; the visual receipt identifies the
final spacing correction.
No provider calls, customer data, PostgreSQL or package build occurred in this
fixture. Browser and temporary service were closed and their workspace removed.

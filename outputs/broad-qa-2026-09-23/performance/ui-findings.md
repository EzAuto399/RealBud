# Rendered chat history measurement — 2026-09-23

The 10,000-message active task exposes a substantial responsiveness problem.
No product files were changed by this measurement packet.

| Active messages | Render + two frames | Type an unsent draft | Switch to Desk | DOM elements | JS heap sample |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 696 ms | 43 ms | 96 ms | 3,075 | 11.3 MiB |
| 1,000 | 1,088 ms | 267 ms | 508 ms | 28,725 | 45.3 MiB |
| 10,000 | 4,980 ms | 4,723 ms | 23,352 ms | 285,225 | 194.3 MiB |

At 10,000 messages, the longest observed initial main-thread task was 1,484 ms;
the largest initial 50 ms timer gap was 1,910 ms. Programmatic top/end scroll
plus two animation frames took 367/464 ms. The run completed without renderer
page errors. All screenshots were limited to the viewport; 1,000 and 10,000
were visually inspected. Numbers are single-run observations, not an SLA.

Code evidence:
- `server/index.ts:391` and `:4391`: GET /api/bots includes all stored messages
  for each bot's active task and each group. It does not include every inactive
  task transcript. `server/store.ts:584` returns the complete message array.
- `src/state/store.tsx:170`: visibleMessages filters by active branch ancestry,
  with no count limit; `:454` hydration keeps the full response.
- `src/components/ChatView.tsx:873`: MessagesList maps every visible message.
  Its memoization can avoid unchanged renders but does not window the DOM.
- `src/components/ChatView.tsx:354` calls messageVersions for every user bubble;
  `src/state/store.tsx:186` scans all bot messages per call. An alternating
  10,000-message history therefore performs roughly 50 million comparisons
  per full list render, in addition to Markdown and DOM work.
- `src/components/AskMessage.tsx:34`: long requests are visually collapsed,
  but remain fully present in the rendered tree. No history virtualization or
  rendering cap was found along this path.

Smallest practical candidate: mount a bounded recent message window with an
explicit Load earlier control and stable scroll anchoring; build the user
message-version lookup once per message-array revision. Preserve the entire
saved transcript, branch/version controls, approvals and exact message IDs.
The measured navigation time includes browser actionability and UI work; this
run establishes the stall, not a profiler-level attribution to one function.

Fixture: `ui-history.mjs`; evidence: `ui-history.json`, `ui-history-100.png`,
`ui-history-1000.png`, `ui-history-10000.png`. Uses the production-built renderer
and a throwaway source service. Only the /api/bots response is replaced with
synthetic 50/50 user/assistant messages, each 1,024 bytes in a valid active
branch. The separate `history.json` measures real HTTP history reads. All
non-GET browser API calls were blocked, including connection checks; no
provider was called and the draft was never sent. No installed Electron,
Windows, total process-memory or peak-memory claim. Browser and service were
closed and the temporary workspace was removed.

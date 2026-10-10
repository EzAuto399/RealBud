# In-chat charts — 6 October 2026

This checkpoint does not establish that a live model follows the chart instruction, a packaged or installed build, Windows, screen-reader behaviour, or customer acceptance. Uncommitted.

Integration note, 10 October: this work is now committed on top of main (branch `claude/integrate-shared-checkout`) with its focused tests rerun there. The counts, receipts and package check below are from the 6–7 October checkout at 0.1.34.

Bud can answer with a fenced `chart` block (JSON: `bar`, `line`, `area`, `stats`, `heatmap`). RealBud draws it with its own React SVG (no chart dependency, no eval, no raw HTML), lazily loaded so Desk's chunk is unchanged.

- Parser: `shared/chat-chart.ts` never throws; strict limits (8 series, 200 points, 12 figures, heatmap 744 cells, 32 KB, finite numbers). Fields a chart doesn't use are ignored, never passed on.
- Renderer: `src/components/chat-chart/`, hooked at the `chart` branch of `src/components/ChatMarkdown.tsx`. Streaming shows "Drawing chart…"; an invalid block shows "This chart couldn't be drawn", a table of what parsed and closed raw data; a render or chunk-load failure is caught inside the chart, so the rest of the message keeps its formatting.
- Plain-text paths (Copy, Send to phone/summary, Telegram/Discord/Slack relays) turn charts into readable lines.
- Instruction: one "Charts:" line in `productBudSystemPrompt()` (`server/ask-book.ts`): real numbers from this turn's sources only, with `source`.
- Palette `--color-chart-*` in `src/styles.css` `@theme`, light only; every chart has a legend for 2+ series and a table view.

Evidence (local tests, scratch-built UI, fictional data): 2305/2305 renderer, shared and channel tests; fuzz 600 parses and 520 renders without a throw; `scripts/qa-chat-charts.mjs` 13/13 with zero page errors and no horizontal scroll at 1440/390. Receipt and screenshots: `outputs/chat-charts-2026-10-06/`. Not run: `qa-screen-loading.mjs` (reads shared `dist/`); Discord/Slack relays have no dedicated test.

## 7 October: tuning and local packaged build

- Adherence proxy (not the office's production model): Bud's exact chart rule plus 12 fictional office scenarios, replies checked with the real parser (`outputs/local-tune-2026-10-07/eval/`). Sonnet 9/9 charts drawn, Haiku 8/8; neither charted the 3 scenarios that should have no chart (empty book, single balance, drafting). Haiku omitted a title once, so a missing title now draws as "Key figures" / "Heat map" / "Chart", and `null` optional fields count as absent.
- Full suite after tuning: 8523 passed / 0 failed / 327 environment-gated skipped; typecheck clean.
- `pnpm package:mac:qa` built 0.1.34 (unsigned, ad-hoc) at `release/mac-arm64/RealBud.app`; its `Resources/ui` and `Resources/server` contain the chart chunk, the "Charts:" rule, "Key figures" and "Office & colleagues". Launched with a scratch `REALBUD_DATA_DIR` and `--user-data-dir`; charts and the Workspace row rendered from its service; the real `~/Library/Application Support/RealBud` and `~/.realbud` were unchanged. Not installed to /Applications; both processes stopped.

## 7 October: variation round

- Harder adherence proxy (20 scenarios incl. a pie request, one-point data, no data, a yes/no question, conflicting bank figure, injected "script" instruction in tool data, two charts requested; `outputs/local-tune-2026-10-07/eval2/`): after tuning Haiku 17/17 and Sonnet 18/18 charts drawn, 0 scenarios with problems. Tuning: unit limit 12 → 24 characters ("AUD (thousands)"); the rule tells Bud to leave out "unit" on mixed figures and write values like "$182,400" / "9 jobs" (rechecked on both models).
- Rendering gallery `scripts/qa-chat-chart-gallery.mjs`: 42 variations × 390/768/1440, 0 layout problems, 0 page errors (before fixes: 9 automated faults plus visual ones). Fixes in `src/components/chat-chart/`: category bars turn sideways when names don't fit, measured label widths, unit captioned once, honest all-zero and flat-heatmap states, compact ticks from 10,000, non-wrapping figures, narrow-card "Table" toggle, capped fallback tables. Shared formatter keeps small decimals (0.012). Before/after: `outputs/chat-chart-gallery-2026-10-07/{before/shots,shots}/`.
- Left: the streaming placeholder (360 px charts, 220 px figures) can still shift the reply by up to ~40 px for a typical vertical chart, more for long sideways charts.

# macOS feature acceptance — 2 October 2026

Owner direction: every feature proven on macOS first, then the same list on a Windows VM. Evidence tiers named per row: **local** (source + local tests/QA), **packaged** (installed RealBud on the owner's Mac, scratch or real data as stated), **live** (a real account, owner present and approving).

Rules: dev checks never use `~/.realbud`; live rows run on the owner's installed app with the owner present; nothing is sent, paid, posted or uploaded to REI unless that row says so and the owner approves that instance.

| # | Feature | How it is proven | Tier needed | Status |
|---|---|---|---|---|
| 1 | App starts, Bud ready, no empty browser at launch | packaged boot; `/api/hermes` ready; no browser process | packaged | 0.1.31 ✓ |
| 2 | Hermes 0.21.5: Install recommended → restart → ready; Use previous → 0.21.3 | owner presses Install; readiness; rollback once | packaged | pending owner |
| 3 | Ask answers with the chosen effort (relay) and real token/cached counts | one live Ask turn; relay log shows effort; usage event has cachedRead | live | pending 2 |
| 4 | Multi-step tool use through Modelvia on 0.21.5 (reasoning replay) | live turn with ≥3 tool calls | live | pending 2 |
| 5 | Prompt caching (only if 4 shows cachedRead > 0 when enabled) | before/after token counts | live | pending 4 |
| 6 | Word / Excel / PDF / PowerPoint create + read | Ask creates each file in the workroom; attach and read back | packaged | 0.1.33: all four created and read back, **but** Bud's shell used `/usr/bin/python3` (system), not its venv; 8 shell approval cards. PATH fix in source (venv first on macOS); recheck next package. Card friction: owner decision |
| 7 | Read a pasted link (read_page); refuses links found in pages/mail | Ask turn with a pasted public URL; injected-link refusal | packaged | ✓ 0.1.33 (example.com read; in-page link refused) |
| 8 | Reminders: Desk add/snooze/done; Bud `set_reminder` | UI + Ask turn | packaged | ✓ 0.1.33 API (create/snooze/stale 409/dismiss) + Bud set one in office timezone |
| 9 | Saved views changed by asking Bud (card, sidebar refresh) | Ask turn | packaged | ✓ 0.1.33 (create + delete via cards; copy nit: Bud says 'if a card appears' after approval) |
| 10 | Workspace layout (two-column Settings & help, deep links) | renderer QA + 390px | local ✓ / packaged pending 0.1.33 | local ✓ |
| 11 | Gmail/Outlook: search/read/draft without card; send shows card with real recipients | connect test mailbox; draft; one self-addressed send approved | live | pending owner |
| 12 | Calendar: read free; create shows card; cancel blocked | connect calendar; one test event approved then deleted by owner | live | pending owner |
| 13 | Hermios: connect (OAuth), read a record, one reviewed change on a test record | Desk → Hermios + Ask | live | pending owner |
| 14 | Redbark: Connect (OAuth), Ask bank tool lists accounts/transactions | Connected apps + Ask | live | pending owner connect |
| 15 | Add a connector by URL: review, approve read tool, call, drift quarantine | a public test MCP server | packaged | **FAIL 0.1.33**: add → 500 and the whole list 500 until removed (installed-only; fresh install OK). Fix in progress |
| 16 | Browser: Bud opens sign-in page itself; submit asks; download private; upload card | fictional site + one real read-only site | packaged | local ✓ |
| 17 | W1 real run to the upload ask (Redbark → review → ANZ artifact) | real bank feed; stop before upload | live | pending 14 |
| 18 | W2 weekly bills + calendar | test mailbox / fixtures | packaged | local ✓ |
| 19 | W3 morning priorities | test mailbox | packaged | local ✓ |
| 20 | Repair/upgrade path re-applies pack and document deps unattended | 0.1.33 install over 0.1.32 | packaged | fix in 0.1.33 |

Windows follows with the same table once rows 1–20 are green or explicitly deferred.

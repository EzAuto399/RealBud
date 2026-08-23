# TODOS

## Hermes partial-facts answers count as complete (gate-4 soft spot)

- **What:** `tryHermesLedger` accepts any strictly-parseable row set as success. Properties absent from a live Hermes answer keep their stale ledger facts and evaluate normally, while the Hands chip flips to "Hermes live". Files: `server/hermes-hands.ts` (parse/resolution), `server/desk.ts` (`runMorningCheckLive` applies rows wholesale without coverage check against requested ids).
- **Why:** Hard gate 4 says any hands miss ⇒ hold. A *subset* answer is currently neither treated as a miss nor as full coverage — uncovered properties are silently stale under a "live" label. This is the last honesty gap in the fail-closed story.
- **Pros of fixing now:** closes the gap before any office depends on it; small diff (compare returned ids vs requested, missing ⇒ hold those properties with reason like `uncovered-by-worker`).
- **Cons of fixing now:** impossible to test against real worker behavior until an office runs live Hermes; risks over-holding during demos that intentionally use partial fixture answers.
- **Context:** Surfaced by eng-review Outside Voice on 2026-08-23 (confidence 8/10). Pre-existing — not introduced by `bdb05ce..aff31a7`. Exposure requires `mode !== "demo"` AND live Hermes, i.e. zero exposure until a named pilot runs live hands.
- **Depends on:** PILOT-CONTRACT.md eight fields signed; first office on live Hermes mode.

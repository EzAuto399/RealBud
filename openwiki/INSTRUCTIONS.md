# RealBud OpenWiki brief

Product name is **RealBud** (not PropertyMe, Hermes, or OpenMausBot). Ship identity and product rules live in `CLAUDE.md`, `docs/IDENTITY.md`, and `DESIGN.md` — treat those as law when they conflict with generated wiki prose.

## Purpose

Write an agent-readable wiki of how this repository works today: architecture, workflows, safety fences, and where to change things. Humans already keep product plans under `docs/`; the wiki should index and explain the **running system**, not rewrite strategy docs.

## Priorities (high → low)

1. **Desk + book** — `server/desk.ts`, `/api/desk`, first-run Desk, properties, never-rules, Recheck / evidence.
2. **Ask + Bud** — product Ask thread, `server/ask-book.ts`, Hermes as headless hands (`pack/property/`, `hermes -p property`), model attach on You.
3. **Portal / Run beside me** — `docs/PORTAL-WORK.md`, `server/portal-fence.ts`, attended runs, Attach, site rules (read/prefill), human Submit/Pay/Send.
4. **Schedule / loops** — RealBud clock routines (`server/routines.ts`), not Hermes cron.
5. **Saved jobs / recipes** — plan approve, attach, capabilities, origins.
6. **Connected apps** — Composio broker key, connect intents (no secrets in Ask).
7. **Electron shell** — RealBud owns the window; packaging under `electron/`, data in `~/.realbud`.
8. **QA harness** — `docs/QA-LIVE-DEBUG.md`, `pnpm qa`, e2e scripts.

## Hard product constraints to document accurately

- Never launch Hermes.app; never edit Hermes source; pin stays in `server/hermes-pin.ts`.
- Bud never sends, pays, or presses Submit unless an explicit attended Submit capability + human Allow.
- Portal login is always human; cookies/sessions are not stored forever as Bud's secrets.
- One Bud thread in product mode — no multi-bot roster.

## Out of scope / de-emphasize

- Upstream OpenMausBot features RealBud deliberately does not take (iOS, teams, plugins, model shop).
- Marketing copy, graduate installer / PR C / inbound work gated by You → This office.
- Verbatim duplication of long design essays in `docs/` — link and summarize instead.

## Tone

Calm, concrete, PM-desk language. Prefer paths and invariants over aspirational roadmap.

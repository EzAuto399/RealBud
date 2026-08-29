# RealBud — LLM briefing (handoff)

Date: 2026-08-29
Repo: EzAuto399/RealBud (local folder still /Users/yoda/projects/PropertyMe)
Canonical spec: **docs/GOAL-PROMPT.md wins on conflict**. Pickup list: **docs/NEXT-WAVE.md**. Read next: DESIGN.md, docs/PRODUCT-DESIGN-PLAN.md, docs/ROUTINES.md, docs/PILOT-CONTRACT.md, pack/property/SOUL.md, TODOS.md.

You are continuing RealBud: a supervised Australian property-management desktop app. Do not invent a PMS, a Hermes fork UI, a bot roster, or a 50-hour unsupervised agent. If a change does not make the worker more PM and less general agent, it is out.

---

## 1. The product in one paragraph

RealBud is a native desktop app (Warm Operational Ledger design) for one PM. It opens on **Desk** — a portfolio exception queue → property/tenancy case → evidence → human decision → bounded browser handoff. Ask is a case-scoped conversation with one worker (Bud). Schedule runs named loops on RealBud's clock. You holds agency/source/worker settings. The PM pastes, drops, or talks their book into existence; Bud drafts everything; **Allow is the only execute button**; a licensed human sends and pays, always from the PMS.

## 2. Hard gates (code invariants, tested)

- `POST /api/desk/drafts/:id/send` always 403; approval never means sent
- No trust EFT, no statutory notice drafting, no invented legal clock
- No Always-allow/auto-approve (denied at the API), no `--yolo`, no cron from Hermes (`cron_mode: deny`, `approvals: manual` — code-owned, never editable)
- `evaluateProperty` never reads Notes/vault (regression-tested)
- The user never touches Hermes: no Terminal, no `hermes` CLI in user flows, no Hermes vocabulary outside Advanced diagnostics
- Browser work is case-scoped, bounded, exact-origin, human-Submit
- One user, one Bud, four nav places (Desk/Ask/Schedule/You)

## 3. What is shipped (all on origin/main, 500 tests green)

**Platform**
- Desk V3 domain model: Agency/Source/PropertyGroup/Property/Tenancy/Contact/ImportIssue/Case/Evidence/MoneyPosition/Proposal/ProposalRevision/Decision/PortalBinding/PortalRecipe/Handoff; strict decoders, atomic encrypted V2→V3 migration with compatibility snapshot, recovery (quarantine + read-only)
- Immutable Evidence + bounded current projections; evaluators never scan history
- Warm Ledger design system (DESIGN.md) with adaptive desktop split view

**Product**
- Desk: queue (filters/search), case canvas (facts, safeguards, wording, decision bar), evidence rail, Book mode (properties, tenancies, contacts, CSV import with row-level holds, ImportIssues)
- Morning money loop + Friday owner letter v0 (both built, clock-editable with revision + no-backfill)
- Ask: PM-scoped chat, courtesy/levy proposals, **paste/drop intake → staged book proposals → Allow fills the book** (deterministic parser, model-optional; pack skill `intake-properties` for conversational intake once a model is funded)
- Worker bridge (zero-terminal): in-app install with streamed progress + preflight + pin verification; model attach (provider picker, key → profile `.env`, model suggestions from the worker's own cache); one-click pinned worker update; key-optional edits with masked key hint
- Recovery key escrow: reveal/copy 64-hex key; unlock-quarantined-book flow
- First-run three-rules screen + Desk/You go-live card; Worker vocabulary; partial ledger holds; one persist for bulk add / Allow-all; Electron `safeStorage` wrap; You last-checked + shared Recheck/Test clock (`hands-last.json`)
- Blind-spot hardening: PATH-safe probes, single-instance lock, host-timezone recovery, send-gate canary tests

## 4. Current test/QA state

- 64 test files / **500 passed** / 8 skipped; typecheck clean
- `node --experimental-strip-types scripts/e2e-walkthrough.mjs` → 26-check walkthrough ALL GREEN (demo→live→allow→CSV→issues→clock→loops→portal handoff→bud-refused→human-submit→recovery)
- Live four-place UI QA passed (findings fixed; P3s tracked in plan)

## 5. The plan (do not jump)

**Immediate code.** W1–W5 in `docs/NEXT-WAVE.md` shipped (first-run + go-live, worker holds, batch persist, safeStorage wrap, last-checked + shared Recheck/Test clock).

**Human, not code.** Fund one model key to live-test conversational + image intake. Fill the eight fields in `docs/PILOT-CONTRACT.md` on a visit.

**Gated on the pilot office**
- Inbound-triage mail, vendor portal, graduate installer, PropertyMe read API, Pocket
- Ask-proposes-clock-changes (PR C), property scope (PR D), Windows worker bundle

**Do not start** inbound, a law shelf, Cmd+K, PropertyGroup UI, or a second agent to "finish" the product.

## 6. How to work in this repo

- `pnpm typecheck` / `pnpm test` (or npm equivalents) before any commit; `node --experimental-strip-types scripts/e2e-walkthrough.mjs` after Desk changes
- QA with isolated data: `REALBUD_DATA_DIR=/tmp/… HOME=/tmp/… node --experimental-strip-types server/index.ts` + `./node_modules/.bin/vite --port 5199`
- User-facing strings never say Hermes (only Advanced diagnostics); never open Terminal; never edit Hermes source; pin bumps are deliberate
- Docs live or die: update GOAL-PROMPT/PRODUCT-DESIGN-PLAN sections you change
- If the next instruction is missing: pick the top open row in `docs/NEXT-WAVE.md`. Tests first for gate and persist code.

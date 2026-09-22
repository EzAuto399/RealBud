# RealBud

Our OpenMausBot fork. Product name is **RealBud**.

Do not ship as PropertyMe (PMS trademark), Hermes, or OpenMausBot.

- Data: `~/.realbud`
- Goal prompt (paste into a new session): `docs/GOAL-PROMPT.md`
- Current product direction (owner clarification 2026-09-21): `docs/decisions/2026-09-21-business-os-and-austin-workflows.md`. RealBud is a standalone extensible business work OS; Austin Realty is the first workflow pack. This supersedes earlier PM-only scope and permanently fixed screens. Preserve core permissions, source truth and recovery while integrating the three Austin workflows.
- Current proof and remaining gates: `docs/BUSINESS-DESKTOP-2026-09-21.md`. `docs/NEXT-WAVE.md` and `docs/PM-DAY.md` are earlier PM-workflow references, not current scope limits. Source-account access and live portal actions still need their applicable customer authority.
- Native PM design system + approved implementation plan: `DESIGN.md` + `docs/PRODUCT-DESIGN-PLAN.md`
- Routines design (GUI + Ask, Hermes as hands): `docs/ROUTINES.md`
- Identity: `docs/IDENTITY.md`
- Workflow: `docs/WORKFLOW-PLAN.md`
- Desk (fixture arrears Allow/Deny/Edit, no send): `server/desk.ts` + `/api/desk`. First-run lands on Desk; engines stay out of onboarding. Desk owns the book: add/edit/remove properties (`POST/DELETE /api/desk/properties`), full per-property options, per-property hands facts; `never` rules are locked.
- RealBud owns the visible window. Pinned Hermes profile `property` is headless only (`pack/property/`, `server/hermes-pack.ts`). Models attach on that profile. Never launch Hermes.app. Never edit Hermes source. Do not register Claude/Codex/Grok as agents.
- Hermes worker pin and reviewed releases: `server/hermes-pin.ts` and `server/hermes-releases.ts`. Check current source; do not track upstream main or trust an old document's version. Preserve profile isolation; a fallback fixture is never evidence that real sources were checked.
- OpenMausBot upstream: reuse reviewed harness/safety patterns. Do not import an unrelated agent roster or model shop. Workspace customization uses scoped RealBud APIs and versioned definitions; legacy plugin routes are not an extension sandbox. Vendor credentials must stay outside customer/Hermes-controlled storage before claiming vendor-only custody.
- Schedule = named loops on the RealBud clock (`server/routines.ts` + `/api/loops`): morning-arrears and owner-letter are built; inbound-triage is declared. No bot prompt-runner, no MAUS roster, no Hermes cron UI (`cron_mode: deny` stays). A loop is never a bot turn, a prompt, or a second agent.
- Portal ("Run beside me"): `docs/PORTAL-WORK.md` + fence `server/portal-fence.ts`. Human signs in and presses Submit/Pay; Bud reads and prefills. Site rules (read/prefill) may auto-allow; Submit is a per-instance ask only on jobs with 'Bud may press Submit'; pay/sign/notice/send never.
- QA: `docs/QA-LIVE-DEBUG.md` + `pnpm qa` / `scripts/qa-e2e.mjs` (five HTTP suites from source, no worker).

## Working in this tree

- Node 24 + pnpm. `pnpm typecheck` (app + server), `pnpm test` (vitest over `shared/`, `server/`, `electron/`, `src/`), `pnpm exec vitest run <file>` for one file, `pnpm exec tsc -p tsconfig.server.json` for server-only types, `pnpm check:electron` for the plain-JS Electron entrypoints, `pnpm qa` (typecheck + test + two-device gate + `scripts/qa-e2e.mjs`). `website/` and `managed-gateway/` test separately with `node --experimental-strip-types --test`.
- Integration tests gate on `REALBUD_TEST_POSTGRES=1` (+ `REALBUD_TEST_POSTGRES_BIN`); renderer QA scripts need `PLAYWRIGHT_MODULE`. A skipped or environment-gated test is never counted as passed.
- Path-scoped conventions live in `.claude/rules/` and load when you open matching files. Read the matching rule before editing that area; it records the idioms a newcomer gets wrong (authority at the boundary, private storage, durable execution, copy rules, packaging).
- This checkout is shared with a long-running Codex session that edits and builds here. Before editing, list recent changes with `find . -path ./node_modules -prune -o -path ./dist-server -prune -o -type f -mmin -60 -print` and stay off files touched in the last hour unless the task requires them. Never revert, reformat or `git add -A` other people's uncommitted work. Never commit or push unless asked. Do not run package builds or Postgres-backed suites while another build is running here.
- Evidence tiers stay separate and are named in every report: source → local tests → packaged build → installed device → live integration → customer acceptance. Fixtures, fictional providers and unsigned packages are never customer proof. Receipts go to `outputs/<topic>-<date>/`; checkpoints to `docs/<TOPIC>-<YYYY-MM-DD>.md`, linked from `docs/GOAL-PROMPT.md` and `docs/END-STATE.md`.

## Models and delegation (Claude Code)

- The interactive session runs Fable; spend it on scope, integration, judgment and final verification. Delegate bounded work to Opus 5 subagents (`model: "opus"` on the Agent tool, or the project agents in `.claude/agents/`: `repo-surveyor`, `implementer`, `test-runner`, `reviewer`): repository surveys, a bounded implementation with an explicit file-ownership list, running suites and summarizing failures, an independent read-only review of a diff. `.claude/settings.json` sets `CLAUDE_CODE_SUBAGENT_MODEL=opus` so an unlabelled subagent defaults to Opus; pass `model: "fable"` only when a packet genuinely needs the stronger model.
- Run independent packets in parallel and in the background. Give each a file-ownership list, an output format and a line budget. Never two writers on one file. A subagent's report is evidence to verify, not a claim to relay: rerun the decisive test before reporting.
- Subagents inherit every boundary in this file and the working agreement: no live customer accounts, no sending, no deployment, no Hermes.app, no secrets in fixtures. They are development tooling; never register them as RealBud runtime agents.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /gstack-office-hours
- Strategy/scope → invoke /gstack-plan-ceo-review
- Architecture → invoke /gstack-plan-eng-review
- Design system/plan review → invoke /gstack-design-consultation or /gstack-plan-design-review
- Full review pipeline → invoke /gstack-autoplan
- Bugs/errors → invoke /gstack-investigate
- QA/testing site behavior → invoke /gstack-qa or /gstack-qa-only
- Code review/diff check → invoke /gstack-review
- Visual polish → invoke /gstack-design-review
- Ship/deploy/PR → invoke /gstack-ship or /gstack-land-and-deploy
- Save progress → invoke /gstack-context-save
- Resume context → invoke /gstack-context-restore
- Author a backlog-ready spec/issue → invoke /gstack-spec

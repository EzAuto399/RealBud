# RealBud

Our OpenMausBot fork. Product name is **RealBud**.

Do not ship as PropertyMe (PMS trademark), Hermes, or OpenMausBot.

- Data: `~/.realbud`
- Goal prompt (paste into a new session): `docs/GOAL-PROMPT.md`
- Next sessions: `docs/NEXT-WAVE.md` (mount first-run, hands honesty, batch persist). Do not start inbound, PR C, live CUA, or a graduate installer until `docs/PILOT-CONTRACT.md` names an office.
- Native PM design system + approved implementation plan: `DESIGN.md` + `docs/PRODUCT-DESIGN-PLAN.md`
- Routines design (GUI + Ask, Hermes as hands): `docs/ROUTINES.md`
- Identity: `docs/IDENTITY.md`
- Workflow: `docs/WORKFLOW-PLAN.md`
- Desk (fixture arrears Allow/Deny/Edit, no send): `server/desk.ts` + `/api/desk`. First-run lands on Desk; engines stay out of onboarding. Desk owns the book: add/edit/remove properties (`POST/DELETE /api/desk/properties`), full per-property options, per-property hands facts; `never` rules are locked.
- RealBud owns the visible window. Pinned Hermes profile `property` is headless only (`pack/property/`, `server/hermes-pack.ts`). Models attach on that profile. Never launch Hermes.app. Never edit Hermes source. Do not register Claude/Codex/Grok as agents.
- Hermes worker pin: `server/hermes-pin.ts` (v0.20.3 / v2026.8.16.2). Do not track upstream main. Desk Recheck may call Hermes; any miss falls back to the training book.
- OpenMausBot upstream: take harness/safety only (PATH, ports, redact, stall watchdog, proxy paths, permission broker). Do not take iOS, extra engines, teams, plugins, or their model shop. Models stay on `hermes -p property`.
- Schedule = named loops on the RealBud clock (`server/routines.ts` + `/api/loops`): morning-arrears and owner-letter are built; inbound-triage is declared. No bot prompt-runner, no MAUS roster, no Hermes cron UI (`cron_mode: deny` stays). A loop is never a bot turn, a prompt, or a second agent.

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

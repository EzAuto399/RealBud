# Plan: REI Cloud as source of truth, daily refresh, signed client packs (2026-10-06)

Decision: `docs/decisions/2026-10-06-rei-source-of-truth-and-client-packs.md`.

Evidence tier for everything below until stated otherwise: source, plus local tests on the fictional REI portal. A live REI read needs the client's written authority.

## Where we start (survey, origin/main 2ce368b)
- **How Bud reaches REI:** browser only, in the person's session. There is no API (`docs/decisions/2026-09-24-rei-browser-first-api-when-approved.md`).
- **Read recipes:** 13 recipes plus a `batches.morning` in `pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json`. They launch only from Ask (`server/portal-recipe-task.ts:145`, `grant.route === "ask"`), and results are reply text only.
- **Writes:** only the W1 receipting upload (`server/w1-rei-workflow.ts`).
- **Desk `Property`** (`shared/contracts.ts:91`): no owner, no REI ids, no amount owing, no per-field source. CSV import updates facts only, and can't add properties (`server/desk.ts:506`).
- **Freshness:** `server/source-gate.ts` treats a CSV as fresh for 12 h and a portal read for 30 min. There's no precedence rule.
- **Packs** (`server/customer-packs.ts`): digest-bound install, upgrade and rollback. Export covers only built-in definitions. Recipes and the site map are hardcoded to a repo path (`portal-recipe-task.ts:32`). There's no signature.

## Packets (one owner each, built in order)
| # | Packet | Main files | Depends on |
|---|---|---|---|
| P1 | **Signed client packs + per-client export.** Ed25519 signature (`node:crypto`, no new dependency) with a pinned public key. Install refuses an unsigned or tampered pack. Export includes workflows, recipes, site map and office settings, with loops off, no data and no secrets. Recipes load from the installed pack instead of the repo path. | `server/customer-packs.ts`, `customer-pack-definition.ts`, `workflow-packs.ts`, `portal-recipe-task.ts`, new `server/pack-signing.ts`, `scripts/sign-pack.mjs` | none (can start now) |
| P2 | **REI-shaped Desk.** Owner entity, REI ids, amount owing, paid-to date, per-field `source`/`observedAt`, the "differs from REI" hold, and new properties proposed as cards. | `shared/contracts.ts`, `server/desk.ts`, `server/csv-ledger.ts`, `server/source-gate.ts` | #59 merged |
| P3 | **REI read → Desk.** Map the tenants, arrears and ledger recipe rows into Desk using the P2 rules, with holds for unmatched or ambiguous rows. | `server/portal-recipe-task.ts`, new `server/rei-desk-sync.ts` | P2 |
| P4 | **Daily read-only refresh loop.** A `rei-morning-refresh` loop, off by default. A grant that is read-only and loop-scoped. Signed out means "Missed: sign in to REI". It never writes. | `server/routines.ts`, `server/browser-authority.ts` (read-only loop grant) | P3, #59 merged |
| P5 | **Daily-workflow use and edge cases.** Extend the fictional REI portal and `scripts/qa-austin-day-one.mjs` with these cases: refresh, a change in REI, a Desk edit held, a new property card, sign-in expired mid-run, partial read, REI slow or down, two refreshes racing, a restart mid-refresh, and a clock jump. Add these to the chaos harness as well. | `server/testing/fictional-rei-portal.ts`, `scripts/qa-austin-day-one.mjs`, `scripts/resilience/*` | P3, P4 |

## Owner and customer inputs
- **Publisher signing key:** generate it once, offline. Keep the private key outside the repo, for example in 1Password or Keychain, and pin only the public key.
- **A real REI tenants and arrears export sample** from Austin, with their consent, to confirm the column mapping. Use fictional data until then.
- **Written authority from Austin** for the first live read-only refresh on an installed device.

## Coordination
The "ANZ business account setup" session's #59 touches the same areas: `routines.ts`, `contracts.ts`, `index.ts`, and the REI `recipes.json`/`site-map.json`. P2–P5 start after #59 merges into `main`. P1 can start now.

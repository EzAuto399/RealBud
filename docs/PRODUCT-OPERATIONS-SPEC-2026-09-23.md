# Product and operations spec — 23 September 2026

What this document does not establish: no customer has run any of this. Every claim below is
source, local test, packaged build on this Mac, or a hosted Windows runner. Signing, a real office
computer, a real Gmail mailbox and a live Modelvia deployment remain gates (`docs/GATES-2026-09-22.md`).

Tier: Product (desktop app, website portal, Windows/macOS operation, Modelvia, Hermes worker).
Inputs: five read-only surveys run on 23 September 2026 (setup paths, website portal, Modelvia,
Hermes capability use, desktop operations), each decisive claim re-checked against source.

## Product, user, job

RealBud is a business work OS on the office's own computer; Austin Realty is the first workflow
pack. Primary user: a nontechnical agency owner or office manager, daily, on a Windows or macOS
desktop. Secondary: the same owner on the website (phone or laptop), weekly, for billing, linked
computers and remote approvals. Job: get the office's routine money and mail work prepared every
morning, approve it, and never lose control of what is sent, paid or signed.

## Happy paths

**Independent agency (new office).** Download → install → first launch lands on setup →
1 name the agency and choose the workflow pack → 2 connect accounts (link this computer to the
RealBud account, which provisions the Modelvia model key and the Composio connector without typing
a key; then connect Gmail) → 3 approve the morning workflow and turn its schedule on → Desk shows
the first prepared work. Target: no typed code, key or path; one browser sign-in and one Gmail
consent.

**Joining an existing office (second computer).** Owner presses "Invite a computer" on the host →
one join code (or link) → new computer installs, pastes the one code → it connects to the host,
enrolls the person, links to the same RealBud account and provisions its own model access → owner
grants department access from the notice the host shows. What does not carry over is said before
joining: each computer keeps its own private Desk book and Bud setup.

## State matrix (setup and operation)

| Surface | Empty / first run | Loading | Error | Blocked | Recovery |
|---|---|---|---|---|---|
| Setup step 2, link account | not linked: one "Link this computer" action | waiting for browser approval, with cancel | code expired or refused: new request | website unreachable: retry, work continues offline | pending link survives restart |
| Model access | provisioning: "Setting up Bud's model access" | minting | skipped reason in words | revoked or out of credit: named reason and the website page to fix it | re-provision on next report |
| Join office | no host: explain hosting vs joining | connecting to host | wrong or used code: which part failed | host asleep or offline: say so | enrollment pending banner resumes |
| Office service | starting (bounded wait) | — | crashed: restart action | another copy serving: adopt it | support bundle for help |
| Website billing | no usage yet | skeleton | gateway lost reply: retry | not billing owner: read-only | one source of truth per number |

## Slices (wave 1, built in parallel, disjoint files)

| Slice | Outcome | Files | Proof |
|---|---|---|---|
| A Hermes efficiency and isolation | one-shot jobs actually load their pack skill; `import-inspect` uses the member's worker profile; no auto-title calls; no runtime package installs; tighter per-turn loop caps | `server/hermes-hands.ts`, `server/import-inspect.ts`, `server/recipe-draft.ts`, `server/hermes-pack.ts` + tests | unit tests; config diff on a fresh profile |
| B Modelvia provisioning reliability | a lost reply or orphaned project resolves through Modelvia's key listing and rotate routes instead of an operator hold; usage reads retry once and refresh faster | `managed-gateway/modelvia-keys.ts`, `managed-gateway/provisioning.ts`, `server/office-link.ts` + tests | gateway tests; live-usage QA against the local Modelvia branch |
| C One join code | host shows one code that carries the host identity and the invitation; the joiner pastes it once; copy buttons; notice to grant department access | `src/components/CompanySetupCard.tsx`, new `src/lib/company-join-code.ts` + test | unit test; rendered states |
| D Website billing clarity | one usage number from one source, invoice list without duplicates, owner-readable copy, no overflow at 360/768, support contact on the home page | `website/app/account/*`, `website/app/page.tsx` | `qa-portal-billing` renders at 360/768/1280 |
| E Support and disk | "Save support bundle" collects redacted logs; full disk gets its own message on private writes | `electron/main.mjs` (handler only), `electron/preload.cjs`, a You-page card, `server/private-json.ts` | unit tests; packaged smoke |

## Wave 2 (designed here, built after wave 1)

1. **Browser sign-in link instead of the `rb1_` code.** Desktop asks the website for a link
   request (installation id and a locally generated token, as redeem takes today), opens the
   browser at the returned verification page, the signed-in owner confirms "Link this computer",
   and the desktop polls with its own bearer until the website binds it through the same SQL
   authority redeem uses. Removes the only typed code from the independent path.
2. **Crash restart of the office service** without ever forking a second one: the window's health
   poll, on a confirmed-dead recorded service, calls the same start-or-adopt path the You button
   uses, with a backoff and a visible count.
3. **Hermes skill surface**: `.no-bundled-skills` plus a curated pdf/xlsx/docx set, and closing the
   built-in browser tools in Ask once an ACP `/tools` check on a throwaway profile shows whether
   they load.
4. **Modelvia cap updates** reach the live Modelvia project (needs an operator route on the
   Modelvia side; requested from the Modelvia session).
5. **Owner letters and bank matches drafted by Hermes**, checked by RealBud against the ledger,
   always held for Allow.

## Rules every slice keeps

Approvals stay manual; nothing sends, pays, signs or files a notice. RealBud owns the clock
(`cron_mode: deny`). Profiles resolve only through `hermes-profile.ts`. Vendor credentials never
enter customer or Hermes-controlled storage beyond the installation's own vaulted Modelvia key.
Every persisted or shown string passes redaction.

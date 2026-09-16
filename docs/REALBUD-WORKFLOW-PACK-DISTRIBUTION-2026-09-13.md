# RealBud product, workflow packs and private office settings

13 September 2026 · Proposed implementation contract · Authoring examples only

Implementation follow-up: [actual Austin preparation packs and test results](../outputs/austin-workflow-packs-2026-09-13/RESULTS.md) now use the existing version-1 importer, with procedures embedded in job descriptions and steps. They passed the local real-model export/import sequence. The richer additive distribution format discussed below remains a proposal.

The newer [four-stage accounts round trip](../outputs/austin-accounts-workflows-2026-09-13/qa/command-centre/RESULTS.md) also verifies the installed import/export/restore UI and current-source synthetic execution. It confirms the remaining product gap: JSON restores plans, while the test harness still supplies the approved support skill and inputs separately. Follow the [command-centre direction](REALBUD-TEAM-USAGE-2026-09-13.md) for later staff channels; an imported pack grants neither staff membership nor source access.

RealBud should be independently downloadable. A workflow pack should teach it a bounded job; private office settings should tell it which accounts, files, people and rules apply. Austin can receive an office bundle selecting the relevant packs without receiving our development workspace or a separate fork of RealBud.

The intended promise is **download, import, connect, try a sample, then activate**. A skill alone cannot supply authenticated access, enforce permissions, guarantee a successful result or make an untested Windows route work.

## What the two posts contribute

The [inbox workflow post](https://x.com/hermeswatcher/status/2098605839359860847) supplies a useful pattern: bounded source coverage, durable office rules, thread-level interpretation, a next action and human review. The underlying [native email-inbox-triage skill](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/skills/email/email-inbox-triage/SKILL.md) is already present in the selected Hermes source. Reuse its reading and classification procedure, then constrain the Austin workflow to bill evidence. Inbox processing supports the two phase-one workflows; it does not add a third promised inbox-management service.

The [release roundup](https://x.com/iamlukethedev/status/2098660639715794985) points to upstream improvements. The [official 0.21.2 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11) confirms profile-isolation and session/database-recovery fixes. This makes the release a useful compatibility-test candidate. It is not an executable workflow pack, evidence of RealBud compatibility, or proof of tenant isolation. Hermes Desktop fixes also do not automatically change RealBud's Electron app. Keep upstream Hermes unmodified and admit upgrades through RealBud's tested runtime manager.

Hermes already documents [versioned profile distributions](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions/) and [skills with supporting scripts and references](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills). Reuse those conventions. A whole profile distribution can replace owned profile content, so installing one over RealBud is not equivalent to adding a workflow. Its distribution mechanism is unsigned by default; RealBud still needs its own admission policy and additive installation transaction. Native distributions keep private runtime state separate and do not automatically arm imported cron jobs.

## Product boundary

| Layer | Owns | Update independently |
|---|---|---|
| Hermes engine | Reasoning, native tools, skills, memory and supported sessions | Official immutable release; compatibility-tested before promotion |
| RealBud application | Connections, device access, job history, scheduling authority, review, Stop/Continue, verified results and pack management | App release |
| Reusable workflow pack | Job instructions, required capabilities, result contracts, tested helpers and synthetic examples | Versioned pack release |
| Private office settings | Selected workflows, source handles, reviewer identities, approved mappings, exceptions and cadence | Office-controlled configuration |
| Private runtime data | Credentials, connected-account bindings, documents, conversations and run evidence | Never part of a distributed pack |

The Austin bundle selects generic expected-bill review and bank-reference preparation. Austin's private settings bind them to the agreed Gmail sources, ANZ export format and REI handoff. The same skills can serve another office with different settings. A later CRM pack can be separate; REI remains the financial record.

Use one office instance as the initial deployment boundary. A Hermes session or profile is not an operating-system security boundary. Private staff DMs and per-person Composio accounts need identity-to-connection authorization in RealBud; adding skills does not establish it. See the [staff-session design](REALBUD-STAFF-SESSIONS-2026-09-13.md).

## Concrete authoring example

The [example folder](../outputs/realbud-pack-authoring-2026-09-13/) contains:

```text
realbud-pack-authoring-2026-09-13/
  reusable-pm-pack/
    manifest.design.json
    skills/
      pm-bill-evidence-review/SKILL.md
      pm-bank-reference-preparation/SKILL.md
    acceptance-cases.md
  customer-templates/
    austin.office-settings.design.json
```

These are proposed contracts and skill instructions, not an archive accepted by the current importer. No credentials, real office records, live account identifiers or active schedules are included. The customer template is separate from the reusable pack and has unbound connection and operator fields.

A released manifest should identify the publisher, pack/version, supported RealBud capability-contract versions, admitted Hermes compatibility, platform support, dependency versions, exact content hashes and signature. It should list every packaged file, requested permission, workflow, output contract and resource limit. Do not claim compatibility from a broad minimum Hermes version alone.

Use an explicit release-file allowlist. Never distribute development AGENTS/Cursor/Codex instructions, personal paths, cookies, auth files, a copied live profile, customer exports or historical conversations. Keep local learning and office rules outside immutable released skill files. A learned improvement becomes a reviewed new pack version; it must not silently change an approved procedure.

The example intentionally contains no new banking script. Reuse [bank-reference.ts](../server/bank-reference.ts) behind a typed host capability: it already parses exports, proposes references and checks reviewed output. Extract a reusable module only if packaging requires it. Do not ask a model to recreate financial file transformations on each run. The capability names in the example manifest describe proposed contracts, not tools available today.

## From a meeting to a working skill

1. Write one job contract from a real example: trigger, supplied inputs, allowed actions, reviewer, output and proof of completion. Record uncertain transcript details as questions, not rules.
2. Put transferable procedure in the skill. Put office-specific identities, source bindings and approved business rules in private settings. Put repeated parsing, date calculations, file integrity and deduplication in tested code.
3. Reuse native skills where useful. For bills, read approved relevant threads using the inbox skill; interpret attachments and ambiguity with the model. Derive arrival dates from the approved register. An unchanged inbox still needs a due-date check.
4. Have the model propose structured findings with source links. Let RealBud validate and persist them through authoritative handlers; model prose saying “updated” is not a completion receipt.
5. Evaluate against synthetic cases with expected outcomes, then run the installed app with the real model. Inspect actual saved records, artifacts, permissions and recovery—not only the final answer.
6. Release a pinned pack only after the complete import-to-result path passes. Use office examples only after the customer authorizes them.

For expected bills, receipt, payment arrangement, available funds and confirmed payment are distinct facts. For bank preparation, preserve original bytes and transaction values; Kevin reviews reference decisions and staff perform the agreed REI handoff. Exact ANZ service/format, clock times and office timezone remain setup inputs.

## Customer experience

Kevin opens RealBud and imports the office bundle. RealBud previews “Expected bills” and “Payment reference preparation,” explains their required sources and shows any missing dependencies. Connections are made in the app using the customer's own accounts. It then offers a synthetic trial and shows the resulting review card and checked file, with a clear explanation of anything it could not verify.

Only after a successful trial does Kevin choose the real source bindings, timezone, agreed cadence and reviewer. Daily/weekly checks are suggestions until accepted; “about every two days” must not silently become a Monday/Wednesday/Friday schedule. Run now uses the same job contract as recurring work. The user should not need a terminal, environment variables or repeated prompting for a routine job.

If login/MFA, source coverage or a mapping is missing, the run shows Needs you with a specific next step. Continue revalidates the account, input revision and approval before acting. Mobile approval must bind the exact operation to the authorized reviewer. Initial setup is necessary; repeated setup should not be.

## Installation and execution contract

One component owns scheduling and one durable run identity prevents duplicate work. RealBud can reuse an upstream scheduling backend behind that authority; it must not independently arm the same job in two clocks.

| Event | Required behavior |
|---|---|
| Import | Check publisher/integrity, compatibility, permissions and file bounds before staging. Reject traversal, links escaping the package, unexpected executables and oversized expansion. No install hooks or model execution during inspection. |
| Duplicate import | Same ID/version/digest is a no-op. A different digest for that release is rejected; local settings remain intact. |
| Install failure | Stage files and job definitions under a versioned installation record; commit atomically or recover without partial activation. |
| Activation | Require local bindings, accepted permissions and cadence, and a passing sample. A manifest permission request never grants permission. |
| Run | Bind office, actor, pack version, source revision and capability grants. Limit runtime, model turns, concurrency and retries. Serialize access to one desktop session. |
| Partial/unknown result | Keep evidence and checkpoint; report incomplete coverage. Inspect the actual operation before retrying uncertain writes. Do not advance a completion checkpoint merely because a source was observed. |
| Update | Stage and test beside the active version. Review new access or procedure changes. Existing runs retain their version; preserve settings and human edits. |
| Rollback/remove | Keep compatible recovery state and receipts. Disable future starts before removing a pack; revoke its grants without deleting customer records. |

For the first release, admit first-party reviewed packs only. A pack can request an existing host capability, but cannot mint a new trusted capability by declaring it. Arbitrary third-party executable extensions and a public marketplace are separate engineering work.

## What exists and what still needs building

The existing [workflow importer](../server/workflow-packs.ts) validates portable version-1 job plans, preserves conflicting local plans and restores new plans in shadow mode. It does **not** install a versioned skill/script bundle, resolve executable dependencies or establish account permissions. The [pack card](../src/components/schedule/WorkflowPacksCard.tsx) and server templates also contain Austin-specific entries. [Bud's core identity](../shared/bud-identity.ts) is still explicitly property-management oriented.

The separation therefore needs actual integration, not a new label on today's JSON export. Keep the legacy Hermes `property` identifier stable while migrating product behavior; a cosmetic rename is not a safe migration strategy.

The [capability review](REALBUD-HERMES-CAPABILITY-REVIEW-2026-09-13.md) also records an effective Ask toolset/whole-script approval discrepancy. Verify and close that boundary before admitting executable office packs. A restrictive skill paragraph is not enforcement, and the 0.21.2 release notes do not prove that issue fixed.

## Next implementation milestone

Build **one office bundle installing these two workflows into an independently installed RealBud**, with private bindings and no customer-specific branch of the app. Use the existing scope and preserve version-1 plan import compatibility.

Start with generic pack discovery and transactional installation, move Austin selection into bundle data, then connect the existing domain services to typed workflow results and review. Add guided source binding and sample execution. Prove the enforced capability boundary before enabling scripts or external actions. Finally test update/rollback and the actual Windows device route.

Acceptance requires successful first install, sample execution with real Hermes, verified bill findings and reviewed bank output, duplicate import/run protection, missing login and partial-source recovery, stale-approval rejection, blocked cross-office access, restart recovery and a safe pack/engine update. [Acceptance cases](../outputs/realbud-pack-authoring-2026-09-13/reusable-pm-pack/acceptance-cases.md) make the expected behaviors concrete. Structural validation of these authoring files is not installed-app or customer acceptance.

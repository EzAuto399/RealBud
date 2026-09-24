# Austin accounts preparation workflows

Current bundle: **revision 4**. Four executable preparation plans support Kevin's accounts work and the two bill/reference outcomes. Kevin is the sole initial operator and reviewer. Source material may name a property-manager handoff; it does not give another person app access. Second-staff sessions and team usage are deferred. The plans preserve source references and prepare decisions. They do not send, move money, post/import into REI, draft statutory notices, change mail, or activate recurrence.

The [latest round-trip QA](../../../outputs/austin-accounts-workflows-2026-09-13/qa/command-centre/RESULTS.md) exercises the actual installed file picker/export/restore and this bundle in two clean source-test offices. Supporting guidance is separately hash-checked and bound by the test harness. New result-format and unmapped-invoice fixes are in RealBud source and have not been rebuilt into the installed app in that pass; no upstream or pack content was changed.

Import [workflows.json](workflows.json) with the existing version-1 office-pack importer. It contains the complete bounded procedure in each recipe description and steps. New imports become **shadow, locally unapproved plans with `schedule:null`**. The separate [schedule proposals](schedule-proposals.json) are paused suggestions, not executable recurrence. “About every two days” has not been turned into Monday/Wednesday/Friday or a customer-approved clock.

| Recipe | Supplied input in the job workroom | Structured result |
|---|---|---|
| `wf-austin-accounts-inbox-triage` | `workflow-inputs/accounts-inbox.json` | `accounts-inbox-triage` |
| `wf-austin-accounts-invoice-review` | `workflow-inputs/accounts-invoices.json` | `accounts-invoice-entry-review` |
| `wf-austin-accounts-bill-exceptions` | `workflow-inputs/accounts-bill-exceptions.json` | `accounts-bill-exception-review` |
| `wf-austin-accounts-anz-reference-prep` | `workflow-inputs/accounts-bank-reference.json` | `accounts-anz-reference-candidates` |

The intended information flow is inbox triage → invoice candidates and source attachments → invoice entry review → **accepted** bill evidence/state for the exception review. The bank-reference workflow is a separate inbound-rent preparation route. These are related procedures, not an implemented automatic pipeline: the current host must bind each stage's supplied input. A model's invoice proposal does not update the bill register or become accepted evidence by itself.

Revision 4 uses the updated host result contract and current bounded bank procedure. The inbox's **proposed synthetic routing policy awaits Kevin's validation**: owner means the internal accountable reviewer, including accounts FYIs and waiting-on-supplier threads; bank-export availability is an accounts handoff to the separate reference job; hardship, funding shortfalls and unrecovered advances receive high internal-review priority. It creates no external deadline or legal clock. Host-derived Needs you items request internal review or source clarification; approval cannot enable sending, paying, PMS mutation or other prohibited actions.

Earlier bundle revisions and failed runs remain in the QA history. Revision 2 clarified inbox routing; subsequent revisions and host fixes added validation and refined bank handling. Do not describe the current bundle as unchanged from revision 1 or use the earlier six-of-nine summary as the current selected result.

## Native Hermes reuse and the current deployment gap

Kevin's requested morning experience is illustrated by [morning-brief-preferences.example.json](morning-brief-preferences.example.json): a priority-ranked daily work list, preferred views, separate waiting/FYIs, and a proposed ready-by time before office arrival. This file is a design example, **not consumed by the importer or installed scheduler**. The interactive workflow preview uses saved synthetic receipts, preserves their original source order and keeps urgent items and coverage warnings visible through filters. The recipe bundle remains revision 4; its execution instructions and approvals did not change. Scheduled complete-mail collection, saved preferences, unresolved-work carry-forward and ready-by monitoring remain delivery work.

The inbox recipe reuses the native `email-inbox-triage` v0.1.0 scope, complete-thread classification and review procedure. [Its supplied SKILL.md](support/email-inbox-triage/SKILL.md) is copied byte-for-byte from the recorded official upstream commit, with [provenance and SHA-256](support/provenance.json) and [upstream MIT license](support/LICENSE.upstream). The bounded recipe adapts how that procedure is used; upstream Hermes source and skill content were not edited.

**Version-1 JSON import does not copy `workflow-support`, attachments, fixtures, schemas or arbitrary scripts/skill code. One-click portable dependency binding is not implemented.** The test host must separately copy the approved native skill to `workflow-support/email-inbox-triage/SKILL.md`, checking its digest against provenance, and bind the permitted input/attachment files. Missing guidance makes inbox preparation stop with a named hold. Other recipes have their full procedure embedded and need only their bound inputs/attachments.

Prepare uses the current file capability to read that approved guidance. It does not dynamically call `skill_view`, load email connectors or run native cron. Only the skill's reading/classification/review guidance applies; its provider-action stage grants no authority here. File-path and no-mutation instructions are part of the job contract, not a newly implemented filesystem enforcement layer.

## Test package and setup

The synthetic test cases live outside this distributable pack at `outputs/austin-accounts-workflows-2026-09-13/fixtures/`. No real customer threads, property addresses, balances, accounts, credentials or approvals are supplied. Every scenario/source identity is marked synthetic; bank row IDs are deterministic hashes of synthetic source bytes, as produced by the existing host parser.

```text
pack/workflows/austin-accounts/
  workflows.json
  schedule-proposals.json
  contracts/*.schema.json
  contracts/outputs.ts
  support/email-inbox-triage/SKILL.md
  support/provenance.json
  support/LICENSE.upstream

outputs/austin-accounts-workflows-2026-09-13/fixtures/
  manifest.json
  inbox-triage/{complete,coverage-gap}/
  invoice-review/{complete,correction-and-gaps}/
  bill-exceptions/{complete,coverage-and-state-gaps}/
  anz-reference-prep/{complete,ambiguous-and-short-stay,format-unconfirmed}/
```

Each manifest case declares its workflow ID, `inputFile`, job-relative `bindingPath`, separately copied files with hashes, and expected business assertions. Source paths in the manifest are repository-relative. Copy only those allowlisted files into a disposable test office's job workroom; intentionally missing attachments stay missing. The actual workroom location is chosen by the host, not stored in the portable plans. In the current QA host the private workroom is the office's `vault/` directory.

For ANZ tests, `batch.input` contains a synthetic CSV and approved synthetic mappings accepted by the existing `createBankReferenceBatch` function. A QA host can recreate the saved batch through the real bank-reference API and rebind the batch ID/revision. That is a synthetic supported layout, **not verification of Austin's actual ANZ service, login/export route or CSV layout**.

Approve each plan locally, then use the same Prepare path for manual runs. Check complete structured outputs and the source reference against that run's input. Export the plans, import into a second clean office, separately rebind its own files and approve locally again. Duplicate IDs must preserve or reject conflicting local plans; imported approval and machine attachment must not travel.

## Output validation and evidence limits

The normal Prepare receipt carries a short human-readable summary plus one complete JSON object as a separate `outputs` string. Four [JSON Schemas](contracts/) and [TypeScript contracts](contracts/outputs.ts) specify the result. They cover shape; the fixture assertions cover source identity, item completeness and business decisions. The updated RealBud host enforces these four reserved workflow contracts: shape, captured source reference, item order and completeness, linked invoice/bill sources, bank identity/row position, coverage prerequisites and attachment stability. It derives the readable report, item holds and Needs you from one structured result. It rejects stale, malformed or inconsistent results with a diagnostic code and hashes. It does not automatically apply proposals to business records. Independent fixture assertions still assess interpretation, and Kevin must accept the proposed routing policy.

The model creates no bank CSV. A separate exact human decision and host validation must check the batch revision, original digest and reference-only changes before a checked export exists. A test simulating that reviewer bridge proves the exercised host path, not automatic application from a Bud answer or permission for final REI import.

The fixtures include fourteen inbox threads, an incomplete twelve-of-sixteen result, older unanswered thread content, attachment-only invoices, exact duplicates, conflicting corrections, untrusted source instructions, uncertain property mappings, arranged-but-unconfirmed payment, a paid bill with unrecovered company advance, and ambiguous/duplicate/short-stay rent rows. Text attachment fixtures test reading bound attachment content; they do not prove PDF rendering, OCR, mailbox acquisition or portal downloads.

Account access, actual source acquisition, accepted field mappings, office clocks, Windows/installed-app behavior and Austin acceptance need their own evidence. Running these preparation cases does not establish them. See the separate test receipts for actual results; this README makes no blanket readiness claim.

## Current runtime and host

Revision 4 requires the updated RealBud host containing `server/accounts-review.ts`; an older version-1 importer can store the plan but does not prove this validation is installed. Latest official Hermes 0.21.2 is admitted through the RealBud adapter. The supplied triage file was also compared with commit `939e45c91d751fadd94dcd1b873ac3cb44846213`: its SHA-256 is unchanged. Native memory and skills remain outside the versioned runtime. Hermes cron, broad connector access and remote device control are not enabled by importing these plans.

# Workflow pack upgrades and managed mail rehearsal

Local continuation dated 22 September 2026. RealBud now has a reviewed transition for installed workflow packs, with local changes preserved, interrupted updates resumable, and prior configurations available for rollback. The managed Gmail rehearsal now runs two actual desktop services through the real managed gateway and default Gmail adapter. Provider responses and Hermes reasoning remain fictional.

## Behavior and recovery

Pack preview compares the current published definition, local plans and proposed version. Compatible publisher changes merge with staff edits; competing edits produce an explicit conflict. The exact installed generation, target digest and preview digest bind the decision. A durable intent precedes instruction changes and atomic plan writes. Affected plans lose approval and schedules, and remain unavailable until the change is reconciled. Lost replies can be reconciled without creating another generation. The host pauses the selected agency morning clock after saving intent and before changing instructions or approvals; failure leaves a held transition that can be resumed. Completed retries do not undo later schedule choices.

Independent review reproduced an ownership deadlock in which a new pack adopted a plan retired by another pack. Initial import, upgrade, resume and runtime checks now reserve active, retired and pending target plan identifiers. Five independent regressions verify refusal without changes, rollback/resume, legacy ambiguity holds and legitimate unowned-plan adoption.

Removed optional plans remain saved as retired records. Neither normal activation nor execution can revive them; a reviewed rollback or newer pack transition restores ownership. Fixed office workflow roles cannot be silently removed by an imported definition. Rollback preserves business records and current reviewed instruction overrides; it creates a new installation generation and does not restore prior approvals or schedules. The UI presents readable plan fields, exact instruction changes, conflicts, confirmation, recovery and prior-definition downloads.

The recipe writer now distinguishes omitted site notes from an explicit removal. Clearing instructions changes the plan revision and clears its approval. Both backup formats validate the retained configuration history and refuse unfinished transitions. Seven actual restore tests cover both cold-restore paths, authenticated corrupt-history refusal, pending-change refusal, repair and rollback with real recipe persistence. A restored installation repairs missing owned native instruction files before its pack can run.

History is bounded to eight prior configurations and the existing private-journal byte limit. At that bound, additional changes remain held for support; there is no automatic deletion of old history. Prior-definition downloads contain published portable pack definitions, not staff edits or customer records.

## Integrated managed mail

`scripts/qa-managed-mail.mjs` starts two independent managed desktop processes and `scripts/testing/managed-mail-gateway.ts` starts the actual gateway HTTP server, connector authority and default Gmail parser. Each desktop has its own administrator verifier, signed service grant and revocable connector credential. Only the exact upstream Composio fetch boundary is simulated; a desktop fetch guard refuses other destinations. This is a fetch boundary check, not an operating-system network sandbox.

The eight scenario groups prove:

- Separate agencies acquire 45 conversations through two provider pages and three typed reasoning batches each; request replay does not repeat acquisition.
- Forged source/account selection and mismatched profiles are refused; the other agency's saved rows cannot be read.
- Device revocation and service suspension during a held read suppress late success and preserve prior staff records.
- A settings change cancels collection through desktop, gateway HTTP and upstream AbortSignal. Releasing a late successful response does not commit it.
- Upstream errors, malformed evidence and a missing server key fail closed; incomplete coverage remains explicitly partial.
- Staff decisions persist across a cold service restart without changing the other agency.
- A selected-pack change durably pauses the enabled morning clock through plan reapproval and restart. Unrelated packs and agencies remain enabled; a completed retry preserves a later explicit schedule choice.
- Fictional vendor-key canaries do not reach responses, desktop files, workflow inputs, database bytes or captured diagnostics. Log checking runs while streaming and survives restarts.

Receipt: `outputs/managed-mail-integration-2026-09-22/final/integration-receipt.json`. All disposable processes and directories were cleaned. This does not prove a real Composio account, a live model, physical two-device operation or native Windows.

## Startup proof

The package smoke now copies the property pack from the selected artifact and requires the actual fresh private profile, expected safeguards, owned skill files and `/api/hermes` status. It independently reads POSIX permissions or Windows ACLs. Missing packs, incorrect skill bytes, public files and false readiness fail the smoke. The temporary root is canonicalized before applying the production path rules.

The ten focused smoke checks and compiled Mac rehearsal passed (451 ms startup and an 8 ms profile inspection on this Mac; these are observations, not service guarantees). Native Windows execution and startup latency remain unmeasured; existing timeout ceilings and Windows memory admission holds remain unchanged. See `WINDOWS-PROFILE-ACCEPTANCE.md` and `outputs/hermes-windows-acceptance-2026-09-22/service-profile-verification.json`.

## Packaged verification

The final full source suite passes **4,496 tests, zero failures, 149 environment-gated skips** across 353 files in 333.586 reported seconds. The admitted Hermes runtime fixture was enabled. Receipt: `outputs/customer-pack-upgrades-2026-09-22/full-source.result.json`; overall proof: `verification.json` beside it. Focused test counts overlap this suite and are not additional unique totals.

The unsigned macOS arm64 app is `outputs/customer-pack-upgrades-2026-09-22/package/mac-arm64/RealBud.app` (Electron 43.4.0; bundled Node 24.18.1). The installed app was not replaced.

- Actual packaged service and rendered browser: **5 scenario groups pass**, including desktop/390px review, exact lost-response replay, conflicting edits, a verified EACCES write failure, cold restart/resume, rollback, retired-plan activation/run refusal and unchanged business-book bytes. No browser errors or off-origin requests. Receipt: `outputs/customer-pack-upgrades-2026-09-22/gui-packaged/receipt.json`.
- Packaged two-desktop managed mail: **8 scenario groups pass** against the real source gateway/default Gmail adapter, using fictional upstream and reasoning. Receipt: `outputs/managed-mail-integration-2026-09-22/packaged/integration-receipt.json`.
- Native Mac renderer/capabilities/service/shutdown smoke passes. The separate exact-artifact profile probe passes with seven private files and six directories, no attached model and no configured worker. This run measured 482 ms startup and 13 ms profile inspection. Receipts: `mac-smoke.log` and `profile-packaged.json` in the package output parent.
- Every checked build output matches its packaged counterpart: 334 compiled server files, 48 shared files, three supporting files and 342 renderer files. Package preparation, TypeScript/frontend builds and Electron syntax checks pass.
- The source manifest has 1,103 files, digest `b4494fb3dff7210275aa1af180fa52f7207cb947c2b584e902eecf9483e69a49`. The app manifest has 2,421 regular files and 14 symlinks, digest `48afdc418ce83e1cd20d6f13a605e387ec4ef9d7f2e7b82854585fb4a2f68a3a`. Both remained unchanged through packaging and the packaged rehearsals.

All rehearsal-owned services, browsers and temporary directories were cleaned. The native startup smoke proves the packaged Electron path; the mail and pack browser scripts run that bundle's service in Electron Node mode with a separate browser. These are separate proof layers, not a Windows or installed-customer claim.

## Review evidence and limits

A fresh Grok 4.7/xhigh ACP review completed in 115.671 seconds with actual `grok-4.7-build`, one model call and one turn. Its agency-isolation, mid-read revocation/cancellation and key-canary recommendations became the integrated mail checks. No tool/permission calls occurred; observed MCP server/tool counts were zero. See `outputs/managed-mail-integration-2026-09-22/grok-mail-review.md`.

A separate one-shot Grok source review reached its 300-second deadline without a terminal answer. It is not an approval or completed code review. Its process was reaped and configuration remained unchanged; frozen excerpts and the incomplete receipt remain under `outputs/customer-pack-upgrades-2026-09-22/grok-*`. Independent local review and executable tests remain the verification basis.

An integrated clock check initially failed because the selected morning clock remained enabled after a pack upgrade. The preserved negative receipt is under `outputs/managed-mail-integration-2026-09-22/clock-red/`; the final eight-group rehearsal verifies the durable pause fix.

The first browser rehearsal used an incorrect assertion that publisher guidance appears directly in the native skill wrapper. RealBud correctly keeps the guidance in the job workroom; the harness was corrected to check both exact artifacts. Its negative receipt is retained under `outputs/pack-upgrades-2026-09-22/gui/`.

## Release gates

This work does not publish, deploy or replace an installed app. Native Windows installation/GUI/privacy/update/uninstall and current two-device office operation remain required. The protected hosted connector, operator revocation/recovery, real Gmail consent and customer-source acceptance, exact bank/REI acceptance and observed daily office use remain distinct commissioning gates. Website installation reporting still does not constitute remote desktop execution.

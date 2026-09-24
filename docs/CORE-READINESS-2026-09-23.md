# Core readiness — 23 September 2026

This checkpoint does not establish a complete release, normal installed-device provisioning, live account connectivity, native Windows acceptance of the local fixes or customer acceptance. The tests below are working-tree evidence. Package and native-fixture receipts identify their exact candidate separately.

The [owner's current decision](decisions/2026-09-23-core-first-and-workflow-scope.md) is core completion first, followed by bank → CSV, email → bills → calendar, and email → morning priorities. REI upload/recognition/import and its simulator are deferred.

Latest continuation: the [Modelvia/security/UIUX checkpoint](MODELVIA-QA-2026-09-23.md) records further local corrections and the later successful isolated live API run. The earlier expired service and pricing-contract gap are preserved as historical findings; a fresh capped fictional service on the compatible release passed four workflow cases and clarified streaming, with six settled requests and verified closure. This does not commission RealBud's ongoing desktop account or prove real customer workflows.

Earlier continuation: the owner requested a focused personal-bank QA run now,
using Commonwealth Bank Australia, plus a real Modelvia service check. The
[own-bank QA run](../outputs/own-bank-qa-2026-09-23/README.md) records a fresh signed
0.1.19 package at `fb6cebed` plus these local fixes, unchanged source during the
build, passing packaged smoke/signature checks, and an isolated app opened for
account linking. Its actual first-run setup found an unsupported global worker
and no provisioned service administrator. A QA-only selection of an existing,
verified supported 0.21.3 runtime clears version admission; it does not close
fresh-machine setup and disables in-app runtime updates for this launcher.
The app now needs model access and is not ready for assistant execution.
Live Modelvia health/readiness and
authenticated status passed; routes are approved, but all five projects were
inactive at the check. No fresh model call or bank export has passed yet. ANZ
remains a separate bank-specific acceptance run. This directed QA does not
replace the broader core acceptance gates below.

The owner's subsequent broad QA request produced the [broad QA packet](../outputs/broad-qa-2026-09-23/README.md): an amended regression result of **5,536 passed / 0 remaining failed / 252 skipped**, 245 local HTTP checks, 127 separately exercised PostgreSQL integration tests, and passing synthetic bank/CSV, bills, morning-mail and second-office checks. Counts are separate proof sets, not a unique grand total. An onboarding initialization-order failure was repaired and all four affected suites rerun. New configuration, onboarding, disconnect and history fixes have their own focused checks. The packet retains original failures, exact measurements and limits.

The 10,000-message rendered chat stress case found a real problem: typing took 4.7 seconds and switching screens 23.4 seconds. Rendering the newest 200 messages with explicit earlier-history loading, while keeping unresolved decisions and focused branch/edit targets available, reduced the same fixture to **37 ms typing / 132 ms navigation**. All stored history remains intact. The same Mac served a 996-property fictional book at **56 ms desk-read p95**. These are measured local cases, not a universal performance promise.

A fresh arm64 0.1.19 package at `e82ea2f0` plus the local fixes now passes strict deep signature verification and packaged smoke (renderer, capabilities, embedded service and shutdown). Its 1,284-file input digest remained unchanged during the build. It is signed, not notarized, and does not replace the installed app. The [QA launcher](../outputs/broad-qa-2026-09-23/launch-qa.command) uses a new isolated workspace and the previously verified supported worker executable; live model access still requires normal account linking. Two deeper native automation attempts failed in their harness before UI assertions; native onboarding/restart remains an owner Mac acceptance check. Negative receipts and confirmed cleanup are linked from the packet.

## Findings and immediate hardening

| Core area | Observed finding | Current disposition |
|---|---|---|
| Conversation recovery | `Store.thread()` treated every read/parse error as a fresh conversation; append overwrote the damaged original. Catalog reads similarly defaulted damaged data to empty. | Fixed locally in `server/store.ts`: only missing files are fresh; invalid/read-failed data raises typed 503 `store_recovery_required`, preserves bytes, and never caches empty replacements. Invalid/cyclic graphs are held. Unconfirmed writes evict cached transcript state and require a fresh read instead of automatic replay. Root independently reproduced the before/after behavior. |
| Settings and disconnect recovery | A profile save could replace malformed settings; disconnect swallowed withdrawal failure and discarded records before cleanup completed. | `config.ts` now distinguishes absence from corrupt/unreadable settings and preserves bytes with `config_recovery_required`. `worker-model-access.ts` propagates failed withdrawal, retaining records for a repaired retry. Independent before/after settings probe and 52 worker/link regression tests passed. |
| First-run state | Browser-origin flags were lost when the service changed ports, repeating completed welcome screens. | Setup state is now a private workspace/member preference with revisions and separate incomplete/recovery states. 28 focused tests and six rendered restart scenarios passed; restored office contact is preserved. |
| Selected-file privacy | Ask attachment directories and files relied on POSIX mode bits without the Windows descriptor admission used elsewhere. | `server/ask-attach.ts` now verifies existing directories, protects newly created directories/files before content, and cleans only new failed copies. Root verification: 25 passed, 0 failed, 5 Windows-only skips across attachment/privacy/composer tests. Native Windows is still unrun. |
| Core/pack separation | Desk and Jobs mount bank/bill/mail-specific UI without an installed pack; specialized agency setup recognizes two baked-in packs even though generic recipe-pack import accepts other IDs. | Generic extension support is partial. A neutral core shell and a supported capability/view contract remain work; do not erase existing customer configuration or weaken department source restrictions. |
| Generic file execution | Browser downloads capture bytes/hash; selected Ask files and mail metadata take different paths. No verified host-owned artifact handoff connects downloaded bytes into the bank review. Email attachment contents are not acquired. Ask and saved jobs have different capability sets. | Reusable source/artifact acquisition and explicit reviewed capability upgrades belong to core. Bank field mappings and bill/priority rules belong to packs. Browser changes remain under their existing owner. |
| Performance and installed operation | Full transcripts are synchronously rewritten and retained in memory; startup visits all saved tasks. Windows protected writes launch PowerShell. Rendering every history row caused measured input/navigation stalls on this Mac. | Mac HTTP/history/property-scale baselines now exist. Bounded rendering and indexed message versions address the reproduced UI stall; full history remains preserved. Windows write/restore performance and normal installed-device acceptance remain gates. |

## Verification during this assessment

Node 24.19.0 core selection passed **232 / 0 / 0** (passed / failed / skipped) across 12 files: service lifecycle/identity/watchdog/persistence, unattended host, schedule recovery/restart, pack persistence/recovery, member binding, private backup and service control. This is local source coverage, not a complete core acceptance run.

Root attachment recheck passed **25 / 0 / 5** across `server/ask-attach.test.ts`, `server/ask-attach-privacy.test.ts`, and `server/composer-attachments.test.ts`. The native Windows cases are explicitly skipped on this Mac. The tests use real temporary files plus injected privacy-admission failures to check before-content ordering, byte preservation, refusal and cleanup.

Final root Store/consumer integration recheck passed **213 / 0 / 0** across 13 files, including Store recovery, tasks, branching, browser/memory approvals, channel continuations and the real local HTTP server with fictional providers. The three root selections total **470 passed, 0 failed, 5 skipped across 28 files**. These are focused checks, not a full-suite or packaged acceptance claim. Final app/server `pnpm typecheck` passed.

The fixed Store also passed an independent disposable reproduction: malformed transcript returned `store_recovery_required`/503 with original bytes unchanged; the same Store object read 10,000 valid messages after deliberate correction. Five subsequent appends took 17.89–22.55 ms; this small sample is a sanity check, not a claimed speed improvement. Exact observations and source hashes are under `outputs/core-readiness-2026-09-23/`.

Recovery limits remain explicit: `server/index.ts` constructs Store and settles saved tasks before listening. A damaged catalog or loaded transcript can therefore stop service startup safely. This patch supplies no guided repair UI; support/restore remains a separate core acceptance gate. Catalog mutation rollback was not redesigned. No installed app was changed and no native Windows run was executed.

A disposable source probe independently reproduced the damaged-transcript overwrite before the Store fix. It also measured 1 KiB synthetic messages at 500, 2,000 and 10,000 entries. At 10,000 entries (~11.8 MB serialized), five append samples were **18.40, 17.97, 29.35, 27.67 and 19.93 ms**; cold read was **13.63 ms**. This does not measure rendering, complete worker turns, multiple active tasks or Windows. Do not infer an existing user-visible slowdown from the source growth pattern alone.

The recorded native Windows privacy-admission cost is roughly 0.2–0.4 seconds per launch; an earlier installed backup restore took 39 seconds. These are dated runner observations in [Windows acceptance](WINDOWS-PROFILE-ACCEPTANCE.md), not a new device benchmark. The synchronous conversation-write path warrants a measured Windows test.

The packaged `yaml` missing-`isSeq` export defect was fixed by the other session in `dbe53d79`, with a CI build guard in `93277901`. A failed earlier rebuild/smoke does not prove that source fix failed. A fresh package built after integration is still needed. An intermediate active-browser grant-type mismatch cleared by the final successful app/server typecheck; it is not recorded as an outstanding defect.

## Acceptance sequence

1. Corruption/privacy hardening is locally verified. Complete the recovery experience and verify the protected paths on actual installed devices; retain original data and fail safely when admission cannot be established.
2. Integrate the active browser work and the generic source/artifact contract, with explicit scopes for Ask, saved jobs and departments.
3. Verify an empty workspace and fictional generic pack before domain packs; prove import, review, run, disable, upgrade/revert and backup/restore.
4. Extend the recorded Mac startup, HTTP, UI-history and scale baselines to Windows, real worker dispatch/Stop and normal installed restore behavior against a stated dataset and candidate hash.
5. Package that fixed revision; run Mac and Windows installed lifecycle/isolation/recovery acceptance, then start the three customer-pack journeys.

Hardware/account/deployment gates remain distinct. Core acceptance must not depend on REI or real customer data, and passing it must not be presented as live bank/email acceptance.

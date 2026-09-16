# Wednesday demonstration readiness — 9 September 2026

Prepared on 7 September for a controlled, fictional-data demonstration on this Mac. This pass produced and rehearsed a signed native build and a persistent demonstration workspace. It does not establish live-office acceptance, clean-machine installation or exhaustive edge-case coverage.

## Repairs

- Sample replay now replaces both book projections together, preserves office configuration, makes one revision commit, and emits only after the commit. Repeated replay no longer accumulates historical open cases. Failed preparation or disk writes restore the prior in-memory and persisted book. Live books and recovery mode refuse sample replacement.
- The welcome wizard offers **Continue to Bud setup** and **Open the sample desk first**. Failed saves remain retryable. Recognized settings hashes route into You on initial load/hash change, allowing interrupted setup to resume after refresh.
- The scale harness creates its isolated data directory before startup, preventing legacy-directory migration into a test workspace.

Existing unrelated working-tree changes were preserved. No customer messages, payments, statutory actions or portal submissions were made. The installed `/Applications/RealBud.app` was neither replaced nor stopped.

## Verification

| Layer | Result |
| --- | --- |
| Final full unit/integration suite | 1,190 passed, 8 skipped, 138 files. |
| Focused replay/storage/V3 suite | 80 passed across 4 files, including preparation failure, disk-full rollback, repeat replay, reopen and live-book refusal. |
| Production preparation | TypeScript, Vite UI, compiled server and updater build passed. Existing Vite chunk-size warnings remain. |
| HTTP workflow rehearsal | All five suites passed: Desk, PM day, PM exceptions, portal jobs and walkthrough. These include controlled integrations, not customer accounts. |
| Scale | 20/50/100/150/200 added properties (26/56/106/156/206 total with built-ins). At 206 records, snapshot approximately 6 ms/198 KB, practice 37 ms, CSV preview 55 ms, import 91 ms on this run. These are local fixture measurements, not real-model throughput. |
| Setup browser | Six assertions passed: save failure/retry, direct Bud continuation, reload recovery, optional sample path, narrow-screen overflow and no browser runtime errors. |
| Native artifact | Developer ID signed arm64 RealBud 0.1.17 app and DMG. Deep/strict app signature and DMG signature checks passed. Native renderer/preload, capability discovery, embedded server and clean shutdown smoke passed. |
| Native 200-property UI | Exactly 200 fictional records; 20-unit building drill-down; unlinked portals labelled; case-to-Ask handoff; selected task retained on return. |
| Native real Hermes request | Real connection check succeeded. A selected maintenance case with a unique saved-note reference produced a short, reviewed response citing that reference and leaving access/spending authority unconfirmed. No booking/send claim. |
| Actual launcher and restart | Reopened native package with separate runtime/profile. 200 records, office name, saved real response and paused demo routines survived restart. Existing office app remained running. |
| Offline fallback | Six labelled, previously generated real-worker examples; tab switching and narrow layout passed; no network requests. |

The native browser harness initially used an exact Tasks button selector that excluded its count badge. This was corrected to target the Desk workspace navigation; the final run passed. The setup reload failure was an application defect and was repaired. Original failure logs remain in the evidence directory.

## Demonstration kit

`outputs/wednesday-demo-2026-09-09/demo-kit/START-HERE.md` is the entry point. It links a 15-minute presenter journey, matching source documents/prompts, a use-case/recovery matrix and an offline HTML viewer. `Open Wednesday Demo.command` launches the packaged app with separate data and browser-profile paths. Do not launch the nested app directly for the demo, because its default path uses the normal office workspace.

The fixture book contains the six built-ins plus 194 fictional units across ten training buildings. It stays in Demo mode. Sources are fictional; the property roster is not ledger evidence. No PMS/OAuth account was connected. Demo routines were paused to avoid an automatic check changing the rehearsed state. The app's sample replay restores the six built-ins and should not be used during the expanded-portfolio walkthrough.

The model profile is the existing Hermes `property` profile; credentials were not copied into the kit. Changing that model profile affects other RealBud use on this Mac. The runtime/profile folders may acquire sensitive state during later use and must not be published.

## Remaining gates and operating limits

- Check disk headroom and the real model connection shortly before the meeting. The preparation run observed critically low free space. A narrowly allowlisted cleanup removed approximately 1.55 GiB of Chrome HTTP/compiled cache entries older than 24 hours after two open-file checks and immediate file-state checks. Cookies, history, sessions, browser profile state, cache indexes and runtimes were excluded; Git status stayed unchanged. Free space finished near 2 GiB. Recheck before presenting; a fresh Hermes installation/update needs additional headroom.
- Meeting time, projector layout and any mandatory customer PMS/portal workflow are not yet specified. The kit assumes this Mac and fictional data on Wednesday 9 September.
- This package is signed but was not newly notarized or installed on a clean second Mac. Its version remains 0.1.17; this is a local demo build, not a published updater release. The redundant ZIP and updater metadata were removed after signature/build verification to conserve disk; the app and DMG remain.
- Customer OAuth, real PMS/inbox ingestion and live customer portal submission have not been accepted end to end. Do not describe brand selection or saved portal grouping as a connected integration.
- Batch restart/partial completion/retry boundaries are test-backed. A 200-property real-model throughput/soak test is still open. Keep a live demonstration batch small.
- Local background work requires the app/service and Mac to remain awake. Unsent property notes/wording are preserved across navigation, not guaranteed after a crash; save before restarting.
- Read model output before use. Safeguards and prompt checks do not eliminate hallucination or prove comprehensive prompt-injection resistance.

Full logs, screenshots, scoped before-copies and scripts are in `outputs/wednesday-demo-2026-09-09/`. Previous real-worker scenario evidence is in `outputs/pm-agentic-walkthrough-2026-09-07/`.

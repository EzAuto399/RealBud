# TODOS

## Execution topology — complete remaining build list

Architecture owner: [`docs/adr/0001-realbud-owned-work-routing.md`](docs/adr/0001-realbud-owned-work-routing.md). The order is deliberate. A later item must not be presented as ready because an earlier contract or simulator is green.

### R0 — planner and honest product projection (source-safe now)

- [x] Land the versioned local-first route planner: structured batch, bounded analysis, scripted browser, isolated browser and visible CUA lanes; local standard remains the complete fallback.
- [x] Enforce one same-account browser lane, at most two independent isolated browser lanes after a CPU/memory check, and exactly one visible-desktop lane.
- [x] Expose the current route, record counts, fallback reason and measured-or-unavailable timing in You → General; no fifth surface and no invented duration.
- [x] Attach the same plan to admitted Ask bulk work so its task card shows the validated route before execution; the morning-money proposal is the first live projection, while unsupported and gated routes remain hidden rather than becoming placeholder cards.
- [x] Test invalid counts, low-resource fallback, unavailable cloud, same-account serialization, independent-account fan-out, serial CUA and secret/path-free projections.

### R1 — durable work broker and Desk reconciliation (structured import shipped)

- [x] Add a versioned work receipt with request/idempotency ids, book/case revision, input digests, route, hashed concurrency key, allowed origins, recipe/version, expiry, cancellation generation and fencing token. Store metadata only.
- [x] Implement atomic admission, bounded queueing, lease/re-lease, cancellation, expiry, restart reconciliation and deduplication. A possible external effect becomes `effect-unknown` and is never automatically replayed.
- [x] Bind every new receipt to `realbud.work-plan.v1`: exact PM request/routine/Allow authority, data/input/account digests, recipe/origins, ordered route chain and fresh adapter attestation. Remote work carries its privacy/spend policy; local-to-cloud escalation, scheduled browser/CUA and possible-effect rerouting fail closed. Read-only cloud-to-local fallback is forward-only, requires and replaces the exact current fence, and refuses expired work; legacy receipts remain readable without inheriting authority.
- [x] Partition and run 100–200 fixture records without losing or duplicating one; aggregate evidence/drafts/holds into one bounded offline result.
- [x] Feed the structured PMS broker aggregate through the existing Desk owner in one bounded encrypted commit without bypassing proposal/Allow authority; a digest-bound source marker closes the crash window between Desk commit and broker settlement.
- [x] Prove crash points before admission, after admission, after lease, during read-only work, before reconciliation and after an ambiguous acknowledgement.

### Offline topology simulator — source proof only (shipped)

- [x] Exercise Local standard/accelerated selection, unavailable-cloud fallback, two analysis lanes, two independent private-browser lane identities, same-account serialization and one visible-desktop lane without network, model, personal browser or personal Hermes access.
- [x] Run a durable 131-item mixed simulation: 100 structured records, 12 analysis items, 16 portal records and 3 CUA-shaped jobs; account for every item as evidence/draft/hold with zero missing or duplicate outcomes across restart.
- [x] Keep production capability flags gated. Simulator success is not a live worker, Chromium, CUA, cloud, installed-build or PM-pilot claim.

### R2 — local analysis lanes (selected evidence only)

- [x] Isolate ordinary Ask attachment review: copy only server-validated selected files into a private short-lived workspace, run the worker from that directory with every tool permission denied and bounded time/output, then clean on settle or startup recovery without changing the originals.
- [x] Add one RealBud-owned adapter to the supported pinned worker interface; durable broker admission, fencing, retry/cancel/restart recovery, encrypted output-before-completion and post-Desk reconciliation are code-owned. Hermes remains an unmodified pinned dependency and its subagent/terminal UI is never exposed.
- [x] Run the serial analysis context in a fresh RealBud task profile with selected files only, the verified property pack plus reconstructed non-secret model fields, no session/memory/channel/schedule/browser state, deny-all tool policy, bounded time/output and strict versioned decoding. Raw worker output and tool events never enter Ask.
- [ ] Add an OS-enforced CPU/memory/network boundary and measure it on packaged macOS/Windows targets; changing cwd, scrubbing environment and denying ACP tools is not that resource sandbox.
- [x] Ship one serial worker lane first. A concurrent request remains durably queued/held rather than starting a second process or dropping work.
- [ ] Add at most a second parallel analysis context only after the resource gate and equivalence benchmark; a failed lane must fall back or hold without dropping the rest of the batch.
- [ ] Load-test extraction/drafting on representative 100-property document sets and compare serial/two-lane time, memory, model usage and result equivalence.

### R3 — deterministic browser loop and private browser pool

- [x] Prove a typed read-only fake-bank DOM login/credit-list recipe through the scripted-browser broker and Desk, with transaction dedupe, discrepancy holds, no raw-reference persistence and transfer/payee refusal. Keep it labelled fixture/CLI proof, not a live bank connector.
- [ ] After the pilot names the bank and read-only test account, wire that admitted adapter into morning money's collect phase. A scheduled auth/MFA/expiry/rate-limit problem must hold visibly for the PM; it must never fall through to absence-as-nonpayment or broaden into transfer, payee, payment, allocation or reconciliation authority.
- [x] Promote one typed fake-portal DOM recipe from QA into the durable fake broker without granting Bud the Agent Browser CLI or raw CUA MCP tools. The fixture path binds exact loopback origin/port, recipe/version and input digests; cancellation, expiry, fencing, bounded retry and ambiguous `effect-unknown` are non-replayable, while Submit remains human-only.
- [ ] Bundle a RealBud-owned Chromium runtime and create one encrypted/isolated profile per lane under the RealBud data boundary. Never import or inspect the PM's browser/profile/cookies/tabs.
- [ ] Keep the same PMS account serial. Add a second lane only for independent test accounts after simultaneous-session, cookie invalidation, stale-read and security-control tests.
- [ ] Cover SSO/MFA wait, redirects, frames, layout changes, auth expiry, rate limits, cancellation, read-back, human Submit and unknown effect. Live vendor work remains blocked by the eight-field pilot contract.

### R4 — visible desktop CUA

- [x] Pin CUA 0.19.3 behind a native version-2 exact-origin/isolated-profile policy, persist it privately, verify the exact policy body/digest at the server boundary, and deny ambient window enumeration, generic desktop/input, clipboard, files and off-origin navigation. The hybrid fake-bank walk proves CUA validates only the disposable browser PID/endpoint before typed credit reconciliation; this is source/fixture proof, not a live adapter.
- [x] Add progressive macOS permission onboarding in You: bundled-runtime truth, Accessibility and Screen & System Audio Recording steps, fixed-pane recovery, serialized re-check and explicit refusal to reuse App Management/personal-helper grants. This is source UX; installed signed-app TCC evidence remains open.
- [ ] Connect one already-admitted RealBud recipe/work receipt to Electron's bounded-session start/end owner. The model must never supply the manifest or receive the raw MCP surface; startup, teardown, cancellation and crash recovery must leave no stale workflow descriptor or policy.
- [ ] Wire the pinned CUA browser primitives through the existing case/recipe/origin/expiry authorization and single computer lease for one named vendor operation.
- [ ] Keep fresh state observation before every semantic step; trajectory recording is QA evidence and Computer History remains a later opt-in recovery receipt.
- [ ] Prove permission denial/recovery, app/window mismatch, screen changes, lid/sleep, PM takeover, timeout, revocation and human Submit on an installed signed build.

### R5 — optional cloud acceleration

- [x] Build the provider-neutral code-owned adapter manifest/attestation foundation with exact routes/operations, generation fencing, short freshness, revocation, sanitized status and a complete cloud privacy/spend/local-fallback policy. This is admission truth, not a selected provider or remote executor.
- [ ] Choose a provider only after a named workflow needs it. Record data classes, region, retention, deletion, encryption, account identity, spend ceiling and who pays.
- [ ] Implement remote lanes behind the same receipt/idempotency/cancellation/fencing/output contracts; no remote lane owns Desk, Ask, Schedule, Notes or approval state.
- [ ] Prove orphan cleanup, disconnect/reconnect, quota/spend exhaustion, partial results, provider outage and complete local fallback before offering automatic route selection.

### R6 — PM workflow coverage and launch evidence

- [x] Keep external agency research out of runtime state and add a portable seven-family Australian system matrix in You. It remains agency-neutral at 0/8 under Demo, has no Connect action and reads only the code-owned pilot contract; partially configured offices retain explicit unknowns.
- [ ] Capture the named PM's baseline for morning money, inbox/maintenance and one tenancy-date workflow: elapsed time, systems opened, records checked, interruptions, follow-ups and error/rework points.
- [ ] Run those three workflows first in shadow mode, compare Bud's cases/drafts/holds with the PM's completed work, then enable supervised proposals only after the source and exception precision are accepted.
- [x] Build the source-safe inbound interrupt foundation: fixed Demo envelope, bounded deterministic classification, exact property matching, digest dedupe, one case per thread, encrypted Evidence, operational reply drafts, explicit external-send attestation and Waiting/Close recovery. This is not a mailbox adapter or an available Schedule loop.
- [ ] Build Wave 1 read-only inbound triage for the pilot's actual mailbox, then maintenance follow-up; every reply remains a Desk draft.
- [ ] Add the named tenancy-date loops only after the pilot supplies real fields; notices, trust and legal clocks stay unreachable.
- [ ] Measure route timing and PM load-off from durable receipts; drafted/allowed/held/unknown must never be reported as sent or completed externally.
- [ ] Prove the three PM-facing states end to end — Bud is handling it, Needs you and Waiting on someone — including source unavailable, login/MFA required, stale facts, connector revocation, layout drift, restart and safe resume.
- [ ] Record the pilot outcome as system visits avoided, manual checks avoided, follow-ups recovered, exception precision and PM time returned. Do not use model/tool-call volume as a success metric.
- [ ] Complete rotated funded-model image intake, real export, named vendor account, real Keychain/TCC first launch, notarized macOS arm64/x64 and the explicit Windows worker-or-CSV-only decision.
- [ ] Run personal-Hermes and personal-browser byte sentinels through install, update, browser setup, execution, rollback and uninstall.

### External-runtime invariant

- Hermes is an immutable pinned dependency behind RealBud's bridge. Never edit its source, launch a personal install, write `~/.hermes`, expose its terminal/gateway/browser bootstrap, or treat its model prose as connection/action truth.
- RealBud owns every lane, profile, receipt, lease, schedule, permission and UI. Ephemeral analysis contexts are not additional RealBud agents and cannot persist identity, memory, channels or authority.

## Now — close the source candidate

- [x] Reconcile the architecture, integration/runtime, PM-workflow, onboarding/release and testing audits into the dependency-ordered `docs/BETA-CONVERGENCE-PLAN.md`; use its C0–C5 exit criteria for every readiness claim.
- [x] Close the first C0 source gaps: packaged product mode cannot inherit the generic test fleet; persisted fleet state canonicalises to one private Bud; exact pack bytes/manual approvals/cron deny/toolset disable are attested; consequential wording is checked on edit, Allow and portal preparation; source readiness uses freshness/coverage and labels Demo bank data practice-only; bounded CUA readiness expires and has explicit revocation.
- [x] Complete the C1 source implementation: Ask persists admitted/dispatching/settled/held states and restarts safe text once while holding attachment/partial work; config plus encrypted settings use ciphertext-only commit recovery; model selection commits only after a successful live test; config/routine/transcript corruption restores a verified previous generation or preserves bytes and pauses the exact owner. Installed-app crash/storage proof remains a separate release bucket.
- [x] Complete C2 bounded queue/detail, import-identity resolution, source-incident aggregation, Waiting/due/closure receipts and 200-property navigation before onboarding a large portfolio. Source proof includes a sub-750 KB 200-property queue and the API walkthrough; installed named-PM usability remains release evidence.
- [ ] Complete the C3–C5 named workflow, execution, onboarding and release gates in the convergence plan; keep source-build work distinct from named-office inputs and installed evidence.
- [x] Add a privacy-safe support report and Advanced-diagnostics evidence labels. It exports categorical runtime/recovery/connection health plus aggregate counts only, never tenant/property/message/source/credential/path material, and never treats a packaged runtime as installed or named-office proof.
- [x] Replace the dense first-run You map with a resumable window-owning setup journey: one current decision, explicit practice-desk escape, live worker/book/recovery-derived progress, compact You re-entry, Ask handoff and no credential, install or authority side effect from opening the guide. The operational shell is now unmounted while setup is open; recovery replaces setup with one protected-state owner instead of exposing You behind a modal.
- [x] Rebuild the current macOS arm64 directory QA app and verify focused first run in the packaged renderer: profile save, three rules, one-decision setup, reload/process-restart resume, compact You re-entry, Escape recovery, zero 900×600 overflow and no renderer warning/error. The current artifact also passed the isolated two-launch mock-Keychain smoke. Worker preparation now requires 3.0 GB free at both API preflight and the installer boundary; the current 1.6 GB host state fails before staging, so the large private-worker download was not repeated.
- [x] Run `node scripts/verify-source.mjs` with Node 24 for one fail-fast source proof. The latest 2026-08-29 working-tree run passed 136 files / 951 tests / 8 skipped, both typechecks, Electron syntax, production UI build, the 36-check Desk/API plus corrupt-book recovery walkthrough, visible portal-browser walkthrough, read-only fake-bank browser walkthrough, native bounded-CUA denials and isolated bank/CUA topology in 39.7 seconds. A separate fresh 900×600 browser pass completed name and three rules, proved the active setup owns the window with zero operational navigation, resumed the authoritative step across reload, returned safely to the practice Desk, re-entered from You, and replaced a simulated locked book with the focused recovery-key owner. Normal and recovery states had zero horizontal overflow or browser warnings/errors. This remains working-tree source/simulated evidence, not commit or installed-package evidence.
- Review the broad shared worktree by named path and split it into reviewable commits before packaging. Do not release, broad-stage, reset or clean the mixed worktree; a green run against uncommitted state is not an immutable candidate.
- [x] Repeat the macOS arm64 QA package structure and isolated installed smoke against the current working tree after the permission-onboarding change: Node 24 produced a locally Developer-ID-signed directory app, exact CUA/resource/architecture/signature verification passed, the bundled runtime returned a PNG frame and two mock-Keychain launches preserved encrypted Desk/model state plus personal-Hermes/CUA sentinels. This is working-tree QA only; rerun from the eventual clean immutable candidate and keep real Keychain/TCC, notarization and release evidence separate.
- Freeze new **live adapter/effect** work until the named-office contract below is filled. The pure route planner, fake broker contracts and simulator tests above may land because they do not contact an account, enable raw tools or claim live capability. Computer History, inbound mail, generic CLI and additional portal operations are not source-candidate blockers.

## External pilot and release evidence

- Fill all eight named-office fields in `docs/PILOT-CONTRACT.md`; do not replace them with Demo guesses.
- Obtain the office's real export dialect and run one full fresh-export → held/draft cards → human Allow/Copy workflow with the named PM.
- Rotate the credential previously pasted into chat. Enter its replacement only through You → Worker, then retain a successful hands test plus one real selected-image intake result. Never reuse or record the pasted key.
- Complete a manual installed macOS first launch with the real Keychain and requested OS permissions. The automated package smoke uses a test-only mock Keychain and is not this evidence.
- Produce and verify notarized/stapled macOS arm64 and x64 artifacts. On Windows, decide and disclose bundled-worker versus CSV-only support before producing a signed NSIS/ZIP and testing install/update/uninstall on Windows.
- Re-run the bounded portal spike only against the named vendor test account; human Submit remains mandatory. At that point connect RealBud's immutable admitted recipe/work receipt to Electron's source-built native bounded-session owner. Never hand Bud the driver's raw MCP surface or the QA-only Agent Browser CLI.
- Name the pilot bank and read-only test account before replacing the fake-bank fixture. Prove PM login/MFA handoff, credit-list selectors, auth expiry, rate limits and session revocation with transfer/payee/payment paths absent; keep PMS authority and treat every discrepancy as a Desk hold.
- After field 1 names the real agency and PM and the agency accepts Telegram's privacy boundary, enrol a dedicated bot + exact numeric PM id in You and capture live send/receive, restart, stale-button, disable/re-enable and delivery-ambiguity evidence. Do not reuse a personal bot or invent a pilot identity.

## Deliberately deferred until pilot evidence requires it

- Direct-V3 command reducers. V3 is already the sole encrypted authority and ordinary compatibility commits now have validated candidates, exact rollback, classified unknown outcomes and read-only recovery. Keep the bridge for the MVP unless a real workflow demonstrates that the direct cut-over pays for its migration risk.
- The live inbound-triage adapter and Schedule loop remain behind the named-office gate. ADR 0002's fixed Demo path proves the case/draft/waiting contract only; it does not read a provider, open attachments or poll. Pocket's Telegram and official WhatsApp Business Cloud text/manual-decision adapters are source-built but live enrollment remains field-1 gated; the WhatsApp path still needs a stable agency-approved HTTPS tunnel and Meta business/privacy setup. Mobile files/photos/voice, proactive mobile alerts and offline background service wait for pilot evidence. No mail/calendar adapter or generic tool access is implied.
- The generic CLI is permanently excluded, but its governed adapter family is now active source work rather than an undefined someday item. The manifest/attestation foundation cannot execute a command. The first real command-line workflow still requires a named, code-owned recipe inside an enforced RealBud-owned ephemeral/container task workspace with selected-file staging, no ambient credentials, bounded commands/resources/network, durable receipts and the same Allow/recovery semantics. Do not enable Hermes' local terminal backend; changing cwd and scrubbing env alone is not a sandbox.
- The CUA Computer History admission/status foundation is source-built and honestly reports the runtime unavailable. The pinned stable Driver 0.19.3 still does not expose the preview's `history_status` / `history_query` tools. When a stable history-capable pin exists and a named PM demonstrates an interrupted-handoff reconstruction problem, implement the opt-in encrypted session/case/time-bounded metadata receipt adapter. It never becomes Notes, evaluation authority, ambient surveillance or permission; paused/dropped/corrupt history stays incomplete evidence. Detailed trajectory recording remains explicit vendor-test/QA evidence only.

## Resolved

- You now has a compact status navigator and a searchable, category-filtered seven-entry approved capability hub without adding a fifth surface or generic marketplace. The collapsed Advanced work-methods row reads the code-owned adapter registry and cannot install/configure/execute a provider. Search is presentation-only, pilot-gated rows have no fake Add state, actions call the existing owners, empty results recover locally, and nested scrolling is owned by the You pane so section jumps cannot blank the 900 × 600 app window.
- First Desk now names both essential readiness checks and every existing follow-on setup area in one compact guide. Agency, computer use, recovery, reminders and pilot connections route to their exact You owners; optional or pilot-gated states never block the working Demo desk or request permissions on view.
- Scheduled routine admission now has occurrence-level duplicate suppression across stale-bookmark restarts, cross-routine manual-id conflict protection, no-overlap missed receipts and bounded secret-redacted phase history. Morning money re-evaluates the latest admitted PMS export without a model call and holds stale/conflicting evidence. Schedule exposes real dependencies/recovery; You exposes a read-only source-method map while Direct API, restricted Composio, approved MCP and inbound mail remain non-executable and pilot-gated.
- macOS QA packaging now stages CUA Driver 0.19.3 plus its matching native SDK from the pinned checksummed upstream artifact by default. Packaged resolution fails closed to the app resource and ignores environment/personal CUA paths; You shows Included/Ready/permission/repair states, and explicit setup is remembered without granting Bud broad MCP access. Package verification checks driver version/architecture, while real permission consent remains a manual installed-app gate.
- Worker install/update is now a private two-phase A/B transaction rather than an in-place replacement: exact-pin staging in a stable inactive slot, one exclusive lease across every worker execution/configuration path, active-path health verification, one retained prior runtime, post-activation rollback and deterministic boot recovery cover partial installs, operation races and every link-switch crash point without touching the property profile or personal Hermes.
- Ask now proposes a closed set of single-step RealBud changes (named routine run/retune, property add/options, agency label, exact setup handoff). Cards are mirrored on Desk and only Allow reaches the existing owner command; retries, stale conflicts and forbidden action kinds are covered by deterministic tests.
- Ask now receives server-owned current capability truth and can propose one already-approved case-bound portal preparation. Demo is labelled practice-only; authorization is consumed before external work, final Submit remains human, and a retry/restart or ambiguous adapter response cannot duplicate the handoff.
- Pocket now uses a RealBud-owned adapter hub: Telegram long polling and official WhatsApp Business Cloud may both project the exact PM into canonical Ask. WhatsApp verifies Meta's signature before parsing, checks the exact business-number route and PM number, claims before its fast webhook acknowledgement and queues work behind the same bounded one-PM turn owner. Both adapters encrypt credentials, reject non-PM/group/credential/unsupported-command input, route native decisions through the same action owner and never auto-replay interrupted or uncertain effects. The Demo contract is network-silent.
- Partial worker ledger answers no longer count as complete coverage. `runMorningCheckLive` records an observation for every requested property; omitted properties become `coverage: missing`, worker-collected balances stay `legacy-unverified`, and live evaluation holds instead of reusing stale facts.
- Bulk property approval is one validated encrypted commit rather than one commit per property.
- Concurrent data writers, unclassified commit outcomes, unenforced retention and plaintext packaged wrapping/provider keys are covered by code-owned fail-closed paths and regression tests.
- Ask/config/model/local-state recovery is now fail-closed and restart-aware. Corrupt config, encrypted settings, routine and transcript state no longer becomes an empty first run; verified previous generations restore, otherwise bytes are preserved and the exact owner is read-only. The isolated four-surface QA also fixed the compact 900 × 600 setup map and proved a corrupt routine clock cannot be resumed or retuned from Schedule.

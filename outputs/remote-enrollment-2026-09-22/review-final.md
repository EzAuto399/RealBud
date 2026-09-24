# Remote enrollment independent review — 2026-09-22

## Scope and disposition

Read-only review of the desktop enrollment domain/coordinator, protocol-2 SQL lifecycle and lock ordering, browser/API authority boundary, and history projection. The reviewer implemented the assigned website library/routes/panel and the subsequently requested authenticated clock and pending-parent cancellation branches. Other workers owned desktop, shared contracts and SQL. This report does not certify execution, deployment, installed Windows/macOS behavior, or customer access.

The reviewed paths fail closed on authority changes and keep enrollment separate from work execution. Concrete findings discovered during this review were fixed or are explicitly listed below. Final integration receipts remain the root agent's responsibility; this report is not a substitute for them.

## Findings addressed

1. **Inactive confirmation receipts were discarded.** Desktop confirmation previously threw before storing a revoked/expired/stale response, then kept retrying the saved confirmation. Current code persists inactive authoritative receipts, preserves the immutable confirmation evidence needed to validate historical approvers, and stops replaying terminal enrollment operations. The owner reported focused regression coverage; this reviewer read the fix.
2. **Client clocks ahead of the server rejected valid new challenges.** The new authenticated `clock` RPC validates the exact active parent. New challenges derive deadlines from its server time; discrepancies exceeding 60 seconds hold enrollment with an actionable clock message. Saved retries retain the original dates and never renew TTLs. Website clock parsing rejects extra keys and malformed timestamps. No TTL allowance was widened.
3. **SQL accepted authentication at exactly ten minutes old.** Website acceptance already rejected age >=600000 ms; SQL used a different equality boundary. SQL now rejects `authenticated <= current_ms - 600000`. The SQL owner preserved a real PostgreSQL red reproduction and reported 600000 denied / 599999 accepted.
4. **Shared snapshots allowed inconsistent active phases.** The root tightened confirmed snapshots to require a nonrevoked approver whose expiry is after serverTime, and pending/candidate snapshots to require unexpired challenges. The root reported three contract regressions passing.
5. **An observed stale SQL enrollment could silently become confirmed again.** Candidate agency-label A→B→A, or disabling/re-enabling the only separate billing owner, could reverse a computed stale phase while desktop treated it as terminal. The current SQL adds a durable `stale_at` latch when stale is observed. Revocation can still supersede stale; label/owner recovery cannot reactivate that enrollment. The SQL owner reported 153 tests passing with the latch, preserving the earlier 140-test receipt; a further cancellation RPC is now in progress.

## Recovery findings and final dispositions

- **Denied first parent publication recovery:** the original failure was a private parent outbox with `grant:null` whose disable DELETE could never find a parent. The parent assigned a concrete correction: reporting-authenticated cancellation of the exact original enrollment creates-and-revokes an absent parent atomically, or returns the exact already-revoked parent. A late original publication cannot reactivate it. The reviewer implemented `/api/installations/v2/command-grants/cancel` and strict request/hash/revoked-receipt validation. Read the resulting SQL/domain fix: local disabled intent persists before cancellation, the original reporting installation/company must match, exact create-and-revoke runs atomically, and no current work/disclosure approval is needed to remove permission. The downgrade marker is retained. Full actual integration verification remains parent-owned.
- **Latched stale grants require explicit revoke before reenrollment.** SQL owner confirmed this is deliberate policy: an old unexpired approver, even stale, must be explicitly revoked before a new immutable enrollment ID is confirmed. The existing SQL regression follows revoke-first. Desktop now permits stale revocation. The reviewer also updated the portal to expose stale disconnection and explicitly instruct disconnect-first, then obtain a new code. Both remain subject to current identity checks. No active-classification relaxation is requested.

## Invariants checked in source

- Browser actor is derived only from a verified v2 session and current identity RPC; SQL repeats identity checks inside the effect transaction. Acceptance requires fresh authentication. Self-list/revoke require current identity but not a fresh login. Raw pasted challenge secrets are hashed before RPC and cleared from the browser input; no URL/storage handoff is used.
- Exact shared response parsers enforce parent/enrollment/generation, candidate, phase, own-subject/company, and bounded list invariants. Committed wrong-code denial is returned as a bounded 403 without rolling back the attempt counter. Route/client initialization failures are bounded and no-store.
- The local v2 marker prevents current-app v1 enrollment and command polling. SQL refuses v1 enrollment after any historical v2 parent for the same installation/workspace, even revoked. New parent generations advance; shared coordinator exclusion and activity barriers guard local publication and transitions.
- The private companion is persisted before the v2 marker, and the marker is verified before remote publication. Companion-only interrupted preparation holds in the current app and can repair the exact marker; it is not evidence of an already published parent.
- Mutating awaits recheck local workspace, worker/profile/config authority, link, catalog and separately reviewed disclosure scopes. Revocation/disable abort in-flight requests and persist intent before retrying. SQL's common identity lock precedes company, installation, billing and parent authority locks, and RPCs require READ COMMITTED.
- Candidate confirmation is checked against current identity under the same SQL locks. Parent revoke cascades to subordinate approvers; stale or inactive receipts cannot authorize confirmation. The domain has no worker, provider, source-execution or disclosure endpoint.
- The history callback projects only inert enrollment evidence (workspace/enrollment IDs, reviewed scopes, person/approver, phase and timestamps). It excludes challenge secret/hash, command token and confirmation outbox. Restore forces historical/restored state and cannot recreate execution authority.
- `status.enabled` is local enrollment readiness, not fresh online permission. Cached confirmed evidence is not an executable grant; any future publication/execution layer must independently validate current authority and disclosure at its boundary.

## Verification and limits

Reviewer executed `node --test website/lib/remote-approvers.test.mjs`: **8/8 passed** after the clock and pending-parent cancellation branches, covering actor freshness/current identity, hashed-only challenge transfer, committed denial/privacy, parent token separation, receipt/candidate matching, own-list/revoke isolation strict clock receipts, and reporting-authorized cancellation with exact revoked receipts. Scoped website ESLint passed. Website TypeScript had passed before the clock addition; the root owns subsequent full build/typecheck. No full suite was rerun by this reviewer.

Parent/owner reports at this checkpoint: desktop focused tests 57 passed; website suite 54 passed; SQL 140 passed before the new stale latch. The first actual desktop→Next→SQL→browser run passed two groups including lost-confirm-response recovery, then stopped on a harness label typo before cold restart; the parent retained that negative and is rerunning. These are scoped checkpoints, not final current-source end-to-end certification. The attempted Grok session advertised current model 4.6 despite the requested 4.7/xhigh. This does not establish whether 4.7 exists or is available elsewhere. Root reports zero prompts/tool calls and verified cleanup. No Grok review result is claimed.

## Read fingerprints

Fingerprints capture the source read for this report after cancellation and portal stale-disconnect fixes. Other owners may subsequently update files; reconcile with final receipts.

- `server/website-remote-approvers.ts`: `3b76a65cbbd66e7d27c3eaa1a377a1ac93ee1a2b67f5cd4114c05bb629d1bc02`
- `server/website-requests.ts`: `9499445a3605912e554445b46e141bf5e288f1f5446d0b7d8d0e4f019aef5a99`
- `server/website-remote-evidence.ts`: `6eddd4c81552d997ed598e6463c680d72f18948a9280e9a933066bb0896ccdd1`
- `website/lib/remote-approvers.ts`: `d5e4d49f21146112b7fdbf2b868db3ff477d53f9d1ebbf3b9f9d1e9604f1e5c3`
- `website/lib/remote-approvers.test.mjs`: `816563867544bd98c0fa9e8ce5743abb72e3b87db9a68b1de6d089a573afb906`
- `website/app/api/installations/v2/command-grants/cancel/route.ts`: `14ad121cbe30cd6ce8dad72fa1a8598ed954fd2a570898be28443b9b561d0400`
- `website/app/account/remote-approvers/panel.tsx`: `9cbf552e5a2d231c10dcf65d3cd97f02232d573201443ab72cf25b237d6e7fdb`
- `shared/website-remote-approvers.ts`: `fc7b4c2f3f0a0e85d0e7cc16a98dcac74ba44743d5ff261d51c1bb926f828c71`
- `website/supabase/migrations/202609220003_remote_approvers.sql`: `17825f58da8cac746e98b5ac36d8ba7005210882b564174bc53fdfa236297b08`

## Supplemental actual-GUI findings and root wiring review

The root's full baseline completed with 4621 passing tests and 191 skipped tests, but its subsequent actual cold-restart GUI scenario exposed a wiring defect not captured by the earlier source review: local mailbox readiness starts unverified after restart, so full catalog/disclosure checks blocked reading an already-enrolled person's authoritative status and could overwrite an inactive phase with a generic local hold. Config and worker identity were unchanged. This is a material recovery/status finding; the earlier no-additional-bypass statement did not prove this recovery path. A narrowly scoped read-only status guard is being implemented by the domain owner; mutation admission remains subject to full checks.

The root also visually observed a stale success banner: a refreshed confirmed row still had the prior return-to-computer instruction above it. The reviewer fixed the portal to retain only the affected enrollment ID and derive banner text from its current validated row. Confirmed/revoked/stale/expired observations now replace the pending instruction; a missing row removes it. Scoped ESLint passed. The root will verify rendered behavior after rebuilding.

Independent root wiring audit checked `server/index.ts`, `server/website-work-adapters.ts`, `server/website-remote-disclosure.ts`, `server/website-remote-evidence.ts`, both backup restore paths, and `RemoteApproversCard.tsx`. No additional concrete privacy/authority bypass was found: disclosure review is local under shared activity barriers, typed projection excludes generic execution binding and raw mailbox connection IDs, read-book plans are held, enrollment sends only descriptors/digests, and restored templates/history cannot become approved authority. These observations do not replace the pending corrected cold-restart run.

### Read-only reconciliation fix reviewed

Read the domain owner's `captureRead`/`readable`/`reconcileStatus` changes and nine added regression cases. Read-only network reconciliation is pinned to the exact local workspace/member, local epoch, marker, original installation/company link and unchanged saved state before and after the response. It may retain an inactive receipt despite worker/catalog/disclosure readiness hold; candidate/confirmed receipt adoption still requires full mutation admission. Saved confirmation under a readiness hold only queries status and is not replayed. Full mutation checks remain on prepare/begin/confirm. Inactive authoritative phases are no longer overwritten by a local generic hold. No new authority bypass found in this bounded review; no duplicate test suite executed.

A concrete visible recovery issue was sent to the root: `RemoteApproversCard` did not render `status.error`, hiding the new source/settings recovery guidance after successful refresh. The displayed generic stale label could incorrectly suggest a new invitation for a recoverable cold-start source check. Root owns displaying the actionable hold notice and clearer wording. Final actual GUI proof remains pending.

Supplemental source fingerprints at this read:
- `server/website-remote-approvers.ts`: `23da02999c6b16df47d7d5b276e75cb388dd4ba8746706e8f7ef7c8c6f3e20a2`
- `server/website-remote-approvers.test.ts`: `5ae6c5e9b02718aea1c2acaeeb403d9cd6eb3a2a3f0784dc7c4dd24ea80bf19e`
- `website/app/account/remote-approvers/panel.tsx`: `73bd922a1530c4b26a093150237f38ccd0d00c991e46277086a17f69dbb8503a`
- `server/website-remote-disclosure.ts`: `f8a90600de540a7f60902f465c8fe987b4bf72070cb2215c532472601772a4f8`
- `server/website-remote-evidence.ts`: `6eddd4c81552d997ed598e6463c680d72f18948a9280e9a933066bb0896ccdd1`
- `server/website-work-adapters.ts`: `464601921256b200b5bde5fd237de5969d342a820b112d46b083ef3c5f15b660`

### Hold UI finding resolved in source

Reviewed the root's exact frozen `RemoteApproversCard.tsx` delta. The card now renders a distinct `status.error` notice, uses the neutral “Needs attention” label, keeps the saved parent workspace/descriptors visible while held, disables inviting another person, and hides new setup while an existing parent remains unresolved. Per-enrollment revocation and parent disable remain available during a hold. Fresh setup becomes available after confirmed parent revocation; no local state deletion or downgrade shortcut was introduced. The source change resolves the hidden-guidance finding without weakening admission. No additional concrete regression identified in this bounded delta review.

Fingerprint: `4e87799bba3607656155f4be1f12413337e678d947f0f7303982f1bb17038bea`. The parent reports root and website builds completed. Its final actual GUI retry uses an explicit connector-status 503 during startup because automatic renderer checks otherwise restore readiness before the hold can be observed; this is an intentional fixture condition, not proof of a product failure. Corrected end-to-end receipt is still pending.

## Final integration evidence recorded by root

The corrected actual GUI completed successfully: `gui-source/receipt.json` records four passing desktop/Next/PostgreSQL/browser groups with 40 RPCs, zero source scans/worker calls/errors and no database/fixture violations. `gui-source/cleanup.json` confirms cleanup. Root visually inspected the final source-hold desktop and confirmed mobile portal: recovery guidance is visible, invitations are held, replacement setup is hidden, and the banner follows the confirmed state. Earlier pending and negative observations above are preserved as chronology, not the final result.

The final frozen product source passes 4,630 tests, zero failed, 191 environment-gated skipped. Both production builds pass. `verification.json` and source manifests identify the final source and the harness-only explicit-outage change. Enrollment is verified at this local layer; protocol-2 work-review/decision/claim execution, fresh native packaging and live customer operation remain unproved.

## Final enrollment integration receipt

Read `gui-source/receipt.json`: all four actual desktop-service/rendered-UI + built-Next + disposable-PostgreSQL groups passed. Coverage includes complete typed-template review, encrypted local consent, lost first-parent publication recovery and new generation, legacy/cross-agency denial, attended confirmation with lost-response reconciliation, unchanged cold restart recovery, and portal self-revocation while desktop was stopped. Receipt records zero source scans, worker calls, errors, violations, database errors and authentication rejections. Migration hash is `17825f58da8cac746e98b5ac36d8ba7005210882b564174bc53fdfa236297b08`. Root reports exit 0, cleanup complete, and visual inspection of final source-hold and confirmed mobile portal screens: recovery guidance and banner corrected, new invitations disabled during hold, new setup hidden, no overflow. Both builds passed. The final full-source suite was still running when this note was added; the earlier 4621-pass/191-skip baseline is not substituted for that result.

This closes the scoped enrollment GUI proof gate. It does not prove hosted deployment, native Windows behavior, real provider/customer access, or remote review/decision/claim execution; those are separate work now being implemented.

# Website requests with local review

Implemented in the RealBud desktop and its `website/` account portal. This is the first private-workspace request vertical from the [protocol](WEBSITE-COMMAND-PROTOCOL-2026-09-22.md). No production migration, deployment, installed-app replacement or customer operation was performed. Website approval on behalf of a local member and shared department execution remain separate work.

## What works

An account owner can request a published preparation on an explicitly opted-in computer and private workspace. The desktop person reviews the full local plan, source scope, instructions and limits before one execution. The portal can cancel a request and display confirmed progress, with readable computer/workspace labels retained in revoked history. Billing readers cannot submit work; billing ownership never grants local approval.

The two supported operations reuse existing execution:

- **Morning priorities** uses the actual inbound-triage loop, reviewed selected-agency Gmail scope, existing source collector, preparation batches and persistent work list. Requesting it does not activate its schedule.
- **Prepare a plan** uses the existing preparation executor and durable manual request key. Only active, currently approved preparation plans are offered. Portal capabilities and dedicated agency ingestion plans cannot enter this generic door.

The website receives opaque descriptor IDs, reviewed public names, requester and timing metadata, bounded outcome enums and opaque run references. Local source identifiers, descriptions, workflow instructions, email contents, results, credentials and free-form execution errors stay outside command messages. The exact local review is capped at 60 KB; oversized plans must be shortened or run through their local workflow instead of silently truncating approval details.

## Authority and recovery

Reporting and command tokens are separate. Grants pin the installation, workspace, immutable private worker identity, generation and exact descriptor revisions. Local credentials use existing private file handling, including Windows privacy checks. Browser-facing local routes require the desktop session and origin checks. Upstream operations use exact schemas, current account/installation checks, service-role RPCs and transactional company/row checks.

Each approval has a persisted decision, claim intent and stable executor UUID. An online claim has a fixed maximum 60-second lease. The desktop rechecks source/plan/worker/service authority after awaited calls and checks a process-local mutation stamp immediately before enqueue. Pack instructions and source scope are rechecked again through deferred morning execution. Lost responses reuse the same claim/event/executor identities.

On restart, pending decisions look up actual execution receipts. An absent run becomes Interrupted and requires a fresh local decision; startup never dispatches an old approval. Cancellation does not pretend to stop an already running worker. It invalidates supported acquisition/preparation steps and preserves the actual eventual run receipt. Fast completion still publishes ordered Running and final receipts.

Both encrypted backup formats validate workspace/request/run relationships, including valid pre-enqueue intents with no run. Cold restore retains historical links, interrupts unfinished requests and invalidates previous execution authority. Reporting/command credential files are excluded, and a destination with existing website credentials cannot count as a fresh restore target.

Polling is outbound to the fixed website origin, at 30-second intervals while the app is running. Responses and pages are bounded. Local history is paged; background traversal retains one 200-record page rather than materializing the whole ledger. The current 5,000-request ceiling produces an explicit assisted-archival hold; automatic deletion is not implemented.

## Verification

- Final full desktop suite: **4,574 passed, zero failed, 149 environment-gated skipped**, across 359 actual files; 357.315 reported seconds. This run covers the frozen source, including final paging, concurrent-observation and managed-account precondition fixes. The earlier 4,565-test receipt is retained as intermediate evidence; counts overlap.
- The final six-file focused integration run passed **126 tests**, including a 221-record lost-acknowledgement regression and concurrent observation versus actual settings changes. Actual v1/v2 cold-restore tests use real encrypted workflow storage, job receipts and loop receipts.
- Website production build, 37 website tests and **72 real PostgreSQL assertions** pass. Five portal HTTP/GUI groups cover two agencies, owner/reader roles, lost committed submit responses, cancellation, ordering, revocation and historical target labels. See the [website report](../website/docs/WEBSITE-REQUESTS-2026-09-22.md).
- Five source desktop/website scenario groups pass through the actual desktop HTTP service, real Next routes and disposable PostgreSQL. They exercise both existing executors, a lost browser approval response, exact retry, source-linked morning results, cross-company history, cancellation, revocation and actual SIGKILL after a committed claim before dispatch. Fictional mail and deterministic CLI responses make this integration/recovery proof, not live Gmail or LLM acceptance. Both UIs were inspected at desktop and 390px widths.
- Grok CLI **4.7 xhigh** completed two bounded reviews with actual `grok-4.7-build`, each one model call/turn and `end_turn` at 170.084 and 111.195 seconds. No tool/permission calls were observed; cleanup was verified. Advice informed restore, stale-authority, duplicate execution and concurrent source-observation cases; it is not implementation approval. Exact receipts and corrections to advisory assumptions are in `outputs/website-requests-2026-09-22/grok-*`.

Independent review reproduced two stale-agency timing gaps and missing material instructions in the approval view. Both timing reproductions now reject with zero enqueues, and the preview includes all effective local plan/instruction fields. Real HTTP QA also caught missing route admission in the local session predicate; both command and installation-link subtrees now require a session. A native Node child test caught a TypeScript parameter property unsupported by strip-only execution; explicit field initialization fixed it.

Packaged end-to-end testing exposed a real timing bug: the renderer's observation-only `POST /api/connected-apps/check` advanced the broad mail mutation counter during a website execution check. Website execution now has a dedicated counter which excludes that exact observation endpoint; actual setup/plan edits, connection invalidation and book commits still fence awaited operations. The final source and packaged rehearsals pass twelve concurrent connection observations, and the focused tests still reject actual settings writes. Existing mail/bill mutation behavior is unchanged.

A separate independent client-to-gateway reproduction found that an account rebind could read a newly bound account before desktop response validation rejected it. Managed scans now require the exact envelope `{ expectedAccountId, scope }`. The gateway compares the expected account with its own resolved device/connection binding before source acquisition and again at each authority checkpoint; the caller cannot select another account. Independent red/green proof now records **zero provider calls** after reviewed A is rebound to B. The client suite passes 31 tests, the full gateway suite passes 103 tests, and both TypeScript checks pass. The two-agency source and packaged HTTP rehearsals each pass all eight groups. Legacy flat scan requests fail closed with 400; mismatched binding fails with 409 and review guidance. Desktop and gateway must be released together; no live service was changed.

Full-site lint retains two documented pre-existing failures outside the website worker's changed code. Focused lint passes. Early harness failures involved closed Office settings, incorrect accessible labels, counting a separate readiness probe as a job, and an incomplete fictional mail receipt; these did not justify weakening guards.

## Fresh Mac artifact

The final unsigned arm64 app is `outputs/website-requests-2026-09-22/package/mac-arm64/RealBud.app`. It uses Electron 43.4.0 and embedded Node 24.18.1. The installed application was not replaced; the final build explicitly disabled automatic signing discovery. An earlier obsolete build had begun discovering/signing with a local identity and was stopped before this unsigned rebuild; it is not the delivered artifact.

All five website request groups and all eight two-agency managed-mail groups pass against this compiled service. The browser uses its bundled renderer at desktop and 390px widths. Native Mac smoke also passes renderer, capability bridge, service and shutdown checks. A fresh-profile smoke starts the compiled service outside the checkout without `node_modules`, verifies private storage (seven files, six directories), manual approvals and bundled safeguards, and correctly reports no model attached or worker ready.

The compiled server (338 files), shared contracts (49), supporting modules (3) and renderer (342) match the artifact byte-for-byte. Source and artifact manifests stayed unchanged through package checks. This verifies the selected unsigned artifact; it does not prove notarized delivery, installed-customer permissions, live Gmail/LLM execution, physical two-device collaboration or Windows behavior.

Evidence is consolidated in `outputs/website-requests-2026-09-22/verification.json`. Earlier negative reproductions remain alongside final receipts. [Desktop review](../outputs/website-requests-2026-09-22/gui-packaged/request-review-desktop.png), [mobile review](../outputs/website-requests-2026-09-22/gui-packaged/request-review-mobile.png) and [saved request history](../outputs/website-requests-2026-09-22/gui-packaged/request-history-desktop.png) show the current rendered interface.

## Remaining goal work

1. Explicitly enrolled portal-person/local-member capabilities for website approval, plus shared department workflow adapters. The delivered feature intentionally requires local review.
2. Separate archival for the 100-version reviewed skill-instruction history; pack configuration archival is already implemented. The [source-backed next plan](SKILL-HISTORY-ARCHIVAL-PLAN-2026-09-22.md), including a completed third Grok 4.7/xhigh design review, identifies the 2 MB journal, downgrade, shared-reference and crash-recovery contracts; this remains unimplemented.
3. Native Windows installation, private storage and Hermes/memory admission, update/uninstall; physical two-device office operation.
4. Protected hosted connector commissioning and revocation/recovery; real Gmail consent, real LLM/source acceptance; exact bank CSV and REI recognition/import receipts; observed customer workdays and release delivery.

The main product goal remains active. None of the local or packaged evidence satisfies the external acceptance gates above.

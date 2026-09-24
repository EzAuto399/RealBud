# Modelvia and workflow QA — 23 September 2026

**Later live follow-up:** [the isolated Modelvia API qualification passed](../modelvia-live-2026-09-23/README.md) after the owner authorized a fresh capped service and the compatible release became available. Four workflow cases and clarified streaming passed; six requests settled, including one preserved initial content failure. The temporary test access is now closed. This QA desktop still needs its normal ongoing service mapping/entitlement.

**Earlier attempt recorded below:** the existing fictional qualification billing service expired at 08:36 Brisbane. Scoped model discovery refused access before inference; that attempt's test key/project were closed and independently checked. The table below preserves that earlier evidence rather than replacing it with the later API result.

**The Mac QA package is ready for owner testing.** Open [the isolated launcher](launch-qa.command), then follow the [five-step Mac checklist](manual-qa.md). This is a signed local candidate, not notarized distribution or accepted live workflows.

## Evidence by layer

| Layer | Result | Receipt |
| --- | --- | --- |
| Deployed preflight | Health/readiness/status pass at `a8938b1`; routes approved through 29 September | [Preflight](live/preflight.json) |
| Live qualification | Scoped project/key issued; model discovery returned `service_unavailable`; **0 inference calls attempted** | [Attempt](live/canary-receipt.json), [expired service](live/service-eligibility.json) |
| Live cleanup | Own test project disabled, one key revoked, revoked key refused; existing account/caps/rates unchanged | [Independent readback](live/cleanup-readback.json) |
| Exact deployed contract, local provider fixture | Fails required pricing-contract-2 assertion | [Negative receipt](local-deployed-contract/receipt.json) |
| Compatible candidate, local provider fixture | **11/11 steps passed** at `aa158c94f9bb`, including usage, revocation, lost-reply rotation and cap sync | [Candidate receipt](local-candidate-contract/receipt.json) |
| Actual pinned worker, loopback provider | Real readiness request captured; deployed parser accepts it; no paid provider | [Worker integration](integration/README.md) |
| Security and failure recovery | **185 passed / 0 failed / 0 skipped** in root's combined changed-backend/consumer run | [Root results](root-backend-regression.json), [findings and recovery limits](security/README.md) |
| Workflow edge cases | **194 passed / 0 failed / 0 skipped**, six disjoint workflow files: CSV formulas/bytes/dates, source/approval isolation, calendar aging/DST and human priority preservation | [Edge coverage](workflow-edges/README.md), [results](workflow-edges/receipt.json) |
| Source HTTP integration | Five suites, 245 checks pass; typecheck and production build pass | [HTTP log](http-e2e.log), [types](typecheck.log), [build](build.log) |
| UIUX | **22/24, ship reviewed UI changes**; 62 unit tests and 19 final rendered interactions pass, with 0 page errors. Native minimum 900 px checked; initial survey also covered 360/768/1280/1536 | [Review](uiux/README.md), [62 UI tests](uiux/final-unit-tests.json), [rendered assertions](uiux/fixed-receipt.json), [root recheck of 52 changed tests](root-ui-regression.json) |
| Mac packaging | **Passed**: 0.1.19 arm64 built in 562.52 seconds; strict signature verification and packaged renderer/capabilities/harness/shutdown smoke pass. Source unchanged across 1,286 files; signed, not notarized | [Result and archive checksum](package-result.json), [build input](package-input.json), [smoke](package-smoke.log) |
| Windows | Latest package CI success is run `35806671985` at `fb6cebed`; it excludes these local changes | Native candidate acceptance remains open |

## What changed

1. Managed model credentials reach readiness/ledger children after ambient credentials are stripped.
2. Failed revocation/cleanup holds future model launches, preserves recovery records and retries after repair. Boot and refresh reject revoked or superseded links.
3. Usage caches cannot reuse another office's completed or delayed response; model-shaped keys are redacted even under ordinary env names.
4. Website account guidance survives reload and is directly reachable from missing-model setup. Unsaved CSV work is protected when changing screens; pending reads/saves stay mounted.
5. The bank workflow's visible result is a reviewed CSV, consistent with the owner's current scope.

No customer/bank/mail data was used. No messages, payments, website deployment or source push occurred. The only live mutations were this run's capped fictional QA project and short-lived key, followed by their closure. Hosted rate-list 502 errors remain unexplained and separate from the confirmed service expiry. Four intended synthetic model tasks did not run; there are no new live inference performance or quality claims.

See [the durable checkpoint](../../docs/MODELVIA-QA-2026-09-23.md) for current live gates and the narrower disk-failure limit. Broad core, multi-office, performance and earlier Windows evidence remains in the [previous packet](../broad-qa-2026-09-23/README.md); it is not rerun or silently upgraded here.

## Mac candidate identity

The candidate is HEAD `e82ea2f067b7aa73d9bdc6e355a9bc4f1f1694c7` plus the preserved working tree, with source digest `6784e6864be8ea1bb32dd1fb5e25e7aac9df99a153b77a94a0eecd4ae113ffd9`. [RealBud-0.1.19-arm64.zip](package/RealBud-0.1.19-arm64.zip) has SHA-256 `8ca57407e781f427cb9b7fe539fe13d82987aa671370240d3bc37cbf1ca6dcc5`.

The launcher uses `~/Library/Application Support/RealBud QA/modelvia-qa-2026-09-23` and the already installed, pinned Hermes runtime `345cd2b057a452236de401d3534b8502a7465e8d-cfb3f08a9ee7`. It does not replace `/Applications/RealBud.app`. This runtime override is for this laptop and disables in-app worker updates; it does not prove provisioning on a fresh machine. The launcher itself remains for the owner's first-run acceptance; the automated smoke used a disposable profile.

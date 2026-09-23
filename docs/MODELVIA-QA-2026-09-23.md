# Modelvia, security and workflow QA — 23 September 2026

**Latest live follow-up:** the owner authorized continuing with an isolated A$0.60 QA service. Gateway `8ba0ba4` was already deployed when freshly checked. Four fictional workflow API cases and a clarified streaming check passed; six requests settled in total, including one preserved initial streaming punctuation failure. Pricing contract 2 and the final charge of A$0.000908 at the fictional QA rate were verified. Both keys are revoked, all three test accounts disabled, and independent readback confirms zero invoices or unresolved requests. See [the live packet](../outputs/modelvia-live-2026-09-23/README.md). This task did not deploy or commission RealBud's ongoing production account/mapping. The earlier expiry/release findings below describe the previous attempt.

This checkpoint does not establish live RealBud-to-Modelvia inference, customer workflow acceptance, or native Windows acceptance of these working-tree changes. The owner requested Modelvia service use, further edge/security testing and a UIUX review. Scope remains bank → CSV, email → bills → calendar, and email → morning priorities; REI upload is deferred.

The [QA packet](../outputs/modelvia-qa-2026-09-23/README.md) contains the exact receipts and final packaging status. Existing dirty work was preserved; this QA task has not committed, pushed or deployed.

## Earlier live Modelvia gate — superseded for isolated API QA

The earlier deployed gateway was `a8938b16f07c14d213db7e56fe14654c2dc197e5`. Read-only health/readiness and authenticated status passed. Its two approved routes were valid through 29 September and permitted at most 256 output tokens.

A separate fictional QA project was created under the existing qualification client/buyer, limited to the fast model, one concurrent request and A$0.60 project/month/request caps. Its short-lived key was issued, but authenticated model discovery returned `service_unavailable` before any inference. Readback establishes that the existing qualification billing service expired at **23 September 2026, 08:36:25 Brisbane**. No completion request was attempted. The new project is disabled, its only key revoked, and separate readback confirms closure. The runner refuses to repeat an existing receipt.

The authenticated rates-list route separately returned 502 `request_failed` twice; its cause was not established. Status succeeded afterward, so do not infer a stable database/card outage. Read-only Render UI inspection found a deployment of the same revision at 03:27:44 UTC and an earlier catalogue reload warning; it did not expose a matching rates failure diagnostic. No hosting change was made by this task.

RealBud's integration harness against that earlier deployed Modelvia source failed its required pricing-contract-2 assertion. The same harness against candidate `aa158c94f9bb` passed all 11 steps, including installation provisioning, settled fictional usage, scoped readback, revocation, lost-reply key rotation and cap sync. That result remains local fictional-provider evidence. The later live packet separately verifies the compatible deployed release and fresh fictional service; no database expiry bypass or real customer terms were used.

## Local corrections

| Area | Reproduced behavior and correction |
| --- | --- |
| Worker model access | Readiness/ledger one-shot children stripped ambient credentials but never injected the installation grant. They now use the same resolved launch snapshot as Ask, after environment hardening. Actual pinned Hermes was also exercised against a loopback provider; its real request passes the deployed parser and omits an explicit output limit. |
| Revocation and recovery | A saved revoked link could skip failed cleanup forever; vault-removal errors could discard recovery records. Revocation now holds access, retries before reconciliation, propagates cleanup errors and prevents stale or cold-start launch snapshots from republishing a revoked grant. |
| Office isolation | An old office's delayed usage response could populate the next office's cache. Cache/in-flight state is now installation/token/company scoped and responses recheck current ownership. |
| Credential logging | An ordinary env-field name bypassed content redaction even for recognizable model keys. Env rows now receive normal recursive content redaction, including extra metadata. |
| Setup and bank workflow | Pending model-access guidance survives reload; missing-model setup leads directly to Website account. Unsaved CSV preparation/decisions get a navigation guard, pending operations keep their owner mounted, and Back/hash cancellation is checked in the rendered app. Visible bank copy now ends at CSV. |

Root's combined backend regression is **185 passed / 0 failed / 0 skipped** across six files. Five source HTTP QA suites pass (245 checks); typecheck and production build pass. The UIUX review scores **22/24** for the reviewed screens: 62 focused tests and 19 final rendered checks pass, including keyboard/focus and Back/hash cancellation. Another six disjoint workflow files pass **194 / 0 / 0**, covering CSV formulas/bytes/dates, source/approval isolation, calendar aging/DST and human priority preservation. Counts overlap prior runs and must not be summed into a unique all-project total.

If both saving the revoked link and durable cleanup fail, an in-memory hold cannot preserve that observation through a process restart. The ordinary saved-revocation/failed-cleanup case is tested across a fresh access object. This work does not add a general recovery journal or guided repair UI.

## Remaining proof

The new Mac 0.1.19 arm64 candidate passed packaging, strict signature verification and the packaged renderer/capabilities/harness/shutdown smoke. The 1,286-file source digest stayed unchanged: `6784e6864be8ea1bb32dd1fb5e25e7aac9df99a153b77a94a0eecd4ae113ffd9`. It is signed but not notarized; the installed app was not replaced. Use the [isolated launcher](../outputs/modelvia-qa-2026-09-23/launch-qa.command) and [owner checklist](../outputs/modelvia-qa-2026-09-23/manual-qa.md). The launcher uses this laptop's existing pinned Hermes runtime; fresh-machine worker provisioning and owner first-run/restart acceptance remain unverified. Exact archive checksum and smoke receipt are in the packet. Previous packages do not contain these new fixes.

Native Windows CI remains green at `fb6cebed`, which predates this dirty-tree work; no Windows device was available for this candidate. Real Commonwealth Bank/ANZ, mailbox/calendar, physical local-team joining and customer acceptance remain separate runs. The later live packet records six actual API latency samples; the earlier expired-service refusal itself proves no model performance.

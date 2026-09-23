# Readiness and Modelvia gap fixes — 23 September 2026

This checkpoint does **not** establish real signed-in website account linking, customer bank/mail acceptance, native Windows behaviour, notarization, fresh-machine setup, damaged-data repair UI, or a two-computer office. Live API tests and local app tests are separate evidence. The bank workflow ends at CSV; REI upload remains deferred.

## Implemented behaviour

- Readiness accepts `OK`, `ok`, `OK.` and `OK!` as the complete answer. It filters only the observed exact worker startup notice, rejects unrelated prose, and recognises provider failures even when the CLI exits zero. Each explicit check gets a unique intent marker; its internal retries retain that marker. Overlapping readiness checks are refused before starting another worker. The existing installation grant injection was retained.
- Expired/revoked access, occupied concurrency, monthly caps and per-request reservation limits have actionable product messages. Managed setup displays the last failed readiness result. A timeout directs the operator to review usage before another check because the upstream outcome may be uncertain.
- Desktop provisioning accepts the gateway's optional validated connector project identifier while still rejecting extra fields and vendor secrets. Newly created private roots use mode 0700; existing unsafe roots remain held for recovery.
- Source-linked bill preparation can acquire **one text-based PDF, at most 2 MB and 20 pages**, from the exact reviewed Gmail account/thread/message. The gateway verifies read-only scopes and message metadata, pins the attachment tool schema/version, and checks authority after asynchronous work. Download URLs come only from the provider, must be HTTPS S3, resolve to public IPv4, cannot redirect, and have byte/time limits. No attachment tool is added to the worker's MCP allowlist.
- PDF parsing runs in a separate bounded process with read-only filesystem permissions, no inherited credentials, no external resource locations, disabled PDF evaluation and a five-second deadline. Node's permission mode is **not** claimed to be an OS network sandbox. Original bytes and their digest remain in encrypted workflow storage; workers and UI receive redacted text and source hashes. Existing receipts remain readable, retries reuse the saved evidence, and bill/calendar acceptance still requires staff review. Blank/scanned pages, unsupported formats, multiple PDFs and acquisition failures remain explicit holds. OCR and complete image-content interpretation are not implemented.

## Current proof

| Layer | Result | Receipt |
|---|---|---|
| Actual local RealBud service, provisioning gateway and pinned Hermes worker; fictional website/provider | 11 / 0 / 0 checks. Account-bound entitlement, encrypted grant application, two explicit readiness calls, overlapping check, request cap, timeout and revoked key. Timeout returned after about 61.7 seconds while `/api/health` remained responsive. | `outputs/readiness-gaps-2026-09-23/app/2026-09-23T05-18-33.061Z/receipt.json` |
| Failure-message UI | 15 / 0 / 0 scenarios across 390, 768 and 1280 px; keyboard operation, no horizontal overflow or renderer errors. | `outputs/readiness-gaps-2026-09-23/ui/2026-09-23T05-14-49.012Z/receipt.json` |
| PDF acquisition, parser and source-bound preparation | 206 / 0 / 0 focused tests before the final broader regression run. | `outputs/readiness-gaps-2026-09-23/files/pdf-acquisition-initial.json` |
| Managed gateway regression suite | 148 / 0 / 0 tests, including attachment wrong-account, revoked access and caller-supplied URL refusal. | `outputs/readiness-gaps-2026-09-23/gateway-regressions.log` |
| Actual local bill workflow and rendered UI, fictional connector/worker | 25 / 0 / 0 checks; PDF text displayed, no automatic bill acceptance, source/retry behaviour, retained drafts, conflicts, paging and calendar corrections. No renderer errors. | `outputs/readiness-gaps-2026-09-23/pdf-ui-final/receipt.json` |
| Compiled PDF reader without checkout dependencies | 10 / 0 / 0 executions from an isolated directory containing spaces; median 65.9 ms, maximum 70.2 ms for one small fictional page. This is a narrow parser measurement, not general app performance. | `outputs/readiness-gaps-2026-09-23/files/packaged-pdf-check.json` |
| CSV format boundaries | 18 / 0 / 0 synthetic cases. Supported UTF-8/BOM, line endings, quoted multi-line descriptions and negative amounts checked; unsupported encodings/formats rejected. Genuine CBA/ANZ exports remain unverified. | `outputs/readiness-gaps-2026-09-23/files/csv-receipt.json` |
| Tool approval fence | Fictional malicious email exercised actual ACP driver, browser broker/authority and persisted approval store, including payment click/Enter, changed recipient/amount, Stop and cross-run/account denial. It uses a fake worker/browser transport, not a hosted model or real payment page. | `outputs/core-gap-qa-2026-09-23/security/summary.json` |

The local timeout deliberately leaves one **unknown** gateway attempt in its disposable ledger. That is preserved evidence of uncertainty, not a settled charge or a live-account problem. The live hosted ledger below has no pending or unknown attempts.

PDF backup and UI projection follow-up: **13 / 0 / 0** in `outputs/readiness-gaps-2026-09-23/pdf-backup-regressions.json`, including retention through restore under a different encryption key without another download or worker call. Release/notarization guard and two-device **receipt validator** tests: **33 / 0 / 0** in `outputs/readiness-gaps-2026-09-23/release-guards.log`. These are guard tests, not notarization or device acceptance.

Full local suite: **5,724 passed / 1 failed / 252 environment-gated skipped**, preserved in `outputs/readiness-gaps-2026-09-23/full-regressions.json`. The single failure was the plural `attachments` wording expectation after review guidance changed; the product sentence was corrected without weakening the test. The affected bill, retained-history, PDF backup and UI projection rerun then passed **102 / 0 / 0**, recorded in `final-bill-regressions.json`. The skip inventory is in `full-regressions-summary.json` (PostgreSQL/company integrations, native Windows and other explicit platform/runtime gates). The whole suite was not repeated after this wording-only correction.

Final TypeScript check passed (`final-typecheck.log`), as did renderer/server builds and `git diff --check`.

Production dependency registry audit: **0 known advisories across 174 dependencies**, recorded in `outputs/readiness-gaps-2026-09-23/dependency-audit.json`. This does not establish that bundled native/Python components or vendored code are vulnerability-free.

## Live Modelvia repeat run

Exact deployed revision: `d5a355dab049aca8e51d9290d2c6b618bae3e720`. New fictional `internal_cost` QA namespace, no customer input, A$0.60 caps, one concurrent request and a one-hour service TTL. Historical external-accounting records were not changed.

**41 / 0 / 0 live content checks; all 41 attempts settled.** Each of readiness, bank CSV preservation, bill due-date extraction and untrusted-email priorities passed 10/10. One streaming readiness call passed. Median API latencies: readiness 0.92 s, CSV 3.02 s, bill 2.57 s, priorities 1.68 s; streaming call 0.83 s. Ten trials per workflow are a small sample and do not establish a production failure rate.

Six live negative checks passed without adding ledger attempts: forbidden model, output ceiling, expired key, lowered own request limit, exact duplicate and changed duplicate. The test did **not** spend through the A$0.60 monthly cap; the live cap case lowered a request limit. Hosted Stop, timeout and concurrency remain unverified live. Local app/driver tests cover those respective controlled failure paths.

Priced QA allocation was **A$0.008585**, with **A$0 wholesale charge** under the internal-cost setup. This is not a provider-cost or margin claim. Both test keys were revoked; client, customer and project disabled; zero invoices. Independent readback confirmed zero active keys, zero pending/unknown attempts and the cleanup. The tenant's service TTL was `2026-09-23T06:15:01.319Z`; its active flag was not used as an access claim after key/account shutdown.

Evidence: `outputs/readiness-gaps-2026-09-23/live/{receipt.json,summary.json,independent-readback.json}`. The live API run did not execute the three workflows through a genuinely linked RealBud website account and worker. The local app harness uses a controlled fictional website link; these layers must not be combined into that claim.

## Reservation finding

Six prior immutable receipts showed a maximum hold of **A$0.524948** versus **A$0.000908** total priced usage. At an A$0.60 cap, that maximum hold leaves only **A$0.075052** of spent headroom. Two simultaneous maximum holds would require A$1.049896. Monthly-cap admission precedes concurrency, so a second request can correctly receive 402 before 429. No real customer plan defaults were inferred and the conservative financial boundary was not weakened. Any smaller hold requires a correspondingly enforceable context/output bound. See `outputs/readiness-gaps-2026-09-23/reservation-analysis.md`.

## Verified Mac QA candidate

Use **`outputs/readiness-gaps-2026-09-23/launch-qa.command`**. It points to `final-candidate/RealBud.app` and uses an independent QA data folder. The installed app and existing data were not replaced. The candidate is signed; notarization remains open.

The initial full package completed signing and its smoke test, but its source-snapshot gate correctly failed when final review corrected the pinned DNS resolver's IPv4 mode. Do not use that superseded `package/` ZIP/DMG for current QA. The retained `package-result.json` remains `passed: false`.

Finalization required an exact two-source-file allowlist (downloader and its test), rebuilt the server, and proved that **only `server/source-attachments.js`** differed from the signed base's compiled server. It copied the base to a new candidate, replaced that one freshly compiled module, verified every compiled server/shared runtime file, signed the outer bundle again, and ran strict deep signature verification, packaged startup/shutdown smoke and actual shipped-Electron PDF extraction. No source changed during final verification. `final-candidate-result.json` records **passed: true**, source SHA-256 `1571af70eac7b53beb605f5ff09d9d7c49f74c6474ad393a2e9b353c3b7839eb`, and the exact compiled-file hashes. This is an explicitly verified incremental local candidate, not a claim that the superseded archive matches current source.

The downloader follow-up passed **30 / 0 / 0** (`files/pdf-pinned-dns.json`). A real Node HTTPS lookup contract check, stopped before any network connection, confirmed that default mode requests an address list while explicit IPv4 uses the single-address callback (`files/node-dns-contract.json`).

Packaged Electron 43.4.0 / Node 24.18.1 extracted the fictional PDF in **159.6 ms**, using the exact shipped helper; `packaged-pdf-runtime.json` records its hash. The packaged smoke verified renderer, capabilities, embedded service and shutdown. These checks do not replace the user's own account-linked workflow test.

## Remaining acceptance gates

1. Identify the signed-in RealBud website account that owns this laptop's QA installation, then commission/link that installation and run the three workflows through the app against live Modelvia. No further paid service was commissioned during these local fixes.
2. Deploy the reviewed connector attachment endpoint through the separately authorised service release process before claiming live managed Gmail PDF support. The adapter is locally tested against the official pinned schema; no real mail was read.
3. Run the user's CBA export and obtain representative redacted ANZ exports. Check actual columns, encoding and decimal/date conventions. Test scanned/multi-attachment bills manually within the explicit limits above.
4. Native Windows, notarized/fresh-machine Mac installation, damaged-data recovery UI and two-computer department/join acceptance remain open.

Earlier failed checks, old packages and receipts remain preserved. This continuation supersedes the older “zero live calls” and “PDF bodies never read” statements only at the specific proof layers recorded here.

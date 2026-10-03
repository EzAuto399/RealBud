# Core and workflow foundation — 1 October 2026

This checkpoint does not establish a released or installed build containing these changes, a live authenticated Modelvia completion, Windows acceptance, connected customer sources or Kevin/Sherry workflow acceptance. It records source changes, local tests, an isolated check using the installed worker and public Modelvia reachability. The [confirmed workflow plan](AUSTON-KEVIN-SHERRY-WORKFLOW-PLAN-2026-09-30.md) remains the delivery scope.

## Implemented in this checkout

**Selected CSV inspection.** New CSV uploads receive a private adjacent `.inspection.json` report containing a digest of the original bytes, exact logical data-row count, blank records, header/width anomalies and per-column missing/duplicate value counts. UTF-8, quoting, size, rows and columns are checked before bounded parsing. Unsupported or invalid files have no estimated count. Originals remain unchanged. Bud's instructions use the ordinary file-read tool for this report rather than requesting a counting command.

The report distinguishes data rows from verified properties. It does not accept identities or import them into the book. It describes the upload snapshot and lives in the writable workroom; it is not an immutable financial record or proof of freshness/later file contents. Existing uploads have no retroactive report. Installed-worker reading of this report without an approval interruption remains a qualification step.

**Model-access recovery.** A missing installation binding remains the explicit withdrawal signal. Damaged, oversized, malformed, linked or unreadable bindings now hold with `service_installation_recovery_required` instead of being treated as removal. Tests demonstrate that the original binding, provisioning record and encrypted model key survive, and repairing the binding restores use of the same grant. Reads are bounded and refuse unsafe file types. Existing private writers admit Windows ACLs; this fix adds no synchronous PowerShell process to the hot capability-check path and makes no new Windows read-ACL qualification claim.

**Worker launch readiness.** An active provisioning receipt with an empty/unavailable resolved key now returns a recovery explanation before launching the selected model worker. It no longer starts that worker with no usable authentication. The same central guard reaches Ask and the existing model-launch paths.

**Verification repairs.** The gateway's Modelvia contract now consumes the actual shared desktop model choices, fixing an existing TypeScript failure and removing a duplicated menu. Usage fixtures explicitly exercise the Brisbane/UTC month boundary and cache rollover. The service-admin fixture writes the same private installation-file mode as production.

## Current workflow evidence and gaps

| Workflow | Existing source implementation | Next required implementation or qualification |
|---|---|---|
| W1 bank references | Strict parsing, row accounting, reference-only byte-preserving export, durable reviewed batches | Accepted reference mappings, untouched/corrected Kevin sample, selected bank export and installed attended run |
| W2 bills and calendar | Composio mail/PDF acquisition, reviewed occurrences, corrections, recurrence and separate arrival/due calendar entries | Invoice identity across forwards; independent financial/REI states; shared Kevin/Sherry case ownership; qualified REI entry/attachment readback |
| W3 morning priorities | Saved mail scans, durable work, decisions and follow-up reconciliation | Named mailbox/history coverage, comparison with Kevin's real morning work and linkage to shared bill issues |
| W4 maintenance | Generic maintenance preparation | Supplier/property three-month evidence grouping, Sherry's review record and suppression of unchanged resolved cases |
| W5 inspections | Generic inspection preparation and a Zapier catalogue entry | Six-month planning and actual Property Inspect action binding through Zapier, including notice effects, results and reschedule/retry reconciliation |

Shared company-work primitives support ownership, assignees, audiences, selected evidence and revisions (`shared/company-work.ts`, `server/company/work-items.ts`). Current source-bill/mail stores are private workspace records (`server/workflow-services.ts`, `server/source-bills-api.ts`); they are not yet a shared Kevin/Sherry bill register. Access to a private mailbox must not be widened to bridge this gap.

Current bill identity is account/thread/message based (`server/source-bill-rules.ts`). `BillFacts` has no invoice-number/version field, so forwarding the same invoice can create another occurrence. Similar supplier/amount/date values alone cannot safely merge legitimate separate repairs.

## Next implementation sequence

1. Use representative invoices and the accepted directory to define a reviewed business invoice identity. Add it to bill accept/correct, preserve each source/history and hold conflicting versions. Rehearse identical forwards, changed amounts/versions, distinct maintenance invoices and stale reviews.
2. Link bill cases to existing scoped company work so Kevin and Sherry share accepted facts, decisions and named next actions under explicit source permissions.
3. Qualify bank CSV and REI bill entry against named accounts/mappings, with verified outcomes before retries. Connect morning items and maintenance reviews to those same bill cases.
4. Discover the actual Property Inspect operations on the designated Zapier connection before implementing booking/calendar/notice dispatch. Zapier remains exclusive to W5; RealBud owns job scheduling.
5. Package the fixed revision and qualify installed devices and complete jobs before enabling recurring execution.

## Verification

Final Node 24.21.0 checks:

| Check | Passed / failed / gated skipped | Evidence |
|---|---|---|
| Full application regression | 6,371 / 0 / 282 across 474 files (446 passed, 28 gated) | `vitest-final.log` |
| Managed gateway | 348 / 0 / 0 | `managed-gateway-final.log` |
| CSV inspection, upload privacy and Ask | 48 / 0 / 5 (native Windows cases) | `csv-final.log` |
| Binding recovery and entitlements | 80 / 0 / 0 | `binding-after.log` |
| Model launch, hands and bridge | 72 / 0 / 0 | `model-launch-after.log` |
| Installed worker request format | 3 / 0 / 0 | `installed-worker-wire.log` |

Application/server and gateway typechecks passed. All five local HTTP suites passed (`http-e2e-final.log`). Independent source review found no remaining blocking issue. Source hashes are retained in the receipt. Environment-gated cases were not counted as passed.

Exact final counts and limits are retained in [the verification packet](../outputs/core-workflows-2026-10-01/receipt.json). Logs are separate proof sets and are not summed as unique tests. The initial exploratory full-suite log was collected while implementation was changing; the final full-suite log is the relevant local regression result.

The installed worker was exercised against an isolated loopback Modelvia-compatible endpoint with fictional credentials and a temporary profile. All three configured model/effort choices passed their wire assertions. This proves the actual worker sends RealBud's configured request format and granted credential to that local endpoint; it is not a paid provider response or customer workflow.

Public Modelvia `/health` and `/ready` returned HTTP 200 on 1 October Brisbane time, with key serving enabled. Local installation metadata reports active Modelvia provisioning and connector configuration. These checks did not open customer documents, output credentials, rotate keys, change accounts or execute a paid model request. A real authenticated completion remains to be verified through the installed application's protected access.

# Daily workflow corrections and Windows setup evidence

22 September 2026 follow-up to the [reusable core](REAL-ESTATE-CORE-2026-09-21.md). This closes two locally reproducible workday gaps and prepares native Windows provisioning acceptance. It does not establish customer bank/Gmail/REI acceptance or a signed public release.

## Bank corrections

Staff can choose **Correct mapping or decisions** from the latest saved bank review. A correction creates a new version against the same immutable original source, with its own mapping, reason and fresh transaction decisions. It never silently rewrites a previously prepared artifact. The UI links previous/newer versions and labels earlier downloads for reconciliation; it warns staff to reconcile an already imported copy in REI Cloud before importing a correction. No REI import or financial posting is performed by this action.

The authoritative store creates the successor and links its predecessor in one SQLite transaction. The parent revision prevents competing corrections from forking history. An exact retry reconciles the committed successor, even after that successor has been reviewed or corrected again. A changed retry fails with a conflict. Old decisions, original bytes and prior output bytes remain individually retrievable after restart. A failed parent write rolls back the inserted child.

Saved envelope version 2 retains all assign/keep decisions and reasons. New reviewed records with missing decisions are held as damaged data. Existing v1 reviews remain readable; amending a historical review explicitly marks unavailable complete decisions instead of inventing unchanged-row reasons. Historical text-only input retains its original limitation and is never upgraded into claimed captured bytes. Review identity versions (`:r2`, `:r3`) are separate from database concurrency revisions.

Live reads/reviews and both private backup formats validate parent/successor links, revision relationships, source identity and request digest. Different-key restoration preserves the entire chain; missing or tampered relationships are rejected before staging/sealing. The amendment form edits structured properties and individual aliases, preserving punctuation and whitespace. A separate reviewer reproduced a lossy delimiter round-trip in the first form; that form was replaced and the real browser test now verifies lossless aliases.

## Waiting conversations

The morning workflow now reconsiders unchanged waiting conversations once their confirmed follow-up interval is due. Eligibility requires a fresh complete scan, complete current thread history, verified sent/reply ordering and the matching current source digest. Office calendar dates define the interval, including daylight-saving changes. Unknown direction, tied latest timestamps, unread/incomplete content and missing coverage do not become overdue claims.

An optional persisted key binds the handled interval to the account, current binding, outgoing message, timezone and configured number of days. It is consumed only after validated worker output is applied. Failed, malformed or stale results remain eligible for a later fresh review. Repeated scans and restarts do not repeatedly review the same interval. Later outgoing messages and changed confirmed settings can establish a new interval. Staff priority, owner, next action, notes, completion, snoozes and reference/noise exclusions remain authoritative. This proposes review work; it never sends a follow-up email.

## Windows and Grok

[Windows profile acceptance](WINDOWS-PROFILE-ACCEPTANCE.md) records the test-only fixture changes and six native cases. Protected empty fixture objects are prepared before content is written; verification never repairs an existing ACL. Independent PowerShell observations check owner/protection/grants and descriptor hashes. Local macOS results are 137 passed and six native cases skipped. Native Windows setup, first install/update, timing and memory acceptance remain unrun. Existing startup still performs eight or nine synchronous PowerShell checks; packaged health alone does not prove profile setup.

The requested development model is callable. A fresh ACP session completed a useful Windows-fixture review with actual `grok-4.7-build`, xhigh, one model call/turn in 50.9 seconds. Its recommendations informed the independent ACL witness and refusal cases. A second, distinct bank review reached the fixed 300-second deadline without final findings. That timeout is retained as a negative result, not review approval. Both runs cleaned their owned processes/temp homes and preserved global settings. The exact invocation, limitations and receipts are in `outputs/hermes-windows-acceptance-2026-09-22/` and `outputs/bank-amendments-2026-09-22/`.

## Verification and remaining gates

Final full source suite: **4,451 passed, zero failed, 149 environment-gated skips**, 348 files, 322.47 seconds of reported test execution. The admitted native Hermes runtime was enabled. All 1,093 recorded inputs stayed unchanged during the run. Frontend/server typechecks, package preparation and Electron syntax checks passed.

Final unsigned macOS arm64 app: `outputs/workflow-corrections-2026-09-22/package-final/mac-arm64/RealBud.app`. Its 2,420 files and 14 symlinks stayed unchanged during native renderer/service/shutdown smoke and all **seven packaged HTTP/browser checks**. The shipped workflow modules and complete UI match the compiled build. Package manifest digest: `201423e1bf949a6cab4b2ca349e12d46836f3695796fb4e582ba9557c007603f`. No installed app was replaced. The earlier `package/` artifact predates the final missing-decision guard and historical-decision explanation; use `package-final/`.

The final verification record, source fingerprints, package and logs are under `outputs/workflow-corrections-2026-09-22/`. Browser evidence uses a real authenticated HTTP service and built UI with fictional bank data. It checks staff decisions, a committed amendment with a lost response, explicit retry, stale competition, fresh-review requirement, both exact downloads and actual service restart. Desktop and 390px captures were visually inspected. The first full-page captures contained blank space below the app's internal scroll viewport; corrected viewport captures are retained separately in `outputs/bank-amendments-2026-09-22/gui-reviewed/`.

Locally actionable follow-ups remain: compatible installed-pack upgrades/migrations with recovery; an integrated managed-mail rehearsal covering the real connector gateway and provider parser together; and Windows startup/profile smoke coverage beyond service health. None requires a customer account to design or test locally. Modelvia remains the separately owned model/billing service; do not build a duplicate model gateway in this repository.

External acceptance still requires current native Windows execution, supported signing/distribution, managed-service deployment and lifecycle commissioning, paired customer bank examples and actual REI recognition, authorized Gmail account acceptance, and independent-device office/recovery/soak checks. No native Windows, live customer, payment, publication or installation action was performed in this wave.

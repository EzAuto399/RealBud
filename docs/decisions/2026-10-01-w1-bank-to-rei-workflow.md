# W1 — bank export, reference review and REI import

1 October 2026 · Owner clarification. This defines the intended complete workflow; no bank login/export, cookie extraction, REI upload/posting or recurring job was performed or enabled by recording it.

The owner defines W1 as: the user signs into the bank and REI in the work browser; RealBud checks every two days, exports the relevant bank transactions to CSV, reviews/prepares the tenant references, then takes the reviewed file through REI import and verifies the result. This extends the target beyond the earlier reviewed-CSV delivery stage. ANZ remains the existing preparation scope; the exact ANZ product/account and original/corrected example are still needed to qualify the layout.

## End-to-end sequence

1. **Establish the session.** The user signs in and handles MFA in RealBud's dedicated work browser. Reuse that browser-managed session while valid and confirm the selected bank account and destination REI agency/trust account. If authentication expires, preserve progress and request user sign-in. Do not log out or weaken session expiry.
2. **Choose the covered period.** Run on an anchored every-two-calendar-days clock at the selected office time. The initial range is reviewed explicitly. Later exports cover the unprocessed interval from the last confirmed import, with a qualified overlap for late postings. A missed run must widen recovery coverage; “the last 48 hours” is not a sufficient recovery rule.
3. **Capture the bank CSV.** Use the supported export controls for the selected bank account, then retain the exact original bytes, hash, requested/observed period, selected account, row count and signed totals. Preserve all exported transactions. Identify tenant-payment candidates without silently dropping debits, other credits or duplicate-looking rows.
4. **Review references.** Use the accepted property/tenant reference directory and original/corrected examples. Propose only supported reference changes; preserve dates, amounts, order and unrelated fields. Retain every row and decision. Unmatched, ambiguous, combined or duplicate-looking payments stay unresolved until reviewed. The existing `keep` decision means preserve the original reference; it does not mean omit the row from import.
5. **Prepare the REI preview.** Bind the exact reviewed output hash and batch version to the selected REI agency/trust account and verified file format. Once native transfer support is qualified, load that file and reconcile the preview row by row: included/excluded rows, proposed tenant matches, amounts, totals and warnings. An unresolved row must not silently be imported merely because it exists in the preserved CSV. Hold the batch unless a separately qualified partial-import path explicitly accounts for every row.
6. **User submits the final posting.** Bud prepares the file and verified preview. The authorized user performs the final action that posts tenant receipts or changes the trust ledger. Uploading a file or opening a preview is not that posting. A generic browser success or approval checkbox is not a financial outcome.
7. **Verify and retain the result.** Read back the resulting REI batch/receipt references and accepted, rejected and pending rows. Reconcile row identities as well as totals. Save the import result, then advance the account/destination progress cursor only for confirmed covered work. Notify the user of completion or remaining exceptions. A timeout or lost reply after an attempted import is an unknown outcome: inspect REI before retrying, including before switching adapters.

## Owner decision, 6 October 2026: wait at REI sign-in, then carry on

The owner wants Bud to treat waiting for a sign-in as part of the workflow: "it sits on the REI Cloud login page until Kevin arrives in the office and logs in, then everything keeps going". It must be reliable and pick up where it left off. The same applies to the Supplier list check (`rei-supplier-check`). As built in source (`server/w1-sign-in-wait.ts`, `server/w1-host.ts`, `server/rei-directory-sync.ts`):

- **Long wait.** A loop run (scheduled or Run now) that finds REI signed out opens REI's sign-in page in the work browser and waits there until 18:00 office time. A run that starts after that waits 15 minutes. If nobody signs in, the run settles as **missed** ("Missed: REI Cloud wasn't signed in today…"), with a chat card and desktop notification, and the next scheduled run tries again. A person's own Continue keeps the attended 15-minute handover.
- **Sign-in detected by itself.** The wait reads only the sign-in tab's address, every 20 seconds. It continues once the tab is back on REI's app origin, off `b2clogin` and off a sign-in path (REI's failed-sign-in page `/Account/NewLoginMFA` does not count). Done stays as a manual fallback, and Stop ends the wait at any time. The same read-only account check then runs under a fresh host grant: it compares REI's top-bar business code with the saved one, and the reicid when one was saved. A match continues with no press. A mismatch stops with the plain account message.
- **Restart reopens the page (this reverses "no browser at startup" for this one case).** The wait is saved (`<data>/w1/sign-in-waits.json`: the loop, the run, the deadline and whether the reminder was said). On service start, each saved wait still inside its deadline starts its loop again. For W1 that also requires its run to still be at the sign-in step. That run opens the work browser and REI's sign-in page and keeps the same deadline. Nothing else opens a browser at startup.
- **Grants and checkpoints.** No grant is held through the wait. Each REI stage gets a fresh host grant with the same scope (the same pack sites and actions, browser, business code and file), never broader. Saved W1 steps are not redone: the bank pull, the review and its file digest. The upload still asks for its own one-time approval, and Bud never approves it.
- **Tell the person once.** The run's Schedule line says "Sign in to REI Cloud so Bud can finish the bank import" (the supplier check says "…check the supplier list"), which posts one chat card and one desktop notification. If it is still waiting, one reminder follows at 12:00. A restart that resumes the same wait says the same line, so nothing is repeated.

Not established: real REI Cloud sign-in detection, its post-login address and live B2C behaviour. [REI-LOGIN-TEST](../REI-LOGIN-TEST.md) records a sign-in journey that failed after about 15 idle minutes. A sign-in page left open for hours may therefore fail on the first attempt; the person retries in the same tab or presses Done. Refreshing the page in place needs a work-browser navigate or close-tab primitive, which is not built. Proof so far is source and local tests over the fictional portal (`server/w1-sign-in-wait.test.ts`, `scripts/qa-rei-login-wait.mjs`).

## Session and CLI choice

Use the existing persistent work profile. The browser retains cookies in its normal protected profile; RealBud keeps the profile identity and task scope. Do not put raw session cookies or authentication tokens in model context, task files, logs, command arguments or a second CLI/browser profile.

The selected native runtime currently controls only its own work profile. An unlocked personal-browser tab is not automatically accessible to Bud. Reuse an existing tab only when it is in the authorized supported connection; otherwise sign in in the spawned work browser. Importing cookies from a personal profile is not the connection mechanism selected here.

The host already invokes a pinned browser command-line engine through its broker. A future CLI adapter can expose qualified bank export and REI preview operations through that same scoped interface, with exact account/file binding, Stop and durable receipts. It is not a shortcut around login/MFA, missing transfer support or final user posting. A documented, entitled vendor API may replace a particular browser operation later; no endpoint, client entitlement or unattended banking connection is assumed.

ANZ's public guidance documents exporting transactions for a selected account and time period, and separately says online banking sessions expire automatically. Session retention therefore does not establish that a bank login will still be valid two days later. Sources checked 1 October 2026: [ANZ transaction export](https://www.anz.com.au/support/online-banking/spending-savings/statements/) and [ANZ session security](https://exclusives.anz.com.au/security/protect-yourself/internet-online-banking/).

REI publicly describes bank-file matching and bulk receipting. That supports the intended product route, but does not verify the selected agency's file format, permissions, preview behavior or import result contract. [REI features](https://reicloud.com.au/features/). Its public API landing page is not evidence of a qualified receipt-posting endpoint.

## Implementation and acceptance

| Area | Existing evidence | Work still required |
|---|---|---|
| Session | Dedicated persistent Chrome/Edge work profile; fictional close/reopen cookie test | Real bank/REI identity, MFA/expiry and restart qualification |
| File transfer | Generic broker has scoped artifact/hash handling | Selected native runtime is read-only and rejects download/upload; implement and qualify its transfer adapter |
| Local review | Original bytes, reference-only edits, all-row preservation, durable versions and exact-file replay | Kevin's original/corrected examples; verified export layout; explicit downstream importability decisions |
| Two-day operation | Durable clock with missed-run history | Clock currently supports time plus weekdays, not an anchored two-day interval; add interval support and a W1 runner |
| Overlapping exports | Same-file dedupe and within-file duplicate warnings | Stable transaction identity across files, bank-account/period binding and preservation of legitimate identical transactions |
| REI | Mapped Bulk Receipting page and a preview recipe that stops before processing | Native upload, exact preview reconciliation, user posting handoff and durable import/readback results |
| Recovery | Local bank-review history and amendments | Separate export, preparation and import checkpoints; account/destination progress cursor; uncertain-result reconciliation |

Use stable bank transaction identifiers when available. Matching only date, amount and narrative is not enough to delete or suppress a duplicate-looking payment: separate legitimate payments can share those fields. When the export lacks a reliable identity, preserve multiplicity and hold ambiguous overlap for reconciliation. The bank-history pagination cursor is unrelated to import progress.

Required rehearsals include: expired login before export; account switch; delayed run; overlapping export; late-posted payment; two legitimate identical-looking credits; incomplete export; ambiguous reference; changed reviewed file; partial REI rejection; timeout after submission; restart at each checkpoint; and an unchanged rerun. No run may call an upload or generated CSV a confirmed REI import.

This W1 target does not change the separate [Gmail-first W2/W3 cadence](2026-10-01-gmail-w2-w3-operating-model.md). W2 remains weekly and W3 daily; W1 is every two days.

The target is recorded in source pack revision 5, which is not installed or activated. Preparation, pack and bank/account checks passed 132 tests across eight files; the final posting-handoff wording passed the affected 63 tests across six files. Generated-pack and type checks passed. These are source contract checks, not live bank/REI acceptance. See the [validation receipt](../../outputs/w2-w3-readiness-2026-10-01/w1-operating-model/source-validation-receipt.json).

Source pointers: [bank review](../../server/bank-reference.ts), [bank review store](../../server/bank-reference-store.ts), [native browser runtime](../../server/native-browser-runtime.ts), [persistent browser host](../../server/work-browser-host.ts), [REI map](../REI-CLOUD-MAP-2026-09-24.md).

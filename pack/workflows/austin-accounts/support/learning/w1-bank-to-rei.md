# W1: bank payments into REI (what we learned before the first live run)

Notes for Bud. Plain facts from a dry run on 2 October 2026 with a FICTIONAL bank feed and a FICTIONAL REI-style portal. Nothing here came from a real bank, a real REI account or a customer. Every name, code and amount below is invented. These notes grant nothing: the RealBud fence decides every browser step.

## What happens, step by step

| Step | What it needs | Who acts |
|---|---|---|
| 1. Settings | The bank account (from the office's bank feed), the business code shown in REI's top bar (this is the account scope). The `reicid` in REI's address is optional. REI's File Format defaults to ANZ(csv file), the office's own bank export. | Office, once |
| 2. Pull | The bank feed connected (Redbark). First pull covers the last 2 days. Later pulls start 3 days before the last confirmed date, so late postings are caught. Pending (not yet posted) bank rows are left out. A pull never moves the "covered to" date. | RealBud |
| 3. Review | The property directory: each property's reference, its aliases (at least three letters or digits), and its REI tenant name. Every pulled row needs one decision: import (to one property), hold, or exclude. | The person |
| 4. REI import file | Built from the review. Only "import" rows go in. Held and excluded rows never go to REI. | RealBud |
| 5. Sign in to REI | The work browser, signed in by the person on REI's own page. Bud never sees passwords or codes. | The person |
| 6. Upload and preview | One approval for the upload of that exact file. Bud then reads REI's preview and compares it row by row (date, reference, tenant, amount, totals, warnings). | Bud asks, the person allows |
| 7. Posting | The person checks the preview in REI and presses Process Receipts themselves. Bud never presses Process Receipts, Receipt All, Save, Post or Finalise. The person then says "I've processed it" (or "not sure"). | The person |
| 8. Readback | Bud reads REI's Receipt Register (one approval for the download) and checks every imported row was receipted. | Bud asks, the person allows |
| 9. Confirm | Only a complete readback moves the "covered to" date. | RealBud |

Approvals seen in the dry run before the upload: the Receipt Register download (a "before" picture of the register), the File Format selection, then the upload itself. After posting: the Receipt Register download again.

## The REI import file RealBud builds

File Format ANZ(csv file): the layout of the office's own ANZ export. There is no header row and there are eight columns. Sample from the fictional dry run:

```
01/09/2026,"550.00",PAYMENT FROM ALEX FICTIONAL A2218,,,,,FT-BRAVO
```

How each column comes from the bank row:

- **Date (column 1)**: the bank's posting date (else the transaction date), as DD/MM/YYYY. Never the run day.
- **Amount (column 2)**: the signed amount with two decimals. Credits are positive. Debits never reach the file (they are excluded or held).
- **Narrative (column 3)**: the bank's description, plus its extended description when different.
- **Reference (column 8)**: the property's directory reference when the person imported the row to that property (here the bank text "A2218" became "FT-BRAVO"). The bank's own reference text stays in the Narrative.

Not known yet: whether live REI reads this file exactly as the fictional portal does. That portal's ANZ(csv file) parser is a guess until one authorised real preview of a tiny file.

## How the first-pass matcher sorted the fictional ANZ-shaped export (27 rows)

- **Import (6)**: a reference or alias matched exactly one property, for example "A2004Smithson" → A2004, "B1605Lasmin" → B1605, "A114-talia" → A114.
- **Hold (18)**: unknown reference ("1204 JORDAN", "Z999"), no reference at all, only an address ("Rent 6 Example St"), a code shared by several properties ("UNIT 5"), two payers into one property in one batch (possible shared rent), invoice-like payments ("ACME water", "INV 3021"), business or payment-service transfers ("BUSACCT", "PAYONEER").
- **Exclude (3)**: outgoing payments (negative amounts) and Airbnb payouts with no reference.

The matcher also runs on every bank-feed (Redbark) pull, using the bank's description and reference. It sorts exceptions first and only suggests: nothing is imported until the person decides each row, and an exception is never suggested as an import. On the fictional feed, run 1 (12 rows) was suggested as 5 import and 7 hold.

Held rows come back. A row the person held stays open, however old, until they import or exclude it. Every later pull carries it into the review with its original bank id, as a Hold exception labelled "Held from an earlier pull · {date}". In the dry run, all 18 holds were offered again on the next pull, including the 10 dated before its 3-day overlap window.

## Things that go wrong, and what RealBud does

| What happens | What RealBud does |
|---|---|
| Bank feed not connected | Pull refuses: "Connect Redbark in Workspace → Connected apps." |
| Nothing new since last time | With no holds open: run ends "No new bank transactions". Nothing created. With holds open: the run opens a review of those holds instead. |
| Every row held or excluded | Stops before REI: nothing to import. |
| A row has no REI tenant in the directory | Nothing uploaded; asks for the tenant to be added. |
| Work browser not open | Opens the work browser on REI's sign-in page for the person, waits, then checks REI and carries on. Only a failed browser launch stops with "Connect your browser before Bud checks REI." |
| REI signed out | Opens REI's sign-in page in the work browser for the person, waits, then checks REI again. |
| Signed in to a different REI business | Stops: switch to the selected account, then continue. |
| Person presses Stop | The step in flight ends; nothing more happens in REI. If an upload was asked about, RealBud treats the result as unknown and checks REI before anything else. |
| Upload reply lost, file not in REI | Checks the register and pending imports; shows "nothing found"; uploads again only if the person chooses it. |
| Upload reply lost, file waiting in REI | Finds it pending; tells the person "Your earlier upload is waiting in REI. Process or delete it there." Never uploads twice. |
| REI's preview differs from the file | Blocks the handoff and the "I've processed it" report. The person closes the import. |
| Person unsure whether they processed it | Reads the register; confirms only what REI shows. |
| RealBud restarts mid-upload | On start, the unfinished upload becomes "outcome unknown" and REI is checked first. |
| Readback stopped or unreadable | "Covered to" does not move. Try again. |
| A held row older than the next pull window | Carried into every later review as "Held from an earlier pull · {date}" until a person imports or excludes it. |

## Decisions Kevin must make

1. Which bank account feeds which REI account and business.
2. REI's File Format to choose, after seeing one real preview of a tiny file.
3. The first period to import (the first pull covers only 2 days back).
4. The property directory: reference, aliases and REI tenant for each property.
5. Per row: import, hold or exclude. Policy for shared rent, part payments, overpayments, invoice payments, business transfers and unknown references.
6. Who signs in to REI each run and who presses Process Receipts.
7. Run time and the every-two-days anchor (paused until approved).

## Preflight checklist for the first live run

1. Owner's written go-ahead names the bank account, the REI account code and business, and the person doing the posting.
2. **Real REI runs read-only recipes only** (`open-session` and other "read" recipes) until the owner separately authorises an upload in writing. No `bulk-receipting-preview` (upload) before that. Process Receipts is always the person's.
3. RealBud data directory is the office's own, not a test or developer folder. Settings saved; the bank account shows masked.
4. The person is ready to sign in to REI in the work browser when RealBud opens it (it opens itself if closed).
5. Directory checked: every property that may be imported has an REI tenant.
6. Run one pull and review it fully. Download the REI import file and compare it with the bank by eye.
7. Read-only REI check: the business code in REI's top bar matches the settings. A different business stops the run before any upload.
8. Only after the upload is authorised: upload one small file, read the preview, and stop if anything differs. The person processes it in REI, then RealBud reads the register back.
9. Know the recovery: REI's pending-import screen has no live recipe yet, so after a lost reply RealBud cannot see a pending file. Check Receipts › Bulk receipting in REI by hand before any second upload.
10. Record the result as live evidence separately from these fictional notes.

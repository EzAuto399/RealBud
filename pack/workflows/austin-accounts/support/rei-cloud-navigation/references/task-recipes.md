# REI Cloud task recipes and traps — source reference

Austin Realty add-on pack source reference, not RealBud core and not part of
the published pack (see `../provenance.json`). It adds task recipes, traps and
coverage gaps to `../SKILL.md` and `../site-map.json`; where they overlap,
those two files and the RealBud portal fence win. Nothing here grants
authority. Placeholders only: `{reicid}`, `{business}`, `{id}`; no record
data, names, emails or account values.

Mapped UI version **26.0922.0**, observed 24 September 2026, revised from the
study notes of 25 September 2026.

## Evidence tiers

- `C`: a screen and its controls were observed read-only in the owner's
  signed-in session by a development browser session, not by RealBud or Hermes.
- `H`: the Hermes native browser read it. Only the top-level navigation labels
  and the rendered page's structural counts (61 links, 17 buttons, one form,
  two tabs, one switch) are `H`; the other screens are not Hermes-tested.
- `U`: the label was seen in navigation only; entry, controls and effect are
  unobserved.

A recipe is only as proven as its weakest tier. No live write, import, export,
report Preview, payment or send has been tested on REI. The study notes cite a
fictional simulation; it is not in this repository, so no recipe here claims a
simulation tier.

## Opening routine (every run)

1. Compare `URL.origin` with `https://app.reimasterapps.com.au` exactly, never
   as a prefix.
2. A sign-in page, MFA, "Sign In Cancelled" or an idle sign-in page: hand over.
   REI's sign-in journey expires when left idle (`docs/REI-LOGIN-TEST.md`); a
   fresh attempt belongs to the person.
3. Run the account-scope check in `../SKILL.md`.
4. Read the footer UI version. If it is not `26.0922.0`, continue read-only,
   flag `map-drift`, re-verify each control before use and report what differed.
5. Navigate by menu labels. The agency context travels in the query string, so
   a bare route can open with no business selected. Re-check the account marker
   after every load; if it is missing, return through the menu.

## Navigation index

Top level (`H`, `C`): Dashboard, Business, Owners, Pool of Owners, Contacts,
Rentals, Tenants, Suppliers, Communities, Sales, Listings, Agents, Booking
Calendar, Tasks, Receipts, Process, Reports, Settings, Tools, My Profile.

| Area | Default |
|---|---|
| Record lists (Owners, Rentals, Tenants, Suppliers, Contacts, Agents, Listings, Sales, Communities, Pool of Owners) | Read |
| Receipts (tenant receipts, bulk receipting) | Read; upload and preview only with an upload grant |
| Process (banking, deposits, charges, direct debit, disbursement, end of month, journals, payments, pending transactions, reallocations, reversals, tax invoices) | Human by default: every effect is financial |
| Reports | Read the parameter dialog; output rules in `../SKILL.md` |
| Settings | Hand over. Settings › Integrations may be read for study only; a listed integration is not API entitlement |
| Tools › Email activity | Read. Never My Profile |
| Dashboard, Business, Booking Calendar, Communities | `U`: study before use |

Screens seen (`C`) that `../site-map.json` does not list. Parent menus marked
"likely" were not observed; confirm on the first live run.

| Screen | Menu | Route | Controls and columns |
|---|---|---|---|
| Agents | Agents | `/customers/bookingagent` | Search, Status, Category, View (Default, Disbursement) |
| Contacts | Contacts | `/customers/contact` | Search, Status, Contact type; file as, company, portfolio |
| Listings | Listings | `/customers/listing` | Search, Status, Category, Listing status, View; type, price, zone, portfolio |
| Sales | Sales | `/customers/sales` | Search, Status, Category, Sales status, View; settlement, seller, buyer |
| Arrears | Tenants › Arrears (likely) | `/customers/arrears/` | Hide vacated tenants, From day, Property portfolio |
| Tenant receipts | Receipts › Tenant receipts (likely) | `/customers/transaction/tenantreceipt` | Selecting a tenant prepares a receipt form: stop there |
| Bulk receipting | Receipts › Bulk receipting (likely) | `/customers/importbanklink/index` | See `../SKILL.md` |
| Bank reconciliation | Process › Bank reconciliation (likely) | `/customers/reconciliation/bankreconciliation` | Never type into Statement balance or Reconciliation date |
| Integrations | Settings › Integrations (likely) | `/RequesterIntegrations` | Read only |

## Recipes

Each recipe starts with the opening routine. `stop_before` labels end Bud's
part: hand the page to the person, or ask the fence to approve that exact
instance.

- **find-record** (`C`), inputs `list`, `query`. Open the list, set Status to
  All (lists default to Active), type the query, wait for the table to settle,
  read it. One row: report its visible columns. None: report "no match with
  Status=All" and never widen the query silently. Several: list them and ask;
  never pick by name similarity.
- **arrears-review** (`C`), input `min_days`. Tenants › Arrears, set From day,
  Hide vacated tenants = Yes, read every page. Stop before Notice, Email, SMS
  or Send. Days in arrears is REI's figure; Bud never computes a legal clock
  or decides notice eligibility. Staff decide. The output is a Desk list with
  evidence, not a notice.
- **receipt-register** (`C`, dialog only), inputs `date_from`, `date_to`.
  Reports, type "Receipt Register" and press Return, open it, wait for the
  dialog, choose Date Range by its visible label, fill From Date and To Date.
  Two radios share the name `RangeOfPeriod`; From/To Period and Financial Year
  Ending stay disabled until their option is chosen. Reversal variants exist;
  use plain Receipt Register unless told. The study notes treat Preview as a
  read, but it is untested on REI: until a read-only study shows it only
  renders on screen, produce the register through the Reports rules in
  `../SKILL.md` (Export Only, with the fence's download approval).
- **bulk-receipting-preview** (`C`, prepare), inputs `bank_format`,
  `approved_file`, `expected_rows`, `expected_total`; needs an upload grant.
  Receipts › Bulk receipting, choose the File Format, load the approved file
  after the fence's approval, read every preview page. Stop before Process
  Receipts, Receipt All, Save, Post or Finalise. Success: preview rows and
  total equal the expected values and every unmatched row is listed. On a
  mismatch, hold and report; never re-upload to try again. If the page reloads
  or times out after upload, run receipt-register for today before any retry.
  Austin's `bank_format` is unconfirmed; ask before the first live run. An
  advertised format is not a verified parser.
- **post-import-readback** (`C`). Run receipt-register, then arrears-review.
  The register total must equal the batch total and no batch tenant may still
  be in arrears for the paid period. Any gap is a hold, not a retry.
- **bank-reconciliation-read** (`C`). Process › Bank reconciliation, read every
  page. Stop before Reconcile, Save, Tick or Finalise.
- **tasks-due** (`C`), inputs `date_from`, `date_to`. Tasks, Status Open, From
  and To, read every page with priority and assignee.
- **compliance-expiry** (`C`), input `view`. Rentals, choose the View (lease
  expiry, management expiry, smoke, pool, pest, water, rates/insurance,
  inspection, vacancy, key register), read every page. REI's date is data, not
  a verified legal deadline.
- **Study only** (`U`): supplier bill entry (Process › Payments or pending
  transactions, a Supplier or Owner record are candidates; bill entry stays
  human until proven), notice evidence (Bud assembles arrears, record and
  sent-mail links; generating and sending are staff actions) and payout
  allocation (Booking Calendar, Process › charges or journals).
- **unknown-screen-study**, input `top_label`. Open it, check the account, read
  the controls. Propose a screen entry (label, menu, route without query,
  controls, columns, date) for the person to approve. Store no rows or
  identifiers and press nothing outside the read-safe labels below.

## Readback: how Bud confirms an effect

| After (staff or approved) | Confirm with | Must match |
|---|---|---|
| Bulk receipting processed | receipt-register for today | Row count and total equal the approved batch |
| Single tenant receipt | find-record on Tenants: paid to, amount owing | Paid-to moved by the paid period |
| Arrears cleared | arrears-review | Tenant absent or days reduced |
| Reconciliation done | bank-reconciliation-read | No unreconciled rows for the period |

A click, upload, toast or HTTP 200 is not a readback.

## Labels

- Read-safe: Search, Status, Category, Zone, View, Type, Portfolio, Scheme,
  Archived, Receipt Register, Date Range, Current Period, Next, Previous,
  Close, Cancel.
- Consequential (fence approval of the exact instance, then readback):
  Process Receipts, Receipt All, Save, Post, Finalise, Reconcile, Tick,
  Disburse, End of Month, Pay, Payment, Transfer, Journal, Reverse, Reversal,
  Delete, Send, Email, SMS, Notice, Generate, Import, Approve, Submit.
- Hand over even under a broad grant: Settings (except reading Integrations),
  My Profile, Process › Disbursement, End of Month, Journals, Reversals,
  Direct Debit and Payments.

## Traps

| Trap | Handling |
|---|---|
| Reports search ignores a value set without input events and Return | Type real keystrokes; confirm the table filtered |
| Report dialog loads asynchronously | Wait for the dialog; choose radios by visible label |
| A bare route loses the agency context | Menu first; re-check the marker after every load |
| Loading, empty and no-match tables look alike | Wait until loading clears; report which state it was |
| Lists default to Active; pagination hides rows | Status All when searching; read every page before counting |
| Idle sign-in journey expires | Hand over; never retry sign-in for the person |
| Upload result unknown | Read back before any retry; never re-upload blind |

## Coverage gaps for the next read-only study

1. Confirm the parent menus marked "likely" above.
2. Bulk receipting: Austin's File Format, preview columns and buttons, using a
   fictional or sandbox file first.
3. Supplier bill entry point for the bills workflow.
4. Dashboard, Business, Booking Calendar and Communities controls.
5. Receipt Register Preview output columns.

Each workflow also needs: one record, empty and multiple results, pagination,
changed account, session expiry, Stop and takeover, uncertain completion and
retry prevention. Mutation cases use fictional data or an approved sandbox.

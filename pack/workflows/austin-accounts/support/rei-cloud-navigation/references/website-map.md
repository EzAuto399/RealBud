# REI Cloud website map v2 — task-first

Austin Realty add-on pack source reference, not RealBud core and not part of
the published pack (see `../provenance.json`). Where it overlaps `../SKILL.md`,
`../site-map.json` or the RealBud portal fence, those win: for example
`../SKILL.md` classes Settings › Integrations as Never, so the Integrations
study exception below does not apply to Bud. Nothing here grants authority.
Placeholders only; no record data, names, emails or account values.

Origin `https://app.reimasterapps.com.au` · mapped UI version **26.0922.0** ·
revised 25 September 2026. Routes omit query strings. No customer rows,
account identifiers, cookies or credentials appear here.

**Evidence tier** on every screen and recipe:
`C` Codex observed the screen/controls in the owner's session (24 Sep,
read-only; RealBud/Hermes did not perform those reads) ·
`H` Hermes native browser observed it ·
`S` passed the fictional simulation (`scripts/qa-rei-map-sim.mjs`). The mock
is built from this map, so `S` proves a recipe is executable and its traps are
handled — never that REI behaves this way ·
`U` label seen in navigation only; entry, controls and effect unobserved.
A recipe is only as proven as its weakest tier. No live write, import,
export, report Preview, payment or send has been tested on REI.

How to use: find the task under **Recipes**. If none fits, use
`unknown-screen-study`. Always run `open-session` first.

## 1. Opening routine (every run)

1. Confirm the exact origin `https://app.reimasterapps.com.au` (compare
   `URL.origin`, never a prefix).
2. Sign-in page, MFA, "Sign In Cancelled" or an idle sign-in page → hand
   over. Never type, paste or read credentials or codes. REI's sign-in
   journey expires when left idle; a fresh attempt belongs to the person.
3. Read both the URL `reicid` and visible business code. Compare each with
   the task's selected account before the first action, after every load,
   before an approved action and at the end. Either missing or changed →
   stop and hand over. Never switch business for the person.
4. Read the footer UI version. Not `26.0922.0` → continue read-only, flag
   `map-drift`, re-verify each control before use and report what differed.
5. Navigate by **menu labels**. The account context travels in the query
   string, so a bare route can open with no business selected. After any
   load, re-check both markers; if either is missing, stop and hand over.

## 2. Site-wide navigation index

Top level (`H` + `C`): Dashboard · Business · Owners · Pool of Owners ·
Contacts · Rentals · Tenants · Suppliers · Communities · Sales · Listings ·
Agents · Booking Calendar · Tasks · Receipts · Process · Reports · Settings ·
Tools · My Profile.

| Area | Children seen (`C` labels) | Bud default |
|---|---|---|
| Records: Owners, Rentals, Tenants, Suppliers, Contacts, Agents, Listings, Sales, Communities, Pool of Owners | Lists with Search, Status, Category, View | Read |
| Tasks | Views, Type, Status, Portfolio, Scheme, Archived, date range | Read |
| Receipts | Tenant receipts, Bulk receipting | Read; upload + preview with an upload grant; receipting is consequential |
| Process | Banking, deposits, charges/bulk charges, direct debit, disbursement, end of month, history, journals, payments/pending transactions, expense reallocations, reversals, tax invoices | **Human by default** — every effect is financial |
| Reports | Administration/arrears/inspections/leases, bonds, bookings, cashbooks, income/fees, owners, reconciliations, sales, suppliers, tenants, transaction registers | Read parameter modal; Export Only requires per-instance download approval |
| Settings | Automation, businesses, accounts/banks, portfolios, templates, integrations, portal settings, profiles, users | **Hand over** (auth, bank/EFT, users, security) — Integrations list is read-only study |
| Tools · My Profile | Email activity · communication and account settings | Read email activity only; never My Profile |
| Dashboard · Business · Booking Calendar · Communities | `U` | Study before use |

## 3. Screens

`menu` is the click path; `stop` lists buttons on that screen Bud never
presses (hand over or request per-instance approval); `menu_confirmed: false` means the parent is the
likely home but was not observed — confirm on the first live run.

```yaml
screens:
  - {id: agents, label: Agents, menu: [Agents], route: /customers/bookingagent, tier: C, controls: [Search, Status, Category, View], views: [Default, Disbursement], columns: [reference, description, contact]}
  - {id: rentals, label: Rentals, menu: [Rentals], route: /customers/property, tier: C, controls: [Search, Status, Category, Zone, View], columns: [owner, tenant, portfolio, rent, room/letting type], views: [inspection, lease expiry, management expiry, rates/insurance, pest, pool, smoke, water, vacancy, key register]}
  - {id: tenants, label: Tenants, menu: [Tenants], route: /customers/tenant, tier: C, controls: [Search, Status, Category, Zone, View], columns: [paid to, rent credit, days, amount owing, lease expiry, vacating]}
  - {id: owners, label: Owners, menu: [Owners], route: /customers/owner, tier: C, controls: [Search, Status, Category, Zone, View], columns: [properties, contact]}
  - {id: suppliers, label: Suppliers, menu: [Suppliers], route: /customers/supplier, tier: C, controls: [Search, Status, Category, View], columns: [reference, description, contact]}
  - {id: contacts, label: Contacts, menu: [Contacts], route: /customers/contact, tier: C, controls: [Search, Status, Contact type], columns: [file as, company, portfolio, contact]}
  - {id: tasks, label: Tasks, menu: [Tasks], route: /customers/task, tier: C, controls: [View, Type, Status, Portfolio, Scheme, Archived, From, To], columns: [due date, priority, assigned to, linked record]}
  - {id: listings, label: Listings, menu: [Listings], route: /customers/listing, tier: C, controls: [Search, Status, Category, Listing status, View], columns: [type, price, zone, portfolio, archive]}
  - {id: sales, label: Sales, menu: [Sales], route: /customers/sales, tier: C, controls: [Search, Status, Category, Sales status, View], columns: [settlement, seller, buyer]}
  - {id: arrears, label: Arrears, menu: [Tenants, Arrears], menu_confirmed: false, route: /customers/arrears/, tier: C, controls: [Day condition, From day, Property portfolio, Hide vacated tenants, Search], stop: [Notice, Email, SMS, Send], columns: [paid to, rent credit, days arrears, amount owing]}
  - {id: tenant-receipts, label: Tenant receipts, menu: [Receipts, Tenant receipts], menu_confirmed: false, route: /customers/transaction/tenantreceipt, tier: C, controls: [Search, Tenant], stop: [Save, Post, Submit], note: "Selecting a tenant prepares a receipt form; stop there."}
  - {id: bulk-receipting, label: Bulk receipting, menu: [Receipts, Bulk receipting], menu_confirmed: false, route: /customers/importbanklink/index, tier: C, controls: [File Format, Load File], stop: [Process Receipts, Receipt All, Save, Post, Finalise], formats_advertised: [ABA, BRF, ERP, TXN, common AU bank CSVs, Custom CSV, StrataPay, payment providers]}
  - {id: bank-reconciliation, label: Bank reconciliation, menu: [Process, Bank reconciliation], menu_confirmed: false, route: /customers/reconciliation/bankreconciliation, tier: C, controls: [Business, Statement balance, Reconciliation date, Search], stop: [Reconcile, Save, Tick, Finalise], columns: [debit, credit, reconciled]}
  - {id: reports, label: Reports, menu: [Reports], route: /report/reportlist, tier: C, controls: [Search], note: "A report opens an async parameter modal. Export Only is a file download needing the fence's approval; report generation was not tested live."}
  - {id: integrations, label: Integrations, menu: [Settings, Integrations], menu_confirmed: false, route: /RequesterIntegrations, tier: C, controls: [Search], tabs: [My Connections, Accounting, Reservations, Marketing, Forms, Payment Gateway, STR], listed: [Xero, RoomPriceGenie, Mobile Integration], note: "Read only. A listed integration is not API entitlement."}
```

## 4. Recipes

Step verbs — `nav` click menu labels in order · `check` origin / signin /
account (URL reicid + header business code) / version · `type` real keystrokes into a labelled field, then Tab to commit · `select`
option by visible label · `radio` by visible label · `click` a read-safe
control · `wait` until the table or modal has settled · `read` table or
controls with the filter state · `paginate` every page · `upload` the granted
file only · `download` only after the fence's file-download approval · `run`
another recipe · `stop_before` labels that end Bud's part:
hand the page to the person or request approval of that exact instance.

```yaml
recipe: open-session
kind: read
tier: [C, H, S]
steps:
  - check: origin
  - check: signin
  - check: account
  - check: version
  - nav: [Dashboard]
  - check: account
success: signed-in app, URL reicid and header business code both equal the selected account
```

```yaml
recipe: find-record
kind: read
tier: [C, S]
inputs: [list, query]
steps:
  - nav: ["{list}"]
  - check: account
  - wait: table
  - select: {field: Status, option: All}
  - type: {field: Search, value: "{query}"}
  - wait: table
  - read: table
success: exactly one matching row; report its visible columns
on_empty: report "no match with Status=All"; never widen the query silently
on_many: list candidates and ask; never pick by name similarity
note: "list is one of Tenants, Owners, Rentals, Suppliers, Contacts, Agents, Listings, Sales."
```

```yaml
recipe: arrears-review
workflow: Austin arrears review; morning priorities
kind: read
tier: [C, S]
inputs: [min_days]
steps:
  - nav: [Tenants, Arrears]
  - check: account
  - wait: table
  - type: {field: From day, value: "{min_days}"}
  - select: {field: Hide vacated tenants, option: "Yes"}
  - wait: table
  - read: table
  - paginate: true
stop_before: [Notice, Email, SMS, Send]
success: every arrears row across all pages, with the filter state recorded
note: >-
  Days in arrears is REI's figure. Bud never computes a legal clock or decides
  notice eligibility. Queensland RTA rules vary by tenancy type and action;
  staff verify current requirements before any notice. See
  https://www.rta.qld.gov.au/during-a-tenancy/rent-and-other-bills/non-payment-of-rent.
  Output is a Desk list with evidence, not a notice.
```

```yaml
recipe: receipt-register
workflow: readback after receipting; morning money
kind: prepare
tier: [C, S]
inputs: [date_from, date_to]
grant_needs: [download]
steps:
  - nav: [Reports]
  - check: account
  - type: {field: Search, value: Receipt Register}
  - wait: table
  - click: Receipt Register
  - wait: modal
  - radio: Date Range
  - type: {field: From Date, value: "{date_from}"}
  - type: {field: To Date, value: "{date_to}"}
  - select: {field: Output, option: Export Only}
  - download: {label: Export}
  - check: account
success: approved Export Only file scoped to the selected account and date range; report its rows and total as readback evidence
on_unknown: hold if approval, download, account scope or file contents are uncertain; never infer receipt posting or retry a money action
note: >-
  Two radios share the name RangeOfPeriod — choose by visible label. From/To
  Period and Financial Year Ending stay disabled until their option is
  chosen. Reversal variants exist; use plain Receipt Register unless told.
  Follow ../SKILL.md Reports: Export Only. The report's actual Export control,
  file format and contents remain unverified on REI; this recipe cannot claim
  live readback until an approved export is inspected.
```

```yaml
recipe: bulk-receipting-preview
workflow: Austin WF1 bank CSV → REI recognition
kind: prepare
tier: [C, S]
inputs: [bank_format, approved_file, expected_rows, expected_total]
grant_needs: [upload]
steps:
  - nav: [Receipts, Bulk receipting]
  - check: account
  - select: {field: File Format, option: "{bank_format}"}
  - upload: {field: Load File, file: "{approved_file}"}
  - wait: table
  - read: table
  - paginate: true
stop_before: [Process Receipts, Receipt All, Save, Post, Finalise]
success: preview rows == expected_rows AND preview total == expected_total AND every unmatched row listed
on_mismatch: hold; report the differing rows; never re-upload to "try again"
on_unknown: >-
  Page reloaded or timed out after upload → request approval for an Export
  Only receipt-register readback for today. If unavailable, hold. Never retry
  an upload or money action from an uncertain result.
note: >-
  bank_format is unconfirmed with Austin — ask before the first live run. An
  advertised format is not a verified parser. Upload ≠ matched ≠ receipted.
```

```yaml
recipe: post-import-readback
workflow: Austin WF1 close-out
kind: prepare
tier: [C, S]
inputs: [date_from, date_to, batch_total, batch_tenants]
grant_needs: [download]
steps:
  - run: receipt-register
  - run: arrears-review
success: >-
  Only after an approved, scoped Export Only register file is inspected:
  register total == batch_total and no batch tenant still listed in arrears
  for the paid period. Any gap or unavailable export is a hold, not a retry.
on_unknown: hold; request an approved Export Only readback before any close-out claim
```

```yaml
recipe: bank-reconciliation-read
kind: read
tier: [C, S]
steps:
  - nav: [Process, Bank reconciliation]
  - check: account
  - wait: table
  - read: table
  - paginate: true
stop_before: [Reconcile, Save, Tick, Finalise]
success: unreconciled debits/credits listed; nothing ticked, typed or saved
note: Never type into Statement balance or Reconciliation date.
```

```yaml
recipe: tasks-due
workflow: morning priorities
kind: read
tier: [C, S]
inputs: [date_from, date_to]
steps:
  - nav: [Tasks]
  - check: account
  - select: {field: Status, option: Open}
  - type: {field: From, value: "{date_from}"}
  - type: {field: To, value: "{date_to}"}
  - wait: table
  - read: table
  - paginate: true
success: open REI tasks due in range, with priority and assignee
```

```yaml
recipe: compliance-expiry
workflow: morning priorities; lease and compliance watch
kind: read
tier: [C, S]
inputs: [view]
steps:
  - nav: [Rentals]
  - check: account
  - select: {field: View, option: "{view}"}
  - wait: table
  - read: table
  - paginate: true
success: rows with the view's date column
note: >-
  view is one of lease expiry, management expiry, smoke, pool, pest, water,
  rates/insurance, inspection, vacancy, key register. REI's date is data,
  not a verified legal deadline.
```

```yaml
recipe: bill-entry-study
workflow: Austin WF2 expected bills → REI
kind: study
tier: [U]
note: >-
  Supplier-invoice entry point unobserved. Candidates: Process › Payments /
  pending transactions, a Supplier record, an Owner record. Run
  unknown-screen-study read-only. Bill entry stays human until proven.
```

```yaml
recipe: notice-evidence
workflow: Austin arrears notice evidence
kind: study
tier: [U]
note: >-
  REI generates notices (vendor lists REI Forms Live / Real Works). Bud
  assembles evidence only: arrears-review + find-record + sent-mail link.
  Generating and sending are staff actions.
```

```yaml
recipe: payout-allocation-study
workflow: Austin Airbnb payout allocation
kind: study
tier: [U]
note: Booking Calendar and Process › charges / journals unobserved. Study only.
```

```yaml
recipe: unknown-screen-study
kind: study
tier: [S]
inputs: [top_label]
steps:
  - nav: ["{top_label}"]
  - check: account
  - wait: table
  - read: controls
success: >-
  A proposed screen entry {label, menu, route without query, controls,
  columns, tier: H, date} for the person to approve into this map. No rows
  or identifiers stored; nothing outside read_safe_labels clicked.
```

## 5. Readback — how Bud proves an effect happened

| After this (staff or approved) | Confirm with | Must match |
|---|---|---|
| Bulk receipting processed | Approved `receipt-register` Export Only file for today | File's account, period, row count and total match approved batch |
| Single tenant receipt | `find-record` Tenants: paid to, amount owing | Paid-to moved by the paid period |
| Arrears cleared | `arrears-review` | Tenant absent or days reduced |
| Bill entered (future) | Supplier/Owner record + supplier report | Exactly one entry |
| Reconciliation done | `bank-reconciliation-read` | No unreconciled rows for the period |

A click, upload, toast or HTTP 200 is **not** a readback.

## 6. Labels Bud may and may not press

```yaml
read_safe_labels: [Search, Status, Category, Zone, View, Type, Portfolio, Scheme, Archived, Receipt Register, Date Range, Current Period, Next, Previous, Close, Cancel]
consequential_labels: [Process Receipts, Receipt All, Save, Post, Finalise, Reconcile, Tick, Disburse, End of Month, Pay, Payment, Transfer, Journal, Reverse, Reversal, Delete, Send, Email, SMS, Notice, Generate, Import, Approve, Submit]
forbidden_areas: [Settings, My Profile, Process › Disbursement, Process › End of Month, Process › Journals, Process › Reversals, Process › Direct Debit, Process › Payments]
```

Consequential = only with the person's approval of that exact instance
(recipient, amount, rows), then readback. Forbidden = hand over even under a
broad grant. Read-only study of Settings › Integrations is the one exception.

## 7. Traps

| Trap | Handle |
|---|---|
| Reports search ignores a value assigned without input events + Return (`C`) | Real typing; confirm the table actually filtered |
| Receipt Register modal loads async; shared radio name (`C`) | `wait: modal`; radio by visible label |
| Bare route loses account context | Menu first; re-check URL reicid and header business code after every load |
| Loading, empty and no-match tables look alike | `wait: table` until the loading state clears; report which state |
| Lists default to Active; pagination hides rows (`C`) | Status=All when searching; `paginate` before counting |
| Sign-in journey expires when idle (`docs/REI-LOGIN-TEST.md`) | Hand over; never retry sign-in for the person |
| UI version drift | `map-drift`, read-only until controls re-verified |
| Upload result unknown | Request approved Export Only readback; hold if unavailable; never re-upload blind |
| Typed filter not committed: the next click fires `change`, re-renders and resets to page 1 (`S`) | Tab after typing; each Next must show a different page, else stop — never count a repeated page |

## 8. Coverage gaps — next live study (read-only)

1. Confirm parent menus for Arrears, Tenant receipts, Bulk receipting, Bank
   reconciliation and Integrations.
2. Bulk receipting: Austin's File Format choice; preview columns and buttons
   (fictional or sandbox file first).
3. Supplier bill entry point (Austin WF2).
4. Dashboard, Business, Booking Calendar and Communities controls.
5. Receipt Register Export Only control, file format, account/period scope and columns with a separately approved download.

Per workflow also test: one record, empty and multiple results, pagination,
changed account, session expiry, Stop/takeover, uncertain completion and
retry prevention. Mutation cases use fictional data or an approved sandbox.
Update the screen entry, raise its tier and link the dated receipt.

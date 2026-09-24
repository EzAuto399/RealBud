# REI Cloud: site map for browser work

Read-only map made on 24 September 2026 in the owner's signed-in REI Cloud session (Claude built-in browser). Only page loads and DOM reads were used. Nothing was saved, submitted, sent, processed, exported or changed. No dialog was confirmed and no toggle was touched.

This map records **structure only**. It holds no names, addresses, emails, amounts or account numbers. Two placeholders stand for account values:
- `{reicid}`: the database ID that REI puts on every URL.
- `{business}`: the business code shown in the header.

It does not establish that a RealBud browser task has run against REI, and it grants no authority to act.

Version observed: **REI Cloud v26.0922.0**. Queensland business; the footer shows the subscription countdown.

## 1. How the app works

- **Hosts:**
  - App: `https://app.reimasterapps.com.au`.
  - Sign-in: Azure AD B2C at `reimasterapps.b2clogin.com` (policy `b2c_1_signin`). A signed-out session redirects there ("Sign in with your email address"). Treat that page as a **sign-in pause** and hand it to the person; Bud never types credentials.
- **Account scope:**
  - Every app URL carries `?reicid={reicid}`. The header shows the business selector (`{business}` button) and the user's initials menu.
  - Check both before and after every task, and **stop if either changes**. That is the account-scope check the portal fence needs.
- **Page frame:**
  - The left sidebar is `nav`/`aside`. Page content is `.page-content`.
  - Record pages use a tab strip (`ul` of `li` tabs) plus a toolbar (Add Tasks, Reports, Add Document, Return) and Save/Cancel, which are disabled until a field changes.
- **Grids:**
  - Lists are data grids with a `Search:` box, Status (Active / Inactive / All), Category, Zones and View selectors, and an **Action** bulk menu.
  - Tenant rows carry stable attributes: `data-tenant-id`, `data-owner-id` and `data-property-id`. **Target records by these IDs, not by screen position.**
  - Grid pages also carry `data-email`. Never copy it into logs.
- **Overlays that can cover the page:**
  - Reminder modal: "Remind Again", "Dismiss All", snooze 5 minutes to 4 weeks.
  - Hidden dialogs preloaded on many pages: New Email, New SMS, Letter, Form (REI Forms Live), Template List, Cloud Documents.
  - Close the reminder with its **×** or "Close". Never choose "Dismiss All" or "Remind All Again", because both change reminder state.
- **Concurrency:** some screens show an edit lock, for example Pending Transactions shows "Editing By `<user>`". Treat a lock held by someone else as **stop and tell the person**.
- **Record pages are live edit forms.** Owner, Rental and Tenant details open in edit mode (the page title reads "Update Owner", for example). The **Active** toggle and every field are live. Browsing must never type into them.

## 2. Navigation (every sidebar route)

Every route below is `…?reicid={reicid}`.

| Group | Pages → route |
|---|---|
| Dashboard | `/customers/dashboard`. Rentals and Bookings tabs. Tiles for items due, insurances, inspections, properties by type, leases, tasks due today, bonds and deposits, rents received, rental status and arrears buckets. Tile links go to `/customers/property/dashboardlink?ViewMode=N&status=1` and `/customers/tenant/dashboardlink?ViewMode=N`. |
| Business | `/customers/businessdetail` |
| Owners | `/customers/owner` (list), `/customers/owner/details?ownerid={id}` |
| Pool of Owners | `/customers/pooling` |
| Contacts | `/customers/contact` |
| Rentals | `/customers/property` (list), `/customers/property/details?propertyId={id}` |
| Tenants | `/customers/tenant` (list), `/customers/tenant/contact?tenantId={id}`, `/customers/tenant/account?tenantId={id}` (ledger), `/Customers/Tenant/create` |
| Suppliers | `/customers/supplier` |
| Communities | `/customers/communities`, plus `/owner`, `/property`, `/committee`, `/manager`, `/tasks`, `/keys`, `/settings` |
| Sales, Listings, Agents | `/customers/sales`, `/customers/listing`, `/customers/bookingagent` |
| Booking Calendar | `/booking/calendar`, `/Booking/Housekeeping`, `/Booking/Search/rei_{ArrivingToday, DepartingToday, InHouse, UnactionedOnline, DepositsDueToday, ArrivingTomorrow, DepartingTomorrow, OverdueArrivals, OverdueDepartures, DepositsOverdue}` |
| Tasks | `/customers/task`. Filters: `taskFilterView`, `taskFilterType`, `taskFilterStatus` |
| **Receipts** | Bulk Receipting `/customers/importbanklink/index`. Tenant `/customers/transaction/tenantreceipt`. Owner `…/ownerreceipt`. Bond Refund `…/bondrefundreceipt`. Sale `…/salereceipt`. Supplier `…/supplierreceipt`. |
| **Process** | Arrears `/customers/arrears/`. Banking `/customers/transaction/banking`. Bank Reconciliation `/customers/reconciliation/bankreconciliation`. Change Deposits `…/transaction/deposits`. Charges `…/transaction/charge`. Charges - Batch `/customers/batchpayments/bulkcharge`. Direct Debit Tenants `…/transaction/directdebittenants`. Disbursement: End Of Month `/customers/disbursement/eom`, Interim `…/interimdisbursement`, History `…/history`. Journals `…/transaction/journal`. Payments `…/transaction/payment`. Payments - Batch `/customers/batchpayments/index`. Pending Transactions `…/transaction/pendingtransactions`. Pre-Disbursement `…/transaction/disbursementcheck`. Re-allocate Expenses `…/transaction/reallocateexpenses`. Reversals: `…/reversepayment`, `…/reversereceipt`. Tax Invoices: `/customers/taxinvoice/normal`, `…/recurring`. |
| Reports | `/report/reportlist` (see §4) |
| Settings | Automation `/automation`, Account Code, Admin Settings `/AdminSettings/UserAdmin`, Banks, Businesses, Charge Batch, Journal Templates, Booking/Reservation provider pages (`/customers/provider/*`), Card Types, Communities (schemes, BC managers, committees), Direct Debit Group, Disbursement Groups, Document Categories, EFT Setup (payments, direct debits), EFT Terminals, General Config (general, defaults, statements, receipts, reservations, email, key number, task, sales settings), Integrations `/RequesterIntegrations`, Maintenance Types, Portfolios (property, sale, contact), Portal Settings, Profiles `/role`, Property/Room Types, Rental Inclusions, SMS Settings, Tax invoice defaults and recurring batches, Templates (`/customers/communication/{emailtemplates, smstemplates, lettertemplates, mailmerge, inspection}`), Users (`/user`, details, portfolios, two-factor auth, password control, login history), User Defined Fields, Web Advertising Sites, Zone & Region |
| Tools | Email Activity `/customers/communication/emailactivity`, Office 365 Email Activity `/user/usergraphemailqdetail` |
| My Profile | Email, SMS, Signature, Reminders, Window Accounts, Change Management (`CheckForInactiveRecordsWithBalances`), Others |
| Account menu | My Account `/Customers/ReiAccount/Index`, Terms, Reset Password, **Log Out** `/account/logout`. Never follow Log Out or Reset Password. |

## 3. Pages that matter for the three Austin workflows

### Bank → CSV → REI (Bulk Receipting)

- **Page:** `/customers/importbanklink/index`, headed "Import Bank Link File".
- **Controls:** a **File Format** select (`BankLinkFormat`), a hidden file input `bank-link-file` (accepts `.txt,.pay,.brf,.erp,.txn,.aba,.csv`) and a **Load File** button.
- **Formats:** `(*.ABA)`, `(*.BRF)`, `(*.ERP)`, `(*.TXN)`, ANZ, Bank of Queensland, BankWest, Bendigo, Commonwealth, Commonwealth - New, Corum, HANDeRENT Secure Payments, IP Payments, NAB Easy Rent, NAB Reverse Format, NAB, Paycorp - RentPay, Rental Rewards, StrataPay, Suncorp, Westpac, **Custom (csv)**.
- **After loading:** the page reuses the Tenant Receipt dialog family: Rent To The Day, bond amount, rent with letting fee, cheques, card/EFTPOS, direct credit, and **Pending Transactions** with Process Pending / Delete Pending.
- **What Bud may do:** choose the matching format and load a reviewed file (a consequential upload that needs approval), then **read** the proposed matches. **Process / Save / Delete Pending need per-instance approval.**
- **What RealBud should hand over:** a CSV in a format this list already accepts. Austin's bank flow ends at a reviewed CSV today. Upload alone is not proof of import.

### Tenant receipting and arrears

- **Tenant Receipts:** `/customers/transaction/tenantreceipt`.
  - List heading: "Funds Received From Tenant".
  - Columns: Reference, Name, B-Pay D/Cr Ref, Paid To, Rent Credit, Days +/-, Amt. Owing, Days Adj., Property.
  - Selecting a row opens the receipt form: receipt number/from/date, tender Cash / Cheque / Card / Direct Credit, rent amount, credit, rebate, pay amount, bond fields, letting fee, and **Save**.
- **Arrears:** `/customers/arrears/`.
  - Filters: Days arrears are [Greater Than …] n Day(s), From Date, Property Portfolio, Hide Vacated Tenants, then **Load**.
  - Columns: Reference, Surname(s), Rent, Per, Paid To, Rent Credit, Days Arrears, Amt. Owing, Days Adj., Vacating.
  - Read-only apart from the communication dialogs.
- **Tenants list:** the View select has ready-made read views: Arrears (All / 1–6 / 7–13 / 14–20 / 21–27 / 28+ / 7+ days), Bond Summary, Bonds In Trust, Lease Information, Leases Expiring 30/60/90, Rent Reviews Due 30, Vacating, In Advance, Current and more.
- **Tenant account (ledger):** `/customers/tenant/account?tenantId={id}`.
  - Filters: Period, Transaction, Financial Year, Pending.
  - Columns: Date, Reference, Description, Account, Amount Excl., Tax, Amount Incl.
  - Tabs: Details, Rental Information, Additional Information, Utilities, Other, Commercial, Account, Invoices, Additional Payments, Tasks / Notes, Document Mgmt, Portal.

### Email → bills → calendar (supplier bills, charges, tasks)

- **Payments:** `/customers/transaction/payment`, "Trust Account Payment".
  - Fields: Cheque / Electronic, Date, Payee, Draw Funds From, EFT account name, Bank (list of Australian banks), BSB, Account No., EFT Reference, File Name.
  - Summary columns: Description / Exclusive / Tax / Inclusive. Then **Save**.
  - **Consequential. Never save without per-instance approval.**
- **Charges:** `/customers/transaction/charge`. Levy Charge Against, Date, Reference No., Recipient of Charge Proceeds, Selected Properties, then Save.
- **Tax invoices:** `/customers/taxinvoice/normal`.
  - Filters: Filter, Date Filter Type, Financial Period, Financial Year End, Archived.
  - Columns: Invoice No., Date, Description, Reference, Amount Incl., Amount Paid, Amount Due, Contra, Period, Year.
  - **New Invoice** and Action.
- **Tasks:** `/customers/task`. The calendar and reminder source.
  - Views: All Tasks, Tasks Due Today, Today's Reminders, Overdue Reminders, All Reminders.
  - Types: Auto Emails, Auto SMS, Conversations, Enquiry, E-Mails, Faxes, Housekeeping, Inspections, Letters, Linked Doc's, Maintenance, Meetings, Notes, Open Home, Other, Phone Calls, SMS, Sticky Notes, To Do List, Viewing.
  - Statuses: Not Started, In Progress, Complete, Follow Up, Deferred, Incomplete, Failed, Done, Deactivated.
  - Date filters: Due, End, Reminder, Completed, Created, Last Modified.
  - Columns: Date Due, Type, Subject, Booking, Owner, Property, Tenant, Supplier, Contact, Sales, Listing, Priority, Status, Completed, Scheduled, Assigned To, Start Date, End Date.
- **Rental record** (`/customers/property/details`):
  - Tabs: Details, Commissions, Deductions, Account, Tasks / Notes, Document Mgmt, Ownership Change, Setup, Booking Charges, Other Settings, Upload To Web, BPAY Details.
  - Hidden task dialogs: Maintenance, Work Orders, Quotation Request, Inspection, Housekeeping, Phone Call, Meeting, Note, To Do.
  - Work order fields: Approved Supplier, Work Order No, Approved Amount.
  - Charge fields: Pay Charge To, Amount, Expense Code, Include GST, Description (Printed On Owners Statement).
- **Supplier Receipts:** "Funds To Be Received To Supplier". **Suppliers** list columns: Reference, Description, Phone, Mobile, Email, Address, Category.

### Owners, statements and month end (read; never run without approval)

- **Owner record:**
  - Tabs: Details, Disbursement, Account, Invoices, Other, Tasks / Notes, Document Mgmt, Portal.
  - Sections: Owner Details, Contact Details, Address Details, Automatic Deduction, Other Details, Office 365 Integration, Properties Linked.
- **Bank Reconciliation:**
  - Controls: Select an Account (trust account), Statement Balance, Reconciled date, **Update**, Reports, Options.
  - "3 - Way summary": Reconciled Balance, Cashbook Balance, Money Held In Trust, and a **BALANCED / NOT BALANCED** badge.
  - Columns: Date, Reference, Type, Description, Debit, Credit, Recon.
  - Reading the badge and totals is a safe first read-only task.
- **Banking:** "Banking Close". Cash/Cheque, Card or all receipts, Deposit Date, EFT Terminals, totals, then **Finalise** (irreversible).
- **End Of Month disbursement:** a wizard that starts with the same Banking Close step (**Next**, **Finalise**). **Never Next or Finalise without explicit approval.**

## 4. Reports (`/report/reportlist`)

Each report opens a parameter dialog. The options include **Output: Export Only / Email Only / Export & Email**. **Computer use must always choose "Export Only".** The email options send statements to owners.

- Admin: Inspection - Summary, Lease Expiry, Log Report, Maintenance, Rental Arrears, Rental Review.
- Bond: Bond Balance (and Historical), Bond Ledger (and EOM).
- Bookings: Arrival, Booking Information, Booking Register, Bookings By Agent, Daily Flash, Departure, Deposit Due, Funds Held in Trust, Holiday Guest List, In House, Length of Stay, Marketing by Agent/Region/Source, Occupancy by Day/Month/Owner/Room Type.
- Business and Cashbook: Business Ledger (EOM), Cashbook Monthly Consolidated/Detailed (EOM).
- Deposit: Balance (Historical), Ledger (EOM).
- Income: Breakdown Full/Portfolio/Summary, Summary Month By Month.
- Management: Comparative Fee, Fee Report, Properties Lost Gained, **Rent Roll**, Rent Roll Valuation, Residential Commission, Statistics.
- Owner: Balance (Historical), Financial Year Detailed/Pooled/Summary, Ledger (EOM, All), Listing, Owner-Property-Tenant Connection, **Owner Statement** (and Pooled).
- Reconciliation: **3 Way Balance** (Historical), Adjustments, Unbanked Receipts, Unpresented Deposits/Payments.
- Sale, Supplier (Balance, Ledger, Statement) and Tenant (**Tenant Ledger**, EOM, All, Listing).
- Transactions: Charges, Deposit Breakdown, Journals, Payment/Receipt Registers (Breakdown, EOM, Range, Reversal), Reprint BPAY/EFT/Receipt.
- Shared filters: financial period (Period 1 July … Period 12 June) and year, disbursement run number, account codes, owner selection, reference ranges, arrears conditions, and log report users and record types.

## 5. Action risk classes for the portal fence

| Class | Examples | Rule |
|---|---|---|
| Read | Navigating to any route above, list filters, `Search:`, View selects, record tabs, report parameter dialogs, Bank Reconciliation totals | Allowed inside a task grant, with an account-scope check |
| Local UI | Closing a reminder with ×, sorting, pagination | Allowed; never "Dismiss All" or "Remind All Again" |
| Export / download | Report with **Export Only**, Tenant Ledger | File-download approval; verify the file matches the requested scope |
| Upload | Bulk Receipting Load File | Per-instance approval showing file name, hash and format |
| **Money or ledger** | Save on Tenant/Owner/Supplier/Sale receipt; Process or Delete Pending; Payments and Batch Payments Save; Charges Save; Journals; Reversals; Banking **Finalise**; EOM/Interim disbursement **Next/Finalise**; Bank Reconciliation **Update**; New/Recurring Tax Invoice | Explicit per-instance approval with the actual amount and recipient; never retry blind; read back the register or ledger afterwards |
| **Send** | Action menu Email/SMS/Letter/Form/Mail Merge to Owner or Tenant; Invite to Portal; report **Email Only / Export & Email**; New Email/SMS dialogs | Explicit per-instance approval with the actual recipients and content |
| **Record change** | Any Save on a detail form; the Active toggle; Apply Automation; Re-Assign Portfolios/Template/Housekeeper; Ownership Change; Upload To Web; Settings pages | Out of scope unless a task names it; approval required |
| Never | Log Out, Reset Password, Admin Settings, Users/2FA/Password Control, EFT Setup, Banks, Integrations connect | Refuse |

## 6. Suggested first qualified tasks (read-only)

1. Read the 3-way reconciliation status: BALANCED or NOT BALANCED, plus the three balances.
2. List tenants in arrears 7+ days: Tenants → View "Arrears - 7+ Days", then read the grid by `data-tenant-id`.
3. Read tasks due today and overdue reminders: Tasks → View.
4. Export a Rent Roll or Tenant Ledger with **Export Only**. This needs file-download approval.
5. Rehearse Bulk Receipting format selection only. Stop before Load File until a reviewed CSV and approval exist.

Machine-readable version: `outputs/rei-cloud-map-2026-09-24/site-map.json`.

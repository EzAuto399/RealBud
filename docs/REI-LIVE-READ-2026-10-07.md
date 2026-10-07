# Live REI read-only run by Bud: 2026-10-07

**Not established:** no packaged or installed build was used, no W1 upload or readback ran, nothing was submitted or edited, and there is no customer acceptance. This report records labels and layout only. It holds no row values, names or amounts.

- **Owner authority (chat, 2026-10-07):** "anything live READ and CLICK just no SUBMIT or editing the live data".
- **Build:** origin/main 54392ddf. Scratch `REALBUD_DATA_DIR`, a scratch work-browser profile, the person signed in. REI v26.0922.0, account AUS06.
- **How each recipe ran:** `POST /api/browser/tasks/recipe`, then Start, then the runner and broker. The grant allowed read, navigate and click (plus fill and keys where a recipe types). Pay, sign, send, notice, delete and account change were refused.

## Recipe results
| Recipe | Outcome | Live cause |
|---|---|---|
| open-session | PASS | — |
| arrears-review | field-missing "From day" | The days box `#arrears_from_day` has no accessible name. The condition is an unnamed select `#arrears_day_con`. "Hide vacated" is a checkbox `#hide_vacated_tenant`, not a select. The only named control is combobox "Show entries". |
| tasks-due | field-missing "Status" | TaskView, TaskType, TaskStatus, TaskDateFilterType, TaskFromDate and TaskToDate all have no accessible name. TaskStatus has no "Open" option. |
| compliance-expiry | field-missing "View" | Rentals is a Syncfusion grid: textbox "Search" and button "Filters", no View select. |
| find-record (Tenants) | table-did-not-settle | Same Syncfusion grid; cell names carry " is template cell column header <Col>". |
| bank-reconciliation-read | broker-refused: "page changed during the read" | Editable form: `#BusinessId`, `#BusinessDetail_StatementBalance`, `#BusinessDetail_ReconciliationDate`. |
| tenant-list | refused from Ask | Not `kind: read` on main. |

## Receipt Register export (done by the developer in the work browser, read and click only)
- **Path:** Reports → "Receipt Register" (search box "Search:"). A modal opens with "Report Period" radios: Current Period / Current Financial Year To Date / Specific Period / Range of Periods / Date Range. The period pickers are bootstrap-select. There is no Output select, and the only button is "Preview".
- **Viewer:** Preview opens `/report/PostedReport` in a **new tab** (Telerik viewer). Exporting is a "dropdownbutton" with menuitems: Acrobat (PDF) file, CSV (comma delimited), Excel Worksheet, PowerPoint, RTF, TIFF and Word.
- **Downloads** landed in the user's `~/Downloads`. `Browser.setDownloadBehavior` was not honoured for the viewer's export.
- **CSV layout:** 16 columns; headers are Telerik ids, not labels.
  - `Reference1` = Date (dd/mm/yyyy)
  - `Surname1` = Rec No (integer, unique)
  - `InTrust1` = `Authority1` = amount (equal in every row)
  - `textBox6` = Received From (payer name text)
  - The remaining columns repeat report totals or captions ("Total:", "Reversal Reason:").
  - There is **no tenant reference, no status, and no business code or period line**.
- **Excel layout:** labelled. There are 10 frozen header rows: business name, "Cashbook Receipts", "For The Period - <Month Year>". The columns are Date, Rec No, Received From, Cash, Cheque, Card, Direct Credit, Total. There is no business code, reference or status here either.
- **Sample:** the September period has 403 receipts. The real files stay in the session scratchpad only, at mode 0600, are never committed, and are deleted after the fixtures are made.

## Consequences
1. Read recipes must not depend on unnamed controls. Read the default grid with "Show entries" = All plus paginate, then filter inside RealBud. The diff is agreed with PR #69's owner and will land after #69.
2. W1 readback (`registerRows` in `server/w1-rei-reconciliation.ts`) expects Date/Reference/Amount headers and business/from/to scope lines. Against the real export it reads 0 rows. Scope and matching have to be redesigned:
   - match on date + amount + Received From, using the tenant directory names;
   - take the account from the page marker checked before export, and/or the business name in the Excel export;
   - read pending imports from Pending Transactions, not from a status column.
3. The `receipt-register` recipe needs the live flow: modal, Preview, new tab, export menu. The new-tab handling lives in runner and browser files owned by PR #69.

# REI Cloud — what was seen, read-only (2 Oct 2026)

Evidence: owner-authorised read-only browse of live REI Cloud in a signed-in browser. Nothing was selected, loaded, processed, deleted or downloaded. Office identifiers and record totals are omitted; no record data is copied here.

## Bulk Receipting (`/customers/importbanklink/index`)
- Page title "Import Bank Link File". One control row: **File Format** dropdown and a **Load File** button. Pressing Load File uploads into REI and creates a pending import — that is a write in REI and needs the person's approval.
- File Format options, exactly as REI lists them: `(*.ABA) File`, `(*.BRF) File`, `(*.ERP) File`, `(*.TXN) File`, `ANZ(csv file)`, `Bank of Queensland(csv file)`, `BankWest(csv file)`, `Bendigo(csv file)`, `Commonwealth(csv file)`, `Commonwealth - New(csv file)`, `Corum`, `HANDeRENT Secure Payments`, `IP Payments`, `NAB Easy Rent`, `NAB Reverse Format(csv file)`, `NAB(csv file)`, `Paycorp - RentPay`, `Rental Rewards`, `StrataPay`, `Suncorp(csv file)`, `Westpac(csv file)`, `Custom(csv file)`.
- REI supports bank-specific export layouts natively. Confirm the intended File Format with the workflow owner before preparing an import; the fictional portal’s `Custom(csv file)` contract was a guess.
- With nothing loaded, the page shows no grid below the control row. A pending (loaded, not processed) import is expected to appear here; none existed at the time.

## Pending Transactions (`/customers/transaction/pendingtransactions`)
- This is pending **payments/levies/invoices** (owner/business, description, amount, sufficient funds) with **Process Pending / Delete Pending** and a **Process** button. It is not the bulk-receipting pending import. Bud must never press Process or Delete here.

## Lists and paging
- Tenants list: a data grid with a **Reference** column (tenant reference used for receipt matching), filters (Status, Category, Zones, View) and a footer like "N records · 0 row(s) selected". It scrolls; there are no numbered pages. The page loads empty first ("No records to display") and fills a moment later, so wait for the record count before reading.

## Reports
- The Receipt Register and Receipt Register Range are in Reports; opening one shows a parameters popup (`#reportParameterOwnerList_popup`) before any output. Running a report and downloading it is an export (approval).

## Addresses after sign-in
- In this session the address bar showed plain paths (for example `/customers/importbanklink/index`) with **no `reicid` parameter**. The business is identified by its code in the top bar. Account-scope checks should read the top-bar business code, not rely on `reicid` being present.

## Proposed changes (for the workflow owner to decide)
1. Confirm W1’s intended File Format with the workflow owner; validate it with one tiny real preview only after the owner authorises an upload.
2. Site map: business scope from the top-bar code when `reicid` is absent; tenant grid "N records" footer as the load-complete marker; mark Pending Transactions Process/Delete as `never` for Bud.

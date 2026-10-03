# Sherry's workflows: build plan and requirements

Updated 2 October 2026 after the owner's scope clarification. This document supersedes its earlier, broader maintenance proposal. Planning and source review only; no customer account setup, live workflow execution, application-code change or activation was performed.

The first maintenance workflow is Gmail collection, invoice history/calendar, matching and notification to Sherry. Inspection planning uses the designated Zapier connection to Auston's Property Inspect account, preferably through MCP. Reuse RealBud's existing capabilities and add only the missing workflow logic.

## W4: Gmail maintenance history and alerts

**Flow:** permitted Gmail messages and invoice attachments → check sender against the approved REI supplier-email directory → extract invoice facts → collect into a saved history/calendar → check for multiple distinct invoices from the same supplier for the same property in a month → notify Sherry with separately labelled findings and source documents.

### Owner clarification: two different reasons to flag

The supplied REI Cloud Suppliers screenshot identifies the intended supplier-directory source. It shows a 60-record list with reference, description and email columns; some email addresses and rows are clipped. It is not a complete import. Obtain the full authorized supplier list/export, retaining supplier references and complete approved email addresses, before enabling sender checks. REI supplier-directory setup is relevant; ongoing REI invoice-history retrieval is not required for this Gmail workflow.

| Flag | Trigger | Purpose |
|---|---|---|
| Sender needs verification | An invoice sender is absent from the approved supplier email addresses, or its supplier mapping is unresolved | Check a new supplier, changed sending address or unknown sender; do not label it fraudulent solely because it is unlisted |
| Multiple invoices for this property | At least two distinct invoices from the same supplier for the same property in the agreed monthly window | Show dates, amounts and descriptions so Sherry can judge similar work versus unrelated repairs |

These checks are independent: an approved sender can still trigger the multiple-invoice flag, and an unlisted sender still needs review when there is only one invoice. If an unlisted address cannot yet be mapped to a supplier, retain the sender flag and leave supplier-level comparison unresolved. The repeat check continues to use the same-property scope from the earlier discussion; invoices across different properties are not grouped into a repeat-repair alert.

“Twice a month” supplies the proposed threshold of two distinct invoices. Calendar month versus rolling 30 days, and invoice-date versus received-date counting, are not yet settled. The earlier three-month lookback may supply comparison history; it is not silently retained as an additional alert trigger. Suggested date basis is invoice date, subject to confirmation.

Match approved addresses and explicitly accepted aliases to a supplier reference. Display-name similarity or a shared email domain alone does not approve a sender. A listed address establishes a directory match, not the validity of the charge. For forwarded mail, distinguish the forwarder from the evidenced original sender; missing original-sender evidence remains unresolved.

The owner clarified that this is enough. Sherry assesses whether the charges concern similar work or legitimate unrelated repairs. Kevin keeps his existing billing responsibility. REI invoice-history retrieval, a separate maintenance case-management system and an automatic decision handoff to Kevin are not prerequisites for this version. They can be considered later if actual use shows a need.

### Smallest useful implementation

1. **Collect Gmail evidence.** Reuse the existing Composio/Gmail connection and attachment-reading path, with the permitted mailbox/folders. Collect enough history to cover the chosen monthly rule, then new or changed items. The earlier three-month backfill can provide context. Show partial history when Gmail or attachments do not cover the whole period.
2. **Extract and save facts.** Retain property/address, supplier reference, sender email and directory-match status, invoice number, invoice date, received date, amount, work description and links to the original message/document. Reuse bill/evidence records where appropriate. Confirm ambiguous property or supplier matches instead of guessing from the sender address alone.
3. **Show calendar/history entries.** Project saved invoice records into the selected calendar or history view, linking back to source evidence. Suggested default: place an invoice on its invoice date; an evidenced due date can be shown separately. This date choice is proposed. The owner has requested a calendar, but has not yet named RealBud's calendar versus an external calendar.
4. **Find related charges.** Count distinct invoices for the same property and supplier in the agreed monthly window, even when invoice numbers or descriptions differ. Show descriptions side by side and label similar/unrelated work as a suggestion for Sherry. Copies and reminders for one invoice do not increment the count. Conflicting revisions stay unresolved instead of becoming separate charges.
5. **Notify Sherry once per new finding.** Label the reason as sender verification or multiple invoices, with both when applicable. Give her the property, supplier, dates, amounts, comparison and source links. Save notified evidence versions; unchanged rescans create no new calendar entry or alert. A third distinct invoice updates the existing monthly finding. A simple seen/dismissed state is sufficient initially. Select the notification destination before activation.

### Inputs we actually need

- Authorized Gmail account/folders, enough invoice history and the complete approved REI supplier-email directory.
- A small sample of repeat repairs, unrelated repairs and forwarded copies.
- Calendar destination and which invoice date to display.
- Sherry's notification destination and scan frequency.
- Monthly window/date basis and a way to resolve new addresses, supplier aliases and ambiguous property matches.

Missing email history limits the comparison; it does not establish that no earlier invoice exists. Show that coverage limitation. The REI supplier directory provides the sender reference; REI invoice-history access remains optional.

### Reusable foundation and remaining work

RealBud already has mail/attachment acquisition, reviewed bill facts, evidence references, persistent workflow records and calendar-related primitives. Current [bill facts](../shared/source-bills.ts) include property ID, vendor label and invoice number/version. Consistent supplier matching still needs a reviewed mapping where labels differ.

The existing [maintenance rehearsal pack](../pack/workflows/austin-maintenance-rehearsal/README.md) supplies useful fictional comparison cases. It does not itself acquire Gmail, maintain calendar entries or send notifications. Extend the normal collection/history path with matching, calendar projection and notification tracking; do not make the more elaborate department rehearsal a prerequisite.

**Acceptance:** a known address matches its supplier; an unlisted address creates a sender-verification finding; two distinct monthly invoices for one supplier/property create a separately labelled comparison even when the sender is approved; invoices for different properties remain separate; unrelated work remains distinguishable; a forwarded copy or reminder does not count twice; rerunning creates no duplicate entry/alert; partial evidence remains visible. Sherry receives the findings through the chosen channel.

## W5: inspections through Zapier MCP

**Flow:** existing property/inspection data + Sherry's working rules → draft six-month area/day/time plan → reviewed Property Inspect actions through Zapier MCP → calendar and notice outcomes → use actual changes/completion for the next plan.

MCP should substantially reduce connector work by exposing existing Property Inspect actions. It does not supply the office's scheduling rules, historical data or a verified RealBud connection automatically.

### Verified public capabilities

[Zapier's Property Inspect directory](https://zapier.com/apps/property-inspect/integrations) lists creation, inspection readback, date changes, cancellation, assignee changes and inspection lifecycle events. Creation and cancellation expose notification-related options. Verify the exact tools exposed by the configured MCP server and their behavior in Auston's account; public listing alone is not account acceptance.

[Zapier MCP](https://help.zapier.com/hc/en-us/articles/48308034391821-What-is-Zapier-MCP) lets an MCP client discover and call connected-app actions. It requires Streamable HTTP support. Connecting it in Codex for setup does not automatically connect the RealBud application that will run the workflow.

[Next Gen Zaps](https://help.zapier.com/hc/en-us/articles/48391476448141-Get-started-with-Next-Gen-Zaps) additionally lets an MCP client build and deploy persistent Zapier workflows. As checked on 2 October 2026, it is early access by request on Professional, Team and Enterprise plans. Confirm account access before depending on MCP-based workflow authoring. Ordinary MCP action execution and hosted workflow authoring are separate capabilities.

### Setup and build steps

1. Connect Auston's Property Inspect account in the designated Zapier account. Configure the needed MCP actions and bind the MCP connection to the runtime that will execute them.
2. Read a sample property and inspection; map property IDs, inspector, dates and contacts. Obtain a baseline of existing bookings/history so future event triggers are not mistaken for complete historical coverage.
3. Encode Sherry's working days, area groups, appointment lengths, travel allowance and daily capacity. Confirm whether the six-month cycle follows the planned or completed inspection date.
4. Prepare a small editable schedule using existing RealBud jobs and views. Keep accepted appointments and manual changes stable across reruns.
5. Run one controlled booking and one date change through the selected actions, retaining external booking IDs and reading results back. Verify calendar behavior and whether an operation sends email/SMS as part of booking.
6. Configure recurring execution and completion/update handling. Prefer RealBud's existing scheduler calling MCP when that meets office availability needs. If unattended hosted execution is needed, a Property Inspect-only Zap can own that trigger. Assign one system to each recurring booking operation to prevent duplicates.

If Next Gen Zaps is enabled, authoring the hosted portion through MCP is an available setup route. Otherwise, configure the required classic Zap in Zapier or let RealBud call the MCP actions on its schedule. A custom Property Inspect API connector is not the starting assumption.

### Remaining inputs and checks

- Zapier/Property Inspect accounts, permissions, enabled MCP tools and any Next Gen access.
- Existing inspection dates/bookings and property IDs.
- Working days, inspectors, duration, capacity, area groups and access constraints.
- Calendar destination and existing synchronization; notice recipients, rules and authorized sender.
- Runtime availability, portfolio size and operation volume for scheduling and cost estimates.

The [generic connected-app policy](../shared/app-tool-policy.ts) currently blocks cancellation. A new MCP execution path must preserve the applicable action controls. Automated cancellation needs a scoped policy design; the first pilot can reconcile cancellation performed by an authorized person in Property Inspect.

**Acceptance:** draft a representative group, create a reviewed booking, move that same booking, verify calendar/notice outcomes and repeat without duplication. Confirm how completion or a missed visit affects the next cycle. MCP makes the connection easier; these checks establish whether the workflow works for Sherry.

## Delivery order

| Step | Useful result |
|---|---|
| Gmail maintenance pilot | Invoice history/calendar, comparison and one notification to Sherry |
| Property Inspect MCP qualification | Correct account, readable sample and verified required actions |
| Inspection planning pilot | Editable area/day/time plan using Sherry's rules |
| Operational inspection workflow | Reviewed bookings, changes, calendar/notices and recurring execution |

The implementation is primarily workflow configuration plus focused matching, saved identities and result handling. The first release does not need the broader maintenance case-management and cross-department handoff proposed in the previous version of this document.

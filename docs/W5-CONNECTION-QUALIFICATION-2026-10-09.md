# W5 connection qualification — 9 October 2026

**Owner-confirmed gate:** the designated Auston Zapier / Property Inspect connection still needs setup. This was confirmed during system resolution on 9 October. Local inspection planning and acceptance remain available; neither means an external booking, calendar entry or tenant notice.

## Prepare the designated connection

1. Open [Zapier MCP](https://mcp.zapier.com/) in the designated account. Connect Auston's own Property Inspect account. Keep credentials in that service's UI.
2. Choose a fixed, limited tool set for inspection work. Save the actual account identity, tool identifiers and input/output schemas as a private qualification receipt; do not substitute names from a public catalogue for authenticated tool identifiers.
3. Inspect each supported operation below without executing a write. Record whether it sends notices or changes a calendar, and whether it returns an external inspection ID and a readable outcome.
4. Map the verified property/inspector identities to the local planner. Review the resulting exact booking contract before dispatch is enabled.
5. Run one separately authorized fictional/safe acceptance case through create, readback, change and uncertain-result recovery. A lost reply must reconcile by the same external identity before a repeat is considered.

| Operation | Qualification evidence required |
|---|---|
| Create booking | Actual exposed tool schema, property/inspector/type/date fields, returned ID, notice side effects and provider idempotence/search behavior |
| Read booking | Account-bound lookup by exact ID, property identity, conduct date/time and state; no match cannot imply non-execution after a lost reply |
| Change booking | Exact existing ID, supported date/assignee fields, stale-state guard, readback and any renewed notice/calendar effects |
| Cancel booking | Actual exposed cancellation capability, external state/readback and notice behavior; a cancellation event is not a callable cancel action |
| Completion and calendar/notice | Returned completion state or qualified event, source/event identity, duplicate-event handling and separate evidence for any calendar or notice effect |

## Public capability evidence

The [official Property Inspect catalogue](https://zapier.com/apps/property-inspect/integrations) lists inspection lookup, date/assignee updates and inspection lifecycle events. Its examples include inspection creation. This establishes public product capability only; it does not establish which tools the designated account exposes or their exact contracts. Cancellation dispatch and notice semantics remain unqualified.

[Zapier's MCP quickstart](https://docs.zapier.com/mcp/quickstart) explains selecting actions and connecting the app account. [Zapier's MCP documentation](https://help.zapier.com/hc/en-us/articles/48308034391821-What-is-Zapier-MCP) supports choosing a fixed tool set. [Usage documentation](https://help.zapier.com/hc/en-us/articles/45645738385805-How-Zapier-MCP-usage-works) states that successful app calls consume tasks. No app call, booking, connection change or paid action was made during this source repair.

## Adapter admission

The implementation must admit a qualified connection only at the authoritative server boundary. It must bind the current private workspace, office, staff role, connection generation, exact external account and tool schema digest. A browser field or model argument cannot grant any of these. Original approved payloads, durable intent/external identity, held unknown outcomes and provider readback remain separate records. Connection/rule changes invalidate the approval and require fresh review.

Do not enable a generic write tool, API-request tool or code-execution tool as a shortcut around the inspection contract. If a needed action is absent, record that capability as missing and keep that action held. The current owner direction remains Zapier for Property Inspect; direct API integration is not silently substituted.

Acceptance receipts must distinguish source tests, fictional adapter simulation, authenticated schema/account qualification, real provider readback and installed staff acceptance. An HTTP success, saved draft or catalogue entry is not booking completion.

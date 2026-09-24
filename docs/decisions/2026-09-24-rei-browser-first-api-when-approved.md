# REI browser first; API preferred when approved

Status: owner direction accepted on 24 September 2026. REI access is now reported working; the owner identified this Mac for the first browser test. The existing Windows VM task keeps platform/live-device QA ownership.

## Sequence

1. Set up and qualify RealBud's browser connection on the Mac, using the person's selected signed-in REI session. Confirm the intended agency/account, tab, task scope, Stop/takeover and sign-in recovery before a real workflow.
2. Rehearse bounded REI workflows through that connection. Start with read/navigation and a named permitted record or report; use an explicitly selected file and target for any export/upload/preview. Browser access is useful independently of API approval and must not wait indefinitely for it.
3. Request official API access in parallel. Obtain written approval, documentation, permission scopes, sandbox availability, pricing and operational limits. A working REI login does not establish API entitlement. The prepared request is unsent.
4. If access is granted and supports the required workflow, prefer the API for structured reads/sync and permitted writes. Keep the browser for unsupported operations and user handoff. Prove each operation against real documentation and the approved account before choosing it.
5. Keep one task/approval/result record across adapters. An unknown result from an API or browser write must be reconciled before retry or switching adapters; never repeat a possible financial effect through the other path. REI remains the authoritative financial record.

This supersedes the blanket REI deferral in the 23 September core-first sequencing for browser qualification and API access preparation. It does not waive core, installed-device, tenant, data or financial-action controls. The [browser task authority decision](2026-09-23-browser-task-authority.md) still applies: complete authorised tasks through the broker; credentials stay with the person; consequential actions require approval of the actual instance and recorded readback. The first read-only check is a test stage, not a permanent product capability limit.

No API credentials, vendor pricing agreement, live import/posting, payment, customer communication or acceptance is established by this decision. Current proof: [REI browser checkpoint](../REI-BROWSER-FIRST-2026-09-24.md).

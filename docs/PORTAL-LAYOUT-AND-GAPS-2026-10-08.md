# Portal layout repairs and remaining product gaps

**8 October 2026 — source and local UI review.** This checkpoint does not establish a deployed website, live authentication, production API availability, an applied customer workflow or customer acceptance. Browser checks use actual source components with fictional identity/data adapters. The [FDE role decision](decisions/2026-10-08-fde-console-and-customer-workspace.md) remains the target; its unimplemented controls must not be presented as working.

## Layout repairs

The supplied Support screenshot showed a real stylesheet fault: account section headings inherited marketing headings up to 58px. Tailwind reset the old lists' default spacing and markers, making the billing and account instructions read as a wall of text. The company-identity code textarea also had no matching control styles.

The authenticated Support page now starts with one email-support action, practical setup links and billing links. Account changes, payment/supplier details and portal/privacy limits are available in three native keyboard-operable disclosures. Existing supplier, ABN/GST, payment, invoice, export/removal and access facts are retained. The signed-in organization appears in the shell. Email actions open the user's mail application; no message is sent automatically and no support-ticket backend is implied.

Shared account styles now define a compact heading hierarchy without altering marketing headings. Textareas have visible borders, surfaces, padding and focus styles in both themes. Forms shrink within their containers, account cards respond to content width, and computer/connection headers wrap before the action collides with the text. Forms are separated from their introductory divider. The navigation groups Support under **Account & help**; the header Support link opens the help page.

Pack loading now has an explicit retry. A confirmed upload/removal remains distinct from a later transient list failure, and retrying the list does not replay the change. Previously loaded rows are labeled stale during transient failure; definitive access/scope failures hide them. A lost or malformed mutation reply stays unconfirmed and asks the user to inspect the current list.

Commercial terms now offer one recovery action for each failure. Previously verified terms remain visible only through transient read failures and cannot be accepted until a successful refresh. Access loss, changed scope, invalid replies and nonretryable setup failures clear old terms. The stable live status announces initial failures without duplicating the visible notice. The existing server authority and acceptance contracts are unchanged.

## Include next, in this order

| Priority | Required behaviour | Completion evidence |
| --- | --- | --- |
| 1. One scoped FDE customer workspace | Select an organization once and see its computers, current setup, blockers and permitted configuration actions. Preserve a draft when access expires. Clear customer-specific drafts, cache and Bud context when switching organizations. Routine changes inside the onboarding managed grant do not need repeated prompts. | Server tests reject cross-organization requests and revoked/insufficient grants. The operator can return to the intended customer/target and resume a valid draft. The existing office directory and AI-access forms alone do not meet this requirement. |
| 2. A complete workflow change lifecycle | Prepare a draft, inspect the change, publish to a specific target, observe installation, run a trial and activate according to policy. Display Published, Installed, Tested and Active separately with the exact revision. Include failure, pause and eligible previous-version recovery. | Revision-bound computer reports confirm each stage. An offline computer remains pending and the last working revision remains identifiable. Keep the working owner upload path until the FDE replacement exists. |
| 3. One useful next action for the customer | Home prioritizes unfinished setup, an assigned decision or a useful result. Show who must act and a direct route. Persist progress across the website/desktop handoff; explain whether the account, computer, source or workflow is waiting. | A new customer can finish the first workflow without guessing between Computers, Workspace access and Company identity. Existing customers are not repeatedly sent through setup. Readiness comes from observed state, not merely an issued invitation or uploaded pack. |
| 4. A simpler role-aware customer workspace | Deliver the agreed Home, Work, Workflows, Computer & help and Account destinations as their replacement capabilities become available. Customer owners manage allowed team/account choices; members see their own work. Engineering controls belong to the FDE surface. Bud uses the same grants as manual controls and prepares a reviewable change before consequential execution. | Owner/member and direct-API tests enforce the distinction. Customers can use permitted work and request a change; an FDE's read-only customer preview does not make real customer sessions read-only. Existing deep links remain useful. |
| 5. Consistent help and recovery | Each failed panel offers one clear next action. Keep useful data with a stale label, distinguish a confirmed change from a failed refresh, and avoid telling a user to repeat an operation whose outcome is unknown. A later support case/change-request flow should carry organization, computer, workflow revision and progress without copying private task contents by default. | UI checks cover initial load failure, retry, stale data, confirmed mutation plus failed refresh, unknown mutation outcome and eventual recovery. Today's email help remains usable until an actual case backend exists. |

The core missing backend connections are unchanged: organization-scoped managed/support authority, atomic operator-targeted publication, and revision-bound installation/trial/activation/result reports. More dashboard panels do not close these gaps. The interface must expose current evidence and a useful next step while those capabilities are implemented.

## Verification

Evidence is under `outputs/portal-layout-2026-10-08/`:

| Check | Final result | Evidence |
| --- | --- | --- |
| Source browser layout and recovery | **57 passed / 0 failed / 0 skipped**; no browser/hydration errors or off-origin requests | `source-layout-results.json`, `source-layout-notes.md`, `source-layout-qa.mjs` |
| Pack and commercial-terms contracts | **27 passed / 0 failed / 0 skipped** | `pack-terms-contract-tests.log` |
| Whole website TypeScript | Exit 0 | `website-typecheck.log` |
| Targeted ESLint; both repositories' diff whitespace checks | Exit 0 | `targeted-eslint.log`; local command results |

The browser suite renders actual page/components and current CSS at 1650, 1024, 768, 390 and 320 px. It covers Support, Computers, Company identity, Workspace connections, Workflow packs, the admin shell and commercial terms. Admin children are fictional; the terms fixture is not the entire billing route. It checks responsive bounds, heading hierarchy, code fields, keyboard disclosures/navigation, dark controls and recovery. Pack write acknowledgments are synthetic loopback replies; acceptance is never sent. All 50 final source hashes match the reviewed files.

The earlier expanded run recorded **55 passed / 2 failed / 0 skipped** because the harness incorrectly applied a 16px typing-font assertion to checkboxes. The preserved receipt is `source-layout-before-checkbox-harness-fix.json`; the final run excludes checkbox/radio fonts from that assertion while still checking their bounds. No product change was made for those two harness failures.

The local QA server is stopped. No PostgreSQL suite, production Next build, deployment, live account mutation, email or computer command was performed. Production CSS bundling order and live integrations remain unverified by this source-rendered fixture.

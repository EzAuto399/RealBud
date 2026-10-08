# Claude Code and Codex UX implementation

**8 October 2026 — source and local verification only.** This checkpoint does not establish a deployed website, a live customer operation, a verified computer workflow or customer acceptance. It continues the [portal layout fixes](PORTAL-LAYOUT-AND-GAPS-2026-10-08.md) and [FDE/customer role decision](decisions/2026-10-08-fde-console-and-customer-workspace.md).

## Collaboration and ownership

The owner explicitly requested working with Claude Code. The local Claude Code CLI was used, not a simulated Claude persona. Its review and implementation session is `011d4a3b-0881-4953-b1ea-50c33b77c3d3`. Source prompts and original results are retained in `outputs/claude-ux-collaboration-2026-10-08/`.

The existing **Intelligent UI design consultation** Claude session was addressed through Claude Code's `SendMessage`. The initial tool replies confirmed inbox delivery, but Claude later reported that the superseding message was held at the cross-session permission boundary. No read or ownership response was received. The active Claude Code CLI session performed the Home implementation; the initial packet required an ownership reply before editing. No private mailbox files or permission settings were changed, no hold was bypassed, and no collaboration response from the idle session is claimed.

| Owner | Bounded work |
| --- | --- |
| Active Claude Code session | Independent admin UX critique; customer Home implementation in `website/app/account/page.tsx` and new `home-*` local files |
| Codex implementation agent | Admin organization directory/selection and existing per-organization AI/apps controls under `website/app/admin/offices/` |
| Codex recovery agent | Exercised `OfficeForm` network-recovery behaviour in `website/app/admin/admin-forms.tsx` |
| Codex integration and QA | Cross-review, actual-source browser checks, API contract checks, scope verification and this evidence record |

## Interaction decisions

Managing existing organizations comes before creating another one. An operator searches the loaded directory, selects a named organization with its canonical ID, and adjusts its existing service controls in a focused detail area. Selection cannot transfer an unsaved setting or pending result to another organization. Confirmed changes update both the selected detail and directory summary.

Claude's independent review identified that an unread AI setting previously preselected the default A$200 cap. A blind save could therefore replace an intentionally disabled setting. Unknown current state now requires an explicit operator choice. Blocked, unread, not set up and deliberately Off are separate states; apps provisioning never claims a connected customer account or working workflow.

Customer Home leads with one evidence-based action and preserves access to work, computers, help and billing. Missing/unreadable computer data is not displayed as zero computers, and a fresh worker report is not called workflow readiness. The company-scoped computer read runs alongside the existing usage read. Owners and readers receive different first-computer guidance. All-stale computers lead to Computers; current computers with disabled AI lead to Support; exhausted or unknown budget leads to billing. Only a known available budget and a current worker report suggest Work requests. Older sign-ins receive the supported sign-in action before sending work. The website and desktop remain separate authorities.

Manual provisioning now releases its pending state after a lost response or timeout, keeps the entered fields and describes the outcome as unconfirmed. A retry is never sent automatically. A successful response must contain `ok: true`, and the next action is refreshing the organization directory and reviewing that organization's service access. AI/apps controls also reject malformed success and error envelopes instead of claiming success or crashing React. Dormant margin-form code is outside this exercised-path fix.

The organization directory has a bounded scroll area at narrow widths, keyboard selection moves focus into the selected detail, and the repeated organization heading was removed from the embedded AI form. The admin navigation now calls this screen Organizations. App setup buttons distinguish the first setup, an unavailable status check, and a retry. Invitations remain mounted after the workspace; manual billing provisioning is under Advanced setup.

## Implementation locations

| Surface | Website source |
| --- | --- |
| Admin directory and controls | `app/admin/offices/page.tsx`, `office-workspace.tsx`, `office-workspace.module.css`, `office-workspace-model.ts`, `ai-access-form.tsx`, `apps-project-status.tsx` |
| Admin navigation and manual recovery | `app/admin/admin-shell.tsx`, `app/admin/admin-forms.tsx` |
| Customer Home | `app/account/page.tsx`, `home-next-step.ts`, `home-page.module.css` |
| Guidance regressions | `app/account/home-next-step.test.mjs`, `app/admin/offices/office-workspace-model.test.mjs` |
| Existing runtime QA expectations | `scripts/qa-account-runtime-auth.mjs`: Overview/Next step and current Support copy; syntax checked only in this pass |

The actual Claude Code patch and subsequent independent Codex corrections are both retained. Claude's source-only `claude-home-report.md` revision 2 predates the budget-aware correction; this checkpoint and final source/browser receipts describe the integrated result. The legacy sign-in requirement was confirmed in `requirePortalPerson` → `gatePortalPerson` and its focused test, and `/sign-in` was checked to render a new sign-in form rather than redirecting the legacy session back to Home.

## Verification and remaining limits

All artifact paths below are under `outputs/claude-ux-collaboration-2026-10-08/`. Counts are passed / failed / environment-gated skipped.

| Verification | Final result | Receipt |
| --- | --- | --- |
| Actual admin components, SSR and hydration with fictional transport | **36 / 0 / 0** | `qa-admin-browser-results.json` |
| Actual customer AccountPage, shell and guidance, SSR and hydration with fictional data | **23 / 0 / 0** | `qa-home-browser-results.json` |
| Operator/person/invite/AI/apps/admin-desk contracts | **50 / 0 / 0** | `qa-admin-contracts.tap` |
| Usage/computer read contracts | **34 / 0 / 0** | `qa-home-contracts.tap` |
| New Home and organization view-model tests | **17 / 0 / 0** | `final-view-model-tests.tap` |
| Whole website TypeScript, targeted ESLint, diff check and runtime QA script syntax | **All exit 0** | `final-static-validation.json`, `final-typecheck.log`, `final-eslint.log` |

The 59 final browser checks observed zero browser/hydration errors and zero external requests. Admin coverage includes name/ID search, duplicate organization names, draft isolation, write locks, confirmed result propagation, partial computer application, unknown outcome readback, missing directory/apps data, malformed replies, provisioning recovery and keyboard focus. Home covers owner/reader setup, stale/current computers, malformed/failed reads, legacy sign-in, disabled/exhausted/unknown/inconsistent and tiny-positive budgets. Layout was checked at 320, 390, 768 and 1650 pixels with dark-mode cases. QA servers and browsers exited after the runs.

Root independently matched all **13 admin** and **31 Home** recorded source hashes to current files in `final-source-hash-verification.json` (the two sets overlap; they are not 44 unique files). Desktop and mobile screenshots were visually inspected. Useful views are `qa-directory-selected-1650.png`, `qa-directory-keyboard-selected-390.png`, `qa-home-current-1650.png` and `qa-home-disabled-390.png`.

Original failures are preserved: the original provisioning network failure left Saving disabled; initial admin fixture locators selected multiple badges; the new keyboard viewport assertion initially sampled during the site's existing smooth scroll. The final assertion waits for actual viewport intersection without overriding product CSS. Intermediate 30-, 34- and 35-pass receipts are historical, not additional tests to add to the final count. The earlier 21-test contract run is a subset of the final 50.

These browser fixtures import source components and use real CSS/fonts, but adapt Next Link/Image/navigation and auth/service boundaries. Refresh records intent and re-renders the same mounted component with a new source snapshot. It does not establish Next RSC refresh behavior, production CSS ordering, live permissions, gateway/database integration or invite delivery. The full production runtime-auth script was not run because it requires a build and database setup. No package or PostgreSQL suite was run.

This slice uses existing admin capabilities and leaves auth/API authority unchanged. It does not implement organization-scoped workflow engineering, targeted atomic pack publication, device-confirmed installation/trial/activation or a support-case backend. Those remain the ordered gaps in the prior review. No deployment, live customer change, commit, push or customer acceptance is part of this pass.

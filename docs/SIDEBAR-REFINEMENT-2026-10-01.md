# Compact sidebar and saved views — 1 October 2026

This checkpoint does **not** establish an installed-app update or live account/workflow acceptance. It records implemented UI source, a successful web build, and browser checks against a disposable fictional workspace. The installed RealBud application remains unchanged by this UI work.

The large persistent workday card is now a compact **Workspace** control. Its popover presents the current guide, book/Bud status, errors and next scheduled job. Connections is a quiet icon-and-label row immediately above it at the bottom of the sidebar; it opens the existing connection sheet without leaving unfinished work. The closed footer measures 113 px high in the desktop browser check.

Manage saved views now has a concise header, a clear Add action, visible Customize desk, compact rows with Open/Edit, and secondary actions under an accessible disclosure. Existing names, filters, ordering, recovery tokens and revision checks remain authoritative. Removing a low row in a long list now brings its confirmation into view and moves focus to it; cancellation restores the row control, and successful deletion falls back to the page heading when the opener disappears.

## Evidence

- [Final browser receipt](../outputs/sidebar-refinement-2026-10-01/run-05/receipt.json): **11 passed / 0 failed / 0 skipped**, zero renderer errors and no external browser requests. Actual source React UI and isolated Node service; no model execution, login, account authorization, REI or messaging. The service exited and its temporary workspace was removed.
- Covered native popover focus, Escape/close/outside dismissal, Connections retaining the current route and an unsent Ask draft, four main shortcuts, saved-view edit/hide/show/reorder, stale revision holds, 390 px navigation/layout and 680 px compact rail. A 12-view, 680×600 case verifies off-screen confirmation recovery, cancellation and successful removal.
- [Focused tests](../outputs/sidebar-refinement-2026-10-01/focused-tests-final.log): **80 passed / 0 failed / 0 skipped** across six files. The agent's 51-test subset overlaps this total. Renderer TypeScript and diff checks pass.
- [Final web build](../outputs/sidebar-refinement-2026-10-01/build-final.log): passed in 3.01 seconds to isolated `ui-final` output. Existing large-chunk advisory remains. Shared `dist` was not replaced.
- Independent source review identified the long-list confirmation issue; the fix is exercised in the final browser run. Earlier runs remain recorded: missing bundled headless Chrome cache; an incorrect outside-click focus expectation; and a successful interaction run rejected by its source-hash guard during a final label adjustment. None is counted as a fully passed run. Run 04 passed the earlier ten checks before the confirmation fix; run 05 is final.

Previews: [desktop](../outputs/sidebar-refinement-2026-10-01/run-05/desktop-closed.png), [status popover](../outputs/sidebar-refinement-2026-10-01/run-05/desktop-open.png), [390 px](../outputs/sidebar-refinement-2026-10-01/run-05/mobile-390.png), [short-window confirmation](../outputs/sidebar-refinement-2026-10-01/run-05/short-680-confirmation.png).

## Source and installation boundary

UI changes are confined to `Sidebar.tsx`, `WorkdayPulse.tsx`, `WorkspaceTabsManager.tsx` and the new `sidebar-utilities.css`. There are new manager tests and a disposable browser runner. The older saved-view QA script received menu-opening selector steps and a syntax check; its entire historical suite was not rerun.

No server, account or permission behavior was changed. Desktop/narrow Chromium are verified; native packaged behavior on other operating systems is not. The existing phone layout still exposes the four primary doors and Views; its footer is hidden as before.

A clean-HEAD renderer build was compared with the installed renderer and did not match its existing Ask and other UI changes. Building the shared checkout also includes unrelated pending UI work, including screens whose corresponding server changes are not installed. Therefore neither renderer was substituted into the running application. An installed update requires a reconciled, reviewed source baseline and matching service package; the current compiled preview is source/local evidence only. Preserve the installed Gmail/paging fixes documented in [Auston's mock checkpoint](AUSTON-MOCK-WORKFLOWS-2026-10-01.md).

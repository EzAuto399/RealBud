# UX audit capture — 2026-10-09

Worktree: `/Users/yo-da/projects/rb-audit` (detached at origin/main `6852499b`, RealBud 0.1.46). UI built to `.ui-build` (scratch). Fictional data only; every run used a disposable temp data dir, never ~/.realbud.
Evidence tier: **local tests** (built React UI in headless Chrome against a disposable local service). Not a packaged build or installed device.

**PNG count:** 108 total · empty 63 · seeded 45

State key: `empty` = brand-new office (qa-clean-walkthrough; extra.mjs after `POST /api/desk/live` replaced the sample with an empty office book). `seeded` = fictional sample book (qa-desktop-shell, extra.mjs) or seeded fictional Austin office (qa-austin-showcase).

## Script results

| Script | State | Result | First error |
|---|---|---|---|
| qa-clean-walkthrough | empty | FAIL (12/13 steps; retried once, same failure) | FAIL 6. Schedule: disable and enable a loop — locator.waitFor: Timeout 15000ms exceeded waiting for getByRole('alert') with text "needs current source checks and reviewed settings" |
| qa-austin-day-one | seeded | PASS (10/10 steps) | —  (service-level rehearsal: writes receipt.json only, no screenshots by design) |
| qa-austin-showcase | seeded | PASS (8/8 steps) | — |
| qa-desktop-shell | seeded | PASS (11/11 checks) | — |
| .audit/extra.mjs (scratch) | both | PASS with 2 misses | work-one-turn (both states): composer disabled — "Connect this computer to your office first"; captured as *-work-one-turn-composer-disabled.png |

Logs: `logs/`. Each script folder also holds its own `receipt.json`. Retry output for qa-clean-walkthrough is kept outside this folder at `/Users/yo-da/projects/rb-audit/.audit/retry/`.

## Gaps

1. **Work with one turn, extra.mjs (both states):** the unlinked sample/empty office blocks the composer ("Connect this computer to your office first"), so no turn could be sent; the blocked composer is captured instead. A real turn is covered by `qa-clean-walkthrough/20-work-answer-1280.png` / `21-work-answer-1024.png` (empty, linked office, scripted answer) and `qa-austin-showcase/10-w4-chat-card.png` (seeded).
2. **qa-clean-walkthrough step 6 (Schedule disable/enable):** failed twice on the expected setup alert; `23-step6-failure.png` shows the screen at failure. Steps 7–13 still ran and captured.
3. **qa-austin-day-one:** no screenshots by design (service-level rehearsal incl. REI morning refresh); only `receipt.json`.
4. Extra captures are 1440×900 only; narrower widths (1100/900/390, Windows title bar) come from qa-desktop-shell, 1280/1024 from qa-clean-walkthrough.

## Screenshots

| Path (relative to this folder) | State | Screen | Script |
|---|---|---|---|
| qa-clean-walkthrough/01-welcome-1280.png | empty | welcome-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/02-welcome-1024.png | empty | welcome-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/03-link-code.png | empty | link-code | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/04-link-error-1280.png | empty | link-error-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/05-link-error-1024.png | empty | link-error-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/06-linked-1280.png | empty | linked-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/07-linked-1024.png | empty | linked-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/08-bud-status-first.png | empty | bud-status-first | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/09-bud-ready-desk.png | empty | bud-ready-desk | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/10-bud-status-ready-1280.png | empty | bud-status-ready-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/11-bud-status-ready-1024.png | empty | bud-status-ready-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/12-desk-empty-1280.png | empty | desk-empty-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/13-desk-empty-1024.png | empty | desk-empty-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/14-add-property.png | empty | add-property | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/15-desk-property-1280.png | empty | desk-property-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/16-desk-property-1024.png | empty | desk-property-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/17-customize-draft.png | empty | customize-draft | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/18-customize-panel-1280.png | empty | customize-panel-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/19-customize-panel-1024.png | empty | customize-panel-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/20-work-answer-1280.png | empty | work-answer-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/21-work-answer-1024.png | empty | work-answer-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/22-schedule-needs-you-empty.png | empty | schedule-needs-you-empty | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/23-step6-failure.png | empty | step6-failure | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/24-approval-waiting-1280.png | empty | approval-waiting-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/25-approval-waiting-1024.png | empty | approval-waiting-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/26-approval-stopped.png | empty | approval-stopped | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/27-service-down-desk.png | empty | service-down-desk | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/28-service-down-work.png | empty | service-down-work | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/29-service-down-schedule.png | empty | service-down-schedule | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/30-recovery-card-1280.png | empty | recovery-card-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/31-recovery-card-1024.png | empty | recovery-card-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/32-recovery-resolved.png | empty | recovery-resolved | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/33-workspace-settings-1280.png | empty | workspace-settings-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/34-workspace-settings-1024.png | empty | workspace-settings-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/35-after-restart-desk-1280.png | empty | after-restart-desk-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/36-after-restart-desk-1024.png | empty | after-restart-desk-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/37-update-deferred-1280.png | empty | update-deferred-1280 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/38-update-deferred-1024.png | empty | update-deferred-1024 | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/39-expired-code.png | empty | expired-code | scripts/qa-clean-walkthrough.mjs |
| qa-clean-walkthrough/40-fresh-code-after-expired.png | empty | fresh-code-after-expired | scripts/qa-clean-walkthrough.mjs |
| qa-austin-showcase/01-desk-book.png | seeded | desk-book | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/02-w3-morning-priorities.png | seeded | w3-morning-priorities | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/03-w2-review-drafts.png | seeded | w2-review-drafts | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/04-w2-accept-form.png | seeded | w2-accept-form | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/05-w2-calendar-due.png | seeded | w2-calendar-due | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/06-w1-review-references.png | seeded | w1-review-references | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/07-w1-rei-sign-in.png | seeded | w1-rei-sign-in | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/08-w1-preview-ready.png | seeded | w1-preview-ready | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/09-w1-readback.png | seeded | w1-readback | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/10-w4-chat-card.png | seeded | w4-chat-card | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/11-w4-findings.png | seeded | w4-findings | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/12-w5-inspection-draft.png | seeded | w5-inspection-draft | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/13-rule-change-card.png | seeded | rule-change-card | scripts/qa-austin-showcase.mjs |
| qa-austin-showcase/14-rule-change-saved.png | seeded | rule-change-saved | scripts/qa-austin-showcase.mjs |
| qa-desktop-shell/01-desk-1440.png | seeded | desk-1440 | scripts/qa-desktop-shell.mjs |
| qa-desktop-shell/02-card-hidden.png | seeded | card-hidden | scripts/qa-desktop-shell.mjs |
| qa-desktop-shell/03-arrange-desk.png | seeded | arrange-desk | scripts/qa-desktop-shell.mjs |
| qa-desktop-shell/03b-arrange-desk-short-window.png | seeded | arrange-desk-short-window | scripts/qa-desktop-shell.mjs |
| qa-desktop-shell/04-drawer-1100.png | seeded | drawer-1100 | scripts/qa-desktop-shell.mjs |
| qa-desktop-shell/05-narrow-900.png | seeded | narrow-900 | scripts/qa-desktop-shell.mjs |
| qa-desktop-shell/06-phone-390.png | seeded | phone-390 | scripts/qa-desktop-shell.mjs |
| qa-desktop-shell/08-windows-titlebar.png | seeded | windows-titlebar | scripts/qa-desktop-shell.mjs |
| extra/empty-arrange-desk.png | empty | arrange-desk | .audit/extra.mjs |
| extra/empty-desk-get-started.png | empty | desk-get-started | .audit/extra.mjs |
| extra/empty-desk-hermios.png | empty | desk-hermios | .audit/extra.mjs |
| extra/empty-desk-more-menu.png | empty | desk-more-menu | .audit/extra.mjs |
| extra/empty-desk-other-bills-and-calendar.png | empty | desk-other-bills-and-calendar | .audit/extra.mjs |
| extra/empty-desk-other-mail-priorities.png | empty | desk-other-mail-priorities | .audit/extra.mjs |
| extra/empty-desk-other-shared-work.png | empty | desk-other-shared-work | .audit/extra.mjs |
| extra/empty-desk-other-work-menu.png | empty | desk-other-work-menu | .audit/extra.mjs |
| extra/empty-desk-tab-bills.png | empty | desk-tab-bills | .audit/extra.mjs |
| extra/empty-desk-tab-properties.png | empty | desk-tab-properties | .audit/extra.mjs |
| extra/empty-desk-tasks-full-page.png | empty | desk-tasks-full-page | .audit/extra.mjs |
| extra/empty-desk-tasks.png | empty | desk-tasks | .audit/extra.mjs |
| extra/empty-right-panel-more-panels-closeup.png | empty | right-panel-more-panels-closeup | .audit/extra.mjs |
| extra/empty-right-panel-more-panels.png | empty | right-panel-more-panels | .audit/extra.mjs |
| extra/empty-schedule-all-jobs.png | empty | schedule-all-jobs | .audit/extra.mjs |
| extra/empty-schedule-job-open.png | empty | schedule-job-open | .audit/extra.mjs |
| extra/empty-status-bar-closeup.png | empty | status-bar-closeup | .audit/extra.mjs |
| extra/empty-work-empty.png | empty | work-empty | .audit/extra.mjs |
| extra/empty-work-one-turn-composer-disabled.png | empty | work-one-turn-composer-disabled | .audit/extra.mjs |
| extra/empty-workspace-approvals.png | empty | workspace-approvals | .audit/extra.mjs |
| extra/empty-workspace-connected-apps.png | empty | workspace-connected-apps | .audit/extra.mjs |
| extra/empty-workspace-settings-help.png | empty | workspace-settings-help | .audit/extra.mjs |
| extra/empty-workspace.png | empty | workspace | .audit/extra.mjs |
| extra/seeded-arrange-desk.png | seeded | arrange-desk | .audit/extra.mjs |
| extra/seeded-desk-get-started.png | seeded | desk-get-started | .audit/extra.mjs |
| extra/seeded-desk-hermios.png | seeded | desk-hermios | .audit/extra.mjs |
| extra/seeded-desk-more-menu.png | seeded | desk-more-menu | .audit/extra.mjs |
| extra/seeded-desk-other-bills-and-calendar.png | seeded | desk-other-bills-and-calendar | .audit/extra.mjs |
| extra/seeded-desk-other-mail-priorities.png | seeded | desk-other-mail-priorities | .audit/extra.mjs |
| extra/seeded-desk-other-shared-work.png | seeded | desk-other-shared-work | .audit/extra.mjs |
| extra/seeded-desk-other-work-menu.png | seeded | desk-other-work-menu | .audit/extra.mjs |
| extra/seeded-desk-tab-bills.png | seeded | desk-tab-bills | .audit/extra.mjs |
| extra/seeded-desk-tab-properties.png | seeded | desk-tab-properties | .audit/extra.mjs |
| extra/seeded-desk-tasks-full-page.png | seeded | desk-tasks-full-page | .audit/extra.mjs |
| extra/seeded-desk-tasks.png | seeded | desk-tasks | .audit/extra.mjs |
| extra/seeded-right-panel-more-panels-closeup.png | seeded | right-panel-more-panels-closeup | .audit/extra.mjs |
| extra/seeded-right-panel-more-panels.png | seeded | right-panel-more-panels | .audit/extra.mjs |
| extra/seeded-schedule-all-jobs.png | seeded | schedule-all-jobs | .audit/extra.mjs |
| extra/seeded-schedule-job-open.png | seeded | schedule-job-open | .audit/extra.mjs |
| extra/seeded-status-bar-closeup.png | seeded | status-bar-closeup | .audit/extra.mjs |
| extra/seeded-work-empty.png | seeded | work-empty | .audit/extra.mjs |
| extra/seeded-work-one-turn-composer-disabled.png | seeded | work-one-turn-composer-disabled | .audit/extra.mjs |
| extra/seeded-workspace-approvals.png | seeded | workspace-approvals | .audit/extra.mjs |
| extra/seeded-workspace-connected-apps.png | seeded | workspace-connected-apps | .audit/extra.mjs |
| extra/seeded-workspace-settings-help.png | seeded | workspace-settings-help | .audit/extra.mjs |
| extra/seeded-workspace.png | seeded | workspace | .audit/extra.mjs |

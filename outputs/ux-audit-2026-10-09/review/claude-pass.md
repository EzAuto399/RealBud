# Claude pass: UX audit notes, 9 Oct 2026 (0.1.46, main 6852499b)

Evidence: built UI on fictional data (local tests), plus the owner's 2 Windows 0.1.46 screenshots (installed device).

## A. Setup vs work (P1)
1. Jobs say "Runs automatically" and the status bar says "Next: Friday owner letter 4:00 pm" at setup 1 of 5 (not linked) and 3 of 5 (no pack). This breaks "workflows come last; each arrives switched off" (empty-desk-get-started, seeded-schedule-all-jobs, windows-0146-schedule).
2. The Schedule list shows an enabled "Run now" while the job drawer disables it with "Connect this computer first" (seeded-schedule-all-jobs vs seeded-schedule-job-open).
3. There are two primary buttons on the Desk at once: the setup step ("Enter link code" / "Open packs from your office") and "Add properties" (12-desk-empty-1280, empty-desk-get-started).
4. The Get started checklist sits above the work on Tasks even at 4 of 5. At that point it pushes the queue below the fold (01-desk-book).

## B. Source of truth (P1)
5. "Add property", "Import CSV" and "Start your office book" are the main actions on an empty Desk, even for an REI office. They invite typing REI facts that REI then overrides (12-desk-empty, windows-0146-desk-properties).
6. The Desk badge says "CSV live", and Evidence says "Observed · PMS CSV export". Neither says "From REI · checked 7:02" (01-desk-book).
7. The REI morning refresh is the job that keeps Desk true to REI. Yet it shows "Switch this on when you want it to run" with no description, even though the code has a clear one (seeded-schedule-all-jobs).

## C. The same thing shown 3–4 times (P2)
8. "Needs you" appears four times: the sidebar Queue counts, the Task queue Status dropdown, the Today panel tiles, and the Approvals waiting list. All four show the same 3 items (01-desk-book).
9. Properties appear in three places: the sidebar list, the Properties tab, and More → "Properties and imports" (seeded-desk-tasks, seeded-desk-more-menu).
10. Bills is both a tab and Other work → "Bills and calendar". Shared work is under Other work, and More opens over it (seeded-desk-other-work-menu, seeded-desk-more-menu).
11. The Schedule sidebar "Loops" repeats the main job list one to one (seeded-schedule-all-jobs).
12. On an empty book there are four "nothing here" messages at once: the badge "Waiting for properties", the queue "No tasks yet", the list, and Today. Evidence still asks you to "Select a case" when none exist (empty-desk-get-started).

## D. Too many entry points (P2)
13. The Desk header has 4 buttons: Check tasks, Ask Bud, More, Other work. "More" and "Other work" do not differ in any way a user can tell.
14. Schedule offers Show Bud a task, Past results and Add a job, while Work can also make a repeat. That gives three ways to create a job.
15. W3 mail has 3 collection buttons ("Collect reviewed Gmail scope", "Collect and prepare priorities with Bud", "Refresh saved mail work"). It also has its own "Enable reviewed morning schedule", which duplicates Schedule (02-w3-morning-priorities).

## E. Words disagree (P2)
16. The same idea has two names: Loops vs jobs, and "Other jobs" under the "Scheduled" tab. Office, Agency and Workspace are used interchangeably ("Agency setup", "Agency workflow setup", "Office details", "office's pack").
17. Dates and times disagree: "Next Fri 7:30 am" vs "Today, 7:30 am"; "Next Mon 7:30 am" vs "Monday, 7:30 am"; and timing reads "from 2026-10-02".
18. The Connected apps copy says "Hermios is the tab beside Needs you on Desk". The tab actually sits beside Tasks (seeded-workspace-connected-apps).
19. Internal and dev words leak into the UI: "Mock maintenance comparison for Sherry", "Source-run key. This is not a production distribution", "configured model service", "invoice-fact reviews", "source-reviewed", "scope".

## F. Core vs pack (P1 for the business-OS goal)
20. The core shell has property-management nouns built in: Properties and Bills tabs, "tenant", "Buildings / Suburbs / Portals", "Morning money check" and "Friday owner letter". A sales or accounts department would see screens that aren't theirs.
21. "Hermios" (one CRM vendor) is a fixed Desk tab and the top card in Connected apps. It is an app, not a core destination.
22. Workspace leads with "Run the sample morning" (training) above Office, Apps and Approvals, even after setup (seeded-workspace).

## G. What already works (reuse it)
23. The W1 job drawer works well for every job: "What this job does · Accounts / Reads / Waits for / Tells / Approval / Needs", a 1–7 stepper, and a blocker line that says exactly what to do (06-w1-review-references). The core jobs don't use it.
24. The rent-reminder card is honest: "Approving saves your decision. It does not send the message."
25. The Approvals card note: "Approve, Stop and recovery stay on each case."
</content>
</invoke>

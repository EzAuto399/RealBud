# Desktop shell and UI components

Status: owner decision, 5 October 2026. It supersedes the 2 October "sleek, few options" layout rule in CLAUDE.md. Safety, recovery and permission rules are unchanged.

## Decision
- **Shell:** an icon rail (Desk / Work / Schedule, with Workspace at the foot), a context sidebar, tabs across main, main content, a right context panel and a slim bottom status bar.
  - The internal key stays `you`, and every `#you-*` link keeps working.
  - Keyboard shortcuts, badges, `aria-current` and accessible names are kept so QA role selectors keep working.
- **Right panel defaults:** Evidence for the selected case, Approvals waiting, and Today. More panels (Bud activity, Connected accounts) are available under "More".
  - Approval, Stop and recovery stay on the case itself. The panel only mirrors them.
- **Status bar:** connection state, last Desk run and staleness, next loop, the active browser account with Stop while a task runs, and spend versus budget. It never presents stale or fallback data as live, and it says "Sample book" for a demo.
- **Freedom to choose:**
  - A "Show on my Desk" / "Hide" item in each card's and panel's ⋯ menu.
  - One "Arrange Desk" sheet with "Reset to recommended", stored per member on the server.
  - Safety, approval and recovery cards can't be hidden.
  - Larger changes go through Bud, using saved views and workflow settings approval cards.
- **Components:** uiarc.dev (free items) and animate-ui are references only. A handful are hand-ported into our Tailwind tokens, using CSS transitions with a `motion-reduce` fallback.
  - No new runtime packages: no `motion`, no Radix, no cva, no shadcn `components.json`.
  - Our focus rings stay; uiarc's "no focus rings" rule is rejected.
  - uiarc Pro items are not copied.
- **Breakpoints:** CSS only (1279 / 959 / 719). The right panel and status bar hide below 959px. The app is desktop-only, but the 390px QA check stays.

## Why
The owner wants staff to see more useful information and choose what matters to them, while Bud keeps helping them more over time. Calm defaults, a reset and Bud-driven customisation keep it usable for non-technical office staff.

## Sources
UI research (5 Oct): https://uiarc.dev/llms.txt, https://uiarc.dev/pricing, https://animate-ui.com/docs/components, GitHub imskyleen/animate-ui LICENSE.md (MIT + Commons Clause). The X post could not be fetched (HTTP 402).

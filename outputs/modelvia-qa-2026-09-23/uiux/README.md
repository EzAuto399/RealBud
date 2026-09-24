# RealBud setup and workflow UIUX review — 2026-09-23

**Ship the reviewed UI changes: 22/24.** This is a local built-renderer verdict; live Modelvia, installed Mac acceptance, Windows and customer workflow acceptance remain separate gates.

Review tier, using [UIUX 1.0.0](/Users/Shared/agent-skills/uiux/releases/1.0.0/skills/uiux/SKILL.md) and its rubric. RealBud is a dense desktop business work tool: account linking, Bud readiness, bank-to-CSV preparation, mail priorities, and source-linked bills/calendar. Current DESIGN.md/rules inform the review; current browser authority and bank-to-CSV decisions supersede historical REI-only constraints.

## Ranked findings

1. **Fixed — blocking, M: leaving Schedule silently discarded unfinished bank work.** Typing column mapping/property references, then Schedule → You → Schedule, cleared both fields without warning. [Before](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/bank-unprepared-before-navigation-900.png), [lost draft](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/bank-unprepared-after-navigation-900.png). [BankReferenceReview.tsx:40](/Users/yoda/projects/RealBud/src/components/schedule/BankReferenceReview.tsx:40) now guards page departure and browser unload. Cancel keeps fields and URL; explicit confirmation discards only unsaved local work. Pending file reads/saves block page departure. A successful save only acknowledges its submitted snapshot, preserving newer edits. No draft contents enter browser storage. [Final preserved decisions](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/fixed-bank-decision-kept-900.png).
2. **Fixed — high, S: Model needed offered no direct website-account path.** The prominent status offered Check again and Service administration, with account linking buried in Office below collaboration controls. [Before](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/setup-entry-1280.png). [ManagedBudStatus.tsx:45](/Users/yoda/projects/RealBud/src/components/ManagedBudStatus.tsx:45) now offers Open website account when model access needs connecting. It reveals Office and focuses the account region through the existing hash-navigation system. Linking does not claim readiness. Managed model-choice and withdrawn-access states retain their existing boundaries. [Keyboard destination at native minimum width](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/fixed-website-keyboard-900.png).
3. **Fixed — medium, S: pending model-access guidance disappeared after reopening a linked computer.** The saved status was linked/unprovisioned, but transient phase was idle. [Before](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/website-linked-1280.png). [WebsiteLinkCard.tsx:129](/Users/yoda/projects/RealBud/src/components/you/WebsiteLinkCard.tsx:129) now renders/announces access progress from persisted service facts, independent of the browser-approval phase. Pending, ready and failed access remain distinct after reload. [After](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/fixed-website-linked-reload-1280.png).
4. **Open — medium, S/M: mail/bill empty states mention Agency setup without a direct next-step control.** Fresh mail shows several collection/schedule actions and an instruction to finish agency setup; bills disable the inbox check without linking to the missing prerequisite. Users can reach setup through You, so this is friction rather than a blocked route. [Mail screenshot](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/mail-empty-1280.png), [bills screenshot](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/bills-empty-1280.png). Source: [MailWorkPanel.tsx:172](/Users/yoda/projects/RealBud/src/components/desk/MailWorkPanel.tsx:172), [SourceBillsPanel.tsx:321](/Users/yoda/projects/RealBud/src/components/desk/SourceBillsPanel.tsx:321). Suggested follow-up: one Open workflow setup action when the authoritative prerequisite is missing, retaining explicit collection/run approval.

## Rubric

| Dimension | Before | Final | Evidence |
|---|---:|---:|---|
| Orientation | 2 | 2 | Named pages, selected navigation, setup title |
| Primary action | 1 | 1 | Mail's collection/preparation/scheduling actions still have equal prominence; finding 4 |
| Workflow completeness | 1 | 2 | Bank cancellation, interrupted navigation and acknowledged-save behavior proved |
| States | 1 | 1 | Website reload guidance fixed; workflow prerequisite CTA friction remains, finding 4 |
| Forms/input | 2 | 2 | Visible labels; failed link preserves computer name; bank leave guard preserves edits |
| Feedback/latency | 2 | 2 | Explicit waiting, error, saved and pending-operation states observed; no performance claim |
| Navigation | 1 | 2 | Direct account path, focus, Escape, Back/hash/URL recovery |
| Accessibility | 2 | 2 | Scoped keyboard walk, visible focus and text/status semantics; contrast spot checks |
| Responsive/platform fit | 2 | 2 | 900px native minimum has no clipped controls; wider/narrower fixtures reviewed |
| Consistency/tokens | 2 | 2 | Existing buttons, Card, colors and navigation reused |
| Copy | 2 | 2 | Cause/recovery text; header now says checked CSV copy; existing accounting-history labels retained |
| Visual craft | 2 | 2 | Ledger hierarchy retained; final screenshots inspected |
| **Total** | **20** | **22** | Initial verdict fix then ship because of data loss; final scoped verdict ship |

## Verification and evidence

- **62 tests passed, zero failed**: WebsiteLinkCard.test.ts, BudSetupCard.test.ts, you-navigation.test.ts, navigation-guard.test.ts, bank-history.test.ts. [Unit receipt](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/final-unit-tests.json). Renderer typecheck passed; root ran the final full build. Final scoped diff check passed.
- **19 final rendered checks, six final screenshots, zero page errors**: [final receipt](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/fixed-receipt.json), [runner](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/verify-fixes.mjs). Includes website keyboard/focus and reload at 900/1280; bank sidebar/hash/Back cancellation, same-page navigation, explicit discard, cleanup, pending read/save, newer edits during save, unsaved decisions, popup navigation asking once, and absence of bank source/decision contents in browser storage.
- Earlier review rendered setup, website and all three workflow entry/empty states at **360/768/1280/1536**; workflow and website transport errors at 1280; native minimum 900 added afterward. [Initial receipt](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/receipt.json), [supplemental receipt](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/supplemental-receipt.json). The initial pending-link fixture was malformed and is excluded; the supplemental valid saved approval rendered its code and resume controls. Earlier harness failures are retained but superseded by completed receipts.
- **Five contrast pairs pass normal-text AA, 4.74–7.16:1**: body-muted on paper/sheet, danger/hold on sheet, white on agency. [Contrast receipt](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/contrast.json). Reduced motion used throughout. No second shipped theme in the reviewed desktop surface.
- [Final source/build digests](/Users/yoda/projects/RealBud/outputs/modelvia-qa-2026-09-23/uiux/final-source-digests.json). Product changes are confined to setup/website navigation and the bank leave guard; earlier App onboarding edits were preserved. Disposable source service, browser and scratch data were cleaned up. No provider, external account, bank/customer data, PostgreSQL, live model request or package build was run by this fixture.

The 360px Schedule grid exposes calendar clipping outside the scrolled bank region; this is below Electron's shipped 900px minimum and is not counted as a desktop ship blocker. Phone support is not claimed. This is not an exhaustive WCAG audit, native dialog/VoiceOver certification, or live account authentication proof.

**Next:** package this frozen build and use the isolated Mac QA launcher; test the real account connection separately.

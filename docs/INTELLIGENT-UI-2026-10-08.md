# Intelligent UI and demo polish (8 October 2026)

Branch `claude/intelligent-ui-fixes`. Built from a ChatGPT Pro design consult (three rounds, the last on real screenshots) and an Astra (Codex) ease-of-use review. Advice and receipts: `outputs/intelligent-ui-consult-2026-10-08/` and `outputs/intelligent-ui-fixes-2026-10-08/`.

## What changed
- **Desk tells the truth about its data.**
  - When the office is disconnected or the last check is stale, empty lists say "in saved data", and a status line names the reason ("Office disconnected · Last Desk check 3 days ago").
  - The sample book gets no warning.
- **Each queue row says why it is there**, using only existing facts: licensee escalation, held, stale or failed, and when it changed. While a case is open the order stays put, and "Updates available · Update order" applies the new order.
- **One customise surface.** Arrange Desk now holds Change history with Restore, move up and down, and Simple desk. The Customize desk panel is deleted.
- **Work offers one state-based Next step on an attached case:** Review draft, Summarise for licensee, the recovery step, or Investigate with Bud. It only fills the composer and never sends.
- **The withdrawn composer** points to Reconnect, matching the office card.
- **Schedule:**
  - Buttons name the problem: failed, missed, incomplete or interrupted run, or Verify result.
  - The attention count shows once.
  - The column reads "Next run" and each row shows its last run.
- **Copy fixes:** "private private setup", "Review unsaved decisions discard", and Arrange Desk's for-you versus shared wording.
- **macOS:** the local-network permission prompt now gives a reason (`NSLocalNetworkUsageDescription`).
- **Cleanup:** about 1,360 lines of unused renderer code and CSS removed, including GroupCallView, the Maus styles and SettingsModal.

## Evidence
Source and local tests:
- `pnpm qa` is all green: 9,726 tests, two-device, release guards and the 5-suite PM e2e battery.
- After merging 0.1.40, the full suite was re-run.

Renderer QA on the built UI:
- `qa-desk-narrow-empty`: 10/10.
- `qa-customizable-desk`: 9/9.
- `qa-austin-workflow`: 17/17, with 3 known open gaps.

Not done yet: a packaged build, an installed device and Windows.

## Open
- After Stop, a step chip in Work can still read "running" with a check icon (seen with the scripted worker). The component has not been found yet.
- The same approval shows in the transcript and above the composer. The Codex `single-approval-card` branch owns this.
- Not built yet: sources on cards, the same object carried across Desk, Work and Today, and structured approval diff cards with saved-view undo.

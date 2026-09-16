# Hermes and website closeout — 5 September 2026

This records the integration and website fixes verified in the current checkout. It does not replace the real-agency pilot gates in `PILOT-CONTRACT.md` or the PM journey checks in `JOB-JOURNEY-RELEASE-CHECK.md`.

## Hermes integration

- Hermes remains independently installed and updateable. Its core was not changed. The installed version verified here is **0.21.0 (2026.8.31)** at upstream commit `63279301bcbdc185c1b07b98a9312eb0c862f26d`.
- RealBud now explicitly accepts that tested release alongside its existing **0.20.3 (2026.8.16.2)** installation and rollback baseline. Compatibility and matching the rollback pin are separate status fields; unknown releases are not automatically accepted for CLI jobs.
- Readiness distinguishes a missing executable from a timeout or failed probe. Version probes are bounded and deduplicated; failed probes can be retried. A successful model check only establishes readiness for the same worker/profile fingerprint.
- Profile repair preserves an existing compatible Hermes installation and the saved model setup. “Reset Bud profile” removes RealBud's profile state while preserving the shared Hermes installation and the property book.
- The packaged app successfully used the existing `grok-4.6` connection. Its You page displayed **Bud is ready**, with all four worker checks ready and the latest successful ping matching the current fingerprint.

### Verification

- **201 tests passed across 14 focused files**, covering compatibility, readiness, profile repair/reset, CLI execution, ACP, drafting/import inspection, scheduling, recipes, job execution, receipts, worker issues, and HTTP boundaries.
- Root build and TypeScript checks passed.
- `npm run qa:hermes-contract` passed against the actual configured provider using synthetic inputs: plan drafting, saved-plan editing, rehearsal, approval of the exact revision, a computed prepared result, duplicate prevention, persisted receipt reload, ACP handshake, follow-up context, and fresh-process transcript recovery.
- The live-worker API check passed. It now treats a failed or skipped model ping as unverified rather than reporting success.
- RealBud **0.1.17** was rebuilt and Developer ID signed. Strict code-signature verification and `npm run qa:package:mac` passed, including renderer, embedded harness, capability checks, and shutdown. The rebuilt app was then opened and its model readiness checked in the native UI.

Local deliverables are `release/mac-arm64/RealBud.app`, `release/RealBud-0.1.17.dmg`, and `release/RealBud-0.1.17-arm64.zip`. They have **not been notarized or published as a customer release**.

## Website

Live site: <https://realbud-property-desk.justnewyodacc.chatgpt.site>

- Reworked the page around a PM's recurring task: explain the work, review the plan, schedule it, and review the prepared result. The page includes interactive workflow examples, a defined-scope paid-pilot invitation, FAQs, and a short enquiry form.
- Improved desktop and mobile layouts, light/dark appearance, focus states, and reduced-motion behavior. The existing social-preview image was preserved.
- Replaced the dead-end email CTA with a server-backed enquiry form. It validates input and consent, bounds request size, checks request origin, limits submissions, and uses idempotency to prevent duplicate receipts. Failures retain the entered details and do not claim a successful save.
- Enquiries are stored in a private D1 database. No public enquiry-list endpoint is exposed. Owner retrieval is documented in `website/README.md`.
- Six enquiry tests, lint, TypeScript checks, and the production build passed. Desktop/mobile rendering, example selection, form errors, and successful receipt focus were checked in the browser.
- The deployed form accepted one clearly marked synthetic test enquiry. The displayed receipt was verified against the private production database. This is an infrastructure check, not a prospect or customer conversion.

The nested website repository is clean and was pushed at commit `e1387f7142ebb3f21b54fff0bb5a54002a33b50f`. Sites version **5** deployed successfully as `appgdep_6a9b4b5fe3548191af9aa7d122740d5e`.

**Enquiry email notifications are not configured.** The owner's intended notification inbox is still needed; current enquiries remain available in the private database.

## Remaining launch gates

1. Name the pilot agency, connect its authorized export/data, and agree one recurring PM outcome and acceptance criteria.
2. Rehearse that outcome with the agency, including review/Allow, a missed or interrupted run, recovery, and the resulting evidence. Synthetic worker and package checks do not establish real-office readiness.
3. Notarize and verify the intended customer distribution package before broad Mac distribution.
4. Configure and verify notifications to the owner's chosen enquiry inbox, then run the first pilot conversation and agree the commercial scope. No paid-pilot evidence is claimed here.

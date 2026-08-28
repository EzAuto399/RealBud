# Pilot contract — Morning Money Check

Status: **Demo / source-run spike**. Replace this file when a paying agency
supplies a real PMS export, portal, jurisdiction, and baseline.

## External agency research is not a contract

Agency and vendor research stays under `docs/research/`; it is not compiled
into the runtime, projected as a customer or treated as setup evidence. The
read-only `/api/pilot-discovery` projection and You → General card use only
this code-owned contract and therefore show **0 of 8 confirmed** while it
remains Demo. External research cannot change `PILOT_CONTRACT`, satisfy
release preflight, enable Pocket, start a live account or grant browser/CUA
authority. Once a non-Demo contract names an office, incomplete fields remain
visibly unconfirmed.

RealBud does not claim local portal automation on an unsupported host.
The first live Cua path is **macOS + pinned Cua 0.19.3**. Linux/Windows
source runs use the fake portal and CSV only.

## Locked stack (demo)

| Field | Value |
|---|---|
| Agency | RealBud Demo Book |
| Jurisdiction | ACT (shop reminder rules only — not a legal clock) |
| PM OS | macOS (Cua host) or any OS for CSV + fake portal |
| PMS / export | Recurring read-only CSV (`imports/ledger.csv`) |
| Named portal | `fake-building-portal` (local test account) |
| Login | Manual sign-in to `~/.realbud/chrome-profile`. No passwords stored. |
| Reminder type | Non-statutory courtesy SMS/email/portal prefill |
| Freshness SLA | 12 hours for CSV; 30 minutes for a portal observation |
| Baseline | Training book: 6 properties, ~8 minutes / ~20 tab touches (manual) |

## Spike boundary (one portal, one account, one property)

Proved by `server/testing/fake-portal.ts`, `server/portal-handoff.test.ts` and the QA-only `scripts/e2e-portal-browser.mjs`:

- Bud may **GET** ledger/read pages and **POST /prefill**.
- Bud must not **POST /submit**, pay, or send.
- Control is revoked at `handoff-ready`.
- The PM performs the final click (or a test double does).
- Ambiguous results become `effect-unknown`.
- The visible simulator survives reordered and delayed layouts through semantic labels, while exact origin (including port), recipe version, one-use claim, bounded waits and no-redirect execution remain code-owned.

The Agent Browser CLI is only a repeatable DOM test driver. It is not bundled as Bud's authority. The pinned CUA binary now has a source-proven native version-2 boundary: an exact-origin isolated-profile policy admits only seven typed browser operations and denies ambient window enumeration, generic desktop access and off-origin navigation. Bud never receives the driver's raw MCP surface. Connecting an admitted portal recipe to Electron's bounded-session owner and exercising it on an installed build still wait for the named vendor test account.

SSO/MFA, cross-origin frames, and autosave-on-blur are recorded as
**unknown on a real building portal** until Stage 0 is re-run against a
vendor test account. Do not expand portal infrastructure past this fake
until that spike is filled in.

## Read-only bank observation boundary

The fake bank is a separate fixture, not the named portal and not a live bank connection. Its deterministic and hybrid walkthroughs prove manual fixture login, a disposable RealBud-owned browser profile, exact CUA PID/endpoint validation, bounded recent-credit extraction, digest-only Desk reconciliation and refusal of transfer/payee routes. They do not prove a bank's MFA, selectors, session policy, rate limits, revocation, consent or terms.

Before morning money may collect from a real bank, the pilot must name the bank and one agency-approved read-only test account, then record the PM login/MFA handoff, selectors, auth expiry, rate limiting, revocation and same-account session behaviour on an installed build. Passwords, MFA secrets, account numbers and raw payment references may not enter Desk, Ask, logs or receipts. The adapter may observe credits only; transfer, payee, payment, allocation, disbursement and trust reconciliation remain structurally unreachable, and the PMS remains money/legal authority.

## PM Pocket boundary

The Telegram and official WhatsApp Business Cloud text/manual-decision
adapters are source-built but this Demo contract keeps both network-off.
`pocketPilotReady` requires only a real
non-Demo agency and the exact named PM in field 1 below; it does not pretend
the vendor portal or export fields are complete. Full distribution still
requires all eight fields.

After field 1 is real, You may enrol one dedicated Telegram bot and/or one
dedicated WhatsApp Business Cloud number for that PM. Only the exact PM's
private chat projects into canonical Ask. Mobile Allow/Not now uses the same
action owner and revision checks as the desktop card. Groups, tenants,
attachments, credentials, terminal/model/update commands and autonomous
sends remain out. Telegram bot chats are not end-to-end encrypted, so the
agency must approve that privacy boundary before live enrolment. WhatsApp
also requires Meta business/privacy approval and an agency-approved stable
HTTPS tunnel or reverse proxy; source completion does not satisfy either.
Personal-account QR automation is not part of this contract.

## Required fields before this stops being a demo

Every field below blocks with a name on it. The visit fills them in; until
then RealBud stays a training appliance and the live CUA path stays off
(`readyForLivePortal` requires `realAgencyNamed`). No code work past the
installer spike starts until these are answered.

| # | Field | Why it blocks |
|---|---|---|
| 1 | **Agency + named PM user** | One desk, one user. The pilot names both — principal and the PM who will actually run Recheck. This field is also the minimum Pocket network gate; it grants no portal or release readiness. |
| 2 | **PMS brand** | PropertyMe / Property Tree / Reapit PM / other. Confirm on the visit; never assume. Decides the export shape and whether a read API exists at all. |
| 3 | **Named exporter** | The person who can actually pull the read-only arrears export. A first-desk PM often cannot — get a principal's yes in writing. This is the single most common pilot killer. |
| 4 | **Export cadence** | How often the export lands. Must satisfy the 12-hour CSV freshness SLA at the office's real rhythm (weekly exports make a morning loop useless). |
| 5 | **Export identity column** | Does their export carry a property id, address, or their own property code? Decides how the mapper matches rows to the book. |
| 6 | **Office OS** | macOS keeps the live CUA door open for later; anything else means CSV + fake portal only for that office. |
| 7 | **Book jurisdiction(s)** | Which states are in the book. Day counts stay shop reminder rules regardless; this only tunes courtesy windows and wording. |
| 8 | **Vendor test account** | For the one portal: Stage-0 spike must be re-run against a vendor test account before any real click. |

When all eight are ticked: replace the Locked stack table above with the
office's real values and mirror every field in `server/pilot-contract.ts`.
Only then may the QA package enter the signed/notarized release proof ladder
in `docs/RELEASE-EVIDENCE-CHECKLIST.md`. `scripts/release-preflight.mjs`
enforces the eight fields; it cannot be bypassed by treating Demo values as a
real office.

## Readiness

A scheduled **live** loop stays disabled until:

1. The CSV (or PMS export) has a stable source identity and a fresh batch.
2. The property has a `PropertyPortalBinding` to a published recipe version
   (fake portal counts for Demo).
3. Agency timezone and retention days are set.
4. A readiness check returns `ok` without using fixture rows as live facts.
5. The platform-specific release and live-office evidence in
   `docs/RELEASE-EVIDENCE-CHECKLIST.md` is attached; a green source suite or
   unsigned QA package is not a substitute.

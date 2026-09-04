# Pilot contract — Morning Money Check

Status: **Demo / source-run spike**. Replace this file when a paying agency
supplies a real PMS export, portal, jurisdiction, and baseline.

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

Proved by `server/testing/fake-portal.ts` and `server/portal-handoff.test.ts`:

- Bud may **GET** ledger/read pages and **POST /prefill**.
- Bud must not **POST /submit**, pay, or send.
- Control is revoked at `handoff-ready`.
- The PM performs the final click (or a test double does).
- Ambiguous results become `effect-unknown`.

SSO/MFA, cross-origin frames, and autosave-on-blur are recorded as
**unknown on a real building portal** until Stage 0 is re-run against a
vendor test account. Do not expand portal infrastructure past this fake
until that spike is filled in.

## Required fields before this stops being a demo

Every field below blocks with a name on it. The visit fills them in; until
then RealBud stays a training appliance for inbound, Pocket, and the graduate
installer. No installer-spike code work starts until these are answered.

**2026-09-02:** live portal runs no longer wait on these eight fields.
They require plan approval + per-job Attach on this Mac with the desktop
helper (`docs/PORTAL-WORK.md` "Run beside me"). `readyForLivePortal` was
never an HTTP gate. The eight fields still gate inbound, Pocket, and the
graduate installer.

| # | Field | Why it blocks |
|---|---|---|
| 1 | **Agency + named PM user** | One desk, one user. The pilot names both — principal and the PM who will actually run Recheck. |
| 2 | **PMS brand** | PropertyMe / Property Tree / Reapit PM / other. Confirm on the visit; never assume. Decides the export shape and whether a read API exists at all. |
| 3 | **Named exporter** | The person who can actually pull the read-only arrears export. A first-desk PM often cannot — get a principal's yes in writing. This is the single most common pilot killer. |
| 4 | **Export cadence** | How often the export lands. Must satisfy the 12-hour CSV freshness SLA at the office's real rhythm (weekly exports make a morning loop useless). |
| 5 | **Export identity column** | Does their export carry a property id, address, or their own property code? Decides how the mapper matches rows to the book. |
| 6 | **Office OS** | macOS keeps the live CUA door open for later; anything else means CSV + fake portal only for that office. |
| 7 | **Book jurisdiction(s)** | Which states are in the book. Day counts stay shop reminder rules regardless; this only tunes courtesy windows and wording. |
| 8 | **Vendor test account** | For the one portal: Stage-0 spike must be re-run against a vendor test account before any real click. |

The eight fields persist on You → This office (`desk.json` `office`, plus
agency name and jurisdictions). Training names still do not count. Filling
the form does not invent a paying agency and does not turn on inbound,
Pocket, or the graduate installer. (2026-09-02: live attended portal runs
are a separate Attach acknowledgement, not this form.)

When all eight are ticked on a real visit: replace the Locked stack table
above with the office's real values. `pilotContractFromBook` already mirrors
the persisted fields. The installer a graduate can double-click becomes
worth building after that visit, not after the form exists.

## Readiness

A scheduled **live** loop stays disabled until:

1. The CSV (or PMS export) has a stable source identity and a fresh batch.
2. The property has a `PropertyPortalBinding` to a published recipe version
   (fake portal counts for Demo).
3. Agency timezone and retention days are set.
4. A readiness check returns `ok` without using fixture rows as live facts.

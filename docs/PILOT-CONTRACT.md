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

## Readiness

A scheduled **live** loop stays disabled until:

1. The CSV (or PMS export) has a stable source identity and a fresh batch.
2. The property has a `PropertyPortalBinding` to a published recipe version
   (fake portal counts for Demo).
3. Agency timezone and retention days are set.
4. A readiness check returns `ok` without using fixture rows as live facts.

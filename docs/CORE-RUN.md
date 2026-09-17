# Core RealBud — run the same desk in another office

Not a second product. Same AU property-manager desk, isolated home.

Another Mac / another company laptop should be able to prove the contract
without touching this operator's `~/.realbud` and without Hermes.app.

## One command

```bash
cd /Users/yoda/projects/PropertyMe
pnpm qa:company
```

That boots the real HTTP harness on a temp `REALBUD_DATA_DIR`, walks the
training book, and exits non-zero on the first broken gate.

Daily PM regression (typecheck + unit + e2e) stays:

```bash
pnpm qa
```

## What the core must keep

| Gate | Proof |
|---|---|
| Product name | `GET /api/health` → `app: realbud` |
| Session | Desk without a token is 401 |
| Training book | Six fixture properties; GET does not invent drafts |
| Draft only | Practice may raise courtesy/levy; statutory is an escalation |
| Never send | `POST …/send` is 403 before and after Allow |
| Planned work | Inbound loop is 409 until a named office asks |
| Ready is a receipt | `/api/hermes` `ready` is false until a hands ping on **this** home |
| Isolation | Files land under `REALBUD_DATA_DIR`, not the operator `~/.realbud` |

## How a second office runs it

1. Install the same RealBud build.
2. Set `REALBUD_DATA_DIR` to that office's directory (never share vaults).
3. Attach **their** model on You. Run the private readiness check there.
4. Import **their** export. Do not copy this machine's `desk.json`.
5. Send stays 403. They copy into their PMS.

Do not clone this operator home. Do not reuse Veylet/Wondertrail data.
Do not turn on inbound, Pocket, or a graduate installer until that office
is named on You → This office.

## Use cases the core script covers

- U1–U8 happy path for a fresh home
- E1 hostile `never` rules ignored
- E2 stale Allow → 409
- E3 a second home does not inherit the first home's extra property

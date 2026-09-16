# RealBud

Local-first desk for Australian residential property managers.

RealBud is our product. The app shell is a fork of [OpenMausBot](https://github.com/milind-soni/OpenMausBot) (MIT). Hermes Agent is a **pinned worker** inside this shell (v0.20.3), not the product name.

Do **not** confuse this with PropertyMe the Australian PMS. We sit on that class of software. We do not replace trust accounting.

## Run from source

Needs **Node 24+** and **pnpm**. Desk runs on the training book with no engine. Chat uses the pinned Hermes worker (`hermes -p property`), never Hermes.app.

```sh
git clone https://github.com/EzAuto399/RealBud && cd RealBud
nvm use          # if you use nvm — see .nvmrc
pnpm install
pnpm dev:server  # harness → 127.0.0.1:8799
pnpm dev         # app → http://127.0.0.1:5199
```

Data lives in `~/.realbud` (migrated from `~/.openmausbot` on first run if that folder exists).

## Model spend (billed path)

RealBud can issue an **office key** and proxy Hermes through `http://127.0.0.1:8799/v1` so model cost lands on this desk, with a configurable markup, instead of a raw OpenRouter key.

On **You → Model spend**: create or revoke keys, read tokens / US$ spent / remaining credits, and press **Connect Bud** to write the OpenRouter provider + RealBud base URL + office key onto the pinned Hermes profile.

### Environment

| Variable | Role |
|---|---|
| `REALBUD_OPENROUTER_API_KEY` | Upstream OpenRouter (or compatible) secret. **Never commit this.** |
| `REALBUD_OPENROUTER_BASE_URL` | Upstream base. Default `https://openrouter.ai/api/v1`. |
| `REALBUD_BILLING_MARKUP` | Price multiplier on upstream cost. Default `1.25`. Use `4` for a 75% gross-margin target. |
| `REALBUD_BILLING_INPUT_USD_PER_1M` / `REALBUD_BILLING_OUTPUT_USD_PER_1M` | Fallback USD rates when the provider omits `usage.cost`. |
| `REALBUD_LLM_GATEWAY_PUBLIC_URL` | Public `/v1` URL if you put the gateway behind a reverse proxy. Default is loopback. |
| `REALBUD_BILLING_MOCK=1` | Practice top-up that credits the office wallet with no card. |
| `STRIPE_SECRET_KEY` | Live Stripe Checkout (`sk_…`). Optional. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` if you forward webhooks. This server binds `127.0.0.1`, so prefer `POST /api/billing/topup/confirm` after Checkout. |
| `REALBUD_BILLING_SUCCESS_URL` / `REALBUD_BILLING_CANCEL_URL` | Checkout return URLs. Default back to You → Model spend. |

No real OpenRouter or Stripe secrets are shipped in this repo.

### How a user pays

1. Practice: set `REALBUD_BILLING_MOCK=1`, then top up US$10 / 25 / 50 on You → Model spend.
2. Cards: set `STRIPE_SECRET_KEY`, top up, complete Stripe Checkout, return to RealBud. The app confirms the paid session (`/api/billing/topup/confirm`). Webhook credit is a TODO until a reachable `STRIPE_WEBHOOK_SECRET` endpoint exists.

### How Hermes points at RealBud

Provider **OpenRouter**. Base URL `http://127.0.0.1:8799/v1` (or **Connect Bud** writes it). API key is the RealBud `rbk_live_…` office key, stored as `OPENROUTER_API_KEY` on the `property` profile. Do not paste a raw OpenRouter key if you want cost to land on this office.

## What this is

- **Engine:** check rent / levy / ledger via the pinned Hermes worker (`server/hermes-pin.ts`). Computer use only for portal buttons that will not script.
- **Options:** per-property switches (how rent lands, what comes out of rent, notify channel).
- **Approve wording:** draft first. RealBud never sends a notice or moves trust.

See `docs/IDENTITY.md`, `docs/WORKFLOW-PLAN.md`, `docs/PRODUCT-BRIEF.md`.

## License

MIT. OpenMausBot copyright remains in `LICENSE`.

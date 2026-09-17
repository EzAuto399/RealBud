# RealBud hosting

Website on **Vercel**. OpenAI admin spend on the **server only**. No Fly.

Supabase is optional later (new `realbud` project in org EzAuto399). Do not reuse `veylet` or `wondertrail-development`.

## Website (Vercel)

From `website/`:

```bash
npx vercel
```

Server env (Vercel project settings — never `NEXT_PUBLIC_` for secrets):

```
REALBUD_SITE_ORIGIN=https://realbud.app
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
OPENAI_ADMIN_KEY=
OPENAI_ORG_ID=
REALBUD_GATEWAY_PORTAL_SECRET=
```

`OPENAI_ADMIN_KEY` is the **admin** key (`sk-admin-…`), not a client inference key. Browser JS never reads it.

Point `realbud.app` at Vercel (Cloudflare DNS CNAME). Email routing stays on Cloudflare.

## OpenAI wiring (our org, one key per office)

1. Create an API key in our OpenAI org for that office. The office does not log into OpenAI.
2. Map `key_…` → `company_id` with `OpenAIOffices.mapKey`.
3. Record FX + **margin policy** per office (`OpenAIOffices.recordPolicy` / private cost `policy`):
   - **Apply a %:** `apply: true`, `method: "margin"` or `"markup"`, `basisPoints` (2000 = 20%).
   - **Skip extra margin:** `apply: false` (or `basisPoints: 0`). Still converts FX and adds 10% GST. The stored % is kept for a later version.
   - Policies are versioned and immutable. To change % or turn it off, record a **new** `version`.
4. Monthly: poll `GET /v1/organization/costs?group_by=api_key_id` → retail AUD (margin only if `apply`) → tax invoice.
5. Clerk invitation to the billing owner. They accept rates, then pay on Square.

Do not bill from org wallet balance. Do not put wholesale USD or margin % on `/account`. Clients cannot toggle margin.

## Gateway (this Node service)

Run next to the operator until a RealBud Supabase/Postgres ledger exists:

```bash
# secrets: managed-gateway/.env.local (gitignored)
export REALBUD_GATEWAY_PORTAL_SECRET="$(openssl rand -hex 32)"
export REALBUD_GATEWAY_DATA=./data
node --experimental-strip-types server.ts
```

`.env.local` may hold `OPENAI_ADMIN_KEY` and `OPENAI_ORG_ID`. Website `REALBUD_GATEWAY_URL` is this service’s HTTPS origin.

## Square

Set `REALBUD_PAYMENT_MODE=sandbox` and `REALBUD_AUTHORIZE_COLLECTION=1` only after Square credentials and webhook URL are on **this** service. Card entry stays on Square.

## Clerk invites

After the Vercel Clerk app exists: create the user (or invitation) for the agency email, then insert `billing_accounts` for that `user_…` id. Same `company_id` as the OpenAI key mapping.

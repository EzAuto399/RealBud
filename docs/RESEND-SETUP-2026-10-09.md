# RealBud Resend setup: Claude Code handoff

Verified on 9 October 2026 (Australia/Brisbane).

## Production configuration

- Resend domain `notify.realbud.app` is Verified.
- Dedicated key: `RealBud website production`, Sending access restricted to
  `notify.realbud.app`.
- Key metadata: https://resend.com/api-keys/e60f4a4a-6148-4aa9-bf44-573dc8cd0e5a
- Vercel project: `ezauto399s-projects/realbud`.
- `RESEND_API_KEY` is saved as a Production Secret in Vercel.
- Sender used by the existing invite implementation:
  `RealBud <no-reply@notify.realbud.app>`.
- Supabase sign-in continues to use its separate `RealBud Auth SMTP` key.

## Deployment and verification

- Redeployed the existing production deployment, without deploying the dirty
  local checkout.
- New deployment: `dpl_BbcUAwyf3C8BmUoNBjh89RsX7Ffa`.
- Deployment URL: https://realbud-mzimctx98-ezauto399s-projects.vercel.app
- `https://realbud.app` resolves to this deployment; Vercel reports READY.
- Approved test recipient: `yoda@yodalai.xyz`.
- Subject: `RealBud email setup test`.
- Resend accepted the request with HTTP 200, and the dashboard confirmed
  Delivered for email `01a11d9c-b46a-7bed-88bf-a222ef4aa9a6`.
- Delivery receipt: https://resend.com/emails/01a11d9c-b46a-7bed-88bf-a222ef4aa9a6
- The two invite-email tests from website commit `888decd` pass. They cover the
  recipient, sender, reply-to, message payload, missing key, refusal and network
  failure.
- The live test exercised the Resend API with the production key. No customer
  invitation was created or sent, and the complete production invitation flow
  was not exercised in this session.

## Credential storage

The same API key is saved in the Yoda Hermios workspace under **resend realbud**,
category **API Key**. Hermios readback confirms `hasSecret: true`.

Vault entry:
https://yoda.hermios.app/object/vaultItem/bb66be78-c683-4358-ada0-e474a6b41c05

No secret value is included in this file, chat output, or source code. Use the
Hermios web Vault secret controls for authorized credential access. Vercel's
Production Secret is already configured; another key or redeploy is not needed
for this setup. Local development and preview environments were not configured
with a production sending credential.

# Hosting decision needed — 22 September 2026

Pick one line. Everything below it is already coded and waiting on the choice.

| Option | What it costs you | What it unblocks |
| --- | --- | --- |
| Fly.io (Sydney), as `managed-gateway/deploy.sh` already targets | One `fly auth login`, secrets exported once, roughly A$10–30 a month for two small apps | Managed gateway and connector service live; vendor keys leave customer machines; subscription enforcement becomes a real service |
| Vercel for the portal only, keep the gateway local for now | Nothing new; the portal already builds with `next build` | Portal sign-in and remote approvals live; connector custody stays a documented gap |
| Neither yet | Nothing | Local key custody stays the model; the "vendor-only custody" claim stays unmade in every doc |

Conflicts to resolve with the choice: `managed-gateway/DEPLOY.md` says "No Fly" while `deploy.sh` and `fly.toml` deploy to Fly; the Supabase projects named `veylet` and `wondertrail-development` must not be reused; no `NEXT_PUBLIC_` variable may carry a secret. The data-flow and retention disclosure must be written before any customer source data is routed through the connector service.

Reply with the option name; the deploy documents get aligned and a runbook prepared, and you run the deploy commands yourself.

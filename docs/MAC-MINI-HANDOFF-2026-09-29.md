# Mac mini handoff (29 September 2026)

Work moves from the MacBook to the Mac mini. On 29 September every local change was committed, every open RealBud and RealBud-website pull request was merged into `main`, and both checkouts were left on `main`. This checkpoint covers source and git state only. It does not establish a packaged build, installed-device behavior, live integration or customer acceptance on the Mac mini.

## Repositories and layout

| Repository | Path on the Mac mini | Notes |
| --- | --- | --- |
| `EzAuto399/RealBud` | `~/projects/RealBud` | Desktop app, server, managed gateway |
| `EzAuto399/RealBud-website` | `~/projects/RealBud/website` | Separate repo nested inside RealBud. It imports `../../shared`, so it must live exactly here. The parent repo ignores `/website/`. |

## Setup

1. `git clone https://github.com/EzAuto399/RealBud.git ~/projects/RealBud`
2. `git clone https://github.com/EzAuto399/RealBud-website.git ~/projects/RealBud/website`
3. Install Node 24 (`.nvmrc`) and pnpm 10.33 (`corepack enable`).
4. `cd ~/projects/RealBud && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`
5. `cd website && npm ci && npx tsc --noEmit -p tsconfig.json && npm test`

## What git does not carry

Move these through a password manager or an encrypted transfer. Never commit them.

1. `website/.env.local`: website server secrets (see `website/.env.example` for names).
2. `~/.realbud`: local RealBud data, including `company-installation` and backups.
3. `~/.hermes/profiles/property`: the pinned headless worker profile. Recreate it through RealBud setup rather than copying other Hermes profiles.
4. Apple signing and notarization credentials, Fly and Vercel CLI logins, GitHub CLI login (`gh auth login`).
5. MacBook-only worktrees under `~/projects/RealBud-*` and `~/projects/rb*`. Their branches were merged or are superseded; they do not need to move.

## Known open items

1. CI `typecheck + test (windows-latest 1/3)` fails on `main` in `server/service-entitlement-install.test.ts` (`windows-acl:inheritance-not-protected`). It fails the same way on `main` before this merge; it passes on macOS and Ubuntu.
2. The managed gateway now requires the scoped RealBud Modelvia secret (merged PR #25). The next gateway deploy fails closed until that protected value is set on Modelvia and the gateway. Follow `managed-gateway/DEPLOY.md`; no Fly action was taken.
3. The website deploys to Vercel manually. Merging to `main` did not deploy.
4. Evidence tiers and remaining release gates are unchanged: see [END-STATE](END-STATE.md), [Next Mac run](NEXT-MAC-RUN-2026-09-25.md) and [Next Windows run](NEXT-WINDOWS-RUN-2026-09-25.md).

# Organisation connection audit — 6 October 2026

This checkpoint does not establish a packaged or installed build, operation between two physical computers, a Windows host, the deployed website or gateway, or customer acceptance. The fixes below are uncommitted.

Integration note, 10 October: on main, the desktop fixes and the Workspace "Office & colleagues" row are integrated on top of the 9 October people, access and identity checks (branch `claude/integrate-shared-checkout`). The "RealBud account" renaming on the desktop and in onboarding is not, because main keeps "Website account" and the link-code-first connect step; the office status button keeps main's name, "Check company status". The website fixes live in the separate website repository and are not part of that integration.

Scope: every control an organisation-linked computer uses, on both connection layers, plus the local host↔join capability.

- **Website account (cloud):** billing, computer pairing and status, website work requests, shared office Gmail, workspace access. Lives in `website/` (its own git repo).
- **Local office host:** one office computer runs owned PostgreSQL behind pinned TLS; other computers join it for cases, departments, templates and membership. Private Desk, Ask, sources and schedules never leave a computer.

Receipts: `outputs/org-audit-2026-10-06/` (`lab/`, `desktop/`, `desktop-after/`, `website/`, `fix-website-a/`, `fix-website-b/`). Evidence tier throughout: source, local tests, local renders with fictional data. No packaged installer, second physical device, Windows host or live integration.

## Proven locally

| Check | Result |
|---|---|
| Office server tests, real PostgreSQL (`server/company*`) | 358/358; needs `LC_ALL=en_US.UTF-8` on this Mac or postgres exits ("postmaster became multithreaded"); kernel suites need `REALBUD_COMPANY_TEST_URL` with a `realbud_company_test_*` database |
| `pnpm qa:company` | 757 tests pass |
| `scripts/qa-two-desktop-lab.mjs` (two compiled services) | 8/8 after correcting its stale invite-replay expectation (401 → 409 `seat_identity_conflict`, matching `qa-two-instance-team.mjs`) |
| Portable 12/12, seat isolation 10/10, Electron pinned TLS 3/3 | pass |
| Desktop components | 507/507; two-server render 14/14 steps, 0 page errors, no overflow at 390/1440 |
| Website `npm test` | 302 pass, 1 skipped (gateway operator-token test needs gateway source beside website); `qa-commands-ui`, `qa-portal-identity`, `qa-portal-billing-ui` pass from a scratch build |

## Fixed (uncommitted)

Desktop: background status checks no longer disable forms; a failed check keeps the member's office, name and role and shows last successful check; one "Can't reach the host? Disconnect this computer" entry opens the existing offline-disconnect review; owner member list reloads after checks and invites; only pending invitations offer Cancel; admin and joining directions point to real controls; office-card buttons are 44 px.

Website: Gmail mode switch confirms and states how many computers lose access; "Show connection link again" after reload; mailbox mutations require a current person session (`requirePortalPerson`), legacy cookies may only read; specific mailbox errors; case-insensitive mailbox match with hint; service-invoice Pay requires same-origin JSON, returns fixed error codes and holds against double payment; sign-out reports failure; non-JSON errors never reach staff; label and support copy fixes; phone menu keeps Setup walkthrough and Download; skip link; three QA harnesses brought up to date.

## Simplification (owner direction 6 October: main screens show only what matters; rare things go to Settings)

Website account: the menu is Home / Computers / Billing / Settings. Home is "Needs your action" (unpaid invoices, terms to confirm, computers that stopped checking in, cap not set) plus computers online and AI spend against cap. Computers holds only computers. Billing leads with what to pay and confirm; usage, rates and terms detail fold into "More billing details". Settings holds Office Gmail (`/account/settings/gmail`), Work from the website (the two request surfaces merged on `/account/remote-work`), Workspace access, Company identity, Support, Setup walkthrough and Download. Old URLs redirect. Receipts: `outputs/org-audit-2026-10-06/simplify-website/` (website 302 pass / 0 fail / 1 environment skip; 11 account QA scripts pass from a scratch build).

Desktop: Workspace has an "Office & colleagues" row with a state hint (`#you-company`). Not in an office: Join an office / Host the office on this computer. In an office: office host, signed in as, this computer, departments you can use; owners also see people and Invite someone. Everything else is inside one closed "Office settings". The website link is called "RealBud account" everywhere, including onboarding. Receipts: `outputs/org-audit-2026-10-06/simplify-desktop/` (1650/1650 renderer tests; two-server rig 38/38 steps, no overflow at 390 px).

Not moved: computer link requests cannot be listed on Home (no list route; approval stays on the link the computer shows). Spend caps stay RealBud-set; Billing offers "email support". Not rerun after the move: repo-root `qa-installations-ui.mjs`, `qa-remote-work.mjs`, `qa-onboarding-*.mjs`, `qa-native-private-restore.mjs`, `qa-bud-status.mjs` (selectors updated only); `qa-website-requests`, `qa-remote-work` and `qa-remote-enrollment` already opened `#you-office` for cards that live in Settings & help.

## Open

- `scripts/build-mac-test-kit.mjs:31` copies a guide that exists only in WIP commit b20e1c9a, so the kit build fails on main.
- `qa-two-instance-team.mjs` and `qa-company-portal.mjs` not run (need a signed package receipt / fresh website build).
- Gateway: switching Gmail mode away and back cannot issue a fresh Google link.
- `website/app/api/auth/logout/route.ts` has no Origin check. A definite payment refusal keeps the invoice held in both billing panels.
- Real devices: LAN firewall/NAT, Windows host (admin-token refusal, installer), signed apps both ends, sleep/wake during a claim. The VirtualBox Windows 11 VM is unavailable until `/Volumes/RealBud-TestLab` is mounted.

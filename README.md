# RealBud

RealBud is a business work operating system that runs on the customer's desktop. A person can work
alone, join an office, take part in departments and keep a private workspace that stays private when
they join or leave. It holds the work records, the evidence behind them, the calendar and the
schedules, and it asks for approval before anything consequential happens.

Austin Realty is the first customer workflow pack. Property-management wording, bank and REI
adapters and bill rules belong to that pack rather than to the product. The direction is recorded in
[`docs/decisions/2026-09-21-business-os-and-austin-workflows.md`](docs/decisions/2026-09-21-business-os-and-austin-workflows.md).

The default screens (Desk, Ask, Schedule, You) are meant to stay plain enough for nontechnical
staff, while a member can save views, filters and layouts inside their own role.

## What RealBud owns, and what it does not

- **RealBud owns** the interface, the authoritative work state, identity and permissions, review and
  approval, scheduling and recovery. Every server read and mutation checks the current member,
  company and scope at the authoritative boundary; a tab or a UI filter is not access control.
- **Hermes is a pinned headless worker** behind that interface, on its own isolated `property`
  profile (`pack/property/`, `server/hermes-pack.ts`). It is never launched as an app, its source is
  never edited, and a worker's prompt or permission mode is never authority to bypass a RealBud
  control. The compatibility pin and the install catalog are `server/hermes-pin.ts` and
  `server/hermes-releases.ts`; read those rather than a version quoted in a document.
- **Vendor credentials belong in a managed service that is not deployed.** Composio project keys
  still sit in the local `~/.realbud/config.json`. The decision document calls this a migration gap,
  not the target custody model; a hidden setting or a same-user worker does not make custody
  vendor-only.
- Data lives in `~/.realbud`.

## Naming

RealBud is the product name. Do not ship this as PropertyMe (that is the Australian PMS trademark),
as Hermes (that is the worker), or as OpenMausBot (that is the upstream shell this forks). We sit on
top of that class of software and do not replace trust accounting. MIT, with the OpenMausBot
copyright kept in [`LICENSE`](LICENSE).

## Run from source

Node 24 (see [`.nvmrc`](.nvmrc)) and pnpm.

```sh
git clone https://github.com/EzAuto399/RealBud && cd RealBud
nvm use
pnpm install

pnpm dev:server    # harness server, 127.0.0.1:8799
pnpm dev           # app, http://127.0.0.1:5199
pnpm dev:desktop   # Electron shell; keep the server and Vite running
```

## Checks

```sh
pnpm typecheck        # app + server
pnpm test             # vitest
pnpm check:electron   # syntax-check the plain-JS Electron entrypoints
pnpm qa               # typecheck, test, the two-device evidence gate, then qa:e2e
pnpm qa:e2e           # five HTTP suites from source: no build, no worker, no network
```

`pnpm qa:full` adds the company, second-office, seat-isolation, scale and live-worker runs; several
of those start a disposable local PostgreSQL. Packaging is `pnpm package:mac` (DMG and ZIP, needs
Swift/Xcode tools), `pnpm package:win`, `pnpm package:linux` and `pnpm package:mac:release` for the
notarized path. `pnpm package` is `package:mac`.

Contribution rules, the test layers and the platform constraints are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Repo map

| Path | What lives there |
|---|---|
| `server/` | The harness: HTTP + SSE API (`index.ts`), driver SPI (`contracts.ts`), company/department authority, durable jobs, scheduler, Hermes boundary. Portable Node only. |
| `shared/` | Contracts shared by the server, the renderer and the portal. |
| `src/` | The React app. All traffic goes through `api()` in `src/state/store.tsx`. |
| `electron/` | Desktop shell: service lifecycle, key custody, dictation, screen capture, local computer use. Platform-specific code is gated here. |
| `pack/` | `property/` is the pinned headless Hermes profile (locked policy). Workflow packs are versioned JSON with an immutable installed revision. |
| `scripts/` | QA batteries, packaging smokes, evidence gates. Receipts land in `outputs/<topic>-<date>/`. |
| `managed-gateway/` | Off-device model forwarding, usage accounting and billing. Never mounted on the desktop API. Its tests run from that directory. |
| `docs/` | Direction, decisions and dated receipts. See below. |

## Where to read next

1. [`docs/GOAL-PROMPT.md`](docs/GOAL-PROMPT.md), the current working direction.
2. [`docs/decisions/2026-09-21-business-os-and-austin-workflows.md`](docs/decisions/2026-09-21-business-os-and-austin-workflows.md), the architecture, authority table and acceptance gates.
3. [`docs/END-STATE.md`](docs/END-STATE.md), the short product map.
4. [`docs/REAL-ESTATE-CORE-2026-09-21.md`](docs/REAL-ESTATE-CORE-2026-09-21.md), the current implementation and evidence.

Everything else in `docs/` describes its own date. `docs/NEXT-WAVE.md`, `docs/PM-DAY.md` and anything
under `docs/history/` are dated references, not current scope. Where an older plan conflicts with the
21 September decision, the decision wins. Document conventions are in
[`.claude/rules/docs.md`](.claude/rules/docs.md).

## What is proved

The evidence tiers are source, local tests, packaged build, installed device, live integration and
customer acceptance, and they are never conflated.

- **Proved:** source and local tests. The vitest suite, the HTTP batteries and the PostgreSQL-backed
  QA scripts run from this checkout.
- **Periodic and unsigned:** the packaged macOS candidate. It is built and smoked when a checkpoint
  needs it, and the recorded candidates are unsigned. A signed and notarized path exists in the
  scripts but is not what the receipts contain.
- **Not proved:** Windows installation, the hosted managed connector service, live customer source
  accounts (Gmail, bank, REI Cloud) and customer acceptance. Synthetic fixtures, fictional providers
  and an unsigned package are never customer evidence.

## For coding agents

[`.claude/rules/`](.claude/rules) holds path-scoped conventions for `server/`, `src/`, `electron/`,
`pack/`, `scripts/`, `managed-gateway/`, `website/` and `docs/`. [`.claude/agents/`](.claude/agents)
holds the surveyor, implementer, reviewer and test-runner definitions. `CLAUDE.md` is the entry
point.

This checkout is shared: another session may be editing it at the same time. Stay inside the files
you own, preserve unrelated edits, and do not start a package build or a PostgreSQL-backed suite
while another one is running. Check the running processes and the recent `outputs/` first.

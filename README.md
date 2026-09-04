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

## What this is

- **Engine:** check rent / levy / ledger via the pinned Hermes worker (`server/hermes-pin.ts`). Computer use only for portal buttons that will not script.
- **Options:** per-property switches (how rent lands, what comes out of rent, notify channel).
- **Approve wording:** draft first. RealBud never sends a notice or moves trust.

See `docs/IDENTITY.md`, `docs/WORKFLOW-PLAN.md`, `docs/PRODUCT-BRIEF.md`.

## License

MIT. OpenMausBot copyright remains in `LICENSE`.

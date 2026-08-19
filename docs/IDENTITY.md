# RealBud identity

Fork of OpenMausBot (MIT). We own the **visible window**. Hermes is a pinned **headless** worker (`server/hermes-pin.ts`, profile `property`), not the brand and not the OS. Models attach on that profile (`hermes -p property model`). Claude/Codex/Grok are not RealBud agents. Never launch Hermes.app. Never edit Hermes source.

| Surface | Old | New |
|---|---|---|
| Display name | OpenMausBot | **RealBud** |
| npm / linux package | openmausbot | **realbud** |
| appId | com.openmausbot.app | **com.realbud.app** |
| desktop id | com.openmausbot.app.desktop | **com.realbud.app.desktop** |
| Health `/api/health` | `openmausbot` | **realbud** |
| Data dir | `~/.openmausbot` | **`~/.realbud`** (migrates from `.openmausbot` if present) |
| Chrome profile | `~/.openmausbot/chrome-profile` | `~/.realbud/chrome-profile` |
| GitHub | EzAuto399/PropertyMe | **EzAuto399/RealBud** |
| Updates | milind-soni/openmausbot-releases | **EzAuto399/RealBud** (no public updater until we cut a release) |
| Author | Milind Soni | **EzAuto399** |
| Do not use | PropertyMe (PMS trademark), Hermes, OpenMausBot | — |

Internal env (`OMB_PORT`, `OMB_DATA_DIR`, …) stays so tests and Electron wiring do not break.

Leave MIT copyright for OpenMausBot contributors in `LICENSE`.

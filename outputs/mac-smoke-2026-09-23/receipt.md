# Packaged Mac smoke — 23 September 2026

Layer: unsigned macOS arm64 package built from source at `7b0e2990` (`pnpm package:mac`, 479 s, `release/RealBud-0.1.19.dmg`). Not signed, not notarized, not an installed-device or customer test.

| Run | Result |
| --- | --- |
| `pnpm package:mac` | exit 0 (`package.log`) |
| `pnpm smoke:mac` (`scripts/smoke-mac-package.mjs`) | `OK: renderer, capabilities, embedded harness, and shutdown`, exit 0 (`smoke.log`) |

What changed since the 22 September smoke and is covered here: private directory admission sharing, the vault development-key ordering, the Hermes profile batching in `server/hermes-pack.ts`, and the office-link provisioning wiring all load and boot inside the packaged app on macOS.

## Limits

Startup, the preload bridge, the embedded service and clean shutdown only. Sign-in start, keep-awake, onboarding steps, Gmail connection, Modelvia provisioning and the recovery wait page were not driven. No Gatekeeper, notarization or installed-device claim.

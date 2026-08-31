# Graduate release — production path

Date: 2026-08-31  
Canonical constraints: `docs/GOAL-PROMPT.md` wins.  
Pilot fields: `docs/PILOT-CONTRACT.md`. Pickup: `docs/NEXT-WAVE.md`.

Owner direction (2026-08-31): **strata portal** for a Dickson ACT property, plus
**full graduate release** — notarized Mac DMG, signed Windows NSIS, double-click
installer with pinned worker available without a terminal.

This file is the ship sequence. Do not invent an agency name in code. The PM
types the eight fields on You → This office.

---

## Target

| Artifact | Trust gate | Worker |
|---|---|---|
| `RealBud-<ver>.dmg` + arm64 zip | Developer ID (have) + **notarytool + staple** | Mac: curl pin install in-app today; bundle later |
| `RealBud-<ver>-setup.exe` | **Authenticode** (need cert) | Windows: `installCommand` is null → **bundle or CSV-only** |
| GitHub release on `EzAuto399/RealBud` | Upload DMG/zip/`latest-mac.yml` + setup.exe/`latest.yml` | Auto-update reads that public repo |

---

## Wave order (do not reorder)

```text
0. Name the office (You → This office, eight real fields)
1. Mac notarize + staple + smoke stapled .app
2. Strata Stage-0 on Dickson portal (human login, Bud prefill only, human Submit)
3. Windows Authenticode + NSIS verify
4. Bundle pinned Hermes into installer (unlocks win32 installCommand)
5. Cut public GitHub release + arm updater
```

Inbound mail, Pocket, Ask clock proposals (PR C), and unrestricted live CUA
still wait. Strata Stage-0 is one portal, one account, one property — same
spike boundary as the fake portal, re-run against the real origin.

---

## Wave 0 — Name the office

On You → This office, type real values (training names do not unlock):

| Field | Dickson / strata pilot example (fill with your real values) |
|---|---|
| Agency | Your shop or landlord entity — **not** “RealBud Demo Book” |
| Who runs Recheck | Named person |
| PMS brand | `other` if money is CSV-only and the portal is strata |
| Named exporter | Who pulls / exports arrears or ledger |
| Export cadence | daily / weekly / … |
| Export identity | address / property-id / property-code |
| Office computers | **macOS** (required for live CUA later) |
| Jurisdictions | **ACT** |
| Vendor test account | Strata portal login **label** (not the password) |

Completing the form sets `demo: false` on the pilot contract and can make
`readyForLivePortal` true on macOS. It does **not** auto-launch a browser.
Stage-0 against the real strata origin is Wave 2.

---

## Wave 1 — Mac notarize (T17 Mac) — DONE for 0.1.17

**Have:** `Developer ID Application: Yo-Da Lai (4F4SMS88P8)` + keychain
profiles `realbud-notary` and `ClawConnect` (validated 2026-08-31).

**Ship artifacts (local `release/`, gitignored):** notarized + stapled
`RealBud-0.1.17.dmg` and `RealBud-0.1.17-arm64.zip` with fresh
`latest-mac.yml` + blockmaps. Gatekeeper: `source=Notarized Developer ID`.

```bash
pnpm notary:store          # once, if keychain profile missing
pnpm package:mac:release   # build → notarize → drop unpacked tree
pnpm clean:release         # keep one version's dmg/zip only (~300MB)
pnpm clean:release --all   # wipe release/ entirely
```

Do **not** bump `package.json` version until the next real ship. Rebuilds
overwrite the same `0.1.17` artifacts.

---

## Wave 2 — Strata Stage-0 (Dickson ACT)

Same spike rules as `server/testing/fake-portal.ts` / `docs/PILOT-CONTRACT.md`:

1. PM logs into the strata portal in Chrome (password never stored in RealBud).
2. Publish a **candidate recipe** with the real `allowedOrigins` (not `127.0.0.1`).
3. Bind one property (Dickson address) to that recipe + remote property id.
4. Bud may **read** and **prefill** only. Bud **submit** stays forbidden.
5. Human clicks Submit once. Result confirmed or `effect-unknown`.
6. Capture SSO/MFA/frame quirks in the visit notes — do not expand the adapter
   until this spike is green.

Live CUA Stages 2–3 (`docs/PORTAL-WORK.md`) build only after Stage-0 evidence.

**Need from the office:** portal product name + base URL (e.g. StrataPay /
BuildingLink / custom body corporate portal).

---

## Wave 3 — Windows signed NSIS (T17 Win)

1. Obtain Authenticode cert (or Azure Trusted Signing).
2. Configure `win.signtoolOptions` in `electron-builder.yml`.
3. Only then set `publisherName` in updater metadata.
4. Build on Windows: `pnpm package:win` (see `.claude/skills/windows-release`).
5. Upload `RealBud-<ver>-setup.exe` + `latest.yml` to the same GitHub release tag.

Until a worker is bundled, Windows UI must stay honest: CSV-only / no in-app
Hermes install (`hermesInstallCommand` returns null on win32).

---

## Wave 4 — Bundled worker

Goal: graduate double-clicks RealBud and never opens Terminal.

| Platform | Today | Target |
|---|---|---|
| macOS | In-app curl pin install | Optional: ship pinned runtime under `extraResources` |
| Windows | `installCommand: null` | Bundle pinned Hermes + pack, or ship a Windows installer path |

Pin stays `server/hermes-pin.ts` (v0.20.3). Do not track upstream main.

---

## Wave 5 — Public release cut

1. Bump `package.json` version.
2. Notarized Mac artifacts + signed Windows artifacts.
3. `gh release create vX.Y.Z` on `EzAuto399/RealBud` with:
   - `RealBud-X.Y.Z.dmg`, `.blockmap`, `RealBud-X.Y.Z-arm64.zip`, `.blockmap`, `latest-mac.yml`
   - `RealBud-X.Y.Z-setup.exe`, `.blockmap`, `latest.yml`
4. Smoke stapled Mac; install smoke on Windows.
5. Confirm packaged updater points at `EzAuto399/RealBud` (`app-update.yml`).

---

## Explicitly still off

- Inbound Gmail / Microsoft 365
- Pocket / WhatsApp for the PM
- Ask proposes clock change (PR C)
- Bud Submit / pay / statutory draft
- PropertyMe trademark as product name

---

## Daily gate while shipping

```bash
pnpm qa:full
pnpm package:mac:release    # build + notarize + clean unpacked
# release/ stays ~300MB (one version dmg+zip). Wipe with: pnpm clean:release --all
```

Stay on one `package.json` version until a real public cut. Overwrite the same
artifacts instead of stacking `0.1.18`, `0.1.19`, … on disk.

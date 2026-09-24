# Graduate release — production path

Date: 2026-08-31  
Canonical constraints: `docs/GOAL-PROMPT.md` wins.  
Pilot fields: `docs/PILOT-CONTRACT.md`. Pickup: `docs/NEXT-WAVE.md`.

**Windows continuation — 23 September 2026:** [Windows build and test](WINDOWS-BUILD-AND-TEST.md)
supersedes this August plan's Windows prerequisites and CSV-only/no-worker
assumptions. Windows now has managed worker setup and a compiled speech helper.
The guide records current evidence and remaining feature/device gates; later
working-tree changes still need a matching Windows build and acceptance run.
The signing and public-release requirements below remain separate gates.

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
| `RealBud-<ver>-setup.exe` | **Authenticode** (need cert) | Windows: managed private runtime setup; fresh-device worker/model acceptance remains separate |
| GitHub release on `EzAuto399/RealBud` | Upload DMG/zip/`latest-mac.yml` + setup.exe/`latest.yml` | Auto-update reads that public repo |

---

## Wave order (do not reorder)

```text
0. Name the office (You → This office, eight real fields)
1. Mac notarize + staple + smoke stapled .app
2. Strata Stage-0 on Dickson portal (human login, Bud prefill only, human Submit)
3. Windows Authenticode + NSIS verify
4. Review bundled-worker distribution (Windows managed setup already exists)
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

**Historical proof:** `Developer ID Application: Yo-Da Lai (4F4SMS88P8)` and
notarization profiles were validated on 2026-08-31. The current candidate's
`realbud-notary` credentials returned HTTP 401; the earlier validation is not
current notarization proof. Follow the [Mac build and test guide](MACOS-BUILD-AND-TEST.md)
for native arm64 Node 24, pnpm 10.33.0, Xcode/Swift and dependency prerequisites.

**Historical artifacts (local `release/`, gitignored):** notarized + stapled
`RealBud-0.1.17.dmg` and `RealBud-0.1.17-arm64.zip` with fresh
`latest-mac.yml` + blockmaps. Gatekeeper: `source=Notarized Developer ID`.

```bash
pnpm install --frozen-lockfile
pnpm package:mac
pnpm smoke:mac
# If missing or rejected by Apple, refresh locally with pnpm notary:store.
pnpm package:mac:notarize
pnpm smoke:mac
# Preserve artifact hashes, receipts and required app tests before optional cleanup.
pnpm clean:release
```

Do **not** bump `package.json` version until the next real ship. Rebuilds
use the version in `package.json` (currently `0.1.19`). The `0.1.17` artifacts
above are historical evidence, not the current build output.

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
4. Build on native Windows x64: `pnpm package:win` (see [Windows build and test](WINDOWS-BUILD-AND-TEST.md)).
5. Upload `RealBud-<ver>-setup.exe` + `latest.yml` to the same GitHub release tag.

The earlier CSV-only restriction inferred from `hermesInstallCommand` is
superseded: that legacy terminal command is disabled on every platform, while
`server/worker-bootstrap.ts` runs checksum-verified Windows setup stages in the
private managed runtime. The package includes Windows speech, browser/CUA
helpers and PostgreSQL. Installed worker/model setup, GUI behavior, attended CUA
and memory review retain their explicit proof requirements and platform holds;
packaging those components does not establish full Windows operation.

---

## Wave 4 — Bundled worker

Goal: graduate double-clicks RealBud and never opens Terminal.

| Platform | Today | Target |
|---|---|---|
| macOS | In-app curl pin install | Optional: ship pinned runtime under `extraResources` |
| Windows | Managed, checksum-verified private runtime setup | Verify fresh-device setup; bundling the complete worker remains a separate distribution choice |

The compatibility floor stays in `server/hermes-pin.ts`; fresh installs use
the reviewed recommendation in `server/hermes-releases.ts`. Do not treat the
older compatibility pin as the current installer target or track upstream main.

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
pnpm package:mac
pnpm smoke:mac
pnpm package:mac:notarize
pnpm smoke:mac
# Preserve hashes, receipts and app test results before optional pnpm clean:release.
```

Stay on one `package.json` version until a real public cut. Overwrite the same
artifacts instead of stacking `0.1.18`, `0.1.19`, … on disk.

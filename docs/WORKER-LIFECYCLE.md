# Worker lifecycle — the hidden spine

Historical design: 2026-08-31. Reviewed 2026-09-10.

**This page is superseded by [RealBud as a modular harness over Hermes](REALBUD-HERMES-HARNESS-2026-09-10.md).** The current source preserves the independently installed Hermes runtime during repair/removal, admits an explicit compatibility list, and still deletes the RealBud property profile on removal. Startup also reapplies the pack. Persistent disable state, non-destructive profile recovery and independent module lifecycle are proposed work, not shipped guarantees. The text below is retained as historical context and must not be used as an installation or deletion contract.

Hermes is the spine, and the spine stays hidden: the user knows Bud, and the
machinery appears only under Advanced diagnostics. The lifecycle has four verbs.

## Install

You → Bud runs the pinned installer in-app (streamed progress, no terminal).
The pin (`server/hermes-pin.ts`) is the only supported build.

## Repair

"Repair Bud" re-runs the installer at the **same pin** and re-applies the
property pack. This is the answer to a broken or half-installed worker: same
supported build, fresh files, profile config and attached model preserved.
It never moves the pin.

## Remove

"Remove Bud" deletes the pinned worker files and the property profile from this
Mac and stops treating the worker as present. **The book is untouched.** RealBud
degrades honestly: Desk, Book, CSV import, loops, and Ask's book answers keep
working; Recheck, free-form Ask, jobs, and channels that need a worker say
"Bud is not installed — reinstall from You → Bud" instead of failing strangely.
Reinstall is Install above; nothing about the book is lost.

## Update

The pin is deliberate — RealBud never tracks upstream main. Worker updates ride
the **app's** release train: a new RealBud release carries a new tested pin, and
the app's own updater (electron-updater, sidebar Check for updates) delivers it.
After an app update, You → Bud re-verifies the pin and offers Repair if the
worker no longer matches. There is no in-app "upgrade Hermes to latest" button;
latest is not a supported build.

## What the UI may say

- Install / Repair / Remove live on You → Bud. Remove asks once, in plain
  language: "Remove Bud from this Mac? Your book stays. You can reinstall any
  time." — the one confirmation, because deleting files is one-way.
- Status copy stays honest: after Remove, `ready` is false and the hands test
  is gone; nothing claims a worker that is not there.

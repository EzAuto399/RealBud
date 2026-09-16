---
name: windows-release
description: Build, verify or publish RealBud Windows installers and update feeds. Use for a Windows release or Windows update-delivery failure.
---

# RealBud Windows release

Use this checkout's `package.json`, `electron-builder.yml`, `.github/workflows/package-win.yml` when present, and `docs/GRADUATE-RELEASE.md` to resolve the current pipeline. Build on Windows or its existing Windows CI runner. Read the installed Node/pnpm requirements; avoid a macOS Wine workaround.

A request to build an installer authorizes preparation and checks. Uploading a release or changing an update feed requires the corresponding release authority. Continue through already authorized stages; do not ask again merely because the workflow has several steps.

## Prepare and build

Resolve the requested version and target repository from current source and the release request. This project's existing release destination is `EzAuto399/RealBud`; confirm the selected checkout matches it. A proof build does not need a version bump. For a versioned release, align package version and tag using the existing process.

Use `pnpm typecheck` and `pnpm package:win` with the checkout's lockfile and Windows environment. Inspect what the script actually includes: Hermes installation, Cua/native controls and speech packaging have changed across checkouts. Do not assume CSV-only operation, no Windows speech helper, or successful native control from an old instruction file.

## Verify artifacts and installation

Check the unpacked resources contain `server/index.js`, `ui/index.html` and the expected `app-update.yml`. Verify the generated update configuration targets the intended repository/channel. Missing server code can prevent service startup; missing UI can produce a blank window.

Check the emitted versioned installer, blockmap, portable artifact when configured, and `latest.yml`. The generated feed must point to the correct installer and digest. Never hand-edit `latest.yml` or substitute an unverified binary.

Exercise per-user installation and startup on Windows, Desk rendering, update behavior and relevant native/worker flows. Keep local logs sanitized. A Windows CI build or a Mac test does not prove a clean Windows install or customer workflow.

Resolve signing state from this build's configuration and signature verification. If unsigned, do not add an unsupported `publisherName` or claim signing. For signed updates, preserve the accepted certificate subject or a deliberately supported subject transition. Never expose signing credentials.

## Publish only within release scope

For an authorized customer release, keep Mac notarized and Windows artifacts on the same version/tag according to the current release policy. If Windows cannot ship, hold the customer release or explicitly disclose the Windows freeze in release notes. A local proof build does not require publishing another platform.

Upload the generated versioned installer, stable `RealBud-setup.exe` alias when used by the website, blockmap and update feed to the intended tag. Verify actual download URLs and feed hashes after upload. Publishing the feed is an external customer-facing effect; do not infer permission from the presence of `gh` credentials.

Report source/version, packaged files, signature status, uploaded/feed status and actual Windows installation/worker evidence separately. Preserve failed build/release state and use the current recovery path instead of blindly bumping a second version.

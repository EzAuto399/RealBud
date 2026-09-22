---
paths:
  - "electron/**"
  - "electron-builder.yml"
  - "scripts/package-files.mjs"
  - "scripts/smoke-*.mjs"
---

# electron/ and packaging conventions

- Service identity is the hash of the data directory published on `/api/health` (`electron/service-instance.mjs`); a PID is never identity, and a responder with a different `instanceId` is ignored, never adopted. Adopt our own running service before starting one: two services over one data directory or company database is the worst outcome here.
- The office service is spawned detached and unref'd so it outlives the window; quitting must not stop it. A saved PID never authorizes a signal: stop only through authenticated `POST /api/service/stop` with the per-process control token, and only when `sha256(controlToken) === health.controlId` and pid/port match (`electron/service-lifecycle.mjs`). A corrupt or foreign handle parses to `null` ("cannot manage"); it never throws.
- Port choice binds a real loopback socket and grants no authority; restarts reuse the port the window loaded because the renderer origin is fixed. One instance only. Shutdown hooks run on `will-quit` with a bounded race; supervisor restarts are bounded (3 per 10 min, backoff, one start in flight).
- Only `electron/desk-key-custody.mjs` chooses the workspace key; main passes the hex through the child env and nothing else. A locked or unreadable wrapped key is never permission to mint a new identity; preserve the old copy before rewrapping; write temp → fsync → rename at 0600; reject symlinks, hardlinks, wrong size, mode or uid before reading.
- The renderer sees only the narrow `window.ogb` bridge (`electron/preload.cjs`): no Node, no `ipcRenderer`, no key, no data path; `contextIsolation` stays on. Renderer text never becomes a process argument.
- Keep pure modules (`capabilities.cjs`, `perm-settings.cjs`, `service-lifecycle.mjs`) importable from tests without booting Electron. `electron/*.test.mjs` run under vitest (`pnpm exec vitest run electron/<file>`). Add every new entry module to `pnpm check:electron`.
- Packaging: the ASAR carries `electron/**` minus tests; UI, server, packs and Postgres ship as `extraResources`. `shared/service-identity.mjs` must stay in electron-builder `files` and stay plain `.mjs`. Use `listPackageZip`/`copyPackageRuntime` in `scripts/package-files.mjs`, never Unix `unzip`/`cp`. Build hosts are `darwin-arm64` and `win32-x64` only. `latest*.yml` ships with the artifacts; `publisherName` stays unset until real signing.
- Windows: file privacy is ACLs applied through env-passed PowerShell (`server/windows-file-privacy.ts`), never interpolated paths; `path.isAbsolute` accepts `/x` on win32, so validate drive or UNC roots explicitly. Native Windows proof comes only from a win32 run; a skip elsewhere is not evidence. Smoke scripts prove inventory, hashes, pinned helper versions and clean exit, not workflows or customer acceptance.

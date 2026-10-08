# Workroom reads without a script approval — 8 October 2026

This checkpoint does not establish a packaged or installed build with this tool, a real Bud model choosing it over `execute_code`, or Windows behaviour. Evidence tier: **source and local tests.** The change is on branch `claude/workroom-read` and is not merged.

## Why

Bud asked for approval to run Python just to read an uploaded Property.csv and its timestamp. Every native `execute_code` script needs its own approval (`HERMES_EXEC_ASK=1`), and that rule stays as it is. Main already writes an `.inspection.json` report beside each new Ask CSV upload (`server/ask-csv-inspect.ts`). That covers fresh uploads up to 750 KB. It does not cover older uploads, larger files, files in `bud-work`, listing, or a file's metadata.

## What changed

Codex's 30 September `workroom_read` tool (snapshot `25700309`) is ported onto main's loopback broker pattern (`startLoopbackToolServer`).

- `server/workroom-read.ts` is the fixed, read-only reader. It can list, stat, read UTF-8 text a page at a time, or inspect a CSV: exact row counts plus per-column present, blank and distinct counts across the whole file. Leading zeros are kept. Malformed, oversized or changing input fails with no partial stats. It rejects external, `..`, hidden, linked (symlink and hardlink), special and private-storage names (`desk.json`, `desk.key`, Desk backups, `credentials.json`). A host-chosen root reached through a link above it, such as macOS `/var` or `/tmp`, is resolved. The root itself must not be a link.
- `server/workroom-read-broker.ts` serves the tool to the worker. It needs an active turn and checks entitlement before and after each read. If Stop, a new turn, a member change or lost entitlement happens during a read, Bud gets no file data. File data comes back inside untrusted-data markers.
- `server/drivers/acp/core.ts` mounts the tool for Hermes Ask only. The mount is pinned to the first turn's root and member scope. A change of either changes the runtime signature, so the warm process and its broker are replaced.
- `server/index.ts`: host binding. The root is `<DATA_DIR>/vault`, the scope is `profile:memberKey`, and the tool is active only while that member is current and Desk is not in recovery.
- `server/ask-book.ts`: Bud is told to prefer `workroom_read` for routine file work, never to wrap it in `execute_code`, and that a file's modification time is not a source date.

Not ported: the snapshot's connected-apps/Gmail changes (already on main), its package version bump and its 30 September docs.

## Verification

- **Local tests:** 177 passed / 0 failed / 0 environment-gated skipped, across `server/workroom-read.test.ts`, `server/workroom-read-broker.test.ts`, `server/drivers/acp/acp.test.ts`, `server/ask-book.test.ts` and `src/lib/tool-label.test.ts`. Log: `outputs/workroom-reads-2026-10-08/tests.log` (local only).
- `pnpm typecheck` and `pnpm exec tsc -p tsconfig.server.json` are clean.
- A source boot under `node --experimental-strip-types server/bootstrap.ts`, with a disposable data folder, answered `/api/health`.

## Not verified

- A real Bud model choosing `workroom_read` over `execute_code` on an installed build.
- Windows path behaviour beyond the unit tests (reserved names and case-insensitive prefixes are coded but untested on Windows).
- Broker port headroom. `BROKER_PORT_POOL_SIZE` is 96, sized for about 10 brokers per turn and 8 warm sessions. An Ask turn with every integration can now mount 14.

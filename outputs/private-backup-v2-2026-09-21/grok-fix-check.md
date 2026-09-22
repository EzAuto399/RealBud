**Invariant 1 — PASS** (on the supplied gate + Telegram test)

`WorkspaceActivityGate.run` waits while a snapshot owner exists, then **always** calls `assertAdmission()` before `running++` or `work`. Shutdown sets `shuttingDown` then `cancelPause()` (`server/index.ts`), so waiters wake with no owner and throw 409 before the callback. Restore is the same if `privateRestoreLocked` is already true when they resume. `running` is not incremented on that throw, so the handler never becomes “admitted drain.” The Telegram test matches: shutdown during pause → rejection, offset 10, no `startTurn`, message not stored.

**Invariant 2 — PASS**

`recoverReadyWork` bails on `canRecover?.() === false` **before** `available()`, and again **after** the await, before `commit`/`kick`. Host `canRecover` is sync: `!paused && !privateRestoreLocked && !shuttingDown`. `pause()` sets `this.owner` before its first await, so `paused` is visible immediately. Failure returns without changing status/`waitingForWorker` and without `kick`; `finally` clears `recovering` so a later probe can resume. `stop()` is unused. The unit test covers hold before and during the probe, unchanged file, no worker, then a later finish with attempts `[1, 1]`.

**Remaining defects (these two fixes only)**

None in the quoted control flow, assuming channel persist/decision sit inside `gate.run` (as the Telegram test does) and restore sets `privateRestoreLocked` before waiters pass `assertAdmission` (same order as shutdown). A restore that cleared the pause **before** the lock could admit a waiter; that setter is not in the packet.

**Source-only limits**

No tests were run. Discord/Slack handlers, restore-lock sequencing, and `kick()` are not in the packet. This cannot prove other channels wrap persist the same way, or that a live restore/shutdown interleaves as intended.
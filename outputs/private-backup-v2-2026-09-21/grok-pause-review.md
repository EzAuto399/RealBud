## Verdict

The gate’s nested-drain / waiter-queue design is coherent in isolation, and several host requirements **are** visible in the shown code: session checks run before the snapshot 409, export still double-reads real files/records/epoch, `onReleased` does not clear restore/shutdown, channel `stop*` is not used for snapshot, and `decideRemotelyAdmitted` revalidates after the wait. There are still concrete defects in the **integration** of `cancelPause`, admission depth, and ungated writers.

---

## P1 — Shutdown resumes snapshot waiters, who persist channel cursor before work is refused

**Where**
- `server/index.ts` 4952–4961: `shuttingDown = true` then `workspaceActivity.cancelPause()` then `stopTelegramBridge()` / Discord / Slack
- `server/workspace-activity.ts` 27–28, 46–50: `cancelPause` → `end()` → `owner.resume()` (waiters proceed; only the lease is failed)
- `server/index.ts` 1238–1241: restore/shutdown is checked **inside** `run()`, **after** admission
- `server/channels/telegram.ts` 587–589, 597, 631–632, 645–647: `saveChannel` / offset advance happen **before** `enqueueOrStart` → `startTurn`

**Interleaving**
1. Snapshot pause is held; a Telegram poll is blocked in `handleTelegramUpdates` → `withWorkspaceActivity` (`telegram.ts` 572–575). Offset has not been saved yet.
2. SIGTERM: `shuttingDown = true`; `cancelPause()` resolves `owner.wait`; bridges are stopped on the same tick (`index.ts` 4952–4961).
3. Waiter microtasks run `handleTelegramUpdatesAdmitted`: `next.offset = update_id + 1`; `saveChannel(next)` (`telegram.ts` 597, 631–632).
4. `enqueueOrStart` → `startTurn` throws 409 (`index.ts` 1240). Catch is not `isTurnBusy`, so the ask is not re-queued (`telegram.ts` 509–517).
5. Process exits. Next boot uses the saved offset; Telegram will not redeliver. The turn never ran.

Slack is the same shape (`slack.ts` 377–380, 390, 425–438). Discord inbound is wrapped (`discord.ts` 371–374, 409), so the same cursor write can happen after resume.

This is a recovery defect introduced by using `cancelPause()` (resume waiters) on a dying process. Pressure/timeout *should* resume waiters; shutdown should not.

**Smallest safe fix**
Do not resume channel handlers after shutdown. Either:
- skip `cancelPause()` on SIGINT/SIGTERM (lease can die with the process; waiters never `saveChannel`), or
- add a gate-level hold checked **after** the wait and **before** `work()`:

```ts
// after the while in run(), before running++
if (this.closed) throw shutdownOrRestoreError;
```

Set `closed` from the host **before** `cancelPause()`. Keep restore/shutdown checks in `startTurn` as a second line, not the first.

---

## P2 — Admitted “drain” is only the `run()` frame; turns keep mutating after `running === 0`

**Where**
- `server/index.ts` 1238–1242: `run()` wraps `startSeatTurn` and returns when that function returns
- `server/channels/telegram.ts` 519–527 (same in Slack 319–324, Discord 313–318): after `await startTurn(...)`, `productBud()?.busy` can still be true
- `server/index.ts` 4895–4902, 4854–4858: after drain, `assertPrivateBackupIdle()` **fails** on `bot.busy` instead of waiting

**Interleaving**
1. A long turn is dispatched; `startSeatTurn` returns with `bot.busy === true`; `run()`’s `finally` drops `running` to 0 (`workspace-activity.ts` 41–43).
2. `POST` backup → `pause()` sees `running === 0`, drain completes immediately (`workspace-activity.ts` 66–68).
3. `assertPrivateBackupIdle()` throws 409 because `bot.busy` (`index.ts` 4856–4858); lease is released.

That is fail-closed (not a corrupt archive), but it does **not** drain admitted work. The pause waits for dispatch wrappers, not for the worker. Nested ALS (`workspace-activity.ts` 33, 40) cannot help once the parent `run()` has returned.

**Smallest safe fix**
Keep the turn inside `workspaceActivity.run` until the bot is no longer busy (or until the worker’s last durable write). Alternatively, while paused, wait/retry `assertPrivateBackupIdle()` until timeout instead of treating drain as sufficient.

Until `startSeatTurn` after line 1280 is inspected, treat “busy is set for the whole worker lifetime” as unproven. If busy can be false while the worker still writes, this becomes a snapshot-consistency hole, not just a failed backup.

---

## P2 — Discord interactions mutate and ACK outside the admission barrier

**Where**
- `server/channels/discord.ts` 454–476: `handleInteraction` is **not** wrapped in `withWorkspaceActivity`
- Contrast `handleInbound` 371–374 and Telegram `handleTelegramUpdates` 572–575
- `decideRemotely` 174–184 **is** wrapped; revalidation at 197–213 still runs after the wait

**Interleaving**
1. Snapshot is capturing (`owner` set, `running === 0`).
2. Discord button: `handleInteraction` runs immediately, `saveChannel({ lastMessageAt })` (`discord.ts` 465), ACK type 6 (`466–471`).
3. `decideRemotely` then waits on the gate (`remote-decisions.ts` 182–184).
4. `saveChannel` can change files under `filesAt` during export (`private-workspace-backup.ts` 430–439) → backup fails closed, **or** channel metadata is snapshotted without the decision.
5. After release, fingerprint/card checks run (`remote-decisions.ts` 197–213). Wrong-draft apply is prevented; the ungated prefix is still a quiesce hole.

**Smallest safe fix**
Wrap the whole `handleInteraction` body in `deps.withWorkspaceActivity`, matching `handleInbound`. Leave `decideRemotelyAdmitted` revalidation as-is.

---

## P2 — Quiesce is incomplete: queued batches, flush timer, office link stay live

**Where**
- Snapshot stops **loops only** (`index.ts` 4898–4900). Shutdown also stops batches, bridges, remote flush (`4957–4963`). Restore stops bridges + flush (`4911–4912`).
- Idle check: `jobRuns` queued **or** running, but batches only `status==='running'` (`index.ts` 4856–4857). `batches.stop()` is not called for snapshot.
- `startRemoteDecisionFlush()` interval is not stopped for snapshot (`remote-decisions.ts` 243–258; still running after `index.ts` 4937).
- `officeLink.start()` is not paired with a snapshot stop (`index.ts` 4939 vs 4898).

**Interleaving**
1. A batch is `queued` (not `running`); idle check passes.
2. Pause drain completes; export `await filesAt` / `recordsAt` (`private-workspace-backup.ts` 430, 437).
3. Batch runner (if ungated) starts the queued batch and writes business files.
4. Epoch/file compare may fail closed (`439`); if the write is outside `filesAt`/`epoch()`, the archive can miss it.

**Smallest safe fix**
Treat queued batches like job runs in `assertPrivateBackupIdle`. For the pause lifetime, stop the same non-channel clocks you already know how to stop (`batches.stop`, remote flush) and restart them in `onReleased` next to `loops?.start()`, still gated on `!privateRestoreLocked && !shuttingDown`.

Do **not** use `stopTelegramBridge` / Discord / Slack here (those clear queues).

---

## P3 — Release is a thundering herd, not a mutex

`end()` resumes every waiter in one turn (`workspace-activity.ts` 49–50). Tests even expect concurrent admission (`workspace-activity.test.ts` 28–32). After a long pause, overlapping `handleTelegramUpdates` / `handleSlackInbound` / `startTurn` all enter at once. `bot.busy` is checked only inside `startSeatTurn` (`index.ts` 1272), so the pause makes a pre-existing race easier to hit.

Fix later if poll loops can overlap (not shown): a single in-flight poll per channel, or FIFO resume. Not required to make a cancelled snapshot consistent.

---

## Requirements that **are** demonstrated in the shown excerpts

| Requirement | Evidence |
|---|---|
| Nested admitted work can drain | ALS `active` skips the wait (`workspace-activity.ts` 33, 40); test 17–26 |
| Detached later work is new admission | `token.active = false` in `finally` (42); test 22–26 |
| New inbound waits; channel `stop*` not used | Snapshot only `loops?.stop()` (`index.ts` 4898–4900); Telegram/Slack/Discord inbound wrapped (`telegram.ts` 572–575, `slack.ts` 377–380, `discord.ts` 371–374) |
| Remote approval revalidates after wait | Wait is **outside** `decideRemotelyAdmitted`; snapshot/fingerprint/card re-read at 197–213 |
| Restore/shutdown survive release | `onReleased`: `if (!privateRestoreLocked && !shuttingDown) loops?.start()` (`index.ts` 4900); catch 4903; `beginRestore` does not clear via snapshot |
| HTTP session before snapshot 409 | `sessionOk` at 2357–2363, pause 409 at 2368–2369 |
| Real source fingerprint before export success | epoch + `filesAt`/`recordsAt` twice + compare (`private-workspace-backup.ts` 428–439); `lease.assertCurrent()` around those awaits |
| Pressure cancels snapshot, not work | `waiting >= maxWaiting` → `end(owner, interrupted())` then waiters run (`workspace-activity.ts` 35, 46–50); test 28–32 |
| Stale lease cannot drop a later pause | `end` no-op if `owner.released` (47–48); test 34–39 |

On `needsSession` routes, unauthenticated callers never see the snapshot 409. On the `else if` branch, only **403** is returned (`index.ts` 2360–2363); a 401 can fall through to `private_snapshot_active`. Pre-existing shape; low.

---

## Proof gaps (not claimed as defects)

These files/behaviors are required to close the review and are **not** in the excerpts:

- Telegram/Slack/Discord **poll loops**: if `setInterval` + `void handle*` can overlap during a 60s wait, duplicate batches run after release (cursor/queue races). Sequential `await handle*` is safe.
- HTTP handler `finally` for `countedPrivateRequest` / `privateBackupRequests--`. Increment is shown (`index.ts` 2372–2374); if this is not an in-flight counter, `assertIdle`’s `privateBackupRequests > 1` is wrong.
- Remainder of `startSeatTurn` (after 1280): when `bot.busy` is set/cleared vs worker writes.
- `filesAt` / `portable()`: whether channel JSON, office-link, and batch outputs are in the fingerprint.
- `LoopManager.stop` / `busy`, batch runner, `officeLink`, `flushDeferredDecisions`, `runDeskCheck` callers: any writer that is not HTTP-409’d and not in `workspaceActivity.run`.
- `/api/events` (excluded from 409 at `index.ts` 2368) — method and mutation surface.
- `needsSession` membership for `/api/private-backup`.
- `decideRemoteText` (text path) vs `decideRemotely` (button path).
- `createPrivateBackupApi` mapping of `interrupted` / idle errors to HTTP.
- `withWorkerProfile` vs ALS: if it drops `WorkspaceActivityGate`’s store, nested `run()` after `await fetch` in channel handlers can deadlock with drain until the 60s timeout (`workspace-activity.ts` 56, `index.ts` 4900).

I did not run code, open the rest of the tree, or use credentials. Codex still owns implementation.
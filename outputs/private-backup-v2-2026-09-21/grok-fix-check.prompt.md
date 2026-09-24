Read-only verification of TWO fixes from your prior workspace snapshot review. Do not use tools, access additional files, edit anything or spawn agents. Codex owns implementation and integration. Only assess the supplied code and the two listed invariants, not a new general audit. 1. A shutdown/restore hold becoming active while a channel handler waits on the snapshot gate must reject the handler before it can persist its cursor or accept a decision. 2. An opted-in paused BatchService auto-recovery probe must not commit 'running' or dispatch a worker if a backup/restore/shutdown hold arrives before its asynchronous available() finishes. The same saved batch should resume later with no attempt consumed by the hold. The host callback is synchronous and reads paused/restore/shutdown flags. Existing batch stop() is terminal and is deliberately not used for temporary pause. Running batches make backup admission fail before pause; the newly found hole was paused/waiting-for-worker batches. Channel connection files, transport ACK receipts, work-batches.json and office-link metadata are excluded from portable business snapshots, but new batch work is now held anyway. Return at most 400 words: pass/fail for each invariant, any concrete remaining defect within those two fixes, and limits of source-only review. Successful tests are reported separately, so do not claim you ran them.

### server/workspace-activity.ts
1: /** A temporary snapshot pause. Admitted work drains; new background work waits
2:  * without clearing its channel queues. Pressure cancels the snapshot, not work.
3:  * This does not replace authorization or durable request identities. */
4: import { AsyncLocalStorage } from 'node:async_hooks';
5: 
6: export type WorkspaceActivity = <T>(work: () => T | Promise<T>) => Promise<T>;
7: export interface WorkspaceSnapshotLease { assertCurrent(): void; release(): void }
8: type Owner = {
9:   released: boolean; failure?: Error; resume: () => void; wait: Promise<void>;
10:   drained: () => void; drain: Promise<void>; dispose: () => void;
11: };
12: const interrupted = () => Object.assign(new Error('The backup pause ended before capture completed. Current work was preserved; retry when the workspace is quiet.'), { status: 409, code: 'private_snapshot_interrupted' });
13: 
14: export class WorkspaceActivityGate {
15:   private owner?: Owner;
16:   private running = 0;
17:   private waiting = 0;
18:   private readonly context = new AsyncLocalStorage<{ active: boolean }>();
19:   private readonly maxWaiting: number;
20:   private readonly assertAdmission: () => void;
21:   constructor(options: { maxWaiting?: number; assertAdmission?: () => void } = {}) {
22:     const maxWaiting = options.maxWaiting ?? 256;
23:     if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1 || maxWaiting > 1024) throw new Error('Invalid workspace pause queue limit.');
24:     this.maxWaiting = maxWaiting;
25:     this.assertAdmission = options.assertAdmission ?? (() => {});
26:   }
27:   get paused() { return !!this.owner; }
28:   get active() { return this.running; }
29:   get queued() { return this.waiting; }
30:   /** Service shutdown invalidates only the current snapshot lease. */
31:   cancelPause(): void { if (this.owner) this.end(this.owner, interrupted()); }
32: 
33:   readonly run: WorkspaceActivity = async work => {
34:     // Nested work belonging to an admitted task must be allowed to drain. A
35:     // detached callback after its parent finishes is a new admission instead.
36:     while (this.owner && !this.context.getStore()?.active) {
37:       const owner = this.owner;
38:       if (this.waiting >= this.maxWaiting) { this.end(owner, interrupted()); break; }
39:       this.waiting++;
40:       try { await owner.wait; } finally { this.waiting--; }
41:     }
42:     // A pause release is not permission to cross a newer restore/shutdown hold.
43:     // Check at execution time, including for callers that waited above.
44:     this.assertAdmission();
45:     const token = { active: true }; this.running++;
46:     try { return await this.context.run(token, work); }
47:     finally {
48:       token.active = false; this.running--;
49:       if (this.running === 0) this.owner?.drained();
50:     }
51:   };
52:   private end(owner: Owner, error?: Error) {
53:     if (owner.released) return;
54:     owner.released = true; owner.failure = error;
55:     if (this.owner === owner) this.owner = undefined;
56:     owner.resume(); owner.drained(); owner.dispose();
57:   }
58:   /** Installs its admission barrier synchronously, before the first await.
59:    * The timeout bounds the entire pause, including capture after drain. */
60:   async pause(options: { signal?: AbortSignal; timeoutMs?: number; onReleased?: () => void } = {}): Promise<WorkspaceSnapshotLease> {
61:     if (this.owner || this.context.getStore()?.active) throw Object.assign(new Error('Another workspace operation is active. Retry the backup after it finishes.'), { status: 409 });
62:     const timeout = options.timeoutMs ?? 30_000;
63:     if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new Error('Invalid snapshot pause deadline.');
64:     options.signal?.throwIfAborted();
65:     let resume!: () => void, drained!: () => void;
66:     const wait = new Promise<void>(resolve => { resume = resolve; }), drain = new Promise<void>(resolve => { drained = resolve; });
67:     const owner: Owner = { released: false, resume, wait, drained, drain, dispose: () => {} };
68:     const cancel = () => this.end(owner, interrupted());
69:     const timer = setTimeout(cancel, timeout); timer.unref?.();
70:     owner.dispose = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); options.onReleased?.(); };
71:     this.owner = owner; options.signal?.addEventListener('abort', cancel, { once: true });
72:     if (this.running === 0) owner.drained();
73:     const assertCurrent = () => { if (owner.failure) throw owner.failure; if (this.owner !== owner || owner.released) throw interrupted(); };
74:     await owner.drain; assertCurrent();
75:     return { assertCurrent, release: () => this.end(owner) };
76:   }
77: }

### server/index.ts
676: // records the active member here before dispatching its turn.
677: const groupSpeakers = new Map<string, { botId: string; name: string; color: string }>();
678: let loops: LoopManager | null = null;
679: let privateRestoreLocked = false;
680: let shuttingDown = false;
681: const workspaceActivity = new WorkspaceActivityGate({ assertAdmission: () => {
682:   if (privateRestoreLocked || shuttingDown) throw Object.assign(new Error('The service is held for restore or shutdown. Restart RealBud before starting work.'), { status: 409 });
683: } });
684: let privateBackupRequests = 0;
685: let privateBackupEpoch = 0;
686: const desk = new Desk({ memberKey: MEMBER_KEY });
687: const batches = new BatchService({
688:   canRecover: () => !workspaceActivity.paused && !privateRestoreLocked && !shuttingDown,
689:   snapshot: () => desk.snapshot(),
690:   notes: id => desk.notesFor(id).body,
691:   available: () => withWorkerProfile(desk.memberKeyForWorker(), async () => applyHandsReadiness(await hermesStatus(), readHandsPing(DATA_DIR)).ready),
692: });
693: try {
694:   writeDeskContext(desk.snapshot());
695: } catch {
696:   /* Desk remains usable if its read-only worker projection cannot be refreshed. */
4948: // Windows, where Node's process.kill does not deliver POSIX signal handlers.
4949: if (process.env.REALBUD_TEST_LAB === "1" && process.send) {
4950:   process.on("message", (message: unknown) => {
4951:     if (message && typeof message === "object" && (message as { type?: string }).type === "realbud-test-stop") process.emit("SIGTERM");
4952:   });
4953: }
4954: for (const signal of ["SIGINT", "SIGTERM"] as const) {
4955:   process.on(signal, () => {
4956:     if (shuttingDown) return;
4957:     shuttingDown = true;
4958:     workspaceActivity.cancelPause();
4959:     oplog("shutdown", signal);
4960:     officeLink.stop();
4961:     stopTelegramBridge();
4962:     stopDiscordBridge();
4963:     stopSlackBridge();
4964:     stopRemoteDecisionFlush();
4965:     loops?.stop();
4966:     batches.stop();
4967:     watchdog.stop();
4968:     cancelBootstrapInstall();
4969:     void Promise.allSettled([registry.disposeAll(), waitForBootstrapStop(), companyHost.close(), browserRuntime.shutdown()]).finally(() => process.exit(0));
4970:   });
4971: }

### server/batches.ts
18: const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
19: type Dependencies = {
20:   file?: string;
21:   snapshot: () => DeskSnapshot;
22:   notes: (id: string) => string;
23:   available: () => Promise<boolean>;
24:   /** Reversible host admission for timer/startup recovery; never stops or
25:    * clears saved work. Rechecked after asynchronous worker readiness. */
26:   canRecover?: () => boolean;
27:   ask?: typeof askWorker;
28:   retryDelayMs?: number;
29: };
30: 
31: function validStored(value: unknown): value is WorkBatch[] {
32:   if (!Array.isArray(value) || value.length > 100) return false;
197:         target.waitingForWorker = false;
198:         target.retryOnly = action === "retry-failed";
199:         target.status = "running"; target.detail = "Preparing from the saved source snapshot. Completed results will not repeat.";
200:       }
201:       this.touch(target);
202:     });
203:     if (action === "pause") this.wakeDelay?.();
204:     if (action === "resume" || action === "retry-failed") this.kick(id);
205:     return this.get(id);
206:   }
207:   /** Timer and startup share a single readiness probe; never overlap workers. */
208:   async recoverReadyWork() {
209:     if (this.recovering || this.stopped || this.error || this.runners.size || this.deps.snapshot().recovery.active || this.deps.canRecover?.() === false) return;
210:     const candidate = this.batches.find(b => b.status === "paused" && b.autoContinue && b.waitingForWorker);
211:     if (!candidate) return;
212:     this.recovering = true;
213:     try {
214:       const available = await this.deps.available().catch(() => false);
215:       if (!available || this.stopped || this.error || this.runners.size || this.deps.snapshot().recovery.active || this.deps.canRecover?.() === false) return;
216:       const current = this.batches.find(b => b.id === candidate.id);
217:       if (!current?.waitingForWorker || current.status !== "paused") return;
218:       this.commit(next => { const b = next.find(b => b.id === candidate.id)!; b.status = "running"; b.waitingForWorker = false; b.detail = "Connection restored. Continuing saved work."; this.touch(b); });
219:       this.kick(candidate.id);
220:     } catch {
221:       this.error = "Batch progress could not be saved. Preparation stopped. Check disk space and reopen RealBud.";
222:     } finally { this.recovering = false; }
223:   }

### server/batches.test.ts
209: 
210: 
211: describe("persistent portfolio preparation", () => {
212:   it.each(['before probe', 'during probe'] as const)('preserves automatic recovery while the host pauses %s', async when => {
213:     let held = false;
214:     const { service, input, available, ask, file } = setup(() => !held);
215:     available.mockResolvedValue(false);
216:     const created = service.create({ ...input, autoContinue: true }); await service.wait(created.id);
217:     const before = readFileSync(file), calls = available.mock.calls.length;
218:     expect(service.get(created.id)).toMatchObject({ status: 'paused', waitingForWorker: true });
219:     if (when === 'before probe') {
220:       held = true; await service.recoverReadyWork(); expect(available).toHaveBeenCalledTimes(calls);
221:     } else {
222:       const probe = deferred<boolean>(); available.mockReturnValueOnce(probe.promise);
223:       const recovery = service.recoverReadyWork(); expect(available).toHaveBeenCalledTimes(calls + 1);
224:       held = true; probe.resolve(true); await recovery;
225:     }
226:     expect(readFileSync(file)).toEqual(before); expect(ask).not.toHaveBeenCalled();
227:     expect(service.get(created.id)).toMatchObject({ status: 'paused', waitingForWorker: true });
228:     held = false; available.mockResolvedValue(true);
229:     await service.recoverReadyWork(); await service.wait(created.id);
230:     expect(service.get(created.id).status).toBe('finished'); expect(ask).toHaveBeenCalledTimes(2);
231:     expect(service.get(created.id).items.map(item => item.attempt)).toEqual([1, 1]);
232:   });
233: 
234:   it.each([20, 50, 100, 150, 200, 500])("completes %i independent properties and preserves progress on reload", async count => {
235:     const { service, snapshot, input, ask, deps } = setup();

### server/channels-telegram.test.ts
110: describe("pairing and relay", () => {
111:   it('retains an incoming message and its offset while a backup pause is active', async () => {
112:     const store = new Store(() => ({ instanceId: '', model: '' })); store.seedIfEmpty();
113:     telegram.saveChannel({ botToken: TOKEN, botUsername: 'realbud_bot', pairedChatId: 111, pairedName: 'Sam', offset: 10, connectedAt: 1, lastMessageAt: null });
114:     const gate = new WorkspaceActivityGate(), startTurn = vi.fn(async () => {}), lease = await gate.pause();
115:     const wired = { ...deps(store, startTurn, stubFetch()), withWorkspaceActivity: gate.run };
116:     const incoming = telegram.handleTelegramUpdates([update(10, 111, 'Review the fictional tasks')], wired);
117:     await new Promise(resolve => setImmediate(resolve));
118:     expect(startTurn).not.toHaveBeenCalled(); expect(telegram.loadChannel()?.offset).toBe(10);
119:     lease.release(); await incoming;
120:     expect(startTurn).toHaveBeenCalledTimes(1); expect(telegram.loadChannel()?.offset).toBe(11);
121:   });
122:   it('keeps the unconsumed cursor when shutdown cancels a backup pause', async () => {
123:     const store = new Store(() => ({ instanceId: '', model: '' })); store.seedIfEmpty();
124:     telegram.saveChannel({ botToken: TOKEN, botUsername: 'realbud_bot', pairedChatId: 111, pairedName: 'Sam', offset: 10, connectedAt: 1, lastMessageAt: null });
125:     let shuttingDown = false;
126:     const gate = new WorkspaceActivityGate({ assertAdmission: () => { if (shuttingDown) throw new Error('Service stopping'); } });
127:     const startTurn = vi.fn(async () => {}); await gate.pause();
128:     const incoming = telegram.handleTelegramUpdates([update(10, 111, 'Review the fictional tasks')], { ...deps(store, startTurn, stubFetch()), withWorkspaceActivity: gate.run });
129:     const refusal = expect(incoming).rejects.toThrow('Service stopping');
130:     shuttingDown = true; gate.cancelPause(); telegram.stopTelegramBridge(); await refusal;
131:     expect(telegram.loadChannel()?.offset).toBe(10); expect(startTurn).not.toHaveBeenCalled();
132:     expect(store.messagesFor(store.productBud()!.threadId).some(message => message.text?.includes('Review the fictional tasks'))).toBe(false);
133:   });
134:   it("requires the Mac pairing code and refuses another chat", async () => {
135:     const store = new Store(() => ({ instanceId: "", model: "" }));
136:     store.seedIfEmpty();
137:     telegram.saveChannel({
138:       botToken: TOKEN,
139:       botUsername: "realbud_bot",
140:       pairedChatId: null,
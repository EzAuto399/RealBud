import { describe, expect, it } from 'vitest';
import { WorkspaceActivityGate } from './workspace-activity.ts';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const thrown = (work: () => unknown) => { try { work(); } catch (error) { return error; } throw new Error('Expected a throw'); };

describe('queue-preserving workspace snapshot pause', () => {
  it('drains admitted work and preserves the waiting work until release', async () => {
    const gate = new WorkspaceActivityGate(), finished = deferred(), calls: string[] = [];
    const current = gate.run(async () => { await finished.promise; calls.push('old'); });
    const pending = gate.pause(); expect(gate.paused).toBe(true);
    const incoming = gate.run(() => { calls.push('new'); });
    await turn(); expect(gate.active).toBe(1); expect(gate.queued).toBe(1); expect(calls).toEqual([]);
    finished.resolve(); await current; const lease = await pending;
    expect(calls).toEqual(['old']); lease.assertCurrent(); lease.release(); await incoming;
    expect(calls).toEqual(['old', 'new']); expect(gate.active).toBe(0); expect(gate.queued).toBe(0);
  });
  it('allows nested admitted operations to drain without admitting detached later callbacks', async () => {
    const gate = new WorkspaceActivityGate(), finish = deferred(), detached = deferred(); let later!: Promise<void>, nested = false, ranLater = false;
    const active = gate.run(async () => {
      await finish.promise;
      await gate.run(() => { nested = true; });
      later = detached.promise.then(() => gate.run(() => { ranLater = true; }));
    });
    const pending = gate.pause(); finish.resolve(); await active;
    const lease = await pending; detached.resolve(); await turn();
    expect(nested).toBe(true); expect(ranLater).toBe(false); lease.release(); await later; expect(ranLater).toBe(true);
  });
  it('cancels a pressured snapshot and lets every waiting action proceed', async () => {
    const gate = new WorkspaceActivityGate({ maxWaiting: 2 }), lease = await gate.pause(), calls: number[] = [];
    await Promise.all([1, 2, 3].map(n => gate.run(() => { calls.push(n); })));
    expect(calls.sort()).toEqual([1, 2, 3]); expect(() => lease.assertCurrent()).toThrow(/pause ended/);
    expect(gate.paused).toBe(false); expect(gate.queued).toBe(0);
  });
  it('aborts while draining and cannot clear a later pause with a stale lease', async () => {
    const gate = new WorkspaceActivityGate(), finish = deferred(), controller = new AbortController();
    const active = gate.run(() => finish.promise), pending = gate.pause({ signal: controller.signal });
    const failure = expect(pending).rejects.toThrow(/pause ended/); controller.abort(); await failure;
    finish.resolve(); await active;
    const old = await gate.pause(); old.release(); const current = await gate.pause(); old.release(); expect(gate.paused).toBe(true); current.assertCurrent(); current.release();
  });
  it('bounds capture time and resumes waiting work on timeout', async () => {
    const gate = new WorkspaceActivityGate(), lease = await gate.pause({ timeoutMs: 10 }); let executed = false;
    const work = gate.run(() => { executed = true; }); await new Promise(resolve => setTimeout(resolve, 30)); await work;
    expect(executed).toBe(true); expect(() => lease.assertCurrent()).toThrow(/pause ended/);
  });
  it('names why a pause ended with one fixed detail under the existing code', async () => {
    const timed = await new WorkspaceActivityGate().pause({ timeoutMs: 1 }); await new Promise(resolve => setTimeout(resolve, 10));
    expect(thrown(() => timed.assertCurrent())).toMatchObject({ status: 409, code: 'private_snapshot_interrupted', interruption: 'timeout' });
    const pressured = new WorkspaceActivityGate({ maxWaiting: 1 }), full = await pressured.pause();
    await Promise.all([pressured.run(() => {}), pressured.run(() => {})]);
    expect(thrown(() => full.assertCurrent())).toMatchObject({ code: 'private_snapshot_interrupted', interruption: 'queue-full' });
    const stopping = new WorkspaceActivityGate(), stopped = await stopping.pause(); stopping.cancelPause();
    expect(thrown(() => stopped.assertCurrent())).toMatchObject({ code: 'private_snapshot_interrupted', interruption: 'stopped' });
    const busy = new WorkspaceActivityGate(), held = await busy.pause();
    await expect(busy.pause()).rejects.toMatchObject({ status: 409, code: 'workspace-change' }); held.release();
  });
  it('does not let an admitted action pause itself or retain activity after failure', async () => {
    const gate = new WorkspaceActivityGate();
    await expect(gate.run(() => gate.pause())).rejects.toThrow(/active/); expect(gate.active).toBe(0);
    await expect(gate.run(() => { throw new Error('failed action'); })).rejects.toThrow('failed action');
    const lease = await gate.pause(); lease.release();
  });
  it.each(['release', 'cancelPause'] as const)('rechecks a new lifecycle hold before %s admits waiting work', async action => {
    let held = false, executed = false;
    const gate = new WorkspaceActivityGate({ assertAdmission: () => { if (held) throw new Error('Service held'); } });
    const lease = await gate.pause(), pending = gate.run(() => { executed = true; });
    const refusal = expect(pending).rejects.toThrow('Service held');
    held = true;
    if (action === 'release') lease.release(); else gate.cancelPause();
    await refusal;
    expect(executed).toBe(false); expect(gate.active).toBe(0); expect(gate.queued).toBe(0);
    await expect(gate.run(() => { executed = true; })).rejects.toThrow('Service held');
    held = false; await gate.run(() => { executed = true; }); expect(executed).toBe(true);
  });
});

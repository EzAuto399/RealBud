import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HermesAgentDriver, hermesWorkerSandbox } from './drivers/acp/hermes.ts';
import { tryHermesPing, tryHermesLedger } from './hermes-hands.ts';
import { askWorker } from './recipe-draft.ts';
import { inspectLedgerColumns } from './import-inspect.ts';
import { hermesStatus, applyHandsReadiness } from './hermes-status.ts';
import { WORKER_PLATFORM_HELD } from './worker-network-sandbox.ts';
import { ProviderRegistry } from './harness/registry.ts';
import { controlPath, workerControlDir } from './worker-control.ts';

async function onPlatform(platform: NodeJS.Platform, work: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { await work(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}
describe('worker admission on an OS without an enforced boundary', () => {
  it('holds Ask before ACP broker creation, profile work or custom CLI launch', async () => {
    for (const platform of ['win32', 'linux'] as const) await onPlatform(platform, async () => {
      const root = mkdtempSync(join(tmpdir(), 'rb-platform-hold-'));
      try {
        mkdirSync(join(root, 'profiles', 'property'), { recursive: true });
        writeFileSync(join(root, 'profiles', 'property', '.skills_prompt_snapshot.json'), 'held cache');
        const before = readdirSync(root, { recursive: true });
        for (const job of ['ask', 'cli', 'diagnostic'] as const) expect(() => hermesWorkerSandbox(job, '/fictional/custom-worker', [], { HERMES_HOME: root }, [4000])).toThrow(WORKER_PLATFORM_HELD);
        expect(() => HermesAgentDriver.create({ instanceId: 'held', config: { cli: '/fictional/custom-worker', workspace: root } } as never)).toThrow(WORKER_PLATFORM_HELD);
        const registry = new ProviderRegistry([HermesAgentDriver]);
        await registry.load({ held: { driver: 'hermesAgent', config: { cli: '/fictional/custom-worker', workspace: root } } });
        // Registry keeps the configured engine as unavailable; the service and
        // saved records can still load, rather than failing all startup.
        expect(registry.get('held')).toBeNull();
        expect(registry.entries()[0]?.shadow?.reason).toBe(WORKER_PLATFORM_HELD);
        expect(readdirSync(root, { recursive: true })).toEqual(before);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  });
  it('returns a truthful hold before one-shot probes, model relays or workrooms', async () => {
    for (const platform of ['win32', 'linux'] as const) await onPlatform(platform, async () => {
      const opts = { cli: '/fictional/custom-worker', root: '/fictional/absent-worker' };
      expect(await tryHermesPing(opts)).toMatchObject({ ok: false, detail: WORKER_PLATFORM_HELD });
      expect(await tryHermesLedger(['fictional'], opts)).toMatchObject({ rows: null, detail: WORKER_PLATFORM_HELD });
      expect(await askWorker('fictional', opts)).toMatchObject({ ok: false, detail: WORKER_PLATFORM_HELD });
      expect(await inspectLedgerColumns('property,balance\nfictional,1', opts)).toMatchObject({ mapping: null, detail: WORKER_PLATFORM_HELD });
    });
  });
  it('does not turn an earlier successful hands receipt into platform admission', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const status = await hermesStatus({ platform, root: '/fictional/absent-worker', cli: '/fictional/never-probed' });
      expect(status).toMatchObject({ ready: false, installerAvailable: false, workerIsolation: { state: 'held', platform, detail: WORKER_PLATFORM_HELD } });
      expect(status.workerFingerprint).toBeUndefined();
      const forgedReady = { ...status, cli: { installed: true, versionText: 'Hermes Agent v0.21.5', matchesPin: true }, pack: { installed: true, approvalsManual: true, workroomReady: true }, workerFingerprint: 'old' };
      expect(applyHandsReadiness(forgedReady, { at: 1, kind: 'ping', ok: true, detail: 'OK', workerFingerprint: 'old' })).toMatchObject({ ready: false, detail: WORKER_PLATFORM_HELD });
    }
  });
  it('retains the platform hold when a separate runtime selection needs recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rb-platform-selection-'));
    try {
      mkdirSync(workerControlDir(root), { recursive: true, mode: 0o700 });
      writeFileSync(controlPath(root, 'runtime-selection'), 'fictional invalid selection', { mode: 0o600 });
      const status = await hermesStatus({ platform: 'win32', root, cli: '/fictional/never-probed' });
      expect(status).toMatchObject({ ready: false, hold: 'selection_needs_recovery', installerAvailable: false, workerIsolation: { state: 'held', platform: 'win32' } });
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(workerControlDir(root), { recursive: true, force: true }); }
  });
});

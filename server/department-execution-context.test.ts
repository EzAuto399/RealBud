import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createDepartmentExecutionContext, DepartmentExecutionContextError, type DepartmentExecutionBinding } from './department-execution-context.ts';

const binding = (): DepartmentExecutionBinding => ({ grantId: randomUUID(), executionId: randomUUID() });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('leaves private calls outside department authority', async () => {
  const current = vi.fn(() => true), check = vi.fn(async () => {});
  const context = createDepartmentExecutionContext({ current, check });
  expect(context.active()).toBeNull();
  await context.check();
  expect(current).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
});

it.each([null, undefined, {}, { grantId: randomUUID() }, { grantId: '', executionId: randomUUID() },
  { ...binding(), required: false }, { grantId: 'not-a-grant', executionId: randomUUID() }])('rejects missing or malformed required binding %j', value => {
  const context = createDepartmentExecutionContext({ current: () => true, check: async () => {} });
  const work = vi.fn();
  expect(() => context.run(value as DepartmentExecutionBinding, work)).toThrow(DepartmentExecutionContextError);
  expect(work).not.toHaveBeenCalled(); expect(context.active()).toBeNull();
});

it('refuses stale entry and rechecks before an awaited probe', async () => {
  let allowed = false;
  const check = vi.fn(async () => {}), work = vi.fn();
  const context = createDepartmentExecutionContext({ current: () => allowed, check });
  expect(() => context.run(binding(), work)).toThrow(DepartmentExecutionContextError);
  expect(work).not.toHaveBeenCalled();
  allowed = true;
  await context.run(binding(), async () => {
    allowed = false;
    await expect(context.check()).rejects.toThrow(DepartmentExecutionContextError);
    expect(context.active()).not.toBeNull();
  });
  expect(check).not.toHaveBeenCalled();
});

it('blocks provider entry when authority is revoked during the awaited check', async () => {
  let allowed = true, providerCalls = 0;
  const entered = deferred(), release = deferred(), expected = binding();
  const context = createDepartmentExecutionContext({ current: () => allowed, check: async value => {
    expect(value).toEqual(expected); entered.resolve(); await release.promise;
  } });
  const work = context.run(expected, async () => { await context.check(); providerCalls++; });
  await entered.promise; allowed = false; release.resolve();
  await expect(work).rejects.toThrow(DepartmentExecutionContextError);
  expect(providerCalls).toBe(0); expect(context.active()).toBeNull();
});

it('propagates authoritative check failure without allowing provider entry', async () => {
  const denied = new Error('Case lease changed'), provider = vi.fn();
  const context = createDepartmentExecutionContext({ current: () => true, check: async () => { throw denied; } });
  await expect(context.run(binding(), async () => { await context.check(); provider(); })).rejects.toBe(denied);
  expect(provider).not.toHaveBeenCalled();
});

it('rejects nested cross-grant, cross-execution and missing bindings while retaining parent provenance', async () => {
  const context = createDepartmentExecutionContext({ current: () => true, check: async () => {} }), expected = binding();
  await context.run(expected, async () => {
    const inherited = context.active();
    for (const next of [binding(), { ...expected, executionId: randomUUID() }, null]) {
      expect(() => context.run(next as DepartmentExecutionBinding, () => {})).toThrow(DepartmentExecutionContextError);
      expect(context.active()).toBe(inherited);
    }
    await context.run({ ...expected }, async () => {
      await Promise.resolve(); expect(context.active()).toBe(inherited); await context.check();
    });
    expect(context.active()).toBe(inherited);
  });
  expect(context.active()).toBeNull();
});

it('snapshots and freezes caller input across queued callbacks', async () => {
  const input = { ...binding() }, expected = { ...input };
  const check = vi.fn(async value => { expect(value).toEqual(expected); });
  const context = createDepartmentExecutionContext({ current: value => value.grantId === expected.grantId, check });
  await context.run(input, () => new Promise<void>((resolve, reject) => {
    input.grantId = randomUUID();
    queueMicrotask(() => {
      expect(context.active()).toEqual(expected); expect(Object.isFrozen(context.active())).toBe(true);
      void context.check().then(resolve, reject);
    });
  }));
  expect(check).toHaveBeenCalledOnce();
});

it('isolates parallel executions and restores outer private context', async () => {
  const first = binding(), second = binding(), entered = deferred(), release = deferred();
  const checked: DepartmentExecutionBinding[] = [];
  const context = createDepartmentExecutionContext({ current: () => true, check: async value => {
    if (value.executionId === first.executionId) { entered.resolve(); await release.promise; }
    expect(context.active()).toEqual(value); checked.push(value);
  } });
  const pending = context.run(first, () => context.check());
  await entered.promise;
  expect(context.active()).toBeNull();
  await context.run(second, async () => { await context.check(); expect(context.active()).toEqual(second); });
  release.resolve(); await pending;
  expect(checked).toEqual([second, first]); expect(context.active()).toBeNull();
});

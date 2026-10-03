import { describe, expect, it, vi } from 'vitest';
import { hydrateLiveSnapshot } from './live-hydration';

describe('live snapshot hydration', () => {
  it('bounds continuous live invalidations without applying any stale snapshot', async () => {
    let revision = 0;
    const read = vi.fn(async () => { revision++; return 'stale'; });
    const apply = vi.fn();
    expect(await hydrateLiveSnapshot({ read, revision: () => revision, current: () => true, apply })).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
    expect(apply).not.toHaveBeenCalled();
  });

  it('retries a lost race and applies only the current response', async () => {
    let revision = 0;
    const read = vi.fn().mockImplementationOnce(async () => { revision++; return 'stale'; }).mockResolvedValue('current');
    const apply = vi.fn();
    expect(await hydrateLiveSnapshot({ read, revision: () => revision, current: () => true, apply })).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls).toEqual([['current']]);
  });

  it('does not retry or apply after unmount or a replacement load', async () => {
    let current = true;
    const read = vi.fn(async () => { current = false; return 'obsolete'; });
    const apply = vi.fn();
    expect(await hydrateLiveSnapshot({ read, revision: () => 0, current: () => current, apply })).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
vi.mock('@/state/store', () => ({ api: (...args: unknown[]) => api(...args) }));
const { getNeedsYou, refreshNeedsYou } = await import('./needs-you');

const snapshot = (title: string) => ({
  checkedAt: '2026-10-10T00:00:00.000Z',
  items: [{ key: 'bill:f1', area: 'bills', level: 'review', title, reason: 'Not received this month.', next: 'Review the follow-up', foundAt: null }],
  counts: { bills: { problem: 0, review: 1 } },
  unavailable: [],
});

describe('Needs you client', () => {
  beforeEach(() => api.mockReset());

  it('coalesces reads and runs once more for a request made during a read', async () => {
    let release!: (value: unknown) => void;
    api.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(snapshot('Second read'));
    const first = refreshNeedsYou();
    void refreshNeedsYou();
    void refreshNeedsYou();
    release(snapshot('First read'));
    await first;
    await vi.waitFor(() => expect(getNeedsYou().snapshot?.items[0]?.title).toBe('Second read'));
    expect(api).toHaveBeenCalledTimes(2);
    expect(getNeedsYou().checking).toBe(false);
  });

  it('keeps the last good snapshot beside the error when a read fails or is malformed', async () => {
    api.mockResolvedValueOnce(snapshot('Water bill'));
    await refreshNeedsYou();
    api.mockResolvedValueOnce({ items: 'nope' });
    await refreshNeedsYou();
    expect(getNeedsYou()).toMatchObject({ error: 'Needs you could not be checked. Refresh to try again.', snapshot: { items: [{ title: 'Water bill' }] } });
    api.mockRejectedValueOnce(new Error('The service is restarting. Try again in a moment.'));
    await refreshNeedsYou();
    expect(getNeedsYou().error).toBe('The service is restarting. Try again in a moment.');
    expect(getNeedsYou().snapshot?.items[0]?.title).toBe('Water bill');
  });
});

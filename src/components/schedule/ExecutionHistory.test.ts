import { describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { aiCostText, readRunCost } from './ExecutionHistory';

describe('a run\'s AI cost line', () => {
  it('reads Modelvia\'s charge in plain words, never a free run it cannot price', () => {
    expect(aiCostText(readRunCost({ state: 'priced', requests: 6, chargedNanoAud: '40000000' }))).toBe('AI: 6 requests · A$0.04');
    expect(aiCostText(readRunCost({ state: 'priced', requests: 1, chargedNanoAud: '1200' }))).toBe('AI: 1 request · under A$0.01');
    expect(aiCostText(readRunCost({ state: 'priced', requests: 3, chargedNanoAud: '12345000000' }))).toBe('AI: 3 requests · A$12.35');
    expect(aiCostText(readRunCost({ state: 'pending', requests: 6 }))).toBe('AI: 6 requests · cost pending');
    expect(aiCostText(readRunCost({ state: 'not-priced', requests: 6 }))).toBe('AI: 6 requests · not priced for this office');
    expect(aiCostText(readRunCost({ state: 'unavailable', requests: 2 }))).toBe('AI: 2 requests · cost unavailable');
    // Some requests carried no receipt id: the count stays, a partial sum is never shown as the total.
    expect(readRunCost({ state: 'incomplete', requests: 3 })).toEqual({ state: 'incomplete', requests: 3 });
    expect(aiCostText(readRunCost({ state: 'incomplete', requests: 3 }))).toBe('AI: 3 requests · cost unavailable');
    expect(aiCostText(readRunCost({ state: 'none' }))).toBeNull();
  });

  it('treats a malformed answer as unavailable', () => {
    for (const value of [null, {}, { state: 'priced', requests: 1, chargedNanoAud: '-5' }, { state: 'priced', requests: 1, chargedNanoAud: 0.04 }, { state: 'pending', requests: -1 }, { state: 'free', requests: 1 }]) {
      expect(readRunCost(value)).toBeNull();
      expect(aiCostText(readRunCost(value))).toBe('AI: cost unavailable');
    }
  });
});

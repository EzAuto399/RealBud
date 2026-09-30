import { describe, expect, it } from 'vitest';
import { usageBudget } from './usage-budget.ts';

describe('customer spending budget', () => {
  it('uses Modelvia headroom including holds, rather than net cost after credits', () => {
    expect(usageBudget('200000000000', '125000000000')).toEqual({ state: 'ready', percent: 37.5, label: '37.5%', committedNanoAud: '75000000000' });
  });
  it('preserves very large exact amounts and never rounds early to 100%', () => {
    const cap = '9'.repeat(60);
    expect(usageBudget(cap, '1')).toMatchObject({ percent: 99.9, label: '99.9%' });
    expect(usageBudget(cap, (BigInt(cap) - BigInt(1)).toString())).toMatchObject({ percent: 0, label: '<0.1%' });
    expect(usageBudget(cap, cap)).toMatchObject({ percent: 0, label: '0%' });
    expect(usageBudget(cap, '0')).toMatchObject({ percent: 100, label: '100%' });
  });
  it('keeps disabled, unknown and inconsistent budgets distinct from zero usage', () => {
    expect(usageBudget('0', '0')).toEqual({ state: 'disabled' });
    for (const [cap, remaining] of [[null, null], ['100', null], ['100', '101'], ['100', '-1'], ['1e3', '0'], ['100', '1.5']]) {
      expect(usageBudget(cap, remaining)).toEqual({ state: 'unavailable' });
    }
  });
});

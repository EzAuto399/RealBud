import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HeldStepCard, WorkerCustodyNotice, readCustodyState, readHeldSteps } from './RecoveryCards';

vi.mock('@/state/store', () => ({ api: vi.fn() }));

const ID = '00000000-0000-4000-8000-00000000000c';
const approval = {
  version: 1, purpose: 'browser-approval-card', id: ID, kind: 'pay', site: 'portal.fictional-strata.example', control: 'Pay now',
  facts: [
    { name: 'recipient', value: 'Fictional Strata Pty Ltd', confirmed: true },
    { name: 'amount', value: '1240.00', confirmed: true },
    { name: 'currency', value: 'AUD', confirmed: true },
  ],
  expiresAt: 1,
};
const server = { steps: [{ id: ID, host: 'portal.fictional-strata.example', summary: 'Pay AUD 1240.00 to Fictional Strata Pty Ltd', approval, at: 1 }] };

describe('held browser step card', () => {
  it('shows what the approval showed, asks the person to check the site and offers the two answers', () => {
    const [step] = readHeldSteps(server);
    const answer = vi.fn();
    const html = renderToStaticMarkup(createElement(HeldStepCard, { step, busy: false, onAnswer: answer }));
    expect(html).toContain('aria-label="Check a step on portal.fictional-strata.example"');
    expect(html).toContain('Bud isn&#x27;t sure this happened. Check portal.fictional-strata.example, then tell Bud.');
    for (const text of ['Did the A$1,240.00 payment to Fictional Strata Pty Ltd go through?', 'Fictional Strata Pty Ltd', 'A$1,240.00', 'Button “Pay now” on portal.fictional-strata.example']) expect(html).toContain(text);
    expect(html).not.toContain('Pay A$1,240.00 to Fictional Strata Pty Ltd?');
    expect(html).toContain('>It happened</button>');
    expect(html).toContain('>It didn&#x27;t happen</button>');
    expect(html).not.toContain('disabled=""');
    // Neither answer is the default: both outcome buttons carry the same secondary style.
    const outcome = [...html.matchAll(/<button [^>]*class="([^"]*)"[^>]*>It (?:happened|didn&#x27;t happen)<\/button>/g)].map(match => match[1]);
    expect(outcome).toHaveLength(2);
    expect(outcome[0]).toBe(outcome[1]);
    expect(outcome[0]).not.toContain('bg-agency');
    expect(renderToStaticMarkup(createElement(HeldStepCard, { step, busy: true, onAnswer: answer })).match(/disabled=""/g)).toHaveLength(2);
  });

  it('keeps a step whose facts are damaged reconcilable, and drops malformed rows', () => {
    const [step] = readHeldSteps({ steps: [{ ...server.steps[0], approval: { broken: true } }, { id: 'nope', host: 'x', summary: '' }] });
    expect(step.approval).toBeNull();
    const html = renderToStaticMarkup(createElement(HeldStepCard, { step, busy: false, onAnswer: vi.fn() }));
    expect(html).toContain('Pay AUD 1240.00 to Fictional Strata Pty Ltd');
    expect(html).toContain('>It happened</button>');
    expect(readHeldSteps({ steps: [{ id: 'nope', host: 'x', summary: '' }] })).toEqual([]);
    expect(() => readHeldSteps({})).toThrow();
  });
});

describe('worker custody notice', () => {
  it('one sentence and one button; damaged has no button', () => {
    const held = renderToStaticMarkup(createElement(WorkerCustodyNotice, { state: 'held', busy: false, onCheck: vi.fn() }));
    expect(held).toContain('restart this computer and then let Bud check.');
    expect(held.match(/<button/g)).toHaveLength(1);
    expect(held).toContain('I&#x27;ve restarted, check again');
    const damaged = renderToStaticMarkup(createElement(WorkerCustodyNotice, { state: 'damaged', busy: false, onCheck: vi.fn() }));
    expect(damaged).not.toContain('<button');
    expect(damaged).toContain('contact RealBud support');
    expect(readCustodyState({ state: 'held' })).toBe('held');
    expect(readCustodyState({ state: 'clear' })).toBe('clear');
    expect(() => readCustodyState({ state: 'anything' })).toThrow();
  });
});

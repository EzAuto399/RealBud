import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CONTINUE_TASK_HINT, HandoffCard, handoffButtons, type Hold } from './HumanHandoffPanel';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: { connected: true } }) }));

const TASK = { version: 1, context: { runId: 'run-1' }, grant: null, completed: [] };
const BINDING = { version: 1, origin: 'https://portal.fictional-strata.example', accountMarker: 'Fictional office account', readyMarker: 'Levy notices', browser: { browserId: 'fictional-browser', tabId: 3 } };
const hold = (value: Partial<Hold['value']> = {}): Hold => ({ id: 'handover:run-1', revision: 2, value: { state: 'awaiting_login', reason: 'login', detail: 'Server detail.', runId: 'run-1', ...value } });
const render = (value: Hold, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(HandoffCard, {
  hold: value, busy: false, connected: true, editing: false, tabs: undefined, draft: undefined, nextStep: undefined,
  onAction: vi.fn(), onToggleEdit: vi.fn(), onDraft: vi.fn(), onNextStep: vi.fn(), ...extra,
}));
const button = (html: string, name: string) => html.match(new RegExp(`<button[^>]*>${name}</button>`))?.[0] ?? '';

describe('HandoffCard', () => {
  it('while Bud waits on the page, shows the server instruction and Stop, and no page form or Continue', () => {
    const html = render(hold({ inPage: true, task: TASK, detail: 'Sign in on the page in your browser, then press Done there. Bud is waiting and continues this task afterwards.' }));
    expect(html).toContain('Sign-in needs you · Waiting for you on the page');
    expect(html).toContain('Sign in on the page in your browser, then press Done there.');
    expect(button(html, 'Stop this request')).not.toContain('disabled=""');
    expect(html).not.toContain('Find my signed-in page');
    expect(html).not.toContain('Page to check');
    expect(html).not.toContain('Change the page check');
    expect(html).not.toContain('Continue — check sign-in');
    expect(html).not.toContain(CONTINUE_TASK_HINT);
  });

  it('keeps Stop usable during the in-page wait even while another action is busy', () => {
    const html = render(hold({ inPage: true, task: TASK }), { busy: true });
    expect(button(html, 'Stop this request')).not.toContain('disabled=""');
  });

  it('on the card with a kept task and a saved page check, says Continue carries the task on', () => {
    const html = render(hold({ task: TASK, binding: BINDING }));
    expect(html).toContain('Sign-in needs you · Waiting for you');
    expect(html).toContain('Sign in on the page, then press Continue — Bud carries on from where it stopped.');
    expect(button(html, 'Continue — check sign-in')).toBeTruthy();
    expect(button(html, 'Stop this request')).toBeTruthy();
    expect(html).not.toContain('Find my signed-in page');
  });

  it('asks for the page on the card when no page check is saved yet', () => {
    const html = render(hold({ task: TASK }), { tabs: [] });
    expect(button(html, 'Find my signed-in page')).toBeTruthy();
    expect(html).toContain('Open it in the browser Bud uses on this computer, then check again.');
    expect(html).not.toContain('Continue — check sign-in');
    expect(html).not.toMatch(/You\s*→/);
  });

  it('does not promise the task carries on for a saved-job handover without a kept task', () => {
    const html = render(hold({ binding: BINDING }));
    expect(button(html, 'Continue — check sign-in')).toBeTruthy();
    expect(html).not.toContain(CONTINUE_TASK_HINT);
  });

  it('closes a checked or stopped handover without the old interrupted-job wording', () => {
    for (const state of ['verified', 'stopped']) {
      const html = render(hold({ state, task: TASK }));
      expect(button(html, 'Close without continuing')).toBeTruthy();
      expect(html).not.toContain('keep job interrupted');
      expect(button(html, 'Stop this request')).toBe('');
    }
    expect(handoffButtons(hold({ state: 'recovery_required' }), false)).toEqual([['retry-release', 'Retry computer release'], ['stop', 'Stop this request']]);
  });
});

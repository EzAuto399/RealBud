import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgencySetupFacts, AgencySetupWorkflowFacts } from '@/lib/setup-sequence';

const store = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(), state: {} as Record<string, unknown> }));
vi.mock('@/state/store', () => ({ useStore: () => ({ state: store.state, dispatch: store.dispatch }), api: store.api }));
/** Stand in for the loops slice the real store hydrates once per session. */
const loopsSlice = (routines: 'loading' | 'ready' | 'error', loops: unknown[] = []) => {
  store.state = { activityLoad: { jobs: routines, routines }, loops };
};
afterEach(() => { store.state = {}; });

import { GoLiveCard } from './GoLiveCard';

const basic = { mode: 'demo' as const, agencyName: '', workerReady: false, onConnectExport: () => {} };
const check = (id: string, state: 'passed' | 'needed' | 'unknown', detail = `${id} detail from the host`) => ({ id, label: `${id} check`, state, detail });
const workflow = (fields: Partial<AgencySetupWorkflowFacts> = {}): AgencySetupWorkflowFacts => ({
  id: 'morning-priorities',
  title: 'Morning priorities and unanswered follow-ups',
  selected: true,
  reviewed: true,
  readyForRun: true,
  checks: [check('gmail', 'passed')],
  ...fields,
});
// Supplying the facts keeps these renders off the card's own bounded read.
const setup = (fields: Partial<AgencySetupFacts> = {}): { agencySetup: AgencySetupFacts } => ({
  agencySetup: { agencyName: 'Harbour Agency', timeZone: 'Australia/Brisbane', packSelected: true, workflows: [workflow()], ...fields },
});

describe('three-step workspace setup card', () => {
  it('shows one current step and its reason on a fresh workspace', () => {
    const html = renderToStaticMarkup(createElement(GoLiveCard, basic));
    expect(html).toContain('aria-label="Workspace setup"');
    expect(html).toContain('Step 1 of 3: Your agency');
    expect(html).not.toContain('Step 2 of 3');
    expect(html).toContain('the timezone its work follows and the workflow pack');
    expect(html).toContain('3 steps, in order');
    expect(html).not.toContain('Go live');
  });

  it('offers exactly one action control for the current step', () => {
    const html = renderToStaticMarkup(createElement(GoLiveCard, basic));
    expect(html.match(/aria-label="Open Agency workflow setup"/g)).toHaveLength(1);
    expect(html).toContain('pm-control');
    // Naming the agency is no longer its own step or its own control.
    expect(html).not.toContain('Name it on You');
    expect(html).not.toContain('go-live-agency');
  });

  it('greys later steps and never shows an unread step as done', () => {
    const html = renderToStaticMarkup(createElement(GoLiveCard, { ...basic, agencySetup: 'unavailable' as const }));
    expect(html).toContain('</span> · 2. Connect your accounts');
    expect(html).toContain('</span> · 3. Approve and schedule');
    expect(html).toContain('could not be read');
    expect(html).not.toContain('Done:');
  });

  it('collapses step 1 once the name, timezone and pack are saved', () => {
    const html = renderToStaticMarkup(createElement(GoLiveCard, {
      ...basic,
      ...setup({ workflows: [workflow({ checks: [check('gmail', 'needed', 'Choose an account and verify its current private read access.')] })] }),
    }));
    expect(html).toContain('Done: 1. Your agency');
    expect(html).toContain('Step 2 of 3: Connect your accounts');
    expect(html).toContain('Connect the accounts your work reads, then check each one.');
    // The host's own check sentence, rendered verbatim.
    expect(html).toContain('Choose an account and verify its current private read access.');
    // Accounts are connected on You, so this step's one control is Connections.
    expect(html.match(/aria-label="Open Connections"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Open Agency workflow setup"');
  });

  it('needs no connected account when the chosen work requires none', () => {
    const html = renderToStaticMarkup(createElement(GoLiveCard, {
      ...basic,
      ...setup({ workflows: [workflow({ id: 'bank-references', title: 'Bank references', checks: [check('mapping', 'passed')], reviewed: false, readyForRun: false })] }),
    }));
    expect(html).toContain('Done: 1. Your agency · 2. Connect your accounts');
    expect(html).toContain('Step 3 of 3: Approve and schedule');
  });

  it('shows Bud as a status line rather than a step', () => {
    expect(renderToStaticMarkup(createElement(GoLiveCard, basic))).toContain('Bud: needs setup on You');
    const ready = renderToStaticMarkup(createElement(GoLiveCard, { ...basic, workerReady: true }));
    expect(ready).toContain('Bud: ready');
    expect(ready).not.toContain('Step 2 of 3: Set up Bud');
  });

  it('ends at the schedule switch while the loops read has not answered', () => {
    const html = renderToStaticMarkup(createElement(GoLiveCard, { ...basic, ...setup() }));
    expect(html).toContain('Step 3 of 3: Approve and schedule');
    expect(html).toContain('switch the schedule on yourself');
    expect(html).toContain('Not checked yet. Enabling is a separate action on Schedule.');
    expect(html).toContain('aria-label="Open Schedule"');
    expect(html).not.toContain('On with a next run recorded');
  });

  it('reads the schedule fact from the store loops slice, done only with a next run', () => {
    const props = { ...basic, ...setup() };
    loopsSlice('ready', [{ id: 'inbound-triage', available: true, enabled: true, nextRunAt: 1_700_000_000_000 }]);
    // Every step is now a host-confirmed done, so the card retires itself.
    expect(renderToStaticMarkup(createElement(GoLiveCard, props))).toBe('');
    loopsSlice('ready', [{ id: 'inbound-triage', available: true, enabled: true, nextRunAt: null }]);
    const stalled = renderToStaticMarkup(createElement(GoLiveCard, props));
    expect(stalled).toContain('Step 3 of 3: Approve and schedule');
    expect(stalled).toContain('Off for Morning priorities and unanswered follow-ups.');
    loopsSlice('error');
    expect(renderToStaticMarkup(createElement(GoLiveCard, props))).toContain('Not checked yet. Enabling is a separate action on Schedule.');
  });

  it('keeps the property export need separate from the three steps', () => {
    const html = renderToStaticMarkup(createElement(GoLiveCard, { ...basic, workflow: 'property-ledger' as const }));
    expect(html).toContain('Also needed for this workflow · Connect your property export');
    expect(html).toContain('aria-label="Open properties"');
    expect(renderToStaticMarkup(createElement(GoLiveCard, basic))).not.toContain('Open properties');
  });

  it('summarises the current step in compact mode', () => {
    const html = renderToStaticMarkup(createElement(GoLiveCard, { ...basic, compact: true, ...setup() }));
    expect(html).toContain('Workspace setup · Step 3 of 3: Approve and schedule');
    expect(html).toContain('Each workflow is still reviewed on its own.');
  });
});

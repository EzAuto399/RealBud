import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { stageState, type FixtureStage } from '../setup-stages.fixture';

const fixture = vi.hoisted(() => ({ stage: 0 as unknown }));
vi.mock('@/state/store', () => ({ api: vi.fn(() => new Promise(() => {})), useStore: () => ({ state: { connected: true, desk: null, loops: [] }, dispatch: vi.fn(), refreshHermes: vi.fn() }) }));
vi.mock('@/lib/use-setup-state', () => ({ useSetupState: () => stageState(fixture.stage as FixtureStage) }));
import { setupStatusItem, StatusBar } from './StatusBar';

const bar = (stage: FixtureStage) => {
  fixture.stage = stage;
  return renderToStaticMarkup(createElement(StatusBar, { browser: null, stopping: false, stopError: '', onStop: () => {}, budget: null }));
};

describe('status bar setup item', () => {
  it('shows one "Setup N of 5 · next" item per stage, each a button to its fix, and nothing once ready', () => {
    const expected: [FixtureStage, string, string][] = [
      [0, 'Setup 1 of 5 · Paste the link code your office sent you', 'Connect this computer to your office first.'],
      [1, 'Setup 3 of 5 · Import your office’s pack', 'Import your office’s pack.'],
      [2, 'Setup 3 of 5 · Import your office’s pack', 'Import your office’s pack.'],
      [3, 'Setup 4 of 5 · Connect what your workflows read', 'Sign in to REI once'],
      [4, 'Setup 5 of 5 · Review and switch on your workflows', '0 of 2 on.'],
    ];
    for (const [stage, label, title] of expected) {
      const html = bar(stage);
      expect(html.match(/Setup \d of 5/g), String(stage)).toHaveLength(1);
      expect(html).toMatch(new RegExp(`<button type="button" class="rb-status-item rb-status-link" title="[^"]*${title}[^"]*"><span[^>]*></span>${label}</button>`));
    }
    const ready = bar('ready');
    expect(ready).not.toContain('Setup ');
    expect(ready).toContain('No loop scheduled');
    expect(setupStatusItem(stageState('ready'))).toBeNull();
  });

  it('replaces setup progress with the most serious degraded state and its fix', () => {
    expect(setupStatusItem(stageState('revoked'))).toMatchObject({ label: 'Office access stopped', target: 'you-website-code' });
    expect(setupStatusItem(stageState('aiLimit'))).toMatchObject({ label: 'AI allowance used', target: 'you-website' });
    expect(setupStatusItem(stageState('gmailLost'))).toMatchObject({ label: 'Gmail needs attention', target: 'you-connected-apps' });
    expect(setupStatusItem(stageState('reiSignedOut'))).toMatchObject({ label: 'REI: sign in needed', target: 'rei-sign-in' });
    const gmail = bar('gmailLost');
    expect(gmail).toMatch(/<button[^>]*title="Gmail needs attention in Connected apps\.[^"]*"><span[^>]*><\/span>Gmail needs attention<\/button>/);
    expect(gmail).not.toContain('Setup ');
    // The connection stays a plain fact while the setup item carries the fix.
    expect(bar('revoked')).not.toMatch(/<button[^>]*>[^<]*<span[^>]*><\/span>Not connected to your office/);
  });
});

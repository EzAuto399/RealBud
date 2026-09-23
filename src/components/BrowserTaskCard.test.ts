import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TASK_OFFER_MARK, BrowserTaskCard, browserTaskAsksFirst, browserTaskSteps, parseBrowserTaskList, type BrowserTaskBrowser, type BrowserTaskCardView } from './BrowserTaskCard';

vi.mock('@/state/store', () => ({ api: vi.fn() }));

const NOW = 1_800_000_000_000;
const task = (extra: Partial<BrowserTaskCardView> = {}): BrowserTaskCardView => ({
  id: '00000000-0000-4000-8000-0000000000c1', messageId: 'message-1', status: 'proposed',
  request: "Download this month's invoices from the strata portal", sites: ['portal.fictional-strata.example'], siteSource: 'saved-job',
  savedJob: 'Strata levy check', actions: ['read', 'navigate', 'click', 'download'], consequential: ['pay', 'sign', 'send', 'notice', 'delete', 'account-change'],
  minutes: 30, budget: 40, offerExpiresAt: NOW + 60 * 60_000, startedAt: null, expiresAt: null, endNote: null, ...extra,
});
const ready: BrowserTaskBrowser = { ready: true, name: 'Chrome' };
const render = (value: BrowserTaskCardView, browser = ready, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(BrowserTaskCard, {
  task: value, browser, now: NOW, onStart: vi.fn(), onDecline: vi.fn(), onSaveJob: vi.fn(), onStop: vi.fn(), onConnect: vi.fn(), ...extra,
}));
const button = (html: string, name: string) => html.match(new RegExp(`<button[^>]*>(?:<[^>]+>)*${name}(?:<[^>]+>)*</button>`))?.[0] ?? '';

describe('BrowserTaskCard', () => {
  it('shows the task as its title, then the site, browser, steps in words, what asks first and the limits, with Start, Not now and Save as a job', () => {
    const html = render(task({ request: "download this month's invoices from the strata portal" }));
    expect(html).toContain('aria-label="Browser task"');
    expect(html).toContain('aria-label="What this task covers"');
    expect(html).toContain("Download this month&#x27;s invoices from the strata portal");
    expect(html).toContain('portal.fictional-strata.example');
    expect(html).toContain('From your saved job “Strata levy check”');
    expect(html).toContain('Chrome on this computer');
    expect(html).toContain('<li>Open pages and read them</li><li>Click links and ordinary buttons</li><li>Download files</li>');
    expect(html).not.toContain('Fill in forms');
    expect(html).not.toContain('Submit this request');
    expect(html).toContain('Asks you first');
    expect(html).toContain('Payments, signatures, messages, notices, deletions and account changes each ask you separately, with the exact details from the page.');
    expect(html).toContain('Time and step limit');
    expect(html).toContain('30 minutes or 40 steps in your browser, whichever comes first. Stop ends it at any time.');
    expect(html).toContain('Needs your go-ahead');
    expect(button(html, 'Start this task')).not.toContain('disabled=""');
    expect(button(html, 'Not now')).toBeTruthy();
    expect(button(html, 'Save as a job instead')).toBeTruthy();
    expect(html).not.toMatch(/broker|MCP|Hermes|You\s*→|grant|origin|action class/i);
  });

  it('offers Connect your browser instead of Start when no browser is connected', () => {
    const html = render(task(), { ready: false, name: null });
    expect(html).toContain('Not connected');
    expect(button(html, 'Start this task')).toBe('');
    expect(button(html, 'Connect your browser')).toContain('aria-describedby');
    expect(html).toContain('Connect your browser before starting.');
    expect(button(html, 'Save as a job instead')).toBeTruthy();
  });

  it('asks for the site when neither the request nor a saved job named one', () => {
    const html = render(task({ sites: [], siteSource: 'none', savedJob: null }));
    expect(html).toContain('<label');
    expect(html).toContain('Site web address');
    expect(html).toContain('placeholder="for example vantagestrata.com.au"');
    expect(button(html, 'Start this task')).toContain('disabled=""');
    expect(html).toContain('Enter the site&#x27;s web address to start.');
  });

  it('shows a running task with its end time and Stop, and no Start', () => {
    const html = render(task({ status: 'active', startedAt: NOW, expiresAt: NOW + 30 * 60_000 }));
    expect(html).toContain('Browser task · running');
    expect(html).toMatch(/Running in your browser · ends by .+ or after 40 steps/);
    expect(button(html, 'Stop the task')).toBeTruthy();
    expect(button(html, 'Start this task')).toBe('');
    expect(button(html, 'Not now')).toBe('');
  });

  it.each([
    ['stopped', 'Stopped by you. Nothing more will be done in your browser for this task.'],
    ['expired', 'This task&#x27;s 30 minutes ran out, so Bud stopped using your browser. Ask again to continue.'],
    ['budget', 'This task used its 40 browser steps, so Bud stopped using your browser. Ask again to continue.'],
    ['finished', 'Finished. This permission has ended; ask again for more browser work.'],
  ] as const)('shows how a %s task ended, with no buttons', (status, note) => {
    const html = render(task({ status, startedAt: NOW, expiresAt: NOW + 1, endNote: note.replace(/&#x27;/g, "'") }));
    expect(html).toContain(note);
    expect(html).not.toContain('<button');
  });

  it('shows Not now, Save as a job and a stale request as final', () => {
    expect(render(task({ status: 'declined' }))).toContain('Not started. Nothing was done in your browser.');
    expect(render(task({ status: 'saved-as-job' }))).toContain('Saved as a job instead.');
    const stale = render(task({ offerExpiresAt: NOW - 1 }));
    expect(stale).toContain('This request is from more than an hour ago. Ask again to start it.');
    expect(stale).not.toContain('<button');
  });

  it('shows a refusal from the server and a busy Start', () => {
    const html = render(task(), ready, { error: 'Another browser task is running in this conversation. Stop it first.', busy: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Another browser task is running in this conversation. Stop it first.');
    expect(button(html, 'Starting…')).toContain('aria-busy="true"');
  });

  it('names forms, upload, keys and Submit only when the task has them', () => {
    expect(browserTaskSteps(['read', 'navigate', 'fill', 'click', 'submit'])).toEqual([
      'Open pages and read them', 'Click links and ordinary buttons', 'Fill in forms', 'Submit this request',
    ]);
    expect(browserTaskSteps(['read', 'navigate', 'click', 'upload', 'keys'])).toEqual([
      'Open pages and read them', 'Click links and ordinary buttons', 'Upload files you give it (none given yet)', 'Press keys such as Enter to search',
    ]);
  });

  it('builds the asks-first line from the task\'s own list and drops the row when it is empty', () => {
    expect(browserTaskAsksFirst(['send', 'pay'])).toBe('Payments and messages each ask you separately, with the exact details from the page.');
    expect(browserTaskAsksFirst([])).toBeNull();
    expect(render(task({ consequential: [] }))).not.toContain('Asks you first');
  });

  it('never turns a malformed reply into a card', () => {
    const good = { tasks: [task()], browser: ready };
    expect(parseBrowserTaskList(good).tasks[0]).toEqual(task());
    expect(() => parseBrowserTaskList({ ...good, browser: { ready: 'yes', name: null } })).toThrow();
    expect(() => parseBrowserTaskList({ ...good, tasks: [{ ...task(), status: 'running-anyway' }] })).toThrow();
    expect(() => parseBrowserTaskList({ ...good, tasks: [{ ...task(), actions: ['read', 'pay'] }] })).toThrow();
    expect(() => parseBrowserTaskList(null)).toThrow();
  });

  it('finds the card by the button name the Ask reply carries (server/browser-grants.ts BROWSER_TASK_OFFER)', () => {
    expect(BROWSER_TASK_OFFER_MARK).toBe('**Start this task**');
  });
});

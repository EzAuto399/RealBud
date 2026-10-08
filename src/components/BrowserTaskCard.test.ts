import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TASK_OFFER_MARK, BrowserTaskCard, DESKTOP_TASK_CHOOSE, DESKTOP_TASK_SCOPE, DesktopWindowPicker, browserTaskAsksFirst, browserTaskLooksOnly, browserTaskSteps, parseBrowserTaskList, type BrowserTaskBrowser, type BrowserTaskCardView } from './BrowserTaskCard';

vi.mock('@/state/store', () => ({ api: vi.fn() }));

const NOW = 1_800_000_000_000;
const task = (extra: Partial<BrowserTaskCardView> = {}): BrowserTaskCardView => ({
  id: '00000000-0000-4000-8000-0000000000c1', messageId: 'message-1', status: 'proposed',
  request: "Download this month's invoices from the strata portal", sites: ['portal.fictional-strata.example'], siteSource: 'saved-job',
  savedJob: 'Strata levy check', actions: ['read', 'navigate', 'click', 'download'], consequential: ['pay', 'sign', 'send', 'notice', 'delete', 'account-change'],
  minutes: 30, budget: 40, offerExpiresAt: NOW + 60 * 60_000, startedAt: null, expiresAt: null, endNote: null, progress: [], ...extra,
});
const ready: BrowserTaskBrowser = { ready: true, name: 'Chrome' };
const render = (value: BrowserTaskCardView, browser = ready, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(BrowserTaskCard, {
  task: value, browser, now: NOW, onStart: vi.fn(), onDecline: vi.fn(), onSaveJob: vi.fn(), onStop: vi.fn(), ...extra,
}));
const mail = { appName: 'Mail', bundleId: 'com.apple.mail', pid: 501, windowId: 77, title: 'Inbox' };
const picker = (state: Parameters<typeof DesktopWindowPicker>[0]['state'], value = '') =>
  renderToStaticMarkup(createElement(DesktopWindowPicker, { state, value, onChange: vi.fn(), onRetry: vi.fn() }));
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

  it('offers Start in one press when the work browser is not open yet: Start opens it', () => {
    const html = render(task(), { ready: false, name: null });
    expect(html).toContain('Work browser on this computer · opens when you start');
    expect(button(html, 'Start this task')).not.toContain('disabled=""');
    expect(html).not.toMatch(/Connect your browser|Not connected/);
    expect(button(html, 'Save as a job instead')).toBeTruthy();
  });

  it('says plainly that a reading task only looks, and shows what the task has done so far', () => {
    expect(render(task())).toContain('Bud only looks: it opens portal.fictional-strata.example, reads pages and follows links. It changes nothing there without asking you first.');
    expect(browserTaskLooksOnly({ actions: ['read', 'navigate', 'click', 'fill', 'keys'], sites: [] })).toBe('Bud only looks: it opens the site, reads pages and follows links. It changes nothing there without asking you first.');
    expect(browserTaskLooksOnly({ actions: ['read', 'navigate', 'click', 'upload'], sites: ['x.example'] })).toBeNull();
    expect(render(task({ actions: ['read', 'navigate', 'click', 'submit'] }))).not.toContain('Bud only looks');
    const running = render(task({ status: 'active', startedAt: NOW, expiresAt: NOW + 60_000, progress: ['Signed in to REI Cloud', 'Opened Reports', 'Downloaded tenants.csv'] }));
    expect(running).toContain('aria-label="Progress"');
    expect(running).toContain('Signed in to REI Cloud · Opened Reports · Downloaded tenants.csv');
    expect(render(task())).not.toContain('aria-label="Progress"');
    expect(render(task({ status: 'finished', startedAt: NOW, expiresAt: NOW + 1, endNote: 'Finished.', progress: ['Opened Reports'] }))).not.toContain('Bud only looks');
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
    expect(() => parseBrowserTaskList({ ...good, tasks: [{ ...task(), progress: undefined }] })).toThrow();
    expect(() => parseBrowserTaskList({ ...good, tasks: [{ ...task(), progress: [42] }] })).toThrow();
    expect(() => parseBrowserTaskList(null)).toThrow();
  });

  it('finds the card by the button name the Ask reply carries (server/browser-grants.ts BROWSER_TASK_OFFER)', () => {
    expect(BROWSER_TASK_OFFER_MARK).toBe('**Start this task**');
  });

  it('offers an app on this computer only when no site was named and the card can start one', () => {
    const noSite = task({ sites: [], siteSource: 'none', savedJob: null });
    expect(render(noSite)).not.toContain('or an app on this computer');
    expect(render(task(), ready, { onStartWindow: vi.fn() })).not.toContain('or an app on this computer');
    const html = render(noSite, ready, { onStartWindow: vi.fn() });
    expect(html).toContain('or an app on this computer');
    expect(html).toContain('Looking for open apps…');
    expect(html).not.toContain('<select');
    expect(button(html, 'Start this task')).toContain('disabled=""');
  });

  it('lists open windows by app and title in a labelled native list, and nothing else until they load', () => {
    const html = picker({ status: 'ready', windows: [mail, { ...mail, windowId: 78, title: '' }] });
    const id = html.match(/<select id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<label for="${id}"`);
    expect(html).toContain('or an app on this computer');
    expect(html).toContain('<option value="" selected="">Choose an open app window</option>');
    expect(html).toContain('<option value="77">Mail — Inbox</option><option value="78">Mail</option>');
    expect(html).not.toMatch(/\bpid\b|\bAX\b|token|501/i);
    expect(picker({ status: 'loading' })).not.toContain('<select');
  });

  it('says why there is no list: none open, could not list, or not available here', () => {
    const empty = picker({ status: 'ready', windows: [] });
    expect(empty).toContain('No app windows are open. Open the app, then check again.');
    expect(empty).not.toContain('<select');
    expect(button(empty, 'Check again')).toBeTruthy();
    const failed = picker({ status: 'error' });
    expect(failed).toContain('RealBud couldn&#x27;t list the open apps.');
    expect(button(failed, 'Check again')).toBeTruthy();
    const off = picker({ status: 'unavailable' });
    expect(off).toBe('<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">Apps on this computer aren&#x27;t available here.</p>');
  });

  it('shows a running app task: the window Bud may use, what asks first, and Stop', () => {
    const html = render(task({ status: 'active', sites: [], siteSource: 'person', savedJob: null, actions: ['read', 'click', 'keys'], startedAt: NOW, expiresAt: NOW + 30 * 60_000, desktop: mail }));
    expect(html).toContain('aria-label="Task in an app on this computer"');
    expect(html).toContain('Task in an app on this computer · running');
    expect(html).toMatch(/Running in Mail · ends by .+ or after 40 steps/);
    expect(html).toContain('App window');
    expect(html).toContain('Mail — Inbox');
    expect(html).toContain(DESKTOP_TASK_SCOPE.replace(/'/g, '&#x27;'));
    expect(DESKTOP_TASK_SCOPE).toContain('asks you before pressing anything that pays, sends, signs or deletes');
    expect(DESKTOP_TASK_SCOPE).not.toMatch(/account/); // a desktop grant carries no account marker to check
    expect(html).toContain('<li>Read the window and scroll it</li><li>Press ordinary buttons, tabs and menu items</li><li>Press Tab, Return, Escape and the arrow keys</li>');
    expect(html).toContain('30 minutes or 40 steps in Mail, whichever comes first. Stop ends it at any time.');
    expect(html).not.toContain('>Browser<');
    expect(html).not.toContain('Bud only looks');
    expect(button(html, 'Stop the task')).toContain('Ends this task and its access to Mail.');
    expect(html).not.toMatch(/\bpid\b|\bAX\b|token|windowId|broker|MCP/i);
  });

  it('titles a request for an app as an app task and asks only for the window, never a site, before one is chosen', () => {
    const notepad = task({ request: 'Open Notepad on this computer and type the rent note', sites: [], siteSource: 'none', savedJob: null, actions: ['read', 'fill', 'click'], appTask: true });
    const html = render(notepad, ready, { onStartWindow: vi.fn() });
    expect(html).toContain('aria-label="Task in an app on this computer"');
    expect(html).toContain(DESKTOP_TASK_CHOOSE.replace(/'/g, '&#x27;'));
    expect(DESKTOP_TASK_CHOOSE).toMatch(/^Bud works only in the window you choose\. /);
    expect(html).toContain('>App window<');
    expect(html).toContain('Choose the window Bud works in');
    expect(html).toContain('Choose the app window to start.');
    expect(button(html, 'Start this task')).toContain('disabled=""');
    expect(html).toContain('<li>Read the window and scroll it</li>');
    expect(html).toContain('30 minutes or 40 steps in the app');
    for (const browserWords of ['Browser task', 'Bud only looks', '>Site<', 'web address', '>Browser<', 'or an app on this computer']) expect(html).not.toContain(browserWords);
    // A site request with no site named keeps the browser wording.
    const site = render(task({ sites: [], siteSource: 'none', savedJob: null, actions: ['read'] }), ready, { onStartWindow: vi.fn() });
    expect(site).toContain('aria-label="Browser task"');
    expect(site).toContain('Bud only looks: it opens the site');
    expect(site).not.toContain('Task in an app');
    expect(parseBrowserTaskList({ tasks: [notepad], browser: ready }).tasks[0].appTask).toBe(true);
    expect(() => parseBrowserTaskList({ tasks: [{ ...notepad, appTask: 'yes' }], browser: ready })).toThrow('Bud sent task details this app cannot read.');
  });

  it('reads an app window on a task and refuses a damaged one', () => {
    const good = { tasks: [task({ desktop: mail })], browser: ready };
    expect(parseBrowserTaskList(good).tasks[0].desktop).toEqual(mail);
    expect(parseBrowserTaskList({ ...good, tasks: [{ ...task(), desktop: null }] }).tasks[0]).not.toHaveProperty('desktop');
    expect(() => parseBrowserTaskList({ ...good, tasks: [{ ...task(), desktop: { ...mail, pid: -1 } }] })).toThrow('Bud sent task details this app cannot read.');
  });
});

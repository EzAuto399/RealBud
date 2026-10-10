import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingState } from '@shared/onboarding';
import { Onboarding } from './Onboarding';
import type { ConnectOfficeViewProps } from './ConnectOffice';
import { defaultComputerName } from './you/browser-link';
import type { OfficeLinkStatus } from '../../server/office-link';

const fixture = vi.hoisted(() => ({
  cells: [] as { value: unknown }[], cursor: 0,
  api: vi.fn(), dispatch: vi.fn(), onDone: vi.fn(), track: vi.fn(), emailGate: vi.fn(),
  config: { profile: { name: '', email: '' } },
  connect: null as unknown as { office: string | null; view: ConnectOfficeViewProps },
  personName: undefined as string | undefined,
  epoch: 0,
  session: new Map<string, string>(),
}));
// Exercise the real rendered handlers while keeping state across explicit
// rerenders. No DOM, server, effect-driven API request or browser storage.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: () => {},
    useState: <T>(initial: T | (() => T)) => {
      const index = fixture.cursor++;
      const cell = fixture.cells[index] ??= { value: typeof initial === 'function' ? (initial as () => T)() : initial };
      return [cell.value as T, (next: T | ((current: T) => T)) => {
        cell.value = typeof next === 'function' ? (next as (current: T) => T)(cell.value as T) : next;
      }];
    },
    useRef: <T>(initial: T) => {
      const index = fixture.cursor++;
      return (fixture.cells[index] ??= { value: { current: initial } }).value as { current: T };
    },
  };
});
vi.mock('@/state/store', () => ({ api: fixture.api, useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }) }));
vi.mock('@/lib/analytics', () => ({ identifyEmail: vi.fn(), setEmailGateDone: fixture.emailGate, track: fixture.track }));
vi.mock('@/lib/company-api', () => ({ companyApi: { sessionVersion: () => fixture.epoch } }));
vi.mock('./Avatar', () => ({ MausAvatar: () => null }));
// The connect step's link state is injected; its protocol is tested in ConnectOffice.test.ts.
vi.mock('./ConnectOffice', async importOriginal => ({
  ...(await importOriginal<typeof import('./ConnectOffice')>()),
  useConnectOffice: (personName?: string) => { fixture.personName = personName; return fixture.connect; },
}));
const OFFICE = 'Fictional Harbour Agency';
const WORKSPACE = 'fictional-private-workspace';
const desk = (contact = 'Fictional Draft', workspaceId = WORKSPACE, revision = 4, onboardingScope = 'a'.repeat(64)) => ({ workspaceId, onboardingScope, revision, book: { office: { pmUser: contact } } });
const request = { approvalUrl: `https://realbud.app/link/${'A'.repeat(43)}`, displayCode: 'ABCD-EFGH', expiresAt: '2026-09-30T10:00:00.000Z' };
function connection(status: OfficeLinkStatus | null, phase: ConnectOfficeViewProps['phase'] = { kind: 'idle' }) {
  const office = status?.state === 'linked' ? status.agencyLabel ?? null : null;
  return { office, view: { status, phase, error: '', code: '', codeBusy: false, onStart: vi.fn(), onOpenAgain: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onCode: vi.fn(), onLinkCode: vi.fn(), onRefresh: vi.fn(), now: Date.parse('2026-09-30T09:55:00.000Z') } };
}

const initial: OnboardingState = { version: 1, scope: 'a'.repeat(64), revision: 3, stage: 'profile' };
type NodeProps = { children?: ReactNode; disabled?: boolean; type?: string; role?: string; onClick?: () => void };
type Node = ReactElement<NodeProps>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement<NodeProps>(value)) return [];
  return [value, ...nodes(value.props.children)];
}
function text(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  return isValidElement<NodeProps>(value) ? text(value.props.children) : '';
}
function render(saved: OnboardingState = initial) {
  fixture.cursor = 0;
  return Onboarding({ initialState: saved, onDone: fixture.onDone });
}
function button(tree: ReactNode, label: string) {
  const matches = nodes(tree).filter(node => node.type === 'button' && text(node.props.children).trim() === label);
  expect(matches).toHaveLength(1);
  return matches[0];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks(); fixture.api.mockReset(); fixture.cells = []; fixture.cursor = 0;
  fixture.config = { profile: { name: '', email: '' } };
  fixture.connect = connection({ state: 'linked', agencyLabel: OFFICE, provisioned: true });
  fixture.epoch = 0;
  fixture.session = new Map();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => fixture.session.get(key) ?? null, setItem: (key: string, value: string) => void fixture.session.set(key, value) });
  let hash = '#welcome';
  vi.stubGlobal('location', { get hash() { return hash; }, set hash(value: string) { hash = '#' + value.replace(/^#/, ''); } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('welcome finish recovery', () => {
  const saved = { ...initial, stage: 'office-rules' as const };

  it('re-enables both destinations when the desk read times out, then completes on retry', async () => {
    vi.useFakeTimers(); fixture.config.profile.name = 'Fictional Draft';
    fixture.api.mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async path => {
      if (path === '/api/desk') return desk();
      if (path === '/api/onboarding') return { ...saved, revision: 4, stage: 'complete' };
      throw new Error('Unexpected fixture request');
    });

    const first = button(render(saved), 'Continue to Bud setup');
    first.props.onClick!(); first.props.onClick!();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api.mock.calls[0]).toEqual(['/api/desk', { signal: expect.any(AbortSignal) }, { timeoutMs: 60_000 }]);
    expect(button(render(saved), 'Open the sample desk first').props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(text(render(saved))).toContain('local service did not respond within a minute');
    expect(fixture.api.mock.calls[0][1].signal.aborted).toBe(true);
    expect(button(render(saved), 'Continue to Bud setup').props.disabled).toBe(false);
    expect(button(render(saved), 'Open the sample desk first').props.disabled).toBe(false);
    expect(fixture.onDone).not.toHaveBeenCalled();

    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledTimes(1));
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk', '/api/desk', '/api/desk', '/api/onboarding', '/api/desk']);
    expect(fixture.api.mock.calls[3][2]).toEqual({ timeoutMs: 60_000 });
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'showDesk' });
    // Choosing the sample desk leaves the office-link screen for this app session.
    expect(fixture.session.get('realbud.linkGateLeft')).toBe('1');
  });

  it('retries a timed-out completion without writing the contact or stage twice', async () => {
    vi.useFakeTimers(); fixture.config.profile.name = 'Fictional Draft';
    let contact = '', stage: OnboardingState['stage'] = 'office-rules', bookRevision = 4;
    const completed = { ...saved, revision: 4, stage: 'complete' as const };
    const lateResponse = deferred<OnboardingState>();
    fixture.api.mockImplementation((path, init, opts) => {
      expect(opts).toEqual({ timeoutMs: 60_000 });
      if (path === '/api/desk') return Promise.resolve(desk(contact, WORKSPACE, bookRevision));
      if (path === '/api/desk/agency') {
        contact = JSON.parse(init.body).office.pmUser;
        expect(JSON.parse(init.body)).toMatchObject({ expectedWorkspaceId: WORKSPACE, expectedRevision: bookRevision });
        bookRevision++;
        return Promise.resolve(desk(contact, WORKSPACE, bookRevision));
      }
      if (path === '/api/onboarding') {
        expect(JSON.parse(init.body)).toEqual({ expectedScope: saved.scope, expectedRevision: saved.revision, stage: 'complete' });
        if (stage === 'complete') return Promise.resolve(completed);
        stage = 'complete';
        return lateResponse.promise;
      }
      throw new Error('Unexpected fixture request');
    });

    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.onDone).not.toHaveBeenCalled();
    expect(button(render(saved), 'Open the sample desk first').props.disabled).toBe(false);
    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledTimes(1));
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk', '/api/desk/agency', '/api/desk', '/api/desk', '/api/onboarding', '/api/desk', '/api/desk', '/api/onboarding', '/api/desk']);
    expect(fixture.api.mock.calls.filter(([path]) => path === '/api/desk/agency')).toHaveLength(1);
    expect(contact).toBe('Fictional Draft');
    expect(stage).toBe('complete');
    lateResponse.resolve(completed);
    await Promise.resolve();
    expect(fixture.onDone).toHaveBeenCalledTimes(1);
  });
  it('holds legacy desk replies without host workspace metadata before any contact write', async () => {
    fixture.config.profile.name = 'Fictional Draft'; fixture.api.mockResolvedValue({ revision: 4, book: { office: { pmUser: '' } } });
    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(text(render(saved))).toContain('reply could not be admitted'));
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk']); expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.onDone).not.toHaveBeenCalled();
  });
  it('holds a deferred first Desk reply from another setup scope before any contact write or completion', async () => {
    fixture.config.profile.name = 'Fictional Draft'; const first = deferred<unknown>();
    const replacement = desk('', 'replacement-workspace', 4, 'b'.repeat(64));
    fixture.api.mockImplementationOnce(() => first.promise).mockImplementation(async path => {
      if (path === '/api/desk') return replacement;
      if (path === '/api/desk/agency') return { ...replacement, revision: 5, book: { office: { pmUser: 'Fictional Draft' } } };
      throw Object.assign(new Error('Your workspace changed. Reopen setup before continuing.'), { status: 409 });
    });
    button(render(saved), 'Open the sample desk first').props.onClick!();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    first.resolve(replacement);
    await vi.waitFor(() => expect(nodes(render(saved)).some(node => node.props.role === 'alert')).toBe(true));
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk']);
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.onDone).not.toHaveBeenCalled();
    expect(fixture.config.profile.name).toBe('Fictional Draft');
  });
  it('holds a Desk reply without its authoritative setup scope before any contact write', async () => {
    fixture.config.profile.name = 'Fictional Draft';
    const { onboardingScope: _scope, ...legacy } = desk(''); fixture.api.mockResolvedValue(legacy);
    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(text(render(saved))).toContain('old reply could not be admitted'));
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk']);
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.onDone).not.toHaveBeenCalled();
  });
  it('holds a later same-workspace Desk reply from a different private member scope before completion', async () => {
    fixture.config.profile.name = 'Fictional Draft'; const later = deferred<unknown>();
    fixture.api.mockResolvedValueOnce(desk()).mockReturnValueOnce(later.promise);
    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(2));
    later.resolve(desk('Fictional Draft', WORKSPACE, 4, 'b'.repeat(64)));
    await vi.waitFor(() => expect(text(render(saved))).toContain('old reply could not be admitted'));
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk', '/api/desk']);
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.onDone).not.toHaveBeenCalled();
  });
  it.each(['workspace', 'actor'] as const)('rejects delayed contact reply after %s change without dispatch or completion', async change => {
    fixture.config.profile.name = 'Fictional Draft'; const reply = deferred<unknown>();
    fixture.api.mockImplementation(path => path === '/api/desk' ? Promise.resolve(desk('')) : path === '/api/desk/agency' ? reply.promise : Promise.reject(new Error('Unexpected fixture request')));
    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(2));
    const payload = JSON.parse(fixture.api.mock.calls[1][1].body); expect(payload).toMatchObject({ expectedWorkspaceId: WORKSPACE, expectedRevision: 4 });
    if (change === 'actor') fixture.epoch++;
    reply.resolve(desk('Fictional Draft', change === 'workspace' ? 'replacement-workspace' : WORKSPACE, 5));
    await vi.waitFor(() => expect(nodes(render(saved)).some(node => node.props.role === 'alert')).toBe(true));
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.onDone).not.toHaveBeenCalled(); expect(fixture.api.mock.calls.filter(([path]) => path === '/api/onboarding')).toHaveLength(0);
    fixture.api.mockResolvedValueOnce({ ...saved, stage: 'profile', revision: 4 });
    button(render(saved), 'Back').props.onClick!();
    await vi.waitFor(() => expect(text(render(saved))).toContain('Before you start'));
    expect(renderToStaticMarkup(render(saved))).toContain('value="Fictional Draft"');
  });
  it('checks current physical workspace after a delayed completion before entering the app', async () => {
    fixture.config.profile.name = 'Fictional Draft'; const reply = deferred<OnboardingState>(); let workspaceId = WORKSPACE;
    fixture.api.mockImplementation(path => path === '/api/desk' ? Promise.resolve(desk('Fictional Draft', workspaceId)) : path === '/api/onboarding' ? reply.promise : Promise.reject(new Error('Unexpected fixture request')));
    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(fixture.api.mock.calls.some(([path]) => path === '/api/onboarding')).toBe(true));
    workspaceId = 'replacement-workspace'; reply.resolve({ ...saved, stage: 'complete', revision: 4 });
    await vi.waitFor(() => expect(text(render(saved))).toContain('old reply could not be admitted'));
    expect(fixture.onDone).not.toHaveBeenCalled(); expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.track).not.toHaveBeenCalledWith('onboarding_completed', expect.anything());
  });
});

describe('welcome backup restore', () => {
  it.each(['profile', 'office-rules'] as const)('offers restore at %s without requiring or saving a profile or book', async stage => {
    const saved = { ...initial, stage };
    const response = deferred<OnboardingState>(); fixture.api.mockReturnValue(response.promise);
    const tree = render(saved), restore = button(tree, 'Restore a private backup');
    expect(restore.props.type).toBe('button'); expect(restore.props.disabled).toBe(false);
    expect(renderToStaticMarkup(tree)).toContain('Choose an encrypted backup and review it before restoring.');
    restore.props.onClick!();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api).toHaveBeenCalledWith('/api/onboarding', { method: 'PUT', body: JSON.stringify({ expectedScope: saved.scope, expectedRevision: saved.revision, stage: 'recovery' }) });
    expect(fixture.onDone).not.toHaveBeenCalled(); expect(location.hash).toBe('#welcome');
    expect(button(render(saved), 'Restore a private backup').props.disabled).toBe(true);
    response.resolve({ ...saved, stage: 'recovery', revision: 4 });
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledTimes(1));
    expect(fixture.onDone).toHaveBeenCalledWith(); expect(location.hash).toBe('#you-private-backup');
    // Recovery never waits behind the office-link screen.
    expect(fixture.session.get('realbud.linkGateLeft')).toBe('1');
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'showYou' });
    expect(fixture.api).toHaveBeenCalledTimes(1); expect(fixture.emailGate).not.toHaveBeenCalled();
    expect(fixture.track).not.toHaveBeenCalledWith('onboarding_completed', expect.anything());
  });

  it.each([
    ['confirmed refusal', () => Promise.reject(Object.assign(new Error('Your workspace changed. Reopen setup before continuing.'), { status: 409 }))],
    ['uncertain response', () => Promise.reject(new TypeError('The save result was not confirmed.'))],
    ['malformed success', () => Promise.resolve({})],
    ['foreign workspace', () => Promise.resolve({ ...initial, scope: 'b'.repeat(64), stage: 'recovery', revision: 4 })],
    ['stale revision', () => Promise.resolve({ ...initial, stage: 'recovery', revision: 2 })],
    ['unexpected completion', () => Promise.resolve({ ...initial, stage: 'complete', revision: 4 })],
  ])('keeps welcome and its draft after %s', async (_name, response) => {
    fixture.config.profile.name = 'Fictional Draft'; fixture.api.mockImplementation(response);
    button(render(), 'Restore a private backup').props.onClick!();
    await vi.waitFor(() => expect(nodes(render()).some(node => node.props.role === 'alert')).toBe(true));
    expect(location.hash).toBe('#welcome'); expect(fixture.onDone).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled(); expect(fixture.emailGate).not.toHaveBeenCalled();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api.mock.calls[0][0]).toBe('/api/onboarding');
    expect(renderToStaticMarkup(render())).toContain('value="Fictional Draft"');
    expect(button(render(), 'Restore a private backup').props.disabled).toBe(false);
  });

  it.each(['profile', 'office-rules'] as const)('blocks duplicate and competing %s actions while restore entry is saving', async stage => {
    fixture.config.profile.name = 'Fictional Draft';
    const saved = { ...initial, stage }, response = deferred<OnboardingState>(); fixture.api.mockReturnValue(response.promise);
    const tree = render(saved), restore = button(tree, 'Restore a private backup');
    restore.props.onClick!(); restore.props.onClick!();
    if (stage === 'profile') button(tree, 'Explore the sample desk').props.onClick!();
    else {
      button(tree, 'Continue to Bud setup').props.onClick!();
      button(tree, 'Open the sample desk first').props.onClick!();
      button(tree, 'Back').props.onClick!();
    }
    expect(fixture.api).toHaveBeenCalledTimes(1);
    response.resolve({ ...saved, stage: 'recovery', revision: 4 });
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledTimes(1));
    expect(fixture.api).toHaveBeenCalledTimes(1);
  });

  it('does not enter restore while an earlier profile save is still unconfirmed', async () => {
    const response = deferred<unknown>(); fixture.api.mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ ...initial, stage: 'office-rules', revision: 4 });
    const tree = render();
    button(tree, 'Explore the sample desk').props.onClick!();
    button(tree, 'Restore a private backup').props.onClick!();
    expect(fixture.api).toHaveBeenCalledTimes(1); expect(fixture.api.mock.calls[0][0]).toBe('/api/config');
    response.resolve({ profile: { name: 'Sample PM', email: '' } });
    await vi.waitFor(() => expect(text(render())).toContain('Step 1 of 5'));
    expect(fixture.api).toHaveBeenCalledTimes(2); expect(fixture.onDone).not.toHaveBeenCalled();
    expect(location.hash).toBe('#welcome');
  });

  it('keeps existing book refusal visible and Open recovery pointed at keys', async () => {
    fixture.config.profile.name = 'Fictional Draft'; const saved = { ...initial, stage: 'office-rules' as const };
    fixture.api.mockImplementation(async path => {
      if (path === '/api/desk') return desk('');
      if (path === '/api/desk/agency') throw new Error('desk is read-only in recovery mode');
      if (path === '/api/onboarding') return { ...saved, stage: 'recovery', revision: 4 };
      throw new Error('Unexpected fixture request');
    });
    button(render(saved), 'Continue to Bud setup').props.onClick!();
    await vi.waitFor(() => expect(text(render(saved))).toContain('A protected book is already on this computer.'));
    const held = render(saved);
    expect(button(held, 'Restore a private backup').props.disabled).toBe(false);
    expect(fixture.onDone).not.toHaveBeenCalled();
    button(held, 'Open recovery').props.onClick!();
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledTimes(1));
    expect(location.hash).toBe('#you-recovery');
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk', '/api/desk/agency', '/api/onboarding']);
  });
});

describe('connect this computer to your office', () => {
  const saved = { ...initial, stage: 'office-rules' as const };
  const html = () => renderToStaticMarkup(render(saved));

  it('leads with the link code and one Connect action, keeping owner approval and rules secondary', () => {
    fixture.config.profile.name = 'Fictional Draft';
    fixture.connect = connection({ state: 'unlinked' });
    const markup = html();
    expect(markup).toContain('Step 1 of 5');
    expect(markup).toMatch(/<h1[^>]*>Connect this computer to your office<\/h1>/);
    expect(markup.match(/class="pm-decision/g)).toHaveLength(1);
    expect(markup).toContain('Paste the link code your office owner sent you.');
    expect(markup).toMatch(/<button type="submit" class="pm-decision[^"]*"[^>]*>Connect with this code<\/button>/);
    expect(markup).toContain('I’m the office owner: approve in my browser</button>');
    // Staff without a code copy the ask for their owner right here; nothing is sent.
    expect(markup).toMatch(/No code yet\?<\/span><span class="workspace-copy"><button type="button"[^>]*aria-label="Copy request for your owner">/);
    expect(markup).not.toContain('<details');
    expect(markup).toContain('aria-label="You stay in charge"');
    expect(markup).not.toContain('Continue to Bud setup');
    expect(button(render(saved), 'Open the sample desk first').props.disabled).toBe(false);
    expect(button(render(saved), 'Restore a private backup').props.disabled).toBe(false);
    expect(markup).not.toMatch(/Hermes|MCP|broker|grant|installation/i);
  });

  it('shows the code to match while the browser approval waits', () => {
    fixture.connect = connection({ state: 'pending', browser: request }, { kind: 'waiting', request });
    const markup = html();
    expect(markup).toContain('Your browser opened realbud.app. Sign in with the email RealBud invited, check the page shows code ABCD-EFGH, then approve.');
    expect(markup).toContain('>ABCD-EFGH</span>');
    expect(markup).toContain('Open the page again</button>');
    expect(markup).toContain('>Cancel</button>');
    expect(markup).toContain('Expires in 5:00');
    expect(markup).not.toContain('approve in my browser</button>');
    expect(markup).not.toContain('Connect with this code');
  });

  it('skips connecting when this computer is already linked and opens Bud setup over Desk', async () => {
    fixture.config.profile.name = 'Fictional Draft'; const replaceState = vi.fn(); vi.stubGlobal('history', { replaceState });
    const markup = html();
    expect(markup).toMatch(/<h1[^>]*>This computer is connected<\/h1>/);
    expect(markup).toContain(`Connected to ${OFFICE}`);
    expect(markup).not.toContain('Connect with this code');
    fixture.api.mockImplementation(async path => {
      if (path === '/api/desk') return desk();
      if (path === '/api/onboarding') return { ...saved, revision: 4, stage: 'complete' };
      throw new Error('Unexpected fixture request');
    });
    button(render(saved), 'Continue to Bud setup').props.onClick!();
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledWith('bud'));
    expect(fixture.session.has('realbud.linkGateLeft')).toBe(false);
    // Get started lives on Desk, the store's first view, so the setup sheet opens over it and no view change closes it.
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'showDesk' });
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: 'showAsk' });
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('explores the sample desk without saving a placeholder as the person’s name, and can still finish', async () => {
    const office: Record<string, unknown> = {};
    fixture.api.mockImplementation(async (path, init) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (path === '/api/config') return { profile: body.profile };
      if (path === '/api/onboarding') return { ...initial, stage: body.stage, revision: body.expectedRevision + 1 };
      if (path === '/api/desk') return desk(String(office.pmUser ?? ''));
      if (path === '/api/desk/agency') { expect(body).toMatchObject({ expectedWorkspaceId: WORKSPACE, expectedRevision: 4 }); Object.assign(office, body.office); return desk(String(office.pmUser)); }
      throw new Error('Unexpected fixture request');
    });
    button(render(), 'Explore the sample desk').props.onClick!();
    await vi.waitFor(() => expect(text(render())).toContain('Step 1 of 5'));
    expect(fixture.api.mock.calls[0][0]).toBe('/api/config');
    expect(JSON.parse(fixture.api.mock.calls[0][1].body)).toEqual({ profile: { name: '', email: '' } });
    expect(defaultComputerName(fixture.personName)).toBe('Office computer');
    const finishSample = button(render(), 'Open the sample desk first');
    expect(finishSample.props.disabled).toBe(false);
    finishSample.props.onClick!();
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledTimes(1));
    // Only the sample book carries the sample contact, which first run never counts as a person.
    expect(office).toEqual({ pmUser: 'Sample PM' });
    expect(fixture.api.mock.calls.filter(([path]) => path === '/api/config')).toHaveLength(1);
  });

  it('numbers connecting as Get started step 1 of 5, with the name page before it', () => {
    expect(renderToStaticMarkup(render())).toContain('Before you start');
    expect(renderToStaticMarkup(render())).not.toMatch(/Step \d of/);
  });
});

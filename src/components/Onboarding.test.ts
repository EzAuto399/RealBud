import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingState } from '@shared/onboarding';
import { Onboarding } from './Onboarding';

const fixture = vi.hoisted(() => ({
  cells: [] as { value: unknown }[], cursor: 0,
  api: vi.fn(), dispatch: vi.fn(), onDone: vi.fn(), track: vi.fn(), emailGate: vi.fn(),
  config: { profile: { name: '', email: '' } },
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
vi.mock('./Avatar', () => ({ MausAvatar: () => null }));

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
  let hash = '#welcome';
  vi.stubGlobal('location', { get hash() { return hash; }, set hash(value: string) { hash = '#' + value.replace(/^#/, ''); } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('welcome finish recovery', () => {
  const saved = { ...initial, stage: 'office-rules' as const };

  it('re-enables both destinations when the desk read times out, then completes on retry', async () => {
    vi.useFakeTimers(); fixture.config.profile.name = 'Fictional Draft';
    fixture.api.mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ book: { office: { pmUser: 'Fictional Draft' } } })
      .mockResolvedValueOnce({ ...saved, revision: 4, stage: 'complete' });

    const first = button(render(saved), 'Continue to Bud setup');
    first.props.onClick!(); first.props.onClick!();
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(fixture.api.mock.calls[0]).toEqual(['/api/desk', { signal: expect.any(AbortSignal) }, { timeoutMs: 15_000 }]);
    expect(button(render(saved), 'Open the sample desk first').props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(text(render(saved))).toContain('local service did not respond within 15 seconds');
    expect(fixture.api.mock.calls[0][1].signal.aborted).toBe(true);
    expect(button(render(saved), 'Continue to Bud setup').props.disabled).toBe(false);
    expect(button(render(saved), 'Open the sample desk first').props.disabled).toBe(false);
    expect(fixture.onDone).not.toHaveBeenCalled();

    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledTimes(1));
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk', '/api/desk', '/api/onboarding']);
    expect(fixture.api.mock.calls[2][2]).toEqual({ timeoutMs: 15_000 });
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'showDesk' });
  });

  it('retries a timed-out completion without writing the contact or stage twice', async () => {
    vi.useFakeTimers(); fixture.config.profile.name = 'Fictional Draft';
    let contact = '', stage: OnboardingState['stage'] = 'office-rules';
    const completed = { ...saved, revision: 4, stage: 'complete' as const };
    const lateResponse = deferred<OnboardingState>();
    fixture.api.mockImplementation((path, init, opts) => {
      expect(opts).toEqual({ timeoutMs: 15_000 });
      if (path === '/api/desk') return Promise.resolve({ book: { office: { pmUser: contact } } });
      if (path === '/api/desk/agency') {
        contact = JSON.parse(init.body).office.pmUser;
        return Promise.resolve({ book: { office: { pmUser: contact } } });
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
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.onDone).not.toHaveBeenCalled();
    expect(button(render(saved), 'Open the sample desk first').props.disabled).toBe(false);
    button(render(saved), 'Open the sample desk first').props.onClick!();
    await vi.waitFor(() => expect(fixture.onDone).toHaveBeenCalledTimes(1));
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(['/api/desk', '/api/desk/agency', '/api/onboarding', '/api/desk', '/api/onboarding']);
    expect(contact).toBe('Fictional Draft');
    expect(stage).toBe('complete');
    lateResponse.resolve(completed);
    await Promise.resolve();
    expect(fixture.onDone).toHaveBeenCalledTimes(1);
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
    await vi.waitFor(() => expect(text(render())).toContain('You stay in charge'));
    expect(fixture.api).toHaveBeenCalledTimes(2); expect(fixture.onDone).not.toHaveBeenCalled();
    expect(location.hash).toBe('#welcome');
  });

  it('keeps existing book refusal visible and Open recovery pointed at keys', async () => {
    fixture.config.profile.name = 'Fictional Draft'; const saved = { ...initial, stage: 'office-rules' as const };
    fixture.api.mockImplementation(async path => {
      if (path === '/api/desk') return { book: { office: { pmUser: '' } } };
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

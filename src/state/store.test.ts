import { isValidElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, StoreProvider } from './store';

// Render StoreProvider once, without a DOM, to reach its real dispatch.
const hook = vi.hoisted(() => ({ state: null as null | ((initial: unknown) => unknown), raw: [] as Array<{ type: string }> }));
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(),
  useReducer: (_reducer: unknown, initial: unknown) => [hook.state ? hook.state(initial) : initial, (action: { type: string }) => { hook.raw.push(action); }],
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
vi.mock('@/lib/local-session', () => ({ ensureSession: async () => '', clearLocalSession: () => {} }));

// A stalled service: the request only ends when its signal aborts.
const stalled = vi.fn((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
  if (init.signal?.aborted) return reject(init.signal.reason);
  init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
}));

describe('api() deadlines', () => {
  afterEach(() => { vi.unstubAllGlobals(); stalled.mockClear(); });
  it('keeps the time budget when the caller also passes a cancel signal', async () => {
    vi.stubGlobal('fetch', stalled);
    vi.stubGlobal('window', new EventTarget());
    const controller = new AbortController();
    await expect(api('/api/channels', { signal: controller.signal }, { timeoutMs: 20 })).rejects.toBeDefined();
    expect(controller.signal.aborted).toBe(false);
  }, 1000);
  it('still lets the caller cancel before the deadline', async () => {
    vi.stubGlobal('fetch', stalled);
    vi.stubGlobal('window', new EventTarget());
    const controller = new AbortController();
    const request = api('/api/channels', { signal: controller.signal }, { timeoutMs: 60_000 });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('turn fallback polling', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); hook.state = null; hook.raw.length = 0; });
  const sendWith = async (connected: boolean) => {
    vi.useFakeTimers();
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { hash: '' } }));
    const bots = [{ id: 'fictional-bud', busy: true, messages: [] }];
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      paths.push(path);
      return new Response(JSON.stringify(path === '/api/bots' ? { bots, groups: [] } : {}), { status: 200 });
    }));
    hook.state = initial => ({ ...(initial as object), connected, bots });
    const tree = StoreProvider({ children: null });
    if (!isValidElement<{ value: { dispatch: (action: unknown) => void } }>(tree)) throw new Error('no provider');
    tree.props.value.dispatch({ type: 'send', botId: 'fictional-bud', text: 'Fictional question' });
    await vi.advanceTimersByTimeAsync(10_000);
    return paths.filter(path => path === '/api/bots').length;
  };
  it('leaves a turn to the live stream instead of polling whole transcripts', async () => {
    expect(await sendWith(true)).toBe(0);
  });
  it('still polls while the live stream is down', async () => {
    expect(await sendWith(false)).toBeGreaterThan(0);
  });
});

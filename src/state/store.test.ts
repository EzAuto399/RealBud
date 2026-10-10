import { isValidElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, clearedStream, flushedStream, StoreProvider, toolStartedStream } from './store';

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
// Sending also asks for the office member session (loaded on demand); with fake timers a real
// module load would land after the timed window, so it answers at once here.
vi.mock('@/lib/company-api', () => ({ companyApi: { memberSessionHeaders: async () => ({}) } }));

// A stalled service: the request only ends when its signal aborts. Its health check is refused.
const stalled = vi.fn((path: string, init: RequestInit) => new Promise((_resolve, reject) => {
  if (path === '/api/health') return reject(new TypeError('Failed to fetch'));
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

describe('Ask step line in the live stream', () => {
  const empty = { streaming: {}, reasoning: {}, step: {} };
  it('names the step at a tool start, keeps it through thinking, and drops it when answer text streams', () => {
    const started = toolStartedStream({ ...empty, streaming: { t: 'Let me look' } }, 't', 'mcp__connected_apps__GMAIL_LIST_THREADS: inbox');
    expect(started).toEqual({ streaming: {}, reasoning: {}, step: { t: 'Checking Gmail…' } });
    const thinking = flushedStream(started, [['t', { text: '', reasoning: 'hmm' }]]);
    expect(thinking.step).toEqual({ t: 'Checking Gmail…' });
    const answering = flushedStream(thinking, [['t', { text: 'Two new', reasoning: '' }]]);
    expect(answering.step).toEqual({});
    expect(answering.streaming).toEqual({ t: 'Two new' });
  });
  it('replaces a step at the next tool, leaves none for an unknown one, and clears it with the turn', () => {
    const bank = toolStartedStream(toolStartedStream(empty, 't', 'mcp__workroom__workroom_read'), 't', 'mcp__bank_source__bank_transactions_list');
    expect(bank.step).toEqual({ t: 'Reading the bank feed…' });
    expect(toolStartedStream(bank, 't', 'tool').step).toEqual({});
    expect(clearedStream({ ...bank, step: { ...bank.step, other: 'Checking Gmail…' } }, 't').step).toEqual({ other: 'Checking Gmail…' });
    expect(clearedStream(empty, 't')).toBe(empty);
  });
});

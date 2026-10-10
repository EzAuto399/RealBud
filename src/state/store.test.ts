import { isValidElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, clearedStream, flushedStream, StoreProvider, toolStartedStream } from './store';
import { WORKSPACE_TABS_CHANGED } from '@/lib/workspace-tabs';
import { productRuntimeEventVisible } from '../../server/product-mode.ts';

// Render StoreProvider once, without a DOM, to reach its real dispatch.
const hook = vi.hoisted(() => ({ state: null as null | ((initial: unknown) => unknown), raw: [] as Array<{ type: string }>, effects: null as null | Array<() => unknown> }));
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(),
  useReducer: (_reducer: unknown, initial: unknown) => [hook.state ? hook.state(initial) : initial, (action: { type: string }) => { hook.raw.push(action); }],
  useState: (initial: unknown) => [initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => { hook.effects?.push(effect); },
}));
vi.mock('@/lib/local-session', () => ({ ensureSession: async () => '', clearLocalSession: () => {} }));
// Sending also asks for the office member session (loaded on demand); with fake timers a real
// module load would land after the timed window, so it answers at once here.
vi.mock('@/lib/company-api', () => ({ companyApi: { memberSessionHeaders: async () => ({}) } }));
vi.mock('@/lib/connected-apps-refresh', () => ({ officeSources: { accept: () => {}, invalidate: () => {} }, watchOfficeSources: () => () => {} }));

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

describe('saved Desk layout announcements in the event stream', () => {
  afterEach(() => { vi.unstubAllGlobals(); hook.effects = null; hook.raw.length = 0; });
  it("rereads Desk once per announced save, from the service's frame alone", async () => {
    const win = Object.assign(new EventTarget(), { location: { hash: '' } });
    vi.stubGlobal('window', win);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const sources: Array<{ onmessage: ((event: { data: string }) => void) | null }> = [];
    vi.stubGlobal('EventSource', class { onmessage = null; onopen = null; onerror = null; constructor() { sources.push(this); } close() {} });
    const heard: unknown[] = [];
    win.addEventListener(WORKSPACE_TABS_CHANGED, event => { heard.push((event as CustomEvent).detail); });
    hook.effects = [];
    StoreProvider({ children: null });
    const stops = hook.effects.map(effect => effect());
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    const frame = (value: unknown) => sources[0]!.onmessage!({ data: JSON.stringify(value) });

    // A product-mode Ask turn where Bud arranges Desk, as the service forwards it
    // (server/index.ts): the tool's completion never reaches the client, and no runtime event rereads.
    const turn = [
      { type: 'turn.started', threadId: 'fictional-thread', turnId: 'fictional-turn' },
      { type: 'item.started', threadId: 'fictional-thread', turnId: 'fictional-turn', itemType: 'tool', itemId: 'tool-1', title: 'mcp__workspace_views__desk_arrange' },
      { type: 'item.completed', threadId: 'fictional-thread', turnId: 'fictional-turn', itemType: 'tool', itemId: 'tool-1', ok: true },
      { type: 'turn.completed', threadId: 'fictional-thread', turnId: 'fictional-turn' },
    ];
    const forwarded = turn.filter(event => productRuntimeEventVisible(event) || event.type === 'turn.started');
    expect(forwarded.map(event => event.type)).toEqual(['turn.started', 'item.started', 'turn.completed']);
    for (const event of forwarded) frame({ kind: 'runtime', event });
    expect(heard).toEqual([]);

    // The service's own announcement: exactly one reread signal per frame, carrying who saved it.
    frame({ kind: 'workspace-tabs', revision: 2, by: 'bud' });
    expect(heard).toEqual([{ revision: 2, by: 'bud' }]);
    frame({ kind: 'workspace-tabs', revision: 3 });
    expect(heard).toEqual([{ revision: 2, by: 'bud' }, { revision: 3 }]);
    // A reconnect may have missed announcements: one signal with no revision rereads.
    frame({ kind: 'hello', streams: [] });
    expect(heard).toHaveLength(3);
    expect(heard[2]).toBeNull();
    for (const stop of stops) if (typeof stop === 'function') stop();
  });
});

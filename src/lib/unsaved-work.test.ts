import { afterEach, describe, expect, it, vi } from 'vitest';

const drafts = vi.hoisted(() => ({ property: false, bill: false, mail: false, office: false, department: false }));
vi.mock('@/lib/property-edits', () => ({ hasPropertyEdits: () => drafts.property }));
vi.mock('@/lib/bill-review-drafts', () => ({ hasUnpersistedBillDrafts: () => drafts.bill }));
vi.mock('@/lib/mail-review-drafts', () => ({ hasUnsavedMailReviews: () => drafts.mail }));
vi.mock('@/lib/office-draft-journal', () => ({ hasUnsavedOfficeDrafts: () => drafts.office }));
vi.mock('@/lib/department-configuration-draft-journal', () => ({ hasUnsavedDepartmentConfigurationDrafts: () => drafts.department }));
// Node renders run no effects: keep one component's refs across renders and record its effects.
const component = vi.hoisted(() => ({ refs: [] as { current: unknown }[], ref: 0, effects: [] as Array<{ effect: () => unknown; deps?: unknown[] }> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useRef: (initial: unknown) => component.refs[component.ref++] ??= { current: initial },
  useEffect: (effect: () => unknown, deps?: unknown[]) => { component.effects.push({ effect, deps }); } }));
import { guardUnsavedWork, hasUnsavedWork, holdUnloadWhile, registerUnsavedCheck, useUnsavedGuard } from './unsaved-work';

/** Whether a beforeunload listener holds the window. */
const holds = (listener: (event: BeforeUnloadEvent) => void) => {
  const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
  listener(event as unknown as BeforeUnloadEvent);
  return event.preventDefault.mock.calls.length === 1 && event.returnValue === '';
};
/** The window's beforeunload listeners, as a component's guard adds and removes them. */
const stubUnloadListeners = () => {
  const listeners = new Set<(event: BeforeUnloadEvent) => void>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: (event: BeforeUnloadEvent) => void) => { if (type === 'beforeunload') listeners.add(listener); },
    removeEventListener: (type: string, listener: (event: BeforeUnloadEvent) => void) => { if (type === 'beforeunload') listeners.delete(listener); },
  });
  return listeners;
};
/** App's guard: beforeunload over the whole answer. */
const appUnloadHeld = () => holds(holdUnloadWhile(hasUnsavedWork));
afterEach(() => vi.unstubAllGlobals());

describe('unsaved work', () => {
  it('gives the update restart the same answer as beforeunload, for every kind of draft', () => {
    expect(hasUnsavedWork()).toBe(false);
    expect(appUnloadHeld()).toBe(false);
    for (const kind of Object.keys(drafts) as (keyof typeof drafts)[]) {
      drafts[kind] = true;
      expect(hasUnsavedWork(), kind).toBe(true);
      expect(appUnloadHeld(), kind).toBe(true);
      drafts[kind] = false;
    }
  });

  it('adds registered checks to the answer until they unregister', () => {
    const caseEdits = new Map<string, unknown>();
    const stop = registerUnsavedCheck(() => caseEdits.size > 0);
    expect(hasUnsavedWork()).toBe(false);
    caseEdits.set('case-1', { note: 'fictional wording' });
    expect(hasUnsavedWork()).toBe(true);
    expect(appUnloadHeld()).toBe(true);
    stop();
    expect(hasUnsavedWork()).toBe(false);
    // The same function registered twice unregisters independently.
    const always = () => true;
    const first = registerUnsavedCheck(always), second = registerUnsavedCheck(always);
    first();
    expect(hasUnsavedWork()).toBe(true);
    second();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('counts a check that throws as unsaved', () => {
    const stop = registerUnsavedCheck(() => { throw new Error('fictional failure'); });
    expect(hasUnsavedWork()).toBe(true);
    stop();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('guards a component: its beforeunload holds exactly when its check answers main, and both end on cleanup', () => {
    const listeners = stubUnloadListeners();
    const draft = { open: false };
    const stop = guardUnsavedWork(() => draft.open);
    expect(listeners.size).toBe(1);
    const [own] = listeners;
    for (const open of [false, true, false]) {
      draft.open = open;
      expect(holds(own)).toBe(open);
      expect(hasUnsavedWork()).toBe(open);
    }
    draft.open = true;
    stop();
    expect(listeners.size).toBe(0);
    expect(hasUnsavedWork()).toBe(false);
  });

  it('joins a component once per mount with its latest answer, and leaves when it unmounts', () => {
    const listeners = stubUnloadListeners();
    component.refs.length = 0; component.effects.length = 0;
    const render = (dirty: boolean) => { component.ref = 0; useUnsavedGuard(dirty); };
    render(false);
    expect(component.effects.map(entry => entry.deps)).toEqual([[]]);
    // React runs an effect with no deps once, after the first render.
    const unmount = component.effects[0]!.effect() as () => void;
    expect(listeners.size).toBe(1);
    const [own] = listeners;
    expect(hasUnsavedWork()).toBe(false);
    // Typing, then saving: each render's answer is what main and beforeunload see.
    for (const dirty of [true, false, true]) {
      render(dirty);
      expect(hasUnsavedWork()).toBe(dirty);
      expect(holds(own)).toBe(dirty);
    }
    unmount();
    expect(listeners.size).toBe(0);
    expect(hasUnsavedWork()).toBe(false);
  });
});

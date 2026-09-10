import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";

type TimingDraft = { base: string; time: string; days: number[] };
interface ViewState { scheduleSelected: string | null; scheduleResults: boolean; deskResults: boolean; expandedActivities: string[]; scheduleTiming: ReadonlySet<string>; timingDrafts: Record<string, TimingDraft> }
const view: ViewState = { scheduleSelected: null, scheduleResults: false, deskResults: false, expandedActivities: [], scheduleTiming: new Set(), timingDrafts: {} };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useWorkspaceViewState<K extends keyof ViewState>(key: K): [ViewState[K], (next: SetStateAction<ViewState[K]>) => void] {
  const value = useSyncExternalStore(subscribe, () => view[key], () => view[key]);
  return [value, next => {
    view[key] = typeof next === "function" ? (next as (old: ViewState[K]) => ViewState[K])(view[key]) : next;
    listeners.forEach(listener => listener());
  }];
}

export function resolveTimingDraft(savedTime: string, savedDays: number[], cached?: TimingDraft): TimingDraft {
  const base = JSON.stringify([savedTime, savedDays]);
  // A changed server schedule supersedes an edit based on an old schedule.
  return cached?.base === base ? cached : { base, time: savedTime, days: [...savedDays] };
}
export function useScheduleTiming(id: string, savedTime: string, savedDays: number[]) {
  const [drafts, setDrafts] = useWorkspaceViewState("timingDrafts");
  const value = resolveTimingDraft(savedTime, savedDays, drafts[id]);
  const update = (change: (old: TimingDraft) => TimingDraft) => setDrafts(current => {
    const next = { ...current, [id]: change(resolveTimingDraft(savedTime, savedDays, current[id])) };
    const keys = Object.keys(next);
    if (keys.length > 100) delete next[keys.find(key => key !== id)!];
    return next;
  });
  return { time: value.time, days: value.days,
    setTime: (next: SetStateAction<string>) => update(old => ({ ...old, time: typeof next === "function" ? next(old.time) : next })),
    setDays: (next: SetStateAction<number[]>) => update(old => ({ ...old, days: typeof next === "function" ? next(old.days) : next })),
  };
}

// Only navigation coordinates live here. No property data or background work.
const positions = new Map<string, number>();
const conversationFollow = new Map<string, boolean>();
export function useConversationFollow(threadId: string): [boolean, (value: boolean) => void] {
  const [follow, setFollow] = useState(() => conversationFollow.get(threadId) ?? true);
  useEffect(() => { setFollow(conversationFollow.get(threadId) ?? true); }, [threadId]);
  const update = useCallback((value: boolean) => {
    conversationFollow.set(threadId, value);
    if (conversationFollow.size > 50) conversationFollow.delete(conversationFollow.keys().next().value!);
    setFollow(value);
  }, [threadId]);
  return [follow, update];
}
export function useWorkspaceScroll(key: string, ready = true) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !ready) return;
    const target = positions.get(key) ?? 0;
    let restoring = target > 0;
    const restore = () => {
      if (!restoring) return;
      node.scrollTop = target;
      if (node.scrollTop >= target - 1) restoring = false;
    };
    restore();
    const resize = new ResizeObserver(restore);
    for (const child of node.children) resize.observe(child);
    const content = new MutationObserver(() => { for (const child of node.children) resize.observe(child); restore(); });
    content.observe(node, { childList: true });
    const settle = () => { restoring = false; };
    const timer = window.setTimeout(settle, 5000);
    const save = () => {
      if (!restoring) positions.set(key, node.scrollTop);
      if (positions.size > 60) positions.delete(positions.keys().next().value!);
    };
    node.addEventListener("scroll", save, { passive: true });
    node.addEventListener("wheel", settle, { passive: true });
    node.addEventListener("touchstart", settle, { passive: true });
    node.addEventListener("keydown", settle);
    node.addEventListener("pointerdown", settle);
    return () => {
      if (!restoring) positions.set(key, node.scrollTop);
      resize.disconnect(); content.disconnect(); window.clearTimeout(timer);
      node.removeEventListener("scroll", save); node.removeEventListener("wheel", settle);
      node.removeEventListener("touchstart", settle); node.removeEventListener("keydown", settle); node.removeEventListener("pointerdown", settle);
    };
  }, [key, ready]);
  return ref;
}

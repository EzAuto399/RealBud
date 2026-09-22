import { useEffect, useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { CHANNELS_UPDATED_EVENT, channelsAwaitingPair, mergeChannelsPatch, readChannels, type ChannelsState } from "./telegram-channel";

export function createPhoneConnections(request: (signal: AbortSignal) => Promise<unknown>) {
  let snapshot: { channels: ChannelsState | null; error: string } = { channels: null, error: "" };
  let generation = 0;
  let flight: Promise<void> | null = null;
  let controller: AbortController | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const replace = (channels: ChannelsState | null) => {
    generation++; controller?.abort(); flight = null;
    snapshot = { channels, error: "" }; emit();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    replace,
    patch: (detail: unknown) => {
      if (!detail || typeof detail !== "object" || !["telegram", "discord", "slack"].some(key => key in detail)) return;
      replace(mergeChannelsPatch(snapshot.channels, detail));
    },
    refresh: () => {
      if (flight) return flight;
      const current = ++generation;
      controller = new AbortController();
      flight = (async () => {
        try {
          const signal = controller!.signal;
          const body = await Promise.resolve().then(() => request(signal));
          if (current !== generation) return;
          if (!body || typeof body !== "object" || !["telegram", "discord", "slack"].every(key => {
            const row = (body as Record<string, unknown>)[key];
            return row && typeof row === "object" && "connected" in row && typeof row.connected === "boolean";
          })) throw new Error("Invalid channel status");
          snapshot = { channels: readChannels(body), error: "" };
        } catch {
          if (current !== generation) return;
          snapshot = { channels: null, error: "Couldn’t check phone connections. Try again when this computer is connected." };
        } finally { if (current === generation) { flight = null; emit(); } }
      })();
      return flight;
    },
  };
}

const phone = createPhoneConnections(signal => api("/api/channels", { signal }, { timeoutMs: 15_000 }));
let watchers = 0;
let stop: (() => void) | undefined;
function watch() {
  if (++watchers === 1) {
    let fastUntil = Date.now() + 5 * 60_000;
    const refresh = () => { if (document.visibilityState !== "hidden") void phone.refresh(); };
    const patch = (event: Event) => { phone.patch((event as CustomEvent).detail); fastUntil = Date.now() + 5 * 60_000; };
    const focus = () => { fastUntil = Date.now() + 5 * 60_000; refresh(); };
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks++;
      if ((channelsAwaitingPair(phone.getSnapshot().channels) && Date.now() < fastUntil) || ticks % 15 === 0) refresh();
    }, 2000);
    window.addEventListener(CHANNELS_UPDATED_EVENT, patch);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", refresh);
    refresh();
    stop = () => { clearInterval(timer); window.removeEventListener(CHANNELS_UPDATED_EVENT, patch); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", refresh); };
  }
  return () => { if (--watchers === 0) { stop?.(); stop = undefined; } };
}
export function usePhoneConnections(enabled = true) {
  const snapshot = useSyncExternalStore(phone.subscribe, phone.getSnapshot, phone.getSnapshot);
  useEffect(() => enabled ? watch() : undefined, [enabled]);
  return { ...snapshot, channels: enabled ? snapshot.channels : null, refresh: phone.refresh, update: phone.replace };
}

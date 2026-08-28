import { describe, expect, it } from "vitest";

import {
  EVENT_STREAM_RETRY_DELAYS_MS,
  EVENT_STREAM_WATCHDOG_MS,
  openResilientEventStream,
} from "./event-stream";

type FakeSource = {
  url: string;
  closed: boolean;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close: () => void;
};

function source(url: string): FakeSource {
  return {
    url,
    closed: false,
    onopen: null,
    onmessage: null,
    onerror: null,
    close() {
      this.closed = true;
    },
  };
}

describe("openResilientEventStream", () => {
  it("refreshes the session token after a stale stream instead of retrying the old URL", async () => {
    const sources: FakeSource[] = [];
    const tokenForces: boolean[] = [];
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const opened: string[] = [];
    const messages: string[] = [];
    let errors = 0;

    const close = openResilientEventStream({
      getSessionToken: async (force) => {
        tokenForces.push(force);
        return force ? "fresh token" : "stale token";
      },
      createSource: (url) => {
        const next = source(url);
        sources.push(next);
        return next as unknown as EventSource;
      },
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancelSchedule: () => {},
      watchdogMs: 0,
      onOpen: () => opened.push("open"),
      onError: () => {
        errors += 1;
      },
      onMessage: (event) => messages.push(event.data),
    });

    await Promise.resolve();
    expect(sources[0].url).toBe("/api/events?session=stale%20token");

    sources[0].onerror?.(new Event("error"));
    expect(sources[0].closed).toBe(true);
    expect(errors).toBe(1);
    expect(scheduled[0].delay).toBe(EVENT_STREAM_RETRY_DELAYS_MS[0]);

    scheduled.shift()!.callback();
    await Promise.resolve();
    expect(tokenForces).toEqual([false, true]);
    expect(sources[1].url).toBe("/api/events?session=fresh%20token");

    sources[1].onopen?.(new Event("open"));
    sources[1].onmessage?.(new MessageEvent("message", { data: "reply" }));
    expect(opened).toEqual(["open"]);
    expect(messages).toEqual(["reply"]);

    close();
    expect(sources[1].closed).toBe(true);
  });

  it("cancels a queued retry when the provider unmounts", async () => {
    const sources: FakeSource[] = [];
    let cancelled = false;
    const close = openResilientEventStream({
      getSessionToken: async () => "old",
      createSource: (url) => {
        const next = source(url);
        sources.push(next);
        return next as unknown as EventSource;
      },
      schedule: () => 7 as unknown as ReturnType<typeof setTimeout>,
      cancelSchedule: () => {
        cancelled = true;
      },
      watchdogMs: 0,
      onOpen: () => {},
      onError: () => {},
      onMessage: () => {},
    });

    await Promise.resolve();
    sources[0].onerror?.(new Event("error"));
    close();
    expect(cancelled).toBe(true);
  });

  it("reconnects when a proxy leaves the event stream silently open", async () => {
    const sources: FakeSource[] = [];
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let errors = 0;
    const close = openResilientEventStream({
      getSessionToken: async (force) => (force ? "refreshed" : "first"),
      createSource: (url) => {
        const next = source(url);
        sources.push(next);
        return next as unknown as EventSource;
      },
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancelSchedule: () => {},
      onOpen: () => {},
      onError: () => {
        errors += 1;
      },
      onMessage: () => {},
    });

    await Promise.resolve();
    expect(scheduled[0].delay).toBe(EVENT_STREAM_WATCHDOG_MS);
    scheduled.shift()!.callback();
    expect(sources[0].closed).toBe(true);
    expect(errors).toBe(1);
    expect(scheduled[0].delay).toBe(EVENT_STREAM_RETRY_DELAYS_MS[0]);

    scheduled.shift()!.callback();
    await Promise.resolve();
    expect(sources[1].url).toBe("/api/events?session=refreshed");
    close();
  });
});

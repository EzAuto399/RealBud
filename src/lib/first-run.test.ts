import { describe, expect, it, vi } from "vitest";

import { createFirstRunApi, firstRunDone, officeContactNamed, readSavedSetup, SAVED_SETUP_SLOW, SAVED_SETUP_TIMEOUT_MS } from "./first-run";
import type { OnboardingState } from '@shared/onboarding';
const state: OnboardingState = { version: 1, scope: 'a'.repeat(64), revision: 0, stage: 'profile' };

describe("saved first run", () => {
  it("never infers completion from an interrupted or recovery stage", () => {
    expect(firstRunDone(null)).toBe(false);
    for (const stage of ['profile', 'office-rules', 'recovery'] as const) expect(firstRunDone({ ...state, stage })).toBe(false);
    expect(firstRunDone({ ...state, stage: 'complete' })).toBe(true);
  });
  it('reads completion from the server with no browser storage', async () => {
    const request = vi.fn().mockResolvedValue({ ...state, stage: 'complete', revision: 2 });
    expect(firstRunDone(await createFirstRunApi(request).read())).toBe(true);
    expect(request).toHaveBeenCalledWith('/api/onboarding');
  });
  it('binds writes to the exact scope and revision and rejects a different member response', async () => {
    const request = vi.fn().mockResolvedValue({ ...state, scope: 'b'.repeat(64), stage: 'office-rules', revision: 1 });
    await expect(createFirstRunApi(request).save(state, 'office-rules')).rejects.toThrow('workspace changed');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ expectedScope: state.scope, expectedRevision: 0, stage: 'office-rules' });
  });
  it.each([null, {}, { ...state, stage: 'unknown' }, { ...state, revision: -1 }, { ...state, extra: true }])('rejects malformed success responses', async response => {
    await expect(createFirstRunApi(vi.fn().mockResolvedValue(response)).read()).rejects.toThrow('could not be checked');
  });
  it('does not turn a lost response into completion', async () => {
    await expect(createFirstRunApi(vi.fn().mockRejectedValue(new Error('response lost'))).save(state, 'office-rules')).rejects.toThrow('response lost');
    expect(firstRunDone(state)).toBe(false);
  });
});

describe("the first screen's bounded read", () => {
  it("offers a retry instead of waiting forever on a busy service", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(() => new Promise(() => {}));
      const read = readSavedSetup(request);
      const settled = expect(read).rejects.toThrow(SAVED_SETUP_SLOW);
      await vi.advanceTimersByTimeAsync(SAVED_SETUP_TIMEOUT_MS);
      await settled;
      // The transport gets the same budget, so the hung request is abandoned too.
      expect(request).toHaveBeenCalledWith('/api/onboarding', undefined, { timeoutMs: SAVED_SETUP_TIMEOUT_MS });
      expect(SAVED_SETUP_SLOW).toMatch(/Try again/);
    } finally { vi.useRealTimers(); }
  });
  it("returns the saved state when the service answers in time and never infers completion from a timeout", async () => {
    await expect(readSavedSetup(vi.fn().mockResolvedValue({ ...state, stage: 'complete', revision: 3 }), 50)).resolves.toMatchObject({ stage: 'complete' });
    await expect(readSavedSetup(vi.fn(() => new Promise(() => {})), 5)).rejects.toThrow('did not answer in time');
  });
});

describe("a restored book already records the office contact", () => {
  it("reads a saved person as recorded", () => {
    expect(officeContactNamed({ book: { office: { pmUser: "Alex" } } })).toBe(true);
  });

  it("reads a saved person as recorded on a book whose agency is still unnamed", () => {
    expect(officeContactNamed({ book: { agency: { name: "" }, office: { pmUser: "Alex" } } })).toBe(true);
  });

  it.each([
    // The contact is the only field first run writes. A named agency with an
    // empty contact is a blank to fill, so it must not skip the write.
    { name: "a named agency with no contact yet", snapshot: { book: { agency: { name: "Harbour PM" }, office: { pmUser: "" } } } },
    { name: "an empty book", snapshot: { book: { office: { pmUser: "" } } } },
    { name: "whitespace standing in for a name", snapshot: { book: { office: { pmUser: "\t" } } } },
    { name: "the sample person", snapshot: { book: { office: { pmUser: "Sample PM" } } } },
    { name: "the sample person in other casing", snapshot: { book: { office: { pmUser: " sample pm " } } } },
    { name: "the demo person", snapshot: { book: { office: { pmUser: "Demo PM" } } } },
    { name: "a book that has not loaded", snapshot: {} },
    { name: "no snapshot at all", snapshot: null },
  ])("does not read $name as a recorded contact", ({ snapshot }) => {
    expect(officeContactNamed(snapshot)).toBe(false);
  });
});

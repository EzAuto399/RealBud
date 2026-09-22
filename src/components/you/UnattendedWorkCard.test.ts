import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { UnattendedWorkCardView, scheduleIsEnabled } from "./UnattendedWorkCard";

// The view is handed what the main process reported; the mock keeps the house
// component-test pattern if anything in its tree reaches for the store.
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

const state = (over: Partial<ServicePersistenceState> = {}): ServicePersistenceState => ({
  settings: { startOfficeServiceAtLogin: false, keepAwakeForSchedules: false },
  startup: { supported: true, reason: "supported", explanation: "RealBud can start its office service in the background after you sign in to this computer." },
  keepAwake: { holding: false, state: "off", explanation: "This computer sleeps on its usual settings, so scheduled work does not run while it is asleep." },
  scheduleEnabled: false,
  ...over,
});

const render = (over: Partial<ServicePersistenceState> | null = {}, extra: { busy?: boolean; error?: string } = {}) =>
  renderToStaticMarkup(
    createElement(UnattendedWorkCardView, {
      state: over === null ? null : state(over),
      busy: extra.busy ?? false,
      error: extra.error ?? "",
      onChange: () => {},
    }),
  );

describe("unattended work settings", () => {
  it("offers both choices by the names QA and screen readers use", () => {
    const html = render();
    expect(html).toContain('aria-label="Start the office service when I sign in"');
    expect(html).toContain('aria-label="Keep this computer awake for scheduled work"');
  });

  it("gives each choice its consequence in one sentence", () => {
    const html = render();
    expect(html).toContain("after you sign in to this computer");
    expect(html).toContain("stops it going to sleep");
    expect(html).toContain("the screen still");
  });

  it("shows what a sign-in start looks like on this particular computer", () => {
    // A Mac opens the app; only Windows starts it out of sight. The card repeats
    // whichever one the main process reported rather than promising both.
    const mac = render({ startup: { supported: true, reason: "supported", explanation: "RealBud opens after you sign in to this computer and starts its office service; on a Mac it cannot start completely out of sight." } });
    expect(mac).toContain("cannot start completely out of sight");
    expect(mac).not.toContain("in the background");
  });

  it("says plainly that a closed lid or a switched-off computer still misses the work", () => {
    const html = render();
    expect(html).toContain("closed lid");
    expect(html).toContain("switched off");
    expect(html).toContain("missed or late");
    expect(html).toContain("last checked");
  });

  it("never claims the work survives a restart", () => {
    const html = render({ settings: { startOfficeServiceAtLogin: true, keepAwakeForSchedules: true } });
    expect(html).not.toMatch(/reboot|restart|even when.{0,20}off|always running/i);
  });

  it("keeps internal vocabulary out of the copy", () => {
    const html = render({ keepAwake: { holding: true, state: "holding", explanation: "While this computer is plugged in and switched on, RealBud keeps it from sleeping so scheduled work can run; the screen still turns off." } });
    expect(html).not.toMatch(/\bHermes\b|\bMCP\b|\bbroker\b|RealBud clock|You\s*(?:→|>)/i);
  });

  it("reflects what the computer reports, not what was asked for", () => {
    const on = render({ settings: { startOfficeServiceAtLogin: true, keepAwakeForSchedules: true } });
    expect(on.match(/checked=""/g)).toHaveLength(2);
    expect(render().match(/checked=""/g)).toBeNull();
  });

  it("shows the live keep-awake explanation, including on battery", () => {
    const html = render({
      settings: { startOfficeServiceAtLogin: false, keepAwakeForSchedules: true },
      keepAwake: { holding: false, state: "on-battery", explanation: "On battery this computer is left to sleep on its usual settings, so plug it in for scheduled work to run unattended." },
    });
    expect(html).toContain("plug it in");
  });

  it("disables and explains the sign-in choice when this build cannot register", () => {
    const html = render({ startup: { supported: false, reason: "development", explanation: "A development build cannot start itself at sign-in; the installed RealBud app can." } });
    expect(html).toContain("A development build cannot start itself at sign-in");
    expect(html).toMatch(/aria-label="Start the office service when I sign in"[^>]*disabled/);
  });

  it("says a choice that could not be saved will not survive a restart", () => {
    expect(render({ saved: false })).toContain("could not be saved on this computer");
  });

  it("does not present unknown settings as off", () => {
    const html = render(null);
    expect(html).toContain("Checking what this computer is set to do");
    expect(html).toMatch(/aria-label="Keep this computer awake for scheduled work"[^>]*disabled/);
  });

  it("surfaces a failed change instead of showing the old value as new", () => {
    expect(render({}, { error: "This computer did not accept the change. Try again." })).toContain("did not accept the change");
  });
});

describe("scheduleIsEnabled", () => {
  it("is unknown until the schedule has actually been read", () => {
    // An unhydrated screen must not report "nothing scheduled" and release a
    // hold that should stand.
    expect(scheduleIsEnabled([])).toBeNull();
  });

  it("is true when any available job is on", () => {
    expect(scheduleIsEnabled([{ enabled: false, available: true }, { enabled: true, available: true }])).toBe(true);
  });

  it("ignores a job that is on but unavailable", () => {
    expect(scheduleIsEnabled([{ enabled: true, available: false }])).toBe(false);
  });

  it("is false when every job is off", () => {
    expect(scheduleIsEnabled([{ enabled: false, available: true }])).toBe(false);
  });
});

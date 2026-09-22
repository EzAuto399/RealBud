import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { autoRestartCopy, officeRunningCopy, ServiceStatusCard } from "./ServiceStatusCard";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

const status = (autoRestart: unknown) => ({ state: "unmanaged", restarts: 0, lastExitCode: null, exhausted: false, running: true, autoRestart });

describe("automatic restart copy", () => {
  it("says how many times the office service was restarted today", () => {
    expect(autoRestartCopy(status({ today: 1, pending: false, exhausted: false })).running).toMatch(/^Restarted automatically once today\./);
    expect(autoRestartCopy(status({ today: 3, pending: false, exhausted: false })).running).toMatch(/^Restarted automatically 3 times today\./);
    expect(autoRestartCopy(status({ today: 0, pending: false, exhausted: false })).running).toBeNull();
  });

  it("hands over to the Start button once automatic restarts pause", () => {
    expect(autoRestartCopy(status({ today: 5, pending: false, exhausted: true })).stopped).toMatch(/paused after five attempts in the last hour/);
    expect(autoRestartCopy(status({ today: 0, pending: true, exhausted: false })).stopped).toMatch(/restart it automatically shortly/);
    expect(autoRestartCopy(status({ today: 0, pending: false, exhausted: false })).stopped).toBeNull();
  });

  it("shows nothing for an older build or a malformed report", () => {
    for (const value of [null, {}, status(undefined), status(null), status("5"), status({ today: "2", pending: "yes", exhausted: 1 }), status({ today: 1.5 })]) {
      expect(autoRestartCopy(value)).toEqual({ running: null, stopped: null });
    }
  });

  it("says on Windows that RealBud stays in the notification area while unattended work is on", () => {
    const windows = officeRunningCopy(false, "win32");
    expect(windows).toMatch(/^It keeps running when you close the window\./);
    expect(windows).toContain("RealBud also stays in the notification area to restart the service if it stops");
    expect(windows).toContain("Quit RealBud from that icon");
    for (const platform of ["darwin", "linux", undefined]) {
      expect(officeRunningCopy(false, platform)).toBe("It keeps running when you close the window. Keep this computer awake and connected for shared records and scheduled work.");
    }
    expect(officeRunningCopy(true, "win32")).toBe("RealBud connected to a service that was already running on this computer.");
  });

  it("renders the card before the main process has reported", () => {
    const html = renderToStaticMarkup(createElement(ServiceStatusCard));
    expect(html).toContain("RealBud service");
    expect(html).not.toContain("Restarted automatically");
  });
});

import { describe, expect, it } from "vitest";
import { serviceActionFeedback, serviceLifecycleCopy, serviceStatusCopy } from "./service-status";

describe("office service status", () => {
  it.each(["unconfigured", "invalid", "expired", "not-yet-valid"])("keeps records and recovery available when %s", state => {
    const result = serviceStatusCopy({ state, managed: true, required: true, expiresAt: null, error: "raw provider key must never appear" });
    expect(result.available).toBe(false);
    expect(result.detail).toContain("Your saved work remains available");
    expect(JSON.stringify(result)).not.toContain("raw provider");
  });
  it("does not present a disabled entitlement check as paid activation", () => {
    const result = serviceStatusCopy({ state: "not-required", managed: true, required: false, expiresAt: null });
    expect(result.title).toBe("Service checks disabled");
    expect(result.detail).toContain("not enforcing paid service access");
  });
  it.each([null, {}, { state: "unknown" }, { state: "active", managed: true, required: true, expiresAt: "tomorrow" }])("rejects incomplete responses", status => {
    expect(() => serviceStatusCopy(status)).toThrow("could not be verified");
  });
});

// Access (paid assistance) and life (is the office running) are different
// questions. A dead service used to be a log line only, so a staff member saw an
// app that quietly did nothing.
describe("desk service lifecycle copy", () => {
  it("says nothing while the service is healthy", () => {
    expect(serviceLifecycleCopy({ state: "running", restarts: 0, lastExitCode: null, exhausted: false })).toBeNull();
    expect(serviceLifecycleCopy({ state: "idle", restarts: 0, lastExitCode: null, exhausted: false })).toBeNull();
    expect(serviceLifecycleCopy({ state: "stopped", restarts: 2, lastExitCode: 0, exhausted: false })).toBeNull();
  });

  it("stays silent when the office is serving, whatever a dev supervisor reports", () => {
    // The supervisor only ever described a development child. Treating its state
    // as authoritative would tell staff the office was down while it served.
    for (const state of ["exhausted", "failed", "exited", "stopped", "unmanaged"]) {
      expect(serviceLifecycleCopy({ state, restarts: 3, lastExitCode: 1, exhausted: true, running: true, manageable: true }), state).toBeNull();
    }
  });

  it("reports the office as down when it is genuinely not running", () => {
    const copy = serviceLifecycleCopy({ state: "unmanaged", restarts: 0, lastExitCode: null, exhausted: false, running: false });
    expect(copy?.title).toMatch(/not running/i);
    expect(copy?.canRetry).toBe(true);
    expect(copy?.detail).toMatch(/last action may already have completed/i);
  });

  it("reports a service this installation does not own without offering to stop it", () => {
    const copy = serviceLifecycleCopy({ state: "unmanaged", restarts: 0, lastExitCode: null, exhausted: false, running: false, external: true });
    expect(copy?.title).toMatch(/connection needs checking/i);
    // Never offer control over a process we did not start.
    expect(copy?.canRetry).toBe(false);
  });

  it("tells staff the office has stopped and offers a restart when supervision gave up", () => {
    const copy = serviceLifecycleCopy({ state: "exhausted", restarts: 3, lastExitCode: 1, exhausted: true });
    expect(copy?.title).toMatch(/stopped/i);
    expect(copy?.canRetry).toBe(true);
    expect(copy?.detail).toMatch(/avoid duplicates/i);
  });

  it("distinguishes a service that never started from one that stopped", () => {
    const failed = serviceLifecycleCopy({ state: "failed", restarts: 2, lastExitCode: null, exhausted: false });
    const exited = serviceLifecycleCopy({ state: "exited", restarts: 1, lastExitCode: 9, exhausted: false });
    expect(failed?.title).toMatch(/did not start/i);
    expect(exited?.title).toMatch(/stopped/i);
  });

  it("does not offer a retry while a restart is already in flight", () => {
    expect(serviceLifecycleCopy({ state: "restarting", restarts: 1, lastExitCode: null, exhausted: false })?.canRetry).toBe(false);
    expect(serviceLifecycleCopy({ state: "exited", restarts: 1, lastExitCode: 1, exhausted: false })?.canRetry).toBe(false);
  });

  it("reports the restart attempt so a flapping service is visible", () => {
    expect(serviceLifecycleCopy({ state: "exited", restarts: 1, lastExitCode: 1, exhausted: false })?.detail).toContain("attempt 1");
  });

  it("ignores junk instead of showing a false alarm", () => {
    for (const value of [null, undefined, {}, { state: 42 }, "exhausted"]) {
      expect(serviceLifecycleCopy(value)).toBeNull();
    }
  });
});

describe("service action confirmation", () => {
  it.each([null, {}, { ok: true }, { ok: false, status: { running: false } }, { ok: true, status: { running: true } }])("does not claim a stop without confirmed stopped state: %j", result => {
    expect(serviceActionFeedback("stop", result).ok).toBe(false);
    expect(serviceActionFeedback("stop", result).message).toContain("not confirmed");
  });
  it("requires both success and live state for start and stop", () => {
    expect(serviceActionFeedback("stop", { ok: true, status: { running: false } }).ok).toBe(true);
    expect(serviceActionFeedback("start", { ok: true, status: { running: true } }).ok).toBe(true);
    expect(serviceActionFeedback("start", { ok: true, status: { running: false } }).ok).toBe(false);
  });
  it("explains that running legacy or external services cannot be stopped from this window", () => {
    for (const status of [{ running: true, manageable: false }, { running: true, external: true }, { running: true }]) {
      const copy = serviceLifecycleCopy({ state: "unmanaged", ...status });
      expect(copy?.title).toContain("cannot stop");
      expect(copy?.canRetry).toBe(false);
    }
  });
});

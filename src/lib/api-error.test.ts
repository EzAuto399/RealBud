import { describe, expect, it } from "vitest";

import { LOCAL_SERVICE_UNAVAILABLE, isLocalServiceProxyFailure, isRecoveryWriteError, localServiceError } from "./api-error";

describe("API error copy", () => {
  it("turns a transport failure into a safe, actionable local-service message", () => {
    const cause = new TypeError("Failed to fetch");
    const error = localServiceError(cause);
    expect(error.message).toBe(LOCAL_SERVICE_UNAVAILABLE);
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain("fetch");
  });

  it("recognises the authoritative recovery write block only", () => {
    expect(isRecoveryWriteError(new Error("desk is read-only in recovery mode"))).toBe(true);
    expect(isRecoveryWriteError(new Error("network is read-only"))).toBe(false);
    expect(isRecoveryWriteError("desk is read-only in recovery mode")).toBe(false);
  });

  it("treats only an empty gateway-style 5xx as a missing local service", () => {
    expect(isLocalServiceProxyFailure(500, undefined)).toBe(true);
    expect(isLocalServiceProxyFailure(503, "")).toBe(true);
    expect(isLocalServiceProxyFailure(500, "desk persistence failed")).toBe(false);
    expect(isLocalServiceProxyFailure(409, undefined)).toBe(false);
  });
});

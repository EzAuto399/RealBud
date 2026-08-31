// Portal session state machine: shadow runs, leases, and evidence.
import { mkdirSync, rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-portal-sessions-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const {
  appendEvidence,
  createSession,
  getSession,
  grantLease,
  listSessions,
  revokeLease,
  transitionSession,
} = await import("./portal-sessions.ts");
const { join } = await import("node:path");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(join(dataDir, "portal-sessions.json"), { force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

describe("portal sessions", () => {
  it("walks prepared → running → awaiting-review → done", () => {
    let session = createSession({
      recipeId: "rec-1",
      allowedOrigins: ["propertyme.com.au"],
    });
    expect(session.state).toBe("prepared");
    expect(session.shadow).toBe(false);
    session = transitionSession(session, "running");
    session = transitionSession(session, "awaiting-review");
    session = transitionSession(session, "done", "Ready.");
    expect(session.state).toBe("done");
    expect(session.detail).toBe("Ready.");
    expect(typeof session.endedAt).toBe("number");
    expect(getSession(session.id)?.state).toBe("done");
  });

  it("lets a shadow run finish from running", () => {
    let session = createSession({
      recipeId: "rec-1",
      allowedOrigins: ["propertyme.com.au"],
      shadow: true,
      state: "running",
    });
    session = transitionSession(session, "unknown", "Bud answered without a shadow walkthrough.");
    expect(session.state).toBe("unknown");
    expect(session.shadow).toBe(true);
  });

  it("grants an origin-locked lease only in awaiting-review", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    let session = createSession({
      recipeId: "rec-1",
      allowedOrigins: ["propertyme.com.au"],
      state: "running",
    });
    try {
      grantLease(session, "propertyme.com.au");
      expect.unreachable();
    } catch (err) {
      expect(statusOf(err)).toBe(409);
    }

    session = transitionSession(session, "awaiting-review");
    try {
      grantLease(session, "https://other-portal.example");
      expect.unreachable();
    } catch (err) {
      expect(statusOf(err)).toBe(400);
    }

    session = grantLease(session, "https://www.PropertyMe.com.au/notice");
    expect(session.submitLease).toEqual({
      origin: "propertyme.com.au",
      expiresAt: 1_700_000_000_000 + 10 * 60_000,
    });

    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000 + 1);
    expect(getSession(session.id)?.submitLease).toBeNull();
    expect(listSessions()[0]?.submitLease).toBeNull();

    session = getSession(session.id)!;
    session = grantLease(session, "propertyme.com.au");
    session = revokeLease(session);
    expect(session.submitLease).toBeNull();
  });

  it("appends evidence notes", () => {
    const session = createSession({
      recipeId: "rec-1",
      allowedOrigins: ["propertyme.com.au"],
    });
    const next = appendEvidence(session, "  would open the arrears report  ");
    expect(next.evidence).toHaveLength(1);
    expect(next.evidence[0]?.note).toBe("would open the arrears report");
    expect(typeof next.evidence[0]?.at).toBe("number");
  });
});

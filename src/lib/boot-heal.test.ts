import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoRunBudReadiness,
  needsAutoReadiness,
  resetBootHealForTests,
  warmMicrophoneAccess,
} from "./boot-heal";
import type { HermesStatus } from "@/state/store";

const readiness = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("./bud-readiness", () => ({
  budReadinessCheck: {
    isRunning: () => false,
    subscribe: () => () => {},
    run: (...args: unknown[]) => readiness.run(...args),
  },
}));

afterEach(() => {
  resetBootHealForTests();
  readiness.run.mockReset();
  const g = globalThis as { window?: { ogb?: unknown }; ogb?: unknown };
  if (g.window) delete (g.window as { ogb?: unknown }).ogb;
});

function hermes(opts: { ready: boolean; modelAttached: boolean }): HermesStatus {
  return {
    ready: opts.ready,
    detail: "",
    homeDir: "/tmp",
    profileDir: "/tmp/property",
    installCommand: null,
    signInCommand: "hermes -p property model",
    cli: {
      installed: true,
      versionText: "Hermes Agent v0.20.3",
      matchesPin: true,
      compatible: true,
      probeState: "ok",
    },
    pack: { installed: true, approvalsManual: true, workroomReady: true },
    pin: { product: "0.20.3", tag: "v2026.8.16.2", commit: "abc", profile: "property" },
    model: {
      attached: opts.modelAttached,
      provider: opts.modelAttached ? "xai" : null,
      model: opts.modelAttached ? "grok-4.6" : null,
    },
  };
}

describe("boot heal", () => {
  it("marks verify-only Bud as needing an automatic readiness check", () => {
    expect(needsAutoReadiness(hermes({ ready: false, modelAttached: true }), true)).toBe(true);
    expect(needsAutoReadiness(hermes({ ready: true, modelAttached: true }), true)).toBe(false);
    expect(needsAutoReadiness(hermes({ ready: false, modelAttached: false }), true)).toBe(false);
  });

  it("runs readiness once per setup fingerprint", async () => {
    const status = hermes({ ready: false, modelAttached: true });
    const next = hermes({ ready: true, modelAttached: true });
    readiness.run.mockResolvedValue({ ok: true, status: next });
    const onStatus = vi.fn();
    expect(await autoRunBudReadiness({ status, connected: true, onStatus })).toEqual({
      ran: true,
      ok: true,
      detail: undefined,
    });
    expect(onStatus).toHaveBeenCalledWith(next);
    expect(await autoRunBudReadiness({ status, connected: true, onStatus })).toEqual({ ran: false });
    expect(readiness.run).toHaveBeenCalledTimes(1);
  });

  it("warms the microphone only when undecided", async () => {
    const permStatus = vi.fn();
    const permRequestMic = vi.fn();
    const g = globalThis as { window?: { ogb?: unknown } };
    g.window = { ogb: { permStatus, permRequestMic } };

    permStatus.mockResolvedValue({ mic: "granted" });
    expect(await warmMicrophoneAccess()).toBe("granted");
    expect(permRequestMic).not.toHaveBeenCalled();

    resetBootHealForTests();
    permStatus.mockResolvedValue({ mic: "not-determined" });
    permRequestMic.mockResolvedValue(true);
    expect(await warmMicrophoneAccess()).toBe("granted");
    expect(permRequestMic).toHaveBeenCalledTimes(1);

    expect(await warmMicrophoneAccess()).toBe("skipped");
  });
});

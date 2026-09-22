import { withWorkerProfile } from "./hermes-profile.ts";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { applyHandsReadiness, hermesReadinessFingerprint, hermesStatus, modelAccessStatus } from "./hermes-status.ts";
import { setWorkerModelGrant } from "./worker-model-access.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { OFF_SCOPE_BUNDLED_SKILLS } from "./hermes-pack.ts";
import { fakeHermesVersion } from "./testing/fake-hermes.ts";

let home: string;
let OLD_HERMES: string;
let PINNED_HERMES: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "omb-hermes-status-"));
  const profile = join(home, "profiles", HERMES_PIN.profile);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
  writeFileSync(
    join(profile, "config.yaml"),
    `approvals:\n  mode: manual\n  timeout: 300\nagent:\n  max_turns: 60\n  budget_warning_ratio: 0.75\ntoolsets:\n  - web\n  - terminal\n  - file\n  - vision\n  - todo\n  - session_search\n  - delegation\nsecurity:\n  redact_secrets: true\n  allow_lazy_installs: false\nterminal:\n  backend: local\n  home_mode: profile\n  env_passthrough: []\nmodel:\n  default: test\nskills:\n  write_approval: true\n  disabled:\n${OFF_SCOPE_BUNDLED_SKILLS.map(name => `    - ${name}\n`).join("")}memory:\n  write_approval: true\nauxiliary:\n  title_generation:\n    enabled: false\n  background_review:\n    enabled: false\n    extra_tools: []\ntool_loop_guardrails:\n  loop_caps:\n    max_web_searches: 10\n    max_subagents: 4\n`,
  );
  OLD_HERMES = fakeHermesVersion("Hermes Agent v0.20.0 (2026.8.3)", "fake-hermes-old");
  PINNED_HERMES = fakeHermesVersion("Hermes Agent v0.20.3 (2026.8.16.2)", "fake-hermes-pinned");
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("hermesStatus", () => {
  it("reports a missing CLI before anything else", async () => {
    const status = await hermesStatus({ root: home, cli: "definitely-not-a-real-cli", platform: "darwin" });
    expect(status.cli.installed).toBe(false);
    expect(status.cli.matchesPin).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/not installed/i);
    expect(status.installCommand).toBeNull();
  });

  it("flags a version mismatch against the pin", async () => {
    const status = await hermesStatus({ root: home, cli: OLD_HERMES, platform: "darwin" });
    expect(status.cli.installed).toBe(true);
    expect(status.cli.matchesPin).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/pin is v0\.20\.3/i);
    expect(status.detail).toContain("0.21.2 (2026.9.11)");
  });

  it("is not ready until the hands test passes", async () => {
    const status = await hermesStatus({ root: home, cli: PINNED_HERMES, platform: "linux" });
    expect(status.cli.installed).toBe(true);
    expect(status.cli.matchesPin).toBe(true);
    expect(status.pack.installed).toBe(true);
    expect(status.pack.approvalsManual).toBe(true);
    expect(status.pack.workroomReady).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/Run the hands test before Recheck or Ask/i);
    expect(status.detail).not.toMatch(/answering/i);

    const afterPing = applyHandsReadiness(status, {
      at: 1,
      ok: true,
      detail: "Worker answered OK.",
      kind: "ping",
      workerFingerprint: status.workerFingerprint,
    });
    expect(afterPing.ready).toBe(true);
    expect(afterPing.detail).toMatch(/passed the hands test/i);

    expect(applyHandsReadiness({ ...status, bootstrapPending: true }, {
      at: 1, ok: true, detail: "previous successful check", kind: "ping", workerFingerprint: status.workerFingerprint,
    }).ready).toBe(false);
    const afterFail = applyHandsReadiness(status, {
      at: 1,
      ok: false,
      detail: "ping failed",
      kind: "ping",
    });
    expect(afterFail.ready).toBe(false);
    expect(afterFail.detail).toMatch(/Run the hands test/i);
    expect(applyHandsReadiness(status, { at: 1, ok: true, detail: "old setup", kind: "ping" }).ready).toBe(false);
    expect(applyHandsReadiness(status, { at: 1, ok: true, detail: "different worker", kind: "ping", workerFingerprint: "different" }).ready).toBe(false);
  });

  it("supports an independently updated worker and invalidates proof after profile changes", async () => {
    const cli = fakeHermesVersion("Hermes Agent v0.21.0 (2026.8.31)");
    const before = await hermesStatus({ root: home, cli });
    expect(before.cli).toMatchObject({ compatible: true, matchesPin: false, installed: true });
    const ping = { at: 1, ok: true, detail: "OK", kind: "ping" as const, workerFingerprint: before.workerFingerprint };
    expect(applyHandsReadiness(before, ping).ready).toBe(true);
    const credentials = join(home, "profiles", HERMES_PIN.profile, ".env");
    try {
      writeFileSync(credentials, "TEST_CREDENTIAL=changed-fixture\n");
      const changed = await hermesStatus({ root: home, cli });
      expect(applyHandsReadiness(changed, ping).ready).toBe(false);
      expect(JSON.stringify(changed)).not.toContain("changed-fixture");
    } finally { rmSync(credentials, { force: true }); }
  });

  it("distinguishes a stalled version probe from a missing install and permits retry", async () => {
    const cli = join(home, "slow-worker.mjs");
    writeFileSync(cli, `#!${process.execPath}\nsetTimeout(() => console.log('Hermes Agent v0.21.0 (2026.8.31)'), 5000);\n`);
    chmodSync(cli, 0o755);
    const missed = await hermesStatus({ root: home, cli, probeTimeoutMs: 100 });
    expect(missed.cli).toMatchObject({ installed: true, compatible: false, probeState: "timeout" });
    expect(missed.detail).toMatch(/retry/i);
    expect(missed.detail).not.toMatch(/not installed/i);
    writeFileSync(cli, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.0 (2026.8.31)');\n`);
    const retry = await hermesStatus({ root: home, cli, probeTimeoutMs: 5000 });
    expect(retry.cli).toMatchObject({ compatible: true, probeState: "ok" });
  });

  it("flags the pack as missing when SOUL.md is absent", async () => {
    const bare = mkdtempSync(join(tmpdir(), "omb-hermes-bare-"));
    try {
      const status = await hermesStatus({ root: bare, cli: PINNED_HERMES, platform: "linux" });
      expect(status.cli.matchesPin).toBe(true);
      expect(status.pack.installed).toBe(false);
      expect(status.ready).toBe(false);
      expect(status.handsLabel).toBe("Bud's hands");
      expect(status.detail).toMatch(/Bud's hands safeguards are not installed/i);
      expect(status.pin.profile).toBe("property");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});


it("does not reuse readiness proof for another profile or a changed OAuth login", () => {
  const other = mkdtempSync(join(tmpdir(), "realbud-other-profile-"));
  try {
    cpSync(home, other, { recursive: true });
    const original = hermesReadinessFingerprint("fixture-version", home);
    expect(hermesReadinessFingerprint("fixture-version", other)).not.toBe(original);
    const before = hermesReadinessFingerprint("fixture-version", other);
    writeFileSync(join(other, "profiles", HERMES_PIN.profile, "auth.json"), '{"syntheticLogin":"changed"}');
    expect(hermesReadinessFingerprint("fixture-version", other)).not.toBe(before);
  } finally { rmSync(other, { recursive: true, force: true }); }
});

it("binds readiness and setup to the same member profile", async () => {
  const base = await hermesStatus({ root: home, cli: PINNED_HERMES });
  const member = await withWorkerProfile("new-member", () => hermesStatus({ root: home, cli: PINNED_HERMES }));
  expect(member.pack.installed).toBe(false);
  expect(member.workerFingerprint).not.toBe(base.workerFingerprint);
  expect(member.signInCommand).toContain("property-new-member");
  expect(applyHandsReadiness(member, { at: 1, kind: "ping", ok: true, detail: "OK", workerFingerprint: base.workerFingerprint }).ready).toBe(false);
});

describe("model access readiness", () => {
  afterEach(() => setWorkerModelGrant({ state: "none" }));

  it("reports nothing extra on an installation with no service grant", async () => {
    const status = await hermesStatus({ root: home, cli: PINNED_HERMES });
    expect(status.modelAccess).toEqual({ managed: false, withdrawn: false, attached: false, detail: "" });
  });

  it("reports managed access when the profile has taken the grant up, with no key on this computer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-managed-ok-"));
    try {
      cpSync(home, dir, { recursive: true });
      const profile = join(dir, "profiles", HERMES_PIN.profile);
      writeFileSync(join(profile, "config.yaml"),
        'approvals:\n  mode: manual\nmodel:\n  default: gpt-5.6-sol\n  provider: openai-api\n  base_url: "https://api.modelvia.dev/v1"\n  api_mode: chat_completions\n');
      setWorkerModelGrant({ state: "active", baseUrl: "https://api.modelvia.dev/v1", keyId: "rbkkey-01", spendCapLabel: "AU$40 per month" });
      const access = modelAccessStatus(dir);
      expect(access).toMatchObject({ managed: true, withdrawn: false, attached: true });
      expect(access.detail).toContain("managed by RealBud service (Modelvia)");
      expect(access.detail).not.toMatch(/OpenAI/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("holds while a stale .env key could still shadow the grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-managed-shadow-"));
    try {
      cpSync(home, dir, { recursive: true });
      const profile = join(dir, "profiles", HERMES_PIN.profile);
      writeFileSync(join(profile, "config.yaml"),
        'model:\n  default: gpt-5.6-sol\n  provider: openai-api\n  base_url: "https://api.modelvia.dev/v1"\n  api_mode: chat_completions\n');
      writeFileSync(join(profile, ".env"), "OPENAI_API_KEY=sk-stale\n");
      setWorkerModelGrant({ state: "active", baseUrl: "https://api.modelvia.dev/v1", keyId: "rbkkey-01", spendCapLabel: "cap" });
      expect(modelAccessStatus(dir).attached).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports a withdrawn grant as a hold, never as a missing model", async () => {
    setWorkerModelGrant({ state: "withdrawn" });
    const status = await hermesStatus({ root: home, cli: PINNED_HERMES });
    expect(status.modelAccess).toMatchObject({ managed: false, withdrawn: true, attached: false });
    expect(status.detail).toMatch(/withdrawn/i);
    expect(status.detail).toMatch(/records are kept/i);
    expect(status.detail).not.toMatch(/not attached|connect a model/i);
    const ready = applyHandsReadiness(status, { at: 1, kind: "ping", ok: true, detail: "OK", workerFingerprint: status.workerFingerprint });
    expect(ready.ready).toBe(false);
    expect(ready.detail).toMatch(/withdrawn/i);
  });
});

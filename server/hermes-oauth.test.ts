import { withWorkerProfile } from "./hermes-profile.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import {
  authHasProvider,
  cancelOAuth,
  oauthStatus,
  parseDeviceCodeOutput,
  resetOAuthSessionsForTests,
  resolveOAuthProviderId,
  startOAuth,
} from "./hermes-oauth.ts";

const dirs: string[] = [];

afterEach(() => {
  resetOAuthSessionsForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseDeviceCodeOutput", () => {
  it("parses OpenAI Codex instructions including ANSI colour codes", () => {
    const text = [
      "To continue, follow these steps:\n",
      "  1. Open this URL in your browser:",
      "     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n",
      "  2. Enter this code:",
      "     \x1b[94mABCD-EFGH\x1b[0m\n",
      "Waiting for sign-in...",
    ].join("\n");
    expect(parseDeviceCodeOutput(text)).toEqual({
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
  });

  it("parses the shared xAI device-code block", () => {
    const text = [
      "To continue:",
      "  1. Open: https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
      "  2. If prompted, enter code: WXYZ-1234",
      "Waiting for approval...",
    ].join("\n");
    expect(parseDeviceCodeOutput(text)).toEqual({
      userCode: "WXYZ-1234",
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
    });
  });

  it("returns null until both url and code are present", () => {
    expect(parseDeviceCodeOutput("Waiting…")).toBeNull();
    expect(parseDeviceCodeOutput("Open: https://example.com/device")).toBeNull();
  });
});

describe("resolveOAuthProviderId", () => {
  it("maps curated picker ids and accepts Hermes oauth ids", () => {
    expect(resolveOAuthProviderId("openai-api")).toBe("openai-codex");
    expect(resolveOAuthProviderId("xai")).toBe("xai-oauth");
    expect(resolveOAuthProviderId("openai-codex")).toBe("openai-codex");
    expect(resolveOAuthProviderId("anthropic")).toBeNull();
  });
});

describe("authHasProvider", () => {
  it("detects credential_pool entries for the exact provider id", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-oauth-auth-"));
    dirs.push(dir);
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, "auth.json"),
      JSON.stringify({ version: 1, credential_pool: { "openai-codex": [{ opaque: "token" }] } }),
    );
    expect(authHasProvider("openai-codex", dir)).toBe(true);
    expect(authHasProvider("xai-oauth", dir)).toBe(false);
  });

  it("does not inherit personal Hermes Desktop root auth", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-oauth-no-root-"));
    dirs.push(dir);
    mkdirSync(join(dir, "profiles", HERMES_PIN.profile), { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ version: 1, credential_pool: { "openai-codex": [{ opaque: "personal" }] } }),
    );
    expect(authHasProvider("openai-codex", dir)).toBe(false);
  });
});

describe("startOAuth", () => {
  it("refuses unknown providers and a missing pack", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-oauth-miss-"));
    dirs.push(dir);
    expect(() => startOAuth("anthropic", { root: dir })).toThrow(/OpenAI ChatGPT and xAI/);
    expect(() => startOAuth("openai-api", { root: dir })).toThrow(/pack/);
  });

  it.skipIf(process.platform === "win32")("parses device-code output from a fake hermes CLI and approves on auth.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-oauth-flow-"));
    dirs.push(dir);
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");

    const bin = join(dir, "fake-hermes");
    writeFileSync(
      bin,
      `#!/bin/sh
cat <<'EOF'
To continue, follow these steps:

  1. Open this URL in your browser:
     https://auth.openai.com/codex/device

  2. Enter this code:
     TEST-CODE1

Waiting for sign-in...
EOF
sleep 0.4
mkdir -p "$HERMES_HOME/profiles/${HERMES_PIN.profile}"
printf '%s\\n' '{"version":1,"credential_pool":{"openai-codex":[{"opaque":"ok"}]}}' > "$HERMES_HOME/profiles/${HERMES_PIN.profile}/auth.json"
`,
    );
    chmodSync(bin, 0o755);

    const started = startOAuth("openai-api", { root: dir, cli: bin });
    expect(started.providerId).toBe("openai-codex");
    expect(["starting", "waiting"]).toContain(started.state);

    let latest = started;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      latest = oauthStatus(started.sessionId);
      if (latest.state === "approved" || latest.state === "error") break;
    }
    expect(latest.userCode).toBe("TEST-CODE1");
    expect(latest.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(latest.state).toBe("approved");
  }, 10_000);

  it.skipIf(process.platform === "win32")("cancel stops an in-flight login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-oauth-cancel-"));
    dirs.push(dir);
    const profile = join(dir, "profiles", HERMES_PIN.profile);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    const bin = join(dir, "fake-hermes");
    writeFileSync(bin, "#!/bin/sh\nsleep 30\n");
    chmodSync(bin, 0o755);

    const started = startOAuth("xai", { root: dir, cli: bin });
    const cancelled = cancelOAuth(started.sessionId);
    expect(cancelled.state).toBe("cancelled");
    expect(oauthStatus(started.sessionId).state).toBe("cancelled");
  });
});

it.skipIf(process.platform === "win32")("keeps a member OAuth session and credential checks inside that profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "realbud-oauth-member-")); dirs.push(dir);
  const profile = join(dir, "profiles", "property-dana"); mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "SOUL.md"), "# Synthetic profile");
  const cli = join(dir, "fake-member.mjs");
  writeFileSync(cli, `#!${process.execPath}\nconsole.log('Waiting for sign-in'); setTimeout(() => {}, 10000);\n`); chmodSync(cli, 0o755);
  const session = withWorkerProfile("dana", () => startOAuth("openai-codex", { root: dir, cli }));
  expect(() => withWorkerProfile("sam", () => oauthStatus(session.sessionId))).toThrow(/not found/);
  expect(() => withWorkerProfile("sam", () => cancelOAuth(session.sessionId))).toThrow(/not found/);
  writeFileSync(join(profile, "auth.json"), JSON.stringify({ credential_pool: { "openai-codex": [{ opaque: "fixture" }] } }));
  expect(withWorkerProfile("dana", () => oauthStatus(session.sessionId)).state).toBe("approved");
  expect(authHasProvider("openai-codex", dir)).toBe(false);
});

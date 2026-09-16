import { describe, expect, it } from "vitest";

import { containsCredential, redactSecrets, redactSecretsInText } from "./redact.ts";

const flat = (value: unknown) => JSON.stringify(value);

describe("redactSecrets", () => {
  it("masks tokens in an ACP session/new, keeping the shape", () => {
    const sessionNew = {
      method: "session/new",
      params: {
        mcpServers: [
          {
            name: "agents",
            env: [
              { name: "OMB_BOT_ID", value: "bot-123" },
              { name: "OMB_COMMS_TOKEN", value: "s3cret-comms-token-value" },
            ],
          },
        ],
      },
    };
    const out = flat(redactSecrets(sessionNew));
    expect(out).not.toContain("s3cret-comms-token-value");
    expect(out).toContain("session/new");
    expect(out).toContain("OMB_COMMS_TOKEN");
    expect(out).toContain("bot-123");
    expect(out).toContain("«redacted 24 chars»");
  });

  it("leaves ordinary protocol traffic alone", () => {
    const update = {
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "the key to this bug" } } },
    };
    expect(redactSecrets(update)).toEqual(update);
  });
});

describe("redactSecretsInText", () => {
  it("masks known key prefixes", () => {
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const out = redactSecretsInText(`set ANTHROPIC_API_KEY=sk-ant-api03-${alpha}`);
    expect(out).not.toMatch(/sk-ant/);
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("treats a pasted provider key as a credential and leaves book talk alone", () => {
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    expect(containsCredential(`sk-ant-api03-${alpha}`)).toBe(true);
    expect(containsCredential(`xai-${alpha}${alpha}`)).toBe(true);
    expect(containsCredential(`rbk_live_${alpha}`)).toBe(true);
    expect(containsCredential("What needs me on Oak?")).toBe(false);
    expect(containsCredential("the keyboard shortcut is cmd-k")).toBe(false);
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecretsInText("the keyboard shortcut is cmd-k")).toBe("the keyboard shortcut is cmd-k");
    expect(redactSecretsInText("password: (leave blank to keep the current one)")).toBe(
      "password: (leave blank to keep the current one)",
    );
  });
});

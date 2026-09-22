import { describe, expect, it } from "vitest";

import { containsCredential, redactSecrets, redactSecretsInText } from "./redact.ts";

const flat = (value: unknown) => JSON.stringify(value);

describe("redactSecrets", () => {
  it('masks managed installation credentials in config and free text', () => {
    const credential = `rbc_${'a'.repeat(64)}`;
    expect(JSON.stringify(redactSecrets({ composio: { managed: { endpoint: 'https://service.example', credential } } }))).not.toContain(credential);
    expect(redactSecretsInText(`Use ${credential}`)).not.toContain(credential);
    expect(containsCredential(credential)).toBe(true);
  });
  it('masks the per-installation model gateway key wherever it is echoed', () => {
    const key = `rbk_${'b'.repeat(40)}`;
    expect(redactSecretsInText(`base https://api.modelvia.dev key ${key}`)).not.toContain(key);
    expect(JSON.stringify(redactSecrets({ model: { provider: 'modelvia', baseUrl: 'https://api.modelvia.dev', key } }))).not.toContain(key);
    expect(JSON.stringify(redactSecrets([{ name: 'REALBUD_MODEL_KEY', value: key }]))).not.toContain(key);
    expect(containsCredential(key)).toBe(true);
    // The key id is an operator reference, not a secret: it must stay readable.
    expect(redactSecretsInText('keyId rbkkey-2026-09-22-01')).toBe('keyId rbkkey-2026-09-22-01');
    // The gateway's own operator key prefix stays covered.
    expect(redactSecretsInText(`mgt_${'c'.repeat(40)}`)).toContain('redacted');
  });
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

  it('masks Composio project and consumer credentials pasted without field names', () => {
    for (const prefix of ['ak_', 'ck_']) {
      const credential = prefix + 'fixture'.repeat(6);
      expect(redactSecretsInText(`Use ${credential}`)).not.toContain(credential);
      expect(containsCredential(credential)).toBe(true);
    }
  });

  it("masks Notion integration tokens before chat, cards, or logs can persist them", () => {
    const token = `ntn_${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const out = redactSecretsInText(`connect notion ${token}`);
    expect(out).not.toContain(token);
    expect(out).toMatch(/redacted/i);
    expect(containsCredential(`connect notion ${token}`)).toBe(true);
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

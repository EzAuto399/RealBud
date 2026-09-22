import { describe, expect, it } from "vitest";
import { serviceSafeChildEnv, stripServiceSecrets } from "./service-child-env.ts";
import { spawnCli } from './procs.ts';

const operatorSecrets = [
  'REALBUD_COMPOSIO_ORG_KEY', 'REALBUD_COMPOSIO_FUTURE_SECRET',
  'REALBUD_GATEWAY_PORTAL_SECRET', 'REALBUD_GATEWAY_FUTURE_SECRET',
  'REALBUD_PAYMENT_WEBHOOK_KEY', 'REALBUD_FINGERPRINT_KEY',
  'REALBUD_SERVICE_CONTROL_TOKEN', 'SQUARE_ACCESS_TOKEN',
  'SQUARE_WEBHOOK_SIGNATURE_KEY', 'OPENAI_ADMIN_KEY',
  'COMPOSIO_ORG_KEY', 'COMPOSIO_ORG_API_KEY',
];

describe("trusted host secrets at child-process boundaries", () => {
  it("removes administration, database and connector credentials including future namespaced values", () => {
    const env: NodeJS.ProcessEnv = {
      REALBUD_CARE_UNLOCK: "private-care-value",
      REALBUD_SERVICE_ADMIN_TOKEN: "private-admin-value",
      REALBUD_COMPANY_DATABASE_URL: "private-database-value",
      REALBUD_ENTITLEMENT_SIGNING_KEY: "private-signing-value",
      REALBUD_BILLING_SECRET: "private-billing-value",
      PGPASSWORD: "private-password", PGHOST: "private-host", PGOPTIONS: "private-options",
      DATABASE_URL: "private-url", COMPOSIO_API_KEY: "private-connector",
      PATH: "/bin", HERMES_HOME: "/work/private-context", HERMES_SAFE_MODE: "1",
    };
    stripServiceSecrets(env);
    expect(env).toEqual({ PATH: "/bin", HERMES_HOME: "/work/private-context", HERMES_SAFE_MODE: "1" });
  });

  it("does not allow per-child overrides to reintroduce service secrets", () => {
    const env = serviceSafeChildEnv({ ...Object.fromEntries(operatorSecrets.map(key => [key, 'fictional-operator-secret'])), REALBUD_SERVICE_PASSWORD: "must-not-escape", HERMES_HOME: "/assigned" });
    for (const key of operatorSecrets) expect(env[key]).toBeUndefined();
    expect(env.REALBUD_SERVICE_PASSWORD).toBeUndefined();
    expect(env.HERMES_HOME).toBe("/assigned");
  });

  it('removes vendor-only namespaces case-insensitively while preserving attached-model and worker configuration', () => {
    const allowed = {
      PATH: '/fictional/bin', HOME: '/fictional/home', HERMES_HOME: '/fictional/worker',
      REALBUD_DATA_DIR: '/fictional/data', HERMES_SAFE_MODE: '1', HERMES_EXEC_ASK: '1',
      HERMES_API_TIMEOUT: '120', DEEPSEEK_API_KEY: 'fictional-attached-provider',
      OPENAI_API_KEY: 'fictional-attached-provider', XAI_API_KEY: 'fictional-attached-provider',
    };
    const env = { ...allowed, ...Object.fromEntries(operatorSecrets.flatMap(key => [[key, 'fictional-operator-secret'], [key.toLowerCase(), 'fictional-operator-secret']])) };
    stripServiceSecrets(env);
    expect(env).toEqual(allowed);
  });

  it('keeps operator authority out of an actual spawned CLI without mutating the parent configuration', async () => {
    const source = { PATH: process.env.PATH, HERMES_HOME: '/fictional/worker', DEEPSEEK_API_KEY: 'fictional-attached-provider',
      ...Object.fromEntries(operatorSecrets.map(key => [key, 'fictional-operator-secret'])) };
    const observedNames = [...operatorSecrets, 'HERMES_HOME', 'DEEPSEEK_API_KEY'];
    const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(observedNames)}.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))))`;
    const child = spawnCli(process.execPath, ['-e', script], { env: source, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', data => { output += data; });
    child.stderr.resume(); child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Synthetic child exited ${String(code)}`)));
    });
    expect(JSON.parse(output)).toEqual({ HERMES_HOME: '/fictional/worker', DEEPSEEK_API_KEY: 'fictional-attached-provider' });
    for (const key of operatorSecrets) expect(source[key as keyof typeof source]).toBe('fictional-operator-secret');
  });
});

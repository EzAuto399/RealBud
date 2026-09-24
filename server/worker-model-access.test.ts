import { readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writePrivateJson } from './private-json.ts';
import { parseInstallationProvisioning, type InstallationProvisioning } from '../shared/office-link.ts';
import {
  WORKER_MODEL_ENV_NAMES, createWorkerModelAccess, managedConnectorApps, readServiceProvisioning, setWorkerModelGrant,
  workerModelEnv, workerModelGrant,
} from './worker-model-access.ts';
import { MANAGED_MODEL_API_MODE, MANAGED_MODEL_DEFAULT, MANAGED_MODEL_PROVIDER, managedModelProfile } from './hermes-pack.ts';
import { HERMES_PIN } from './hermes-pin.ts';
import { privateFixtureDirectory, privateFixtureRoot, writePrivateFixtureFile, WINDOWS_PROFILE_TEST_OPTIONS } from './testing/private-profile-fixture.ts';
import { applyWorkerModelAccessEnv } from './hermes-runtime-env.ts';
import { hardenHermesChildEnv } from './drivers/acp/hermes.ts';
import { serviceSafeChildEnv } from './service-child-env.ts';
import { redactSecretsInText } from './redact.ts';
import { spawnSync } from 'node:child_process';
import { ConfigRecoveryError } from './config.ts';

const roots: string[] = [];
const KEY = Buffer.alloc(32, 7);
const MODEL_KEY = `rbk_${'a'.repeat(40)}`;

function grant(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    service: { companyId: 'fictional-office', hostInstallationId: 'fictional-host-1' },
    connector: { endpoint: 'https://connections.fictional-service.invalid', credential: `rbc_${'b'.repeat(64)}`, profile: 'property', apps: ['gmail', 'outlook'] },
    model: { provider: 'modelvia', baseUrl: 'https://api.modelvia.dev/v1', projectId: 'proj-fictional-01', key: MODEL_KEY, keyId: 'rbkkey-01', spendCapLabel: 'AU$40 per month' },
    ...overrides,
  };
}

/** A private worker profile the grant can attach to, laid out exactly as the
 * installed pack does: `<hermesRoot>/profiles/property`. */
function fixture(profileFiles: Record<string, string> = { 'SOUL.md': '# RealBud\n' }) {
  const root = privateFixtureRoot(join(tmpdir(), 'realbud-provision-')); roots.push(root);
  const hermesRoot = join(root, 'hermes');
  const profileDir = join(hermesRoot, 'profiles', HERMES_PIN.profile);
  privateFixtureDirectory(profileDir);
  for (const [name, body] of Object.entries(profileFiles)) writePrivateFixtureFile(join(profileDir, name), body);
  const saved: Record<string, unknown>[] = [];
  const access = createWorkerModelAccess({ directory: root, key: KEY, hermesRoot, saveConfig: patch => { saved.push(patch as Record<string, unknown>); } });
  return { root, hermesRoot, profileDir, access, saved, provisioning: parseInstallationProvisioning(grant()) as InstallationProvisioning };
}

afterEach(() => {
  setWorkerModelGrant({ state: 'none' });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installation provisioning contract', () => {
  it('accepts one exact shape and refuses anything carrying a vendor organization key', () => {
    const parsed = parseInstallationProvisioning(grant()) as InstallationProvisioning;
    expect(parsed.connector.apps).toEqual(['gmail', 'outlook']);
    expect(parsed.model.baseUrl).toBe('https://api.modelvia.dev/v1');
    expect(parseInstallationProvisioning(undefined)).toBeUndefined();
    // An org/project key must never reach a customer machine, in any field.
    expect(() => parseInstallationProvisioning(grant({ model: { provider: 'modelvia', baseUrl: 'https://api.modelvia.dev/v1', projectId: 'p', key: `ak_${'c'.repeat(32)}`, keyId: 'k', spendCapLabel: 'cap' } }))).toThrow(/vendor key/);
    expect(() => parseInstallationProvisioning({ ...grant() as object, extra: 1 })).toThrow(/cannot accept/);
    expect(() => parseInstallationProvisioning(grant({ version: 2 }))).toThrow(/cannot accept/);
    expect(() => parseInstallationProvisioning(grant({ model: { provider: 'openai', baseUrl: 'https://api.modelvia.dev/v1', projectId: 'p', key: MODEL_KEY, keyId: 'k', spendCapLabel: 'cap' } }))).toThrow(/cannot accept/);
    // The operator key prefix is not an installation key.
    expect(() => parseInstallationProvisioning(grant({ model: { provider: 'modelvia', baseUrl: 'https://api.modelvia.dev/v1', projectId: 'p', key: `mgt_${'e'.repeat(40)}`, keyId: 'k', spendCapLabel: 'cap' } }))).toThrow(/cannot accept/);
    expect(() => parseInstallationProvisioning(grant({ connector: { endpoint: 'http://broker.invalid', credential: `rbc_${'b'.repeat(64)}`, profile: 'property', apps: ['gmail'] } }))).toThrow(/cannot accept/);
    expect(() => parseInstallationProvisioning(grant({ model: { provider: 'modelvia', baseUrl: 'https://api.modelvia.dev/v1?key=x', projectId: 'p', key: MODEL_KEY, keyId: 'k', spendCapLabel: 'cap' } }))).toThrow(/cannot accept/);
  });
});

describe('zero-touch provisioning on this computer', WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it('keeps the model key out of config and puts it only in the vault and the worker launch env', async () => {
    const { root, access, saved, provisioning } = fixture();
    await access.apply(provisioning, 'installation-a');

    expect(saved).toEqual([{ composio: { managed: { endpoint: provisioning.connector.endpoint, credential: provisioning.connector.credential, profile: 'property' }, key: '', apiKey: '', url: '', selectedAccounts: {} } }]);
    expect(JSON.stringify(saved)).not.toContain(MODEL_KEY);

    const record = readFileSync(join(root, 'service-provisioning.json'), 'utf8');
    expect(record).not.toContain(MODEL_KEY);
    expect(JSON.parse(record)).toMatchObject({ version: 1, state: 'active', installationId: 'installation-a', projectId: 'proj-fictional-01', keyId: 'rbkkey-01', apps: ['gmail', 'outlook'] });
    if (process.platform !== 'win32') expect(statSync(join(root, 'service-provisioning.json')).mode & 0o777).toBe(0o600);

    // The entitlement authority's own file shape, written by its own module.
    expect(JSON.parse(readFileSync(join(root, 'service-installation.json'), 'utf8')))
      .toEqual({ schema: 1, companyId: 'fictional-office', hostInstallationId: 'fictional-host-1' });

    // The vault entry is an encrypted envelope, not the key in the clear.
    const envelope = readFileSync(join(root, 'company-installation', 'private', 'worker-model-access.json'), 'utf8');
    expect(envelope).not.toContain(MODEL_KEY);

    expect(await access.env()).toEqual({ OPENAI_BASE_URL: 'https://api.modelvia.dev/v1', OPENAI_API_KEY: MODEL_KEY });
    expect(await managedConnectorApps(root)).toEqual(['gmail', 'outlook']);
  });

  it('points the worker profile at the gateway and never writes the key there', async () => {
    const { profileDir, access, provisioning, hermesRoot } = fixture({
      'SOUL.md': '# RealBud\n',
      'config.yaml': 'approvals:\n  mode: manual\nmodel:\n  default: gpt-5.6-sol\n  provider: openai-api\n  base_url: \'\'\n',
    });
    await access.apply(provisioning, 'installation-a');

    const config = readFileSync(join(profileDir, 'config.yaml'), 'utf8');
    // The keys the pinned runtime reads to select provider, endpoint and wire.
    expect(config).toContain(`  provider: ${MANAGED_MODEL_PROVIDER}\n`);
    expect(config).toContain('  base_url: "https://api.modelvia.dev/v1"\n');
    expect(config).toContain(`  api_mode: ${MANAGED_MODEL_API_MODE}\n`);
    // The office's own model choice survives; the grant carries no model id.
    expect(config).toContain('  default: gpt-5.6-sol\n');
    // Unrelated profile policy is untouched.
    expect(config).toContain('approvals:\n  mode: manual\n');
    expect(config).not.toContain(MODEL_KEY);
    expect(managedModelProfile(hermesRoot)).toEqual({
      provider: MANAGED_MODEL_PROVIDER, model: 'gpt-5.6-sol',
      baseUrl: 'https://api.modelvia.dev/v1', apiMode: MANAGED_MODEL_API_MODE, envKeyPresent: false,
    });
    expect(workerModelGrant()).toEqual({ state: 'active', baseUrl: 'https://api.modelvia.dev/v1', keyId: 'rbkkey-01', spendCapLabel: 'AU$40 per month' });
  });

  it('strips a stale .env provider key that would shadow the grant, and records it', async () => {
    const { root, profileDir, access, provisioning } = fixture({
      'SOUL.md': '# RealBud\n',
      '.env': 'OTHER_SETTING=keep-me\nOPENAI_API_KEY=sk-stale-office-key\nXAI_API_KEY=keep-this-too\n',
    });
    await access.apply(provisioning, 'installation-a');

    // Upstream prefers the profile dotenv over the launch env, so a leftover
    // line here would outrank the granted key on every turn.
    const env = readFileSync(join(profileDir, '.env'), 'utf8');
    expect(env).not.toContain('OPENAI_API_KEY');
    expect(env).toContain('OTHER_SETTING=keep-me');
    expect(env).toContain('XAI_API_KEY=keep-this-too');
    expect(env).not.toContain(MODEL_KEY);

    const record = JSON.parse(readFileSync(join(root, 'service-provisioning.json'), 'utf8'));
    expect(record.modelProfile).toMatchObject({
      provider: MANAGED_MODEL_PROVIDER, apiMode: MANAGED_MODEL_API_MODE,
      baseUrl: 'https://api.modelvia.dev/v1', model: 'auto', envKeyRemoved: true,
    });
    expect(JSON.stringify(record)).not.toContain(MODEL_KEY);
    // A re-apply has nothing left to remove and says so.
    await access.apply(provisioning, 'installation-a');
    expect(JSON.parse(readFileSync(join(root, 'service-provisioning.json'), 'utf8')).modelProfile.envKeyRemoved).toBe(false);
  });

  it('leaves a fresh computer ready on the gateway router, without replacing an office choice', async () => {
    // No prior model on this computer: the grant writes the gateway's own
    // router entry, so setup finishes without a second step.
    const fresh = fixture();
    await fresh.access.apply(fresh.provisioning, 'installation-a');
    expect(managedModelProfile(fresh.hermesRoot)).toMatchObject({ model: MANAGED_MODEL_DEFAULT, provider: MANAGED_MODEL_PROVIDER });
    expect(readFileSync(join(fresh.profileDir, 'config.yaml'), 'utf8')).toContain('  default: auto\n');

    // An office that already named a model keeps it; `auto` never overwrites.
    const chosen = fixture({ 'SOUL.md': '# RealBud\n', 'config.yaml': 'model:\n  default: office-picked-model\n  provider: anthropic\n' });
    await chosen.access.apply(chosen.provisioning, 'installation-a');
    expect(managedModelProfile(chosen.hermesRoot).model).toBe('office-picked-model');
  });

  it('publishes a withdrawn grant as a hold the synchronous readers can see', async () => {
    const { access, provisioning } = fixture();
    await access.apply(provisioning, 'installation-a');
    await access.withdraw();
    expect(workerModelGrant()).toEqual({ state: 'withdrawn' });
    await access.clear();
    expect(workerModelGrant()).toEqual({ state: 'none' });
  });

  it('is idempotent for the same installation and holds a different one for recovery', async () => {
    const { root, access, provisioning } = fixture();
    await access.apply(provisioning, 'installation-a');
    const provisionedAt = (await readServiceProvisioning(root) as { provisionedAt: string }).provisionedAt;
    await access.apply(provisioning, 'installation-a');
    expect((await readServiceProvisioning(root) as { provisionedAt: string }).provisionedAt).toBe(provisionedAt);
    expect((await access.state()).provisioned).toBe(true);
    await expect(access.apply(provisioning, 'installation-b')).rejects.toThrow(/already set up for another installation/);
    // Nothing was replaced: the original grant is still the live one.
    expect((await access.state()).installationId).toBe('installation-a');
  });

  it('refuses a grant issued for a different private workspace', async () => {
    const { access } = fixture();
    const other = parseInstallationProvisioning(grant({ connector: { endpoint: 'https://connections.fictional-service.invalid', credential: `rbc_${'b'.repeat(64)}`, profile: 'someone-else', apps: ['gmail'] } })) as InstallationProvisioning;
    await expect(access.apply(other, 'installation-a')).rejects.toThrow(/different private workspace/);
    expect((await access.state()).provisioned).toBe(false);
  });

  it('withdraws access in one operation and keeps a state the cards can show', async () => {
    const { root, access, saved, provisioning } = fixture();
    await access.apply(provisioning, 'installation-a');
    expect(await access.withdraw()).toBe(true);

    expect(saved.at(-1)).toEqual({ composio: { managed: undefined, selectedAccounts: {} } });
    expect(existsSync(join(root, 'company-installation', 'private', 'worker-model-access.json'))).toBe(false);
    expect(existsSync(join(root, 'service-installation.json'))).toBe(false);
    expect(await access.state()).toEqual({ provisioned: false, withdrawn: true, installationId: 'installation-a' });
    expect(await access.withdrawn()).toBe(true);
    expect(await access.env()).toEqual({});
    // Withdrawal drops the extra apps back to the default, never widens them.
    expect(await managedConnectorApps(root)).toEqual(['gmail']);
    expect(await access.withdraw()).toBe(false);
  });

  it('keeps provisioning intact when disconnect needs config recovery, then clears on a repaired retry', async () => {
    const { root, hermesRoot, provisioning } = fixture();
    const recovery = new ConfigRecoveryError();
    let configNeedsRecovery = false;
    const access = createWorkerModelAccess({ directory: root, key: KEY, hermesRoot, saveConfig: () => {
      if (configNeedsRecovery) throw recovery;
    } });
    await access.apply(provisioning, 'installation-a');
    const paths = [
      join(root, 'service-provisioning.json'),
      join(root, 'service-installation.json'),
      join(root, 'company-installation', 'private', 'worker-model-access.json'),
    ];
    const originalBytes = paths.map(path => readFileSync(path));

    configNeedsRecovery = true;
    const pendingEnv = access.env();
    await expect(access.clear()).rejects.toBe(recovery);
    expect(await pendingEnv).toEqual({});
    expect(recovery).toMatchObject({ status: 503, code: 'config_recovery_required' });
    expect(paths.map(path => readFileSync(path))).toEqual(originalBytes);
    expect(workerModelGrant()).toEqual({ state: 'withdrawn' });
    expect(await access.state()).toMatchObject({ provisioned: false, withdrawn: true, installationId: 'installation-a' });
    expect(await access.env()).toEqual({});
    expect(await access.withdrawn()).toBe(true);
    expect(workerModelGrant()).toEqual({ state: 'withdrawn' });
    await expect(access.apply(provisioning, 'installation-a')).rejects.toThrow(/withdrawal needs recovery/);

    configNeedsRecovery = false;
    await access.clear();
    expect(paths.map(path => existsSync(path))).toEqual([false, false, false]);
    expect(workerModelGrant()).toEqual({ state: 'none' });
    expect(await access.state()).toEqual({ provisioned: false, withdrawn: false });
    expect(await access.env()).toEqual({});
  });

  it('holds access and keeps recovery records when vault removal refuses damage, then retries after repair', async () => {
    const { root, access, provisioning } = fixture();
    await access.apply(provisioning, 'installation-a');
    const vaultPath = join(root, 'company-installation', 'private', 'worker-model-access.json');
    const original = readFileSync(vaultPath);
    writePrivateFixtureFile(vaultPath, '{fictional damaged envelope');
    await expect(access.clear()).rejects.toThrow();
    expect(readFileSync(vaultPath, 'utf8')).toBe('{fictional damaged envelope');
    expect(existsSync(join(root, 'service-provisioning.json'))).toBe(true);
    expect(existsSync(join(root, 'service-installation.json'))).toBe(true);
    expect(await access.env()).toEqual({});
    expect(await access.state()).toMatchObject({ provisioned: false, withdrawn: true });
    writePrivateFixtureFile(vaultPath, original);
    await access.clear();
    expect(existsSync(vaultPath)).toBe(false);
    expect(existsSync(join(root, 'service-provisioning.json'))).toBe(false);
    expect(existsSync(join(root, 'service-installation.json'))).toBe(false);
    expect(await access.state()).toEqual({ provisioned: false, withdrawn: false });
  });

  it('withdraws when a service administrator removes the installation binding', async () => {
    const { root, access, provisioning } = fixture();
    await access.apply(provisioning, 'installation-a');
    expect(await access.reconcile()).toBe(false);
    rmSync(join(root, 'service-installation.json'));
    expect(await access.reconcile()).toBe(true);
    expect(await access.withdrawn()).toBe(true);
  });

  it('rotates in place and refuses a vault entry that no longer matches the record', async () => {
    const { root, access, provisioning } = fixture();
    await access.apply(provisioning, 'installation-a');
    const rotatedKey = `rbk_${'z'.repeat(40)}`;
    await access.apply(parseInstallationProvisioning(grant({ model: { provider: 'modelvia', baseUrl: 'https://api.modelvia.dev/v1', projectId: 'proj-fictional-01', key: rotatedKey, keyId: 'rbkkey-02', spendCapLabel: 'AU$40 per month' } })) as InstallationProvisioning, 'installation-a');
    expect(await access.env()).toEqual({ OPENAI_BASE_URL: 'https://api.modelvia.dev/v1', OPENAI_API_KEY: rotatedKey });
    // A record naming a key the vault no longer holds must not fall back to
    // whatever key happens to be stored: only the recorded grant is spend-capped.
    const stale = createWorkerModelAccess({ directory: root, key: KEY, saveConfig: () => {} });
    await writePrivateJson(join(root, 'service-provisioning.json'), { ...(await readServiceProvisioning(root)), keyId: 'rbkkey-03' });
    await expect(stale.env()).rejects.toThrow(/needs recovery/);
  });

  it('a damaged provisioning record holds rather than re-provisioning over it', async () => {
    const { root, access, provisioning } = fixture();
    await access.apply(provisioning, 'installation-a');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'service-provisioning.json'), JSON.stringify({ version: 1, state: 'active' }), { mode: 0o600 });
    await expect(access.apply(provisioning, 'installation-a')).rejects.toThrow(/needs recovery/);
    // A damaged record must not silently widen the connector allowlist either.
    expect(await managedConnectorApps(root)).toEqual(['gmail']);
  });
});

describe('worker launch environment', WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it('injects exactly the variables the pinned worker reads, and nothing when unprovisioned', () => {
    expect(WORKER_MODEL_ENV_NAMES).toEqual(['OPENAI_BASE_URL', 'OPENAI_API_KEY']);
    const env: NodeJS.ProcessEnv = { HERMES_HOME: '/synthetic/home' };
    applyWorkerModelAccessEnv(env, {});
    expect(env).toEqual({ HERMES_HOME: '/synthetic/home' });
    applyWorkerModelAccessEnv(env, workerModelEnv('https://api.modelvia.dev/v1', MODEL_KEY));
    expect(env).toEqual({ HERMES_HOME: '/synthetic/home', OPENAI_BASE_URL: 'https://api.modelvia.dev/v1', OPENAI_API_KEY: MODEL_KEY });
    // Only the two admitted names are ever copied across.
    applyWorkerModelAccessEnv(env, { OPENAI_API_KEY: '', COMPOSIO_KEY: 'ak_should_not_travel' } as Record<string, string>);
    expect(env.COMPOSIO_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe(MODEL_KEY);
  });

  it('survives the adapter hardening and reaches a real child process', async () => {
    const { access, provisioning, profileDir } = fixture({
      'SOUL.md': '# RealBud\n',
      'config.yaml': 'model:\n  default: gpt-5.6-sol\n  provider: anthropic\n  base_url: \'\'\n',
      '.env': 'OPENAI_API_KEY=sk-stale-office-key\n',
    });
    await access.apply(provisioning, 'installation-a');
    // The adapter deletes ambient provider keys on purpose, so the grant must
    // be injected after that strip — this is the order a launch has to use.
    const env = serviceSafeChildEnv({ OPENAI_API_KEY: 'sk-ambient-must-not-survive', COMPOSIO_KEY: `ak_${'d'.repeat(32)}` });
    hardenHermesChildEnv(env);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    applyWorkerModelAccessEnv(env, await access.env());

    // The child reads BOTH: the launch env, and the profile files the env
    // points it at. Both are asserted from inside the spawned process, so a
    // profile the parent never rewrote cannot pass this check.
    const child = spawnSync(process.execPath, [
      '-e',
      'const fs=require("node:fs");const p=process.argv[1];' +
      'process.stdout.write(JSON.stringify({b:process.env.OPENAI_BASE_URL??null,k:process.env.OPENAI_API_KEY??null,' +
      'c:process.env.COMPOSIO_KEY??null,config:fs.readFileSync(p+"/config.yaml","utf8"),' +
      'dotenv:fs.existsSync(p+"/.env")?fs.readFileSync(p+"/.env","utf8"):""}))',
      profileDir,
    ], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(child.status).toBe(0);
    const seen = JSON.parse(child.stdout) as { b: string; k: string; c: null; config: string; dotenv: string };
    expect({ b: seen.b, k: seen.k, c: seen.c }).toEqual({ b: 'https://api.modelvia.dev/v1', k: MODEL_KEY, c: null });
    expect(seen.config).toContain(`  provider: ${MANAGED_MODEL_PROVIDER}\n`);
    expect(seen.config).toContain('  base_url: "https://api.modelvia.dev/v1"\n');
    expect(seen.config).toContain(`  api_mode: ${MANAGED_MODEL_API_MODE}\n`);
    expect(seen.config).not.toContain('provider: anthropic');
    // Nothing in the profile can shadow or leak the granted key.
    expect(seen.dotenv).not.toContain('OPENAI_API_KEY');
    expect(`${seen.config}${seen.dotenv}`).not.toContain(MODEL_KEY);
    // Anything this key touches on the way to a log or a card is masked.
    expect(redactSecretsInText(`launch env ${MODEL_KEY}`)).not.toContain(MODEL_KEY);
  });
});

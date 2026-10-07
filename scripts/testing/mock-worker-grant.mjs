// Disposable QA only. Reuses the office-link and worker-model-access test
// fixture patterns to admit a deterministic CLI through the real launch guard.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceSmokeEnv } from '../service-smoke-env.mjs';

export const fictionalWorkerModelKey = `rbk_${'f'.repeat(40)}`;

// `model` ({ key, baseUrl }) replaces the fictional model, e.g. scripts/eval-golden.mjs --arm live
// with a capped dev key. It travels on stdin, never argv, and is never printed here.
export function provisionMockWorkerGrant({ executable = process.execPath, resources, home, data, endpoint, credential, companyId, hostInstallationId, preserveFictionalLink = false, memberKey, model }) {
  // Never import application stores in the harness's own HOME. All writes and
  // credential reads happen in this child with a sanitized disposable home.
  const within = (parent, child) => { const part = relative(parent, child); return part && part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep); };
  assert.ok(within(realpathSync(tmpdir()), realpathSync(home)), 'The fictional grant needs a disposable temporary home.');
  assert.ok(within(realpathSync(home), realpathSync(data)), 'The fictional grant data must be inside its temporary home.');
  const url = new URL(endpoint);
  assert.equal(url.origin, endpoint);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  const root = resources || resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const moduleUrl = name => pathToFileURL(join(root, `server/${name}.${resources ? 'js' : 'ts'}`)).href;
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    globalThis.fetch = async () => { throw new Error('Fictional grant setup denies all network access'); };
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const { withWorkerProfile, currentWorkerProfile } = await import(${JSON.stringify(moduleUrl('hermes-profile'))});
    await withWorkerProfile(input.memberKey, async () => {
    const { Desk } = await import(${JSON.stringify(moduleUrl('desk'))});
    const { applyPropertyPack } = await import(${JSON.stringify(moduleUrl('hermes-pack'))});
    const { createWorkerModelAccess } = await import(${JSON.stringify(moduleUrl('worker-model-access'))});
    const { createOfficeLink } = await import(${JSON.stringify(moduleUrl('office-link'))});
    const { managedModelLaunchRefusal, setWorkerModelAccessSnapshot } = await import(${JSON.stringify(moduleUrl('hermes-runtime-env'))});
    applyPropertyPack(process.env.REALBUD_HERMES_HOME);
    const desk = new Desk();
    const access = createWorkerModelAccess({ directory: process.env.REALBUD_DATA_DIR, key: Buffer.from(desk.recoveryKeyHex(), 'hex') });
    const modelKey = input.model?.key ?? ${JSON.stringify(fictionalWorkerModelKey)};
    const provisioning = { version: 1,
      service: { companyId: input.companyId, hostInstallationId: input.hostInstallationId },
      connector: { endpoint: input.endpoint, credential: input.credential, profile: currentWorkerProfile().profile, apps: ['gmail'] },
      model: { provider: 'modelvia', baseUrl: input.model?.baseUrl ?? 'https://model.fictional.invalid/v1', projectId: 'fictional-qa-project', keyId: 'fictional-qa-key', key: modelKey, spendCapLabel: input.model ? 'Capped dev key (eval only)' : 'Fictional deterministic worker only' } };
    const link = createOfficeLink({ directory: process.env.REALBUD_DATA_DIR, appVersion: '0.0.0', origin: 'https://website.fictional.invalid',
      report: async () => ({ appVersion: '0.0.0', workerVersion: null, workerReady: true }),
      provisioning: { ...access, active: async () => (await access.state()).provisioned },
      fetch: async (url, init) => {
        assert.equal(url, 'https://website.fictional.invalid/api/installations/redeem'); assert.equal(init.method, 'POST');
        const body = JSON.parse(init.body);
        return Response.json({ installationId: body.id, companyId: input.companyId, agencyLabel: 'Fictional QA office', provisioning });
      } });
    if (input.preserveFictionalLink) {
      const existing = await link.credentials();
      assert.equal(existing?.companyId, input.companyId, 'Only the same fictional office can resume');
      await access.apply(provisioning, existing.installationId);
    } else await link.link({ code: 'rb1_' + 'f'.repeat(64), label: 'Fictional deterministic worker' });
    const env = await link.modelAccessEnv(() => access.env());
    assert.deepEqual(env, { REALBUD_MODEL_API_KEY: modelKey });
    setWorkerModelAccessSnapshot(env);
    assert.equal(managedModelLaunchRefusal(process.env.REALBUD_HERMES_HOME), null);
    for (const path of ['config.json', 'service-provisioning.json', 'office-link/link.json', 'company-installation/private/worker-model-access.json', 'hermes/profiles/' + currentWorkerProfile().profile + '/config.yaml'])
      assert.ok(!readFileSync(join(process.env.REALBUD_DATA_DIR, path), 'utf8').includes(modelKey), 'Fictional model key leaked outside the launch environment');
    });
  `;
  const result = spawnSync(executable, ['--input-type=module', '-e', script], {
    cwd: root, env: { ...serviceSmokeEnv({ executable, home, data, scratch: home, port: 0 }), ...(memberKey ? { REALBUD_MEMBER: memberKey } : {}) },
    input: JSON.stringify({ endpoint, credential, companyId, hostInstallationId, preserveFictionalLink, memberKey, ...(model ? { model } : {}) }), encoding: 'utf8',
    // Windows pays a cold PowerShell ACL admission per private file it writes.
    timeout: process.platform === 'win32' ? 180_000 : 30_000,
  });
  assert.equal(result.status, 0, `Fictional model grant setup failed: ${result.error?.message ?? result.stderr}`);
}

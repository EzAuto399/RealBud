// What the product creates in its data directory carries its own protected
// Windows descriptor from creation, before content, and nothing that already
// exists is ever restricted. The real ACL helper runs with win32 simulated;
// only its powershell.exe launch is injected, so each recorded call below is
// one process that would have run on Windows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirPrivateSync, writeFileAtomic, writeFileFsynced, writeFilePrivateSync } from './atomic.ts';
import { ensureDirs } from './config.ts';
import { DEFAULT_VAULT_DOCUMENTS, appendAllowedLine, seedVault } from './vault.ts';
import { oplog, setOpLogPath } from './oplog.ts';
import { loadDeskKey } from './desk-key.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { createBackupOperationStore } from './private-backup-operations.ts';
import { privateDirectory } from './private-json.ts';
import { createPrivateWorkspaceBackup } from './private-workspace-backup.ts';
import { encryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { createCustomerPackService } from './customer-packs.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';

type Operation = [path: string, kind: string, action: string, bytes: number | null];
const acl = vi.hoisted(() => ({ launches: [] as Operation[][], refuse: false, refuseAsync: false }));
function record(options: { env?: Record<string, string | undefined> } | undefined): void {
  const env = options?.env ?? {};
  const count = Number(env.REALBUD_WINDOWS_FILE_PRIVACY_COUNT);
  acl.launches.push(Array.from({ length: count }, (_, index) => {
    const suffix = index ? `_${index}` : '';
    const path = env[`REALBUD_WINDOWS_FILE_PRIVACY_PATH${suffix}`]!, kind = env[`REALBUD_WINDOWS_FILE_PRIVACY_KIND${suffix}`]!;
    // A restricted file must still be empty when its descriptor is applied.
    return [path, kind, env[`REALBUD_WINDOWS_FILE_PRIVACY_ACTION${suffix}`]!, kind === 'file' ? statSync(path).size : null];
  }));
}
vi.mock('node:child_process', async original => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: (_program: string, _args: string[], options: { env?: Record<string, string | undefined> }) => {
    record(options);
    if (acl.refuse) throw Object.assign(new Error('fictional refusal'), { status: 5, stdout: '0\n', stderr: '' });
    return Buffer.alloc(0);
  },
  execFile: (_program: string, _args: string[], options: { env?: Record<string, string | undefined> }, done: (error: unknown, stdout: string, stderr: string) => void) => {
    record(options);
    if (acl.refuseAsync) done(Object.assign(new Error('fictional refusal'), { code: 5, stdout: '', stderr: '' }), '', '');
    else done(null, '', '');
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const roots: string[] = [];
const fixture = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'realbud-created-acl-'))); roots.push(root); return root; };
const restricted = () => acl.launches.flat().filter(([, , action]) => action === 'restrict').map(([path]) => path);
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  // Absolute on every host, so the helper's own path check admits it.
  vi.stubEnv('SystemRoot', '/synthetic/Windows');
  acl.launches.length = 0; acl.refuse = false; acl.refuseAsync = false;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); setOpLogPath('');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('atomic writers', () => {
  it('restrict only the new temp file, while empty, and never the file it replaces', () => {
    const path = join(fixture(), 'bots.json');
    writeFileAtomic(path, '[1]'); writeFileAtomic(path, '[2]');
    expect(acl.launches).toHaveLength(2);
    for (const [launch] of acl.launches) expect(launch).toEqual([expect.stringMatching(/bots\.json\.\d+\.[0-9a-f-]{36}\.tmp$/), 'file', 'restrict', 0]);
    expect(restricted()).not.toContain(path);
    expect(readFileSync(path, 'utf8')).toBe('[2]');
  });

  it('keep the saved file and leave no temp behind when Windows refuses', () => {
    const root = fixture(), path = join(root, 'desk.json');
    writeFileAtomic(path, 'saved'); acl.refuse = true;
    expect(() => writeFileAtomic(path, 'replacement')).toThrow(/inheritance-not-protected/);
    expect(readFileSync(path, 'utf8')).toBe('saved'); expect(readdirSync(root)).toEqual(['desk.json']);
  });

  it('protect a created file before its first byte, and write an existing one in place without a launch', () => {
    const root = fixture(), key = join(root, 'desk.key'), backup = join(root, 'backup.json');
    writePrivateSyncAndFsynced(key, backup);
    expect(acl.launches).toEqual([[[key, 'file', 'restrict', 0]], [[backup, 'file', 'restrict', 0]]]);
    acl.launches.length = 0;
    writePrivateSyncAndFsynced(key, backup);
    expect(acl.launches).toEqual([]);
    expect(readFileSync(key, 'utf8')).toBe('fictional-key'); expect(readFileSync(backup, 'utf8')).toBe('exact-bytes');
  });

  it('remove a new file Windows refused to protect instead of filling it', () => {
    const path = join(fixture(), 'desk.key'); acl.refuse = true;
    expect(() => writeFilePrivateSync(path, 'fictional-key', 0o600)).toThrow(/inheritance-not-protected/);
    expect(existsSync(path)).toBe(false);
  });

  it('restrict every folder level a mkdir creates in one process, outermost first', () => {
    const root = fixture(), leaf = join(root, 'a', 'b', 'c');
    mkdirPrivateSync(leaf);
    expect(acl.launches).toEqual([[[join(root, 'a'), 'directory', 'restrict', null], [join(root, 'a', 'b'), 'directory', 'restrict', null], [leaf, 'directory', 'restrict', null]]]);
    acl.launches.length = 0; mkdirPrivateSync(leaf);
    expect(acl.launches).toEqual([]);
  });

  it('launch nothing on other systems', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const root = fixture();
    writeFileAtomic(join(root, 'x.json'), '{}'); writeFilePrivateSync(join(root, 'k'), 'k'); mkdirPrivateSync(join(root, 'd', 'e'));
    expect(acl.launches).toEqual([]);
  });
});

function writePrivateSyncAndFsynced(key: string, backup: string): void {
  writeFilePrivateSync(key, 'fictional-key', 0o600); writeFileFsynced(backup, Buffer.from('exact-bytes'));
}

describe('boot-time creators in the data directory', () => {
  it('ensureDirs restricts the data, events and native folders it creates in one process, then never again', () => {
    const data = join(homedir(), '.realbud');
    expect(existsSync(data)).toBe(false);
    ensureDirs();
    expect(acl.launches).toEqual([[data, join(data, 'events'), join(data, 'native')].map(path => [path, 'directory', 'restrict', null])]);
    acl.launches.length = 0; ensureDirs();
    expect(acl.launches).toEqual([]);
  });

  it('seedVault protects its folders and empty default documents in one process, then writes them', () => {
    const vault = join(fixture(), 'vault');
    seedVault(vault);
    expect(acl.launches).toEqual([[
      ...[vault, join(vault, 'properties'), join(vault, 'owners'), join(vault, 'decisions')].map(path => [path, 'directory', 'restrict', null]),
      ...Object.keys(DEFAULT_VAULT_DOCUMENTS).map(name => [join(vault, name), 'file', 'restrict', 0]),
    ]]);
    for (const [name, content] of Object.entries(DEFAULT_VAULT_DOCUMENTS)) expect(readFileSync(join(vault, name), 'utf8')).toBe(content);
    acl.launches.length = 0; seedVault(vault);
    expect(acl.launches).toEqual([]);
  });

  it('seedVault leaves nothing unprotected behind when Windows refuses', () => {
    const vault = join(fixture(), 'vault'); acl.refuse = true;
    expect(() => seedVault(vault)).toThrow(/inheritance-not-protected/);
    expect(existsSync(vault)).toBe(false);
    acl.refuse = false; seedVault(vault);
    expect(restricted()).toContain(join(vault, 'USER.md'));
  });

  it('a new decisions day log is protected while empty; later lines add no launch for it', () => {
    const vault = join(fixture(), 'vault'); seedVault(vault); acl.launches.length = 0;
    appendAllowedLine('fictional-property', 'Allowed a fictional reminder', vault);
    const day = join(vault, 'decisions', `${new Date().toISOString().slice(0, 10)}.md`);
    expect(acl.launches.flat()).toContainEqual([day, 'file', 'restrict', 0]);
    acl.launches.length = 0; appendAllowedLine('fictional-property', 'Allowed another fictional reminder', vault);
    expect(restricted()).not.toContain(day);
    expect(readFileSync(day, 'utf8')).toContain('Allowed another fictional reminder');
  });

  it('realbud.log is protected when created, not on each append, and again after rotation', () => {
    const path = join(fixture(), 'realbud.log'); setOpLogPath(path);
    oplog('boot', 'first'); oplog('boot', 'second');
    expect(acl.launches).toEqual([[[path, 'file', 'restrict', 0]]]);
    writeFileSync(path, 'x'.repeat(1_000_001)); acl.launches.length = 0;
    oplog('boot', 'after rotation');
    expect(acl.launches).toEqual([[[path, 'file', 'restrict', 0]]]);
    expect(readFileSync(path, 'utf8')).toContain('after rotation');
  });

  it('a generated desk.key is protected before the key is written; an existing key launches nothing', () => {
    const dir = fixture(), path = join(dir, 'desk.key');
    vi.stubEnv('REALBUD_DESK_KEY', '');
    const first = loadDeskKey({ dir });
    expect(acl.launches).toEqual([[[path, 'file', 'restrict', 0]]]);
    acl.launches.length = 0;
    expect(loadDeskKey({ dir }).key).toEqual(first.key);
    expect(acl.launches).toEqual([]);
  });

  it('workflow-state.sqlite is created empty and protected before SQLite opens it; a reopen launches nothing', () => {
    const dir = fixture(), path = join(dir, 'workflow-state.sqlite'), key = Buffer.alloc(32, 7);
    new WorkflowDatabase({ dir, key }).close();
    expect(acl.launches).toEqual([[[path, 'file', 'restrict', 0]]]);
    acl.launches.length = 0;
    new WorkflowDatabase({ dir, key }).close();
    expect(acl.launches).toEqual([]);
  });

  it('the backup operation store protects the shared private-backup-v2 root it creates, and only verifies it later', async () => {
    const directory = fixture(), root = join(directory, 'private-backup-v2'), operations = join(root, 'operations');
    const settings = { directory: operations, key: Buffer.alloc(32, 9), workspaceId: '00000000-0000-4000-8000-000000000001' };
    (await createBackupOperationStore(settings)).close();
    expect(acl.launches[0]).toEqual([[root, 'directory', 'restrict', null], [operations, 'directory', 'restrict', null]]);
    acl.launches.length = 0;
    (await createBackupOperationStore(settings)).close();
    expect(restricted()).toEqual([]);
    expect(acl.launches.flat()).toContainEqual([operations, 'directory', 'verify', null]);
  });

  it('an existing folder is never restricted by the stores that open it', () => {
    const dir = fixture(); mkdirSync(join(dir, 'vault')); vi.stubEnv('REALBUD_DESK_KEY', '');
    seedVault(join(dir, 'vault')); loadDeskKey({ dir }); new WorkflowDatabase({ dir, key: Buffer.alloc(32, 3) }).close();
    expect(restricted()).not.toContain(join(dir, 'vault'));
    expect(restricted()).not.toContain(dir);
  });
});

describe('asynchronous private folders', () => {
  it('privateDirectory protects every level it creates, top-down, and only verifies it afterwards', async () => {
    const root = fixture(), parent = join(root, 'company-installation'), leaf = join(parent, 'private');
    await privateDirectory(leaf);
    expect(acl.launches).toEqual([[[parent, 'directory', 'restrict', null]], [[leaf, 'directory', 'restrict', null]]]);
    acl.launches.length = 0; await privateDirectory(leaf);
    expect(acl.launches).toEqual([[[leaf, 'directory', 'verify', null]]]);
  });

  it('privateDirectory removes the levels it made when Windows refuses, so a retry protects them', async () => {
    const root = fixture(), parent = join(root, 'company-installation'); acl.refuseAsync = true;
    await expect(privateDirectory(join(parent, 'private'))).rejects.toThrow(/inheritance-not-protected/);
    expect(existsSync(parent)).toBe(false);
  });

  it('a staged legacy restore verifies the existing data folder and restricts only its new temp file', async () => {
    const directory = fixture(), key = Buffer.alloc(32, 5), workspaceId = '00000000-0000-4000-8000-000000000002';
    const passphrase = 'Fictional long backup passphrase';
    mkdirSync(join(directory, 'company-installation'));
    writeFileSync(join(directory, 'company-installation', 'workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
    writeFileSync(join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional agency', timezone: 'Australia/Brisbane', jurisdictions: [] }))));
    const service = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => '0', assertIdle: () => {}, assertFresh: () => {} });
    const { backup } = await service.exportBackup(passphrase), receipt = await service.previewBackup(backup, passphrase);
    acl.launches.length = 0;
    await service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
    expect(acl.launches.flat()).toContainEqual([directory, 'directory', 'verify', null]);
    expect(restricted()).toEqual([expect.stringMatching(/private-workspace-restore\.json\.[0-9a-f-]{36}\.tmp$/)]);
  });

  it('a pack install creates workflow-support folders and files protected, top-down and before content', async () => {
    const root = fixture(), vault = join(root, 'vault'), support = join(vault, 'workflow-support');
    mkdirSync(vault);
    const service = createCustomerPackService({ directory: root, profileDirectory: () => join(root, 'profile'), workroomDirectory: () => vault,
      listRecipes: () => [], saveRecipes: () => [], resetRecipeApprovals: () => {}, activeRecipeIds: () => [],
      learningStatus: () => ({ supported: true, policyReady: true, enabled: true }),
      readiness: async () => ({ worker: { label: 'Worker', state: 'needed' as const, detail: 'Not installed', nextAction: 'Install through setup' } }) });
    const pack = austinCustomerPack(), preview = await service.preview(pack);
    acl.launches.length = 0;
    await service.install(pack, preview.digest);
    const skill = pack.skills[0]!, folder = join(support, skill.id), file = join(folder, 'SKILL.md'), ops = acl.launches.flat();
    const at = (path: string) => ops.findIndex(([target, , action]) => target === path && action === 'restrict');
    expect(at(support)).toBeGreaterThanOrEqual(0);
    expect(at(folder)).toBeGreaterThan(at(support));
    expect(at(file)).toBeGreaterThan(at(folder));
    expect(ops[at(file)]![3]).toBe(0);
    expect(ops[at(join(folder, 'LICENSE'))]![3]).toBe(0);
    expect(restricted()).not.toContain(vault);
    expect(readFileSync(file, 'utf8')).toBe(skill.instructions);
    acl.launches.length = 0; await service.install(pack, preview.digest);
    expect(restricted().filter(path => path.startsWith(support))).toEqual([]);
  });
});

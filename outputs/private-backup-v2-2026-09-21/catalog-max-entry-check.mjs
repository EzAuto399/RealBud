import { PrivateBackupCatalog, catalogStorageBudget } from '../../server/private-backup-catalog.ts';
import { emptyV3 } from '../../shared/desk-v3.ts';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud maximum entry '));
const key = randomBytes(32), workspaceId = randomUUID(), limits = { maxEntries: 20, maxBytes: 16 * 1024 ** 2, maxStorageBytes: 32 * 1024 ** 2 };
let catalog, reopened;
const sampledRss = [{ phase: 'start', bytes: process.memoryUsage().rss }];
try {
  catalog = await PrivateBackupCatalog.create({ directory: join(root, 'catalog'), key, workspaceId, ...limits });
  catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })) });
  catalog.addFile({ path: 'desk.json', encoding: 'json', data: Buffer.from(JSON.stringify(emptyV3({ name: 'Fictional maximum entry', timezone: 'UTC', jurisdictions: [] }))) });
  const body = randomBytes(8 * 1024 ** 2), sha = bytes => createHash('sha256').update(bytes).digest('hex'), started = performance.now();
  catalog.addFile({ path: 'vault/workflow-inputs/maximum.csv', encoding: 'bytes', data: body });
  sampledRss.push({ phase: 'afterInsert', bytes: process.memoryUsage().rss });
  const sealed = catalog.seal(); catalog.close();
  reopened = await PrivateBackupCatalog.open({ directory: catalog.directory, key, workspaceId, catalogId: catalog.catalogId });
  const actual = reopened.getFile('vault/workflow-inputs/maximum.csv').data;
  if (actual.length !== body.length || sha(actual) !== sha(body) || reopened.validate().digest !== sealed.digest) throw new Error('Exact maximum entry check failed');
  sampledRss.push({ phase: 'afterReopenAndValidate', bytes: process.memoryUsage().rss });
  const receipt = { success: true, node: process.version, platform: process.platform, arch: process.arch, payloadBytes: body.length, physicalBytes: (await stat(join(catalog.directory, 'catalog.sqlite'))).size, limits, budget: catalogStorageBudget(limits), elapsedMs: performance.now() - started, sampledRss, layer: 'Source fixture with real8MiB random bytes, actual catalog write, seal and reopen. RSS samples are not a peak memory measurement or SLA.' };
  await writeFile(new URL('./catalog-max-entry-receipt.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt));
} finally { reopened?.close(); catalog?.close(); key.fill(0); await rm(root, { recursive: true, force: true }); }

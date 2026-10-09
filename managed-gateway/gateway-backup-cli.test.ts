import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './testing.ts';
import { runGatewayBackupCli } from './gateway-backup-cli.ts';

test('offline CLI returns only bounded artifact receipts and never key/customer/secret content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-backup-cli-')); try {
    const state = join(root, 'state'), f = fixture(join(state, 'ledger.sqlite')); f.close();
    const key = join(root, 'key', 'recovery'), archive = join(root, 'exports', 'backup'), output: string[] = [], errors: string[] = [];
    const run = (args: string[]) => runGatewayBackupCli(args, { REALBUD_GATEWAY_DATA: state }, line => output.push(line), line => errors.push(line));
    assert.equal(await run(['key-create', '--key-file', key]), 0); assert.equal(readFileSync(key).length, 32);
    assert.equal(await run(['export', '--key-file', key, '--output', archive]), 0);
    assert.equal(await run(['verify', '--key-file', key, '--archive', archive, '--scratch', join(root, 'verify')]), 0);
    assert.equal(await run(['restore', '--key-file', key, '--archive', archive, '--target', join(root, 'restored')]), 0);
    assert.equal(await run(['restore', '--key-file', key, '--archive', archive, '--target', state, '--activate', 'true']), 1);
    assert.ok(errors.every(line => /^\{"status":"refused","error":"gateway_[a-z_]+"\}$/.test(line)));
    assert.equal(output.join('\n').includes('Fictional Agency'), false); assert.ok(output.every(line => Object.keys(JSON.parse(line)).every(key => ['status', 'path', 'sha256'].includes(key))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

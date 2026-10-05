// Temporary Windows measurement for the private-file path; removed before merge.
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { windowsFilePrivacy, windowsFilePrivacySync } from './windows-file-privacy.ts';
import { readPrivateFileSync, writeFileAtomic } from './atomic.ts';

const roots: string[] = [];
afterAll(async () => { for (const root of roots) await removeFixture(root); });
async function time(label: string, count: number, run: (i: number) => unknown): Promise<number> {
  await run(-1);
  const started = performance.now();
  for (let i = 0; i < count; i++) await run(i);
  const ms = (performance.now() - started) / count;
  console.log(`[bench] ${label}: ${ms.toFixed(1)} ms/op over ${count}`);
  return ms;
}

describe.runIf(process.platform === 'win32')('Windows private-file cost', () => {
  it('measures each private operation', { timeout: 600_000 }, async () => {
    const root = privateTempRoot(join(process.env.RUNNER_TEMP ?? process.env.TEMP ?? 'C:\\Temp', 'rb-bench-')); roots.push(root);
    const file = join(root, 'state.json');
    await writePrivateJson(file, { n: 0 });
    await time('windowsFilePrivacy verify dir (async)', 10, () => windowsFilePrivacy(root, 'directory'));
    await time('windowsFilePrivacySync verify dir', 10, () => windowsFilePrivacySync(root, 'directory'));
    await time('readPrivateJson', 10, () => readPrivateJson(file));
    await time('writePrivateJson (replace)', 10, i => writePrivateJson(file, { n: i }));
    await time('writePrivateJson (new file)', 10, i => writePrivateJson(join(root, `new-${i + 1}.json`), { n: i }));
    await time('writeFileAtomic + readPrivateFileSync', 10, i => { writeFileAtomic(join(root, 'a.txt'), String(i)); return readPrivateFileSync(join(root, 'a.txt')); });
    expect(true).toBe(true);
  });
});

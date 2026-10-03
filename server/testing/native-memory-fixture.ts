/** Copies only admitted source modules into a disposable fictional runtime. */
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { MEMORY_REVIEW_RUNTIMES } from '../hermes-memory-review.ts';
import { runtimeCommit } from '../hermes-runtime-selection.ts';

/** `source` is `<runtimes>/<commit>-<suffix>/hermes-agent` for an admitted commit (0.21.3 or 0.21.5). */
export async function prepareNativeMemoryFixture(data: string, source: string) {
  if (process.platform === 'win32') throw new Error('This native fixture requires the separately admitted POSIX layer.');
  const admitted = await realpath(source), hermes = join(data, 'hermes');
  const runtimeId = basename(dirname(admitted)), commit = runtimeCommit(runtimeId);
  if (!commit || !Object.hasOwn(MEMORY_REVIEW_RUNTIMES, commit)) throw new Error('Native fixture admission failed: runtime commit is not admitted.');
  const files = MEMORY_REVIEW_RUNTIMES[commit];
  const runtime = join(hermes, 'runtimes', runtimeId, 'hermes-agent');
  const profile = join(hermes, 'profiles', 'property');
  const directory = async (path: string) => { await mkdir(path, { recursive: true, mode: 0o700 }); };
  const privateWrite = async (path: string, text: string) => { await writeFile(path, text, { mode: 0o600 }); await chmod(path, 0o600); };
  for (const path of [data, runtime, profile, join(profile, 'memories'), join(profile, 'pending', 'memory')]) await directory(path);
  for (const [name, digest] of Object.entries(files)) {
    const original = join(admitted, name), file = await lstat(original);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 2 * 1024 ** 2 || createHash('sha256').update(await readFile(original)).digest('hex') !== digest) throw new Error(`Native fixture admission failed: ${name}`);
    await directory(dirname(join(runtime, name))); await copyFile(original, join(runtime, name)); await chmod(join(runtime, name), 0o600);
  }
  const venv = join(runtime, 'venv'), sourceVenv = join(admitted, 'venv'); await directory(join(venv, 'bin'));
  await symlink(join(sourceVenv, 'bin', 'python'), join(venv, 'bin', 'python'));
  await copyFile(join(sourceVenv, 'pyvenv.cfg'), join(venv, 'pyvenv.cfg'));
  for (const name of ['lib', 'lib64', 'Lib', 'DLLs']) {
    const from = join(sourceVenv, name), to = join(venv, name);
    if (await stat(to).then(() => true, () => false)) continue;
    if (await stat(from).then(value => value.isDirectory(), () => false)) await symlink(from, to, 'dir');
  }
  await privateWrite(join(hermes, 'realbud-runtime.json'), JSON.stringify({ version: 1, selected: runtimeId, previous: null, previousAvailable: false }));
  await privateWrite(join(profile, 'config.yaml'), 'memory:\n  write_approval: true\n  memory_enabled: true\n  user_profile_enabled: true\n  memory_char_limit: 2200\n  user_char_limit: 1375\n');
  const memoryFile = join(profile, 'memories', 'MEMORY.md');
  await privateWrite(memoryFile, 'Prefers concise updates.\n§\nUse Australian English.');
  return { profile, runtime, runtimeId, commit, hermes, memoryFile, pendingDirectory: join(profile, 'pending', 'memory'), privateWrite };
}

// Test stand-ins for private objects the product would have created itself.
// Windows admits a private object only when it carries its own protected
// descriptor; a plain mkdtemp/mkdir/writeFile object inherits its parent's and
// is refused (`windows-acl:inheritance-not-protected`). These give each object
// they create that descriptor before any content, exactly as the product does
// (server/atomic.ts), and are plain fs calls on every other system. They never
// touch an object that already exists. Tests that deliberately create an
// unprotected, linked or foreign object to prove a refusal must keep plain fs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createEmptyFileSync, mkdirNewSync, mkdirPrivateSync, restrictNewSync, writeFilePrivateSync, type NewPrivateObject } from '../atomic.ts';
import { windowsFilePrivacySync } from '../windows-file-privacy.ts';

/** `mkdtempSync(prefix)` whose new root gets its own protected descriptor. */
export function privateTempRoot(prefix: string): string {
  const root = mkdtempSync(prefix);
  try { windowsFilePrivacySync(root, 'directory', true); return root; }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

/** `mkdir -p` restricting each level it creates, outermost first. The missing
 * levels are listed by walking up, never inferred from mkdir's return value
 * (Windows can report it in its \\?\ form). Existing levels are left alone. */
export function privateDir(path: string, mode = 0o700): void {
  mkdirPrivateSync(path, mode);
}

/** A file the product would have written: missing parent levels are created
 * privately, a new file is created empty ('wx'), restricted, then written. An
 * existing file is written in place and keeps its descriptor. */
export function plantPrivateFile(path: string, data: string | Buffer, mode = 0o600): void {
  privateDir(dirname(path));
  writeFilePrivateSync(path, data, mode);
}

/** Several planted files with one Windows admission for all new ones. */
export function plantPrivateFiles(files: ReadonlyArray<readonly [path: string, data: string | Buffer]>, mode = 0o600): void {
  const folders = [...new Set(files.map(([path]) => dirname(path)))];
  restrictNewSync(folders.flatMap(folder => mkdirNewSync(folder, 0o700)).map(path => ({ path, kind: 'directory' as const })));
  const created: NewPrivateObject[] = [];
  for (const [path] of files) if (createEmptyFileSync(path, mode)) created.push({ path, kind: 'file' });
  restrictNewSync(created);
  for (const [path, data] of files) writeFileSync(path, data, { mode });
}

/** Options for a test that Windows admission makes slow: there every private
 * object the product creates or verifies costs one PowerShell launch (about
 * 0.2–0.4 s on a hosted runner). `launches` is the count measured for that test;
 * elsewhere the suite's default timeout applies unchanged. */
export function windowsAdmissionTimeout(launches: number): { timeout?: number } {
  return process.platform === 'win32' ? { timeout: Math.max(60_000, launches * 1_000) } : {};
}

/** Test cleanup that never fails a passing test. Windows can hold a folder for
 * a moment after a database closes or a child process exits (EPERM/EBUSY), and
 * rm's own retries do not cover the folder itself; retry briefly, then warn. */
export async function removeFixture(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); return; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  console.warn(`test cleanup could not remove a fixture folder: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

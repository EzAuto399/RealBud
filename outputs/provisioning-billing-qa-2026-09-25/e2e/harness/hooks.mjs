// Loader hooks for the QA harness: website route modules use extensionless
// relative imports (Next resolves them); plain Node needs `.ts`. `lib/db` is
// redirected to a fake whose rpc() runs the real SQL functions in a disposable
// PostgreSQL. Nothing else is rewritten.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
const fakeDb = new URL('./fake-db.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  const parent = context.parentURL ?? '';
  if (parent.includes('/website/') && /(^|\/)lib\/db(\.ts)?$/.test(specifier)) return { url: fakeDb, shortCircuit: true };
  if (parent.startsWith('file:') && parent.includes('/website/') && (specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]s$/.test(specifier)) {
    const base = resolvePath(dirname(fileURLToPath(parent)), specifier);
    if (existsSync(base + '.ts')) return { url: pathToFileURL(base + '.ts').href, shortCircuit: true };
  }
  return next(specifier, context);
}

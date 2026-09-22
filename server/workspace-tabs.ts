import { createHash, randomUUID } from 'node:crypto';
import { lstat, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseWorkspaceTabs, validWorkspaceRevision, type WorkspaceTabs, type WorkspaceTabsResponse } from '../shared/workspace-tabs.ts';
import { privateDirectory, readPrivateJson, writePrivateJson } from './private-json.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';

const MAX_BYTES = 32_000;
const queues = new Map<string, Promise<unknown>>();
const fail = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail(400, 'invalid_tabs', 'Check the saved view settings.');
  return value;
}

/** One private service owns a DATA_DIR. Queue all windows/store instances before
 * rereading revisions. Office membership cannot change this immutable binding. */
export function createWorkspaceTabsHandler(options: { directory: string; workspaceId: string }) {
  if (!/^[a-f0-9-]{36}$/i.test(options.workspaceId)) throw new Error('A private workspace identity is required.');
  const directory = resolve(options.directory, 'workspace-views');
  const path = join(directory, 'tabs.json');
  const defaults = (): WorkspaceTabs => ({ version: 1, revision: 0, tabs: [] });
  async function fingerprint() {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw fail(503, 'tabs_recovery_required', 'Saved view storage needs service recovery. Your business records are unchanged.');
    await windowsFilePrivacy(path, 'file');
    return createHash('sha256').update(`${options.workspaceId}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`).digest('hex');
  }
  async function read(): Promise<WorkspaceTabsResponse> {
    await privateDirectory(directory);
    try {
      const value = await readPrivateJson(path, MAX_BYTES);
      if (value === undefined) return { state: defaults(), recovery: null };
      if (!record(value) || Object.keys(value).sort().join(',') !== 'state,workspaceId' || value.workspaceId !== options.workspaceId) throw new Error('Different workspace');
      return { state: parseWorkspaceTabs(value.state), recovery: null };
    } catch {
      return { state: null, recovery: { message: 'Saved views could not be loaded. Your business records are unchanged. Reset views to keep a recovery copy and start with the standard navigation.', resetToken: await fingerprint() } };
    }
  }
  function serial<T>(action: () => Promise<T>) {
    const previous = queues.get(path) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    queues.set(path, next);
    void next.finally(() => { if (queues.get(path) === next) queues.delete(path); }).catch(() => {});
    return next;
  }
  async function save(state: WorkspaceTabs) {
    if (!validWorkspaceRevision(state.revision)) throw fail(409, 'tabs_revision_exhausted', 'Saved views need service recovery before further changes. Your business records are unchanged.');
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_BYTES - 200) throw fail(400, 'invalid_tabs', 'Saved views are too large.');
    await writePrivateJson(path, { workspaceId: options.workspaceId, state });
    return { state, recovery: null } satisfies WorkspaceTabsResponse;
  }
  return {
    async handle(route: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
      if (route !== '/api/workspace-tabs' && route !== '/api/workspace-tabs/reset') return null;
      if (!(route === '/api/workspace-tabs' && ['GET', 'PUT'].includes(method)) && !(route.endsWith('/reset') && method === 'POST')) return { status: 405, body: { error: 'This saved view action is unavailable.' } };
      try {
        const result = await serial(async () => {
          const current = await read();
          if (method === 'GET') return current;
          if (route.endsWith('/reset')) {
            const input = fields(body, ['expectedRevision', 'confirm', 'resetToken']);
            if (input.confirm !== true) throw fail(400, 'confirmation_required', 'Confirm resetting your saved views.');
            if (current.recovery) {
              if (input.resetToken !== current.recovery.resetToken) throw fail(409, 'tabs_changed', 'Saved views changed. Refresh and review the reset again.');
              await rename(path, join(directory, `tabs-recovery-${randomUUID()}.json`));
              return save({ ...defaults(), revision: 1 });
            }
            if (!validWorkspaceRevision(input.expectedRevision) || input.expectedRevision !== current.state!.revision) throw fail(409, 'tabs_changed', 'Saved views changed in another window. Refresh before resetting.');
            return save({ version: 1, revision: current.state!.revision + 1, tabs: [] });
          }
          if (!current.state) throw fail(409, 'tabs_recovery_required', 'Saved views need recovery. Reset views before making changes.');
          const input = fields(body, ['expectedRevision', 'version', 'tabs']);
          if (!validWorkspaceRevision(input.expectedRevision)) throw fail(400, 'invalid_tabs', 'Refresh saved views before changing them.');
          if (input.expectedRevision !== current.state.revision) throw fail(409, 'tabs_changed', 'Saved views changed in another window. Refresh and review your changes again.');
          let next: WorkspaceTabs;
          try { next = parseWorkspaceTabs({ version: input.version, revision: current.state.revision + 1, tabs: input.tabs }); }
          catch { throw fail(400, 'invalid_tabs', 'Check the saved view names, types and filters. No views were changed.'); }
          return save(next);
        });
        return { status: 200, body: result };
      } catch (cause) {
        const known = cause as { status?: number; code?: string; message?: string };
        return { status: known.status ?? 503, body: { error: known.status ? known.message : 'Saved views could not be saved or checked. Refresh before retrying; your business records are unchanged.', code: known.code ?? 'tabs_unavailable' } };
      }
    },
  };
}

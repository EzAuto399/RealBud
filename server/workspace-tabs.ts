import { createHash, randomUUID } from 'node:crypto';
import { lstat, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_DESK_LAYOUT_HISTORY, defaultDeskSections, simpleDeskSections, parseDeskSections, parseWorkspaceTabs, sameDeskSections, validWorkspaceRevision, type DeskSection, type WorkspaceTabs, type WorkspaceTabsResponse } from '../shared/workspace-tabs.ts';
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
export function createWorkspaceTabsHandler(options: { directory: string; workspaceId: string; now?: () => number }) {
  const now = options.now ?? Date.now;
  if (!/^[a-f0-9-]{36}$/i.test(options.workspaceId)) throw new Error('A private workspace identity is required.');
  const directory = resolve(options.directory, 'workspace-views');
  const path = join(directory, 'tabs.json');
  const defaults = (): WorkspaceTabs => ({ version: 2, revision: 0, tabs: [], desk: { sections: defaultDeskSections() }, history: [] });
  /** Record an accepted desk layout, newest first. The layout in place before the
   * first customization is kept too, so it can be restored. */
  const withDesk = (current: WorkspaceTabs, revision: number, sections: DeskSection[]): Pick<WorkspaceTabs, 'desk' | 'history'> => {
    if (sameDeskSections(current.desk.sections, sections)) return { desk: current.desk, history: current.history };
    const earlier = current.history.length ? current.history : [{ revision: current.revision, savedAt: null, sections: current.desk.sections }];
    // One entry per distinct layout: restoring or re-saving a layout moves it to the top.
    return { desk: { sections }, history: [{ revision, savedAt: now(), sections }, ...earlier.filter(entry => !sameDeskSections(entry.sections, sections))].slice(0, MAX_DESK_LAYOUT_HISTORY) };
  };
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
    /** A newly linked office starts on the simple desk (brief + Needs you).
     * Only when this computer has never saved a layout: a person's own
     * choice is never replaced. Returns whether it applied. */
    async simpleDeskIfNeverCustomized(): Promise<boolean> {
      return serial(async () => {
        const current = await read();
        if (!current.state || current.state.revision !== 0 || current.state.history.length) return false;
        const revision = 1;
        await save({ ...current.state, revision, ...withDesk(current.state, revision, simpleDeskSections()) });
        return true;
      });
    },
    async handle(route: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
      if (route !== '/api/workspace-tabs' && route !== '/api/workspace-tabs/reset' && route !== '/api/workspace-tabs/revert') return null;
      if (!(route === '/api/workspace-tabs' && ['GET', 'PUT'].includes(method)) && !(route !== '/api/workspace-tabs' && method === 'POST')) return { status: 405, body: { error: 'This saved view action is unavailable.' } };
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
            return save({ ...current.state!, revision: current.state!.revision + 1, tabs: [] });
          }
          if (route.endsWith('/revert')) {
            if (!current.state) throw fail(409, 'tabs_recovery_required', 'Saved views need recovery. Reset views before making changes.');
            const input = fields(body, ['expectedRevision', 'toRevision']);
            if (!validWorkspaceRevision(input.expectedRevision) || !validWorkspaceRevision(input.toRevision)) throw fail(400, 'invalid_tabs', 'Refresh the Desk layout before restoring one.');
            if (input.expectedRevision !== current.state.revision) throw fail(409, 'tabs_changed', 'This card changed — open it again');
            const target = current.state.history.find(entry => entry.revision === input.toRevision);
            if (!target) throw fail(400, 'invalid_tabs', 'That earlier Desk layout is no longer kept.');
            const revision = current.state.revision + 1;
            return save({ ...current.state, revision, ...withDesk(current.state, revision, target.sections) });
          }
          if (!current.state) throw fail(409, 'tabs_recovery_required', 'Saved views need recovery. Reset views before making changes.');
          // Version 1 bodies change tabs only; version 2 bodies carry the Desk layout too.
          const input = fields(body, ['expectedRevision', 'version', 'tabs', 'desk']);
          if (!validWorkspaceRevision(input.expectedRevision)) throw fail(400, 'invalid_tabs', 'Refresh saved views before changing them.');
          if (input.version !== 1 && input.version !== 2 || (input.version === 1) !== (input.desk === undefined)) throw fail(400, 'invalid_tabs', 'Check the saved view settings.');
          if (input.expectedRevision !== current.state.revision) throw fail(409, 'tabs_changed', 'Saved views changed in another window. Refresh and review your changes again.');
          const revision = current.state.revision + 1;
          let tabs: WorkspaceTabs['tabs'], sections = current.state.desk.sections;
          try { tabs = parseWorkspaceTabs({ version: 1, revision, tabs: input.tabs }).tabs; }
          catch { throw fail(400, 'invalid_tabs', 'Check the saved view names, types and filters. No views were changed.'); }
          if (input.version === 2) {
            const desk = input.desk as Record<string, unknown> | undefined;
            try { if (!record(desk) || Object.keys(desk).join() !== 'sections') throw new Error(); sections = parseDeskSections(desk.sections); }
            catch (cause) { throw fail(400, 'invalid_desk', cause instanceof Error && cause.message ? `${cause.message} No layout was changed.` : 'Check the Desk sections. No layout was changed.'); }
          }
          return save({ version: 2, revision, tabs, ...withDesk(current.state, revision, sections) });
        });
        return { status: 200, body: result };
      } catch (cause) {
        const known = cause as { status?: number; code?: string; message?: string };
        return { status: known.status ?? 503, body: { error: known.status ? known.message : 'Saved views could not be saved or checked. Refresh before retrying; your business records are unchanged.', code: known.code ?? 'tabs_unavailable' } };
      }
    },
  };
}

import type { DeskSnapshot } from '@shared/contracts';
import { sameOfficeDraftScope, type OfficeChanges, type OfficeDraftContext } from './office-draft-journal';

export type WorkspaceDeskSnapshot = DeskSnapshot & { workspaceId: string; onboardingScope?: string };
const held = () => Object.assign(new Error('The office reply could not be admitted to the current workspace and session. Your original typing is kept. Check saved settings before any further save.'), { status: 409 });
/** Metadata is authored by the host route, never a company ID or refreshed token. */
export function readWorkspaceDeskSnapshot(value: unknown): WorkspaceDeskSnapshot {
  const row = value as { workspaceId?: unknown; revision?: unknown } | null;
  if (typeof row?.workspaceId !== 'string' || !row.workspaceId || row.workspaceId.length > 128 || row.workspaceId.trim() !== row.workspaceId ||
    /[\u0000-\u001f\u007f]/.test(row.workspaceId) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) throw held();
  return value as WorkspaceDeskSnapshot;
}

/** The actual Office reload/save boundary. No dispatch/success is allowed after
 * an await without host workspace metadata and current renderer scope checks. */
export function createOfficeDraftRequests(options: {
  context: OfficeDraftContext;
  request(path: string, init?: RequestInit): Promise<unknown>;
  readIdentity(): Promise<OfficeDraftContext>;
  currentContext(): OfficeDraftContext | null;
  currentEpoch(): number;
  active(): boolean;
  currentRevision(): number | null;
  accept(snapshot: WorkspaceDeskSnapshot): void;
}) {
  const context = structuredClone(options.context);
  const current = () => {
    const now = options.currentContext();
    if (!options.active() || options.currentEpoch() !== context.sessionVersion || !now || !sameOfficeDraftScope(context, now)) throw held();
  };
  const snapshot = (value: unknown) => {
    current(); const result = readWorkspaceDeskSnapshot(value);
    if (result.workspaceId !== context.workspaceId) throw held();
    return result;
  };
  const identity = async () => {
    const now = await options.readIdentity(); current();
    if (!sameOfficeDraftScope(context, now)) throw held();
  };
  const accept = (value: WorkspaceDeskSnapshot) => {
    current(); const revision = options.currentRevision();
    if (revision !== null && value.revision < revision) throw held();
    options.accept(value);
  };
  return {
    async reload() {
      current();
      const loaded = snapshot(await options.request('/api/desk'));
      await identity(); accept(loaded);
    },
    async save(input: OfficeChanges) {
      current();
      const [now, value] = await Promise.all([options.readIdentity(), options.request('/api/desk')]);
      const before = snapshot(value);
      if (!sameOfficeDraftScope(context, now)) throw held();
      if (before.revision !== input.expectedRevision) {
        accept(before);
        throw Object.assign(new Error('The saved book changed. Your typing is kept. Discard edits and reload saved settings before saving.'), { status: 409 });
      }
      let returned: unknown;
      try {
        returned = await options.request('/api/desk/agency', { method: 'PATCH', body: JSON.stringify({
          name: input.name, jurisdictions: input.jurisdictions, office: input.office,
          expectedRevision: input.expectedRevision, expectedWorkspaceId: context.workspaceId,
        }) });
      } catch (cause) {
        // Explicit validation/permission refusals precede the write. A lost reply
        // can hide a committed save; retain it as requiring inspection.
        if (![400, 403, 409].includes(Number((cause as { status?: number })?.status))) {
          throw Object.assign(held(), { officeOutcomeUnknown: true });
        }
        throw cause;
      }
      try {
        const saved = snapshot(returned);
        await identity(); accept(saved);
      } catch { throw Object.assign(held(), { officeOutcomeUnknown: true }); }
    },
  };
}

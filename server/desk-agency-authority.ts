import type { Desk, DeskSnapshot } from './desk.ts';

export type WorkspaceDeskSnapshot = DeskSnapshot & { workspaceId: string };

/** Response metadata identifies the physical private workspace, never office membership. */
export function deskSnapshotForWorkspace(snapshot: DeskSnapshot, workspaceId: string): WorkspaceDeskSnapshot {
  return { ...snapshot, workspaceId };
}

/** Keep this check and the synchronous book commit together after request-body awaits. */
export function patchDeskAgencyForWorkspace(
  desk: Pick<Desk, 'patchAgency'>,
  workspaceId: string,
  value: unknown,
): WorkspaceDeskSnapshot {
  const body = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const expected = body.expectedWorkspaceId;
  if (typeof expected !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(expected) || expected !== workspaceId) {
    throw Object.assign(new Error('The private workspace could not be confirmed or changed while you were editing. Your edits are kept. Update this app if needed, then reopen Office details to check the current workspace before saving.'), { status: 409, code: 'workspace-conflict' });
  }
  const snapshot = desk.patchAgency({
    name: typeof body.name === 'string' ? body.name : undefined,
    jurisdictions: Array.isArray(body.jurisdictions) ? body.jurisdictions as string[] : undefined,
    office: body.office,
    expectedRevision: body.expectedRevision,
  });
  return deskSnapshotForWorkspace(snapshot, workspaceId);
}

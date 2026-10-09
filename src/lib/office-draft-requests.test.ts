import { describe, expect, it, vi } from 'vitest';
import { OfficeDraftJournal, type OfficeDraftContext } from './office-draft-journal';
import { createOfficeDraftRequests, readWorkspaceDeskSnapshot } from './office-draft-requests';

const context: OfficeDraftContext = { workspaceId: 'fictional-private-workspace', companyId: 'fictional-company', memberId: 'fictional-member', sessionVersion: 2 };
const desk = (workspaceId = context.workspaceId, revision = 4) => ({ workspaceId, revision, book: { office: { pmUser: 'Fictional contact' } } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; }
function fixture() {
  const state = { context: { ...context }, epoch: 2, active: true, host: { ...context }, revision: 4 };
  const accept = vi.fn(), request = vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => desk());
  const readIdentity = vi.fn(async () => ({ ...state.host }));
  const boundary = createOfficeDraftRequests({ context, request, readIdentity, currentContext: () => state.context, currentEpoch: () => state.epoch, active: () => state.active, currentRevision: () => state.revision, accept });
  return { state, accept, request, readIdentity, boundary };
}
describe('actual office request boundary', () => {
  it('sends the exact opening private workspace and revision and accepts only after current host reread', async () => {
    const f = fixture(); f.request.mockImplementation(async path => desk(context.workspaceId, path.endsWith('/agency') ? 5 : 4));
    await f.boundary.save({ name: 'Typed', expectedRevision: 4 });
    expect(JSON.parse(f.request.mock.calls[1][1]!.body as string)).toEqual({ name: 'Typed', expectedRevision: 4, expectedWorkspaceId: context.workspaceId });
    expect(f.readIdentity).toHaveBeenCalledTimes(2); expect(f.accept).toHaveBeenCalledExactlyOnceWith(desk(context.workspaceId, 5));
  });
  it.each([{ workspaceId: 'other' }, { companyId: 'other' }, { memberId: 'other' }, { sessionVersion: 3 }])('holds a delayed save reply after current scope changes %j and keeps original journal typing', async change => {
    const f = fixture(), reply = deferred<unknown>(), journal = new OfficeDraftJournal();
    const entry = journal.write(context, 4, { name: 'Private original typing' }); journal.beginSave(context, 4, entry.sequence);
    f.request.mockImplementation(path => path.endsWith('/agency') ? reply.promise : Promise.resolve(desk()));
    const saving = f.boundary.save({ name: 'Private original typing', expectedRevision: 4 });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    f.state.context = { ...context, ...change }; if ('sessionVersion' in change) f.state.epoch = change.sessionVersion!;
    reply.resolve(desk(context.workspaceId, 5));
    await expect(saving).rejects.toMatchObject({ officeOutcomeUnknown: true });
    journal.finishSave(context, entry.sequence, false, true);
    expect(f.accept).not.toHaveBeenCalled(); expect(journal.read(context)).toMatchObject({ changes: { name: 'Private original typing' }, needsReconciliation: true });
    expect(() => journal.beginSave(context, 4, entry.sequence)).toThrow('previous save reply');
  });
  it('rejects a delayed returned workspace even if current renderer context did not update', async () => {
    const f = fixture(); f.request.mockImplementation(async path => desk(path.endsWith('/agency') ? 'new-host-workspace' : context.workspaceId));
    await expect(f.boundary.save({ expectedRevision: 4 })).rejects.toMatchObject({ officeOutcomeUnknown: true }); expect(f.accept).not.toHaveBeenCalled();
  });
  it('rechecks after awaited final identity so rebind during that read cannot admit an old save', async () => {
    const f = fixture(), identity = deferred<OfficeDraftContext>();
    f.readIdentity.mockResolvedValueOnce({ ...context }).mockImplementationOnce(() => identity.promise);
    const saving = f.boundary.save({ expectedRevision: 4 }); await vi.waitFor(() => expect(f.readIdentity).toHaveBeenCalledTimes(2));
    f.state.context = { ...context, workspaceId: 'replacement' }; identity.resolve({ ...context });
    await expect(saving).rejects.toMatchObject({ officeOutcomeUnknown: true }); expect(f.accept).not.toHaveBeenCalled();
  });
  it('holds a same-metadata save when the authoritative host identity reread changed', async () => {
    const f = fixture(); f.readIdentity.mockResolvedValueOnce({ ...context }).mockResolvedValueOnce({ ...context, workspaceId: 'replacement' });
    await expect(f.boundary.save({ expectedRevision: 4 })).rejects.toMatchObject({ officeOutcomeUnknown: true }); expect(f.accept).not.toHaveBeenCalled();
  });
  it.each(['response', 'final-identity'] as const)('refuses a delayed reload changed during %s before global dispatch', async stage => {
    const f = fixture(), reply = deferred<unknown>(), identity = deferred<OfficeDraftContext>();
    if (stage === 'response') f.request.mockImplementation(() => reply.promise); else f.readIdentity.mockImplementation(() => identity.promise);
    const reload = f.boundary.reload();
    if (stage === 'final-identity') await vi.waitFor(() => expect(f.readIdentity).toHaveBeenCalledOnce());
    f.state.context = { ...context, workspaceId: 'replacement' };
    reply.resolve(desk()); identity.resolve({ ...context }); await expect(reload).rejects.toThrow('could not be admitted'); expect(f.accept).not.toHaveBeenCalled();
  });
  it('holds missing metadata, stale initial revision or changed initial identity before any PATCH', async () => {
    const f = fixture(); f.request.mockResolvedValue({ revision: 4 });
    await expect(f.boundary.save({ expectedRevision: 4 })).rejects.toThrow('could not be admitted'); expect(f.request).toHaveBeenCalledTimes(1);
    f.request.mockClear(); f.request.mockResolvedValue(desk()); f.readIdentity.mockResolvedValue({ ...context, memberId: 'other' });
    await expect(f.boundary.save({ expectedRevision: 4 })).rejects.toThrow('could not be admitted'); expect(f.request).toHaveBeenCalledTimes(1);
    f.readIdentity.mockResolvedValue({ ...context }); f.request.mockClear();
    await expect(f.boundary.save({ expectedRevision: 3 })).rejects.toMatchObject({ status: 409 }); expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('keeps lost PATCH replies held without reissuing and preserves explicit pre-write refusal', async () => {
    const f = fixture(); f.request.mockImplementation(async path => { if (path.endsWith('/agency')) throw new Error('reply lost'); return desk(); });
    await expect(f.boundary.save({ expectedRevision: 4 })).rejects.toMatchObject({ officeOutcomeUnknown: true }); expect(f.request).toHaveBeenCalledTimes(2); expect(f.accept).not.toHaveBeenCalled();
    f.request.mockImplementation(async path => { if (path.endsWith('/agency')) throw Object.assign(new Error('workspace refused'), { status: 409 }); return desk(); });
    await expect(f.boundary.save({ expectedRevision: 4 })).rejects.toEqual(expect.objectContaining({ status: 409 }));
  });
  it('rejects an old same-context reload after a newer snapshot was admitted during the identity await', async () => {
    const f = fixture(), identity = deferred<OfficeDraftContext>(); f.readIdentity.mockImplementation(() => identity.promise);
    const loading = f.boundary.reload(); await vi.waitFor(() => expect(f.readIdentity).toHaveBeenCalledOnce());
    f.state.revision = 6; identity.resolve({ ...context });
    await expect(loading).rejects.toThrow('could not be admitted'); expect(f.accept).not.toHaveBeenCalled();
  });
  it('holds an old same-context save after a newer revision or later view operation supersedes it', async () => {
    const f = fixture(), identity = deferred<OfficeDraftContext>();
    f.readIdentity.mockResolvedValueOnce({ ...context }).mockImplementationOnce(() => identity.promise);
    const saving = f.boundary.save({ expectedRevision: 4 }); await vi.waitFor(() => expect(f.readIdentity).toHaveBeenCalledTimes(2));
    f.state.revision = 6; identity.resolve({ ...context });
    await expect(saving).rejects.toMatchObject({ officeOutcomeUnknown: true }); expect(f.accept).not.toHaveBeenCalled();
    f.state.active = false; await expect(f.boundary.reload()).rejects.toThrow('could not be admitted');
  });
  it.each([null, {}, { workspaceId: ' ', revision: 4 }, { workspaceId: 'x\n', revision: 4 }, { workspaceId: context.workspaceId, revision: -1 }])('refuses unreadable host metadata %j', value => {
    expect(() => readWorkspaceDeskSnapshot(value)).toThrow('could not be admitted');
  });
});

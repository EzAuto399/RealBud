import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Desk } from './desk.ts';
import { DeskStore } from './desk-store.ts';
import { deskSnapshotForWorkspace, patchDeskAgencyForWorkspace } from './desk-agency-authority.ts';
import { SESSION_TOKEN, sessionOk } from './session-auth.ts';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const directories: string[] = [];
const key = Buffer.alloc(32, 7);
function fixture() {
  const directory = privateTempRoot(join(tmpdir(), 'fictional-desk-agency-authority-'));
  directories.push(directory);
  const file = join(directory, 'desk.json');
  const desk = new Desk({ file, key });
  return { directory, file, desk };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await removeFixture(directory);
    expect(existsSync(directory)).toBe(false);
  }
});

describe('physical workspace authority for Office settings', () => {
  it.each([undefined, null, 1, '', ' fictional-workspace', 'fictional-workspace ', 'bad\nworkspace', 'a'.repeat(129), 'fictional-other-workspace'])('holds missing, malformed or changed workspace %j without touching the actual book', expectedWorkspaceId => {
    const { desk, file } = fixture(), before = desk.snapshot(), bytes = readFileSync(file);
    expect(() => patchDeskAgencyForWorkspace(desk, 'fictional-workspace', {
      expectedWorkspaceId, expectedRevision: before.revision, name: 'Fictional stale typing',
    })).toThrow(expect.objectContaining({ status: 409, code: 'workspace-conflict' }));
    expect(desk.snapshot()).toEqual(before);
    expect(readFileSync(file)).toEqual(bytes);
    expect(new Desk({ file, key }).snapshot()).toEqual(before);
  });

  it('does not write replacement B after a stale-session refusal and refreshed admission when A and B revisions collide', () => {
    const a = fixture(), b = fixture();
    const opening = a.desk.snapshot(), before = b.desk.snapshot(), bytes = readFileSync(b.file);
    expect(opening.revision).toBe(before.revision);
    const request = { method: 'PATCH', url: '/api/desk/agency', headers: {
      host: '127.0.0.1:8799', 'x-realbud-session': 'fictional-stale-per-boot-token',
    } } as unknown as IncomingMessage;
    expect(sessionOk(request, 8799)).toEqual({ ok: false, status: 401, error: 'session required' });
    request.headers['x-realbud-session'] = SESSION_TOKEN;
    expect(sessionOk(request, 8799)).toEqual({ ok: true });
    const originalBody = { expectedWorkspaceId: 'fictional-workspace-a', expectedRevision: opening.revision, name: 'Fictional A typing' };
    expect(() => patchDeskAgencyForWorkspace(b.desk, 'fictional-workspace-b', originalBody)).toThrow(expect.objectContaining({ status: 409 }));
    expect(b.desk.snapshot()).toEqual(before);
    expect(readFileSync(b.file)).toEqual(bytes);
    expect(new Desk({ file: b.file, key }).snapshot()).toEqual(before);
  });

  it('saves the checked target, returns authoritative response metadata and persists only book data', () => {
    const { desk, file } = fixture(), before = desk.snapshot();
    const saved = patchDeskAgencyForWorkspace(desk, 'fictional-workspace', {
      expectedWorkspaceId: 'fictional-workspace', expectedRevision: before.revision,
      name: 'Fictional reviewed office', office: { pmUser: 'Fictional contact' },
    });
    expect(saved).toMatchObject({ workspaceId: 'fictional-workspace', revision: before.revision + 1,
      book: { agency: { name: 'Fictional reviewed office' }, office: { pmUser: 'Fictional contact' } } });
    const store = new DeskStore({ file, key, book: { properties: [], ledger: [] } });
    expect(store.data).not.toHaveProperty('workspaceId');
    expect(store.v3).not.toHaveProperty('workspaceId');
    const reopened = new Desk({ file, key }).snapshot();
    expect(reopened).not.toHaveProperty('workspaceId');
    const { workspaceId: _metadata, ...bookSnapshot } = saved;
    expect(reopened).toEqual(bookSnapshot);
  });

  it('preserves revision CAS on the correct physical workspace', () => {
    const { desk, file } = fixture(), opening = desk.snapshot();
    patchDeskAgencyForWorkspace(desk, 'fictional-workspace', {
      expectedWorkspaceId: 'fictional-workspace', expectedRevision: opening.revision, name: 'Fictional saved office',
    });
    const current = desk.snapshot(), bytes = readFileSync(file);
    expect(() => patchDeskAgencyForWorkspace(desk, 'fictional-workspace', {
      expectedWorkspaceId: 'fictional-workspace', expectedRevision: opening.revision, name: 'Fictional stale overwrite',
    })).toThrow(expect.objectContaining({ status: 409, code: 'revision-conflict' }));
    expect(desk.snapshot()).toEqual(current);
    expect(readFileSync(file)).toEqual(bytes);
  });

  it('tags repeated reads without mutating the snapshot, encrypted bytes or persisted revision', () => {
    const { desk, file } = fixture(), before = desk.snapshot(), bytes = readFileSync(file);
    const tagged = deskSnapshotForWorkspace(before, 'fictional-private-workspace');
    expect(tagged.workspaceId).toBe('fictional-private-workspace');
    expect(before).not.toHaveProperty('workspaceId');
    expect(deskSnapshotForWorkspace(desk.snapshot(), 'fictional-private-workspace')).toEqual(tagged);
    expect(desk.snapshot()).toEqual(before);
    expect(readFileSync(file)).toEqual(bytes);
  });
});

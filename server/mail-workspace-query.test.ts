import { describe, expect, it } from 'vitest';
import { mailWorkspaceQuery } from './mail-workspace-query.ts';

describe('private mail HTTP query admission', () => {
  it('keeps Unicode search and admits only bounded page fields', () => {
    expect(mailWorkspaceQuery(new URLSearchParams({ group: 'waiting', q: '租金 café', limit: '20', cursor: 'abc_DEF-123' }), 'tasks'))
      .toEqual({ group: 'waiting', q: '租金 café', limit: 20, cursor: 'abc_DEF-123' });
    expect(mailWorkspaceQuery(new URLSearchParams(), 'tasks')).toEqual({});
    expect(mailWorkspaceQuery(new URLSearchParams('limit=100'), 'scans')).toEqual({ limit: 100 });
  });
  it.each(['limit=0', 'limit=101', 'limit=2.5', 'limit=1e2', 'limit=20&limit=30', 'group=waiting&group=done',
    'group=urgent', 'accountId=another-account', 'q=%00', `q=${'x'.repeat(201)}`, 'cursor=', 'cursor=bad%3D', 'cursor=a&cursor=b'])
  ('rejects unsupported, duplicate or oversized task fields: %s', query => {
    expect(() => mailWorkspaceQuery(new URLSearchParams(query), 'tasks')).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('rejects filter fields on history and every query on exact reads or mutations', () => {
    expect(() => mailWorkspaceQuery(new URLSearchParams('group=all'), 'scans')).toThrow(expect.objectContaining({ status: 400 }));
    for (const query of ['limit=1', 'cursor=abc', 'q=source', 'group=all']) {
      expect(() => mailWorkspaceQuery(new URLSearchParams(query))).toThrow(expect.objectContaining({ status: 400 }));
    }
  });
});

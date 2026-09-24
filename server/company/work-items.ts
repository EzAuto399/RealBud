import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type {
  CloseSharedWorkInput,
  RespondToSharedWorkInput,
  SharedWorkItem,
  SharedWorkPerson,
  SharedWorkPurpose,
  SharedWorkState,
  ShareWorkInput,
  AcceptSharedWorkInput, ReassignSharedWorkInput, SharedWorkEvidence, SharedWorkActivity,
} from '../../shared/company-work.ts';
import { CompanyError, type CompanyActor, type CompanyScope, type ScopeKind, type ScopePermission } from './types.ts';

const S = 'realbud_company';
const KEY = 'realbud-work-item:v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSES = new Set<SharedWorkPurpose>(['share-result', 'request-review', 'handoff']);
const STATES = new Set<SharedWorkState>(['open', 'accepted', 'responded', 'closed']);

export type WorkItemDeps = {
  authenticated: <T>(sessionToken: string, fn: (client: PoolClient, actor: CompanyActor) => Promise<T>) => Promise<T>;
  authorizedScope: (client: PoolClient, actor: CompanyActor, scopeId: string, permission: ScopePermission) => Promise<CompanyScope>;
  newScope: (client: PoolClient, actor: Pick<CompanyActor, 'companyId' | 'memberId'>, kind: ScopeKind, name: string) => Promise<CompanyScope>;
};

type Stored = {
  title: string;
  summary: string;
  purpose: SharedWorkPurpose;
  state: SharedWorkState;
  assigneeMemberId: string | null;
  recipientMemberIds: string[];
  response: string;
  evidence: SharedWorkEvidence | null;
  acceptedMemberId: string | null;
  action: SharedWorkActivity['action'];
};

type Share = {
  requestId: string;
  title: string;
  summary: string;
  purpose: SharedWorkPurpose;
  recipients: string[];
  assigneeMemberId: string | null;
  evidence: SharedWorkEvidence | null;
};

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new CompanyError('invalid_input');
  return value.toLowerCase();
}

function revision(value: unknown): string {
  // pg BIGINT and JSON round-trips may arrive as a number or bigint. The pager
  // must accept the cursor it just returned.
  const text = typeof value === 'bigint' || typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^(0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text) > 9_223_372_036_854_775_807n) {
    throw new CompanyError('invalid_input');
  }
  return text;
}

function bounded(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new CompanyError('invalid_input');
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || value.length > max) throw new CompanyError('invalid_input');
  return value;
}

function reply(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > 4000 || !value.trim()) throw new CompanyError('invalid_input');
  return value;
}

function pgConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '23505');
}

function iso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  throw new CompanyError('invalid_input');
}

function parsePayload(content: string): Stored {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new CompanyError('invalid_input'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CompanyError('invalid_input');
  const o = raw as Record<string, unknown>;
  const legacyKeys = 'assigneeMemberId,purpose,recipientMemberIds,response,state,summary,title';
  const modernKeys = 'acceptedMemberId,action,assigneeMemberId,evidence,purpose,recipientMemberIds,response,state,summary,title';
  const keys = Object.keys(o).sort().join(',');
  if (keys !== legacyKeys && keys !== modernKeys) {
    throw new CompanyError('invalid_input');
  }
  if (!PURPOSES.has(o.purpose as SharedWorkPurpose) || !STATES.has(o.state as SharedWorkState)) throw new CompanyError('invalid_input');
  if (o.assigneeMemberId !== null && typeof o.assigneeMemberId !== 'string') throw new CompanyError('invalid_input');
  if (!Array.isArray(o.recipientMemberIds) || o.recipientMemberIds.length < 1 || o.recipientMemberIds.length > 10) {
    throw new CompanyError('invalid_input');
  }
  if (o.recipientMemberIds.some(id => typeof id !== 'string')) throw new CompanyError('invalid_input');
  const recipientMemberIds = [...new Set(o.recipientMemberIds.map(uuid))].sort();
  if (recipientMemberIds.length !== o.recipientMemberIds.length) throw new CompanyError('invalid_input');
  if (typeof o.response !== 'string' || o.response.includes('\0') || o.response.length > 4000) throw new CompanyError('invalid_input');
  const assigneeMemberId = o.assigneeMemberId === null ? null : uuid(o.assigneeMemberId);
  if (assigneeMemberId && !recipientMemberIds.includes(assigneeMemberId)) throw new CompanyError('invalid_input');
  if (o.purpose !== 'share-result' && !assigneeMemberId) throw new CompanyError('invalid_input');
  const acceptedMemberId = keys === legacyKeys || o.acceptedMemberId === null ? null : uuid(o.acceptedMemberId);
  if (acceptedMemberId && acceptedMemberId !== assigneeMemberId) throw new CompanyError('invalid_input');
  if (o.state === 'accepted' && !acceptedMemberId) throw new CompanyError('invalid_input');
  const action = keys === legacyKeys ? (o.state === 'closed' ? 'closed' : o.state === 'responded' ? 'responded' : 'shared') : o.action;
  if (!['shared', 'accepted', 'reassigned', 'responded', 'closed'].includes(String(action))) throw new CompanyError('invalid_input');
  return {
    title: bounded(o.title, 1, 160),
    summary: bounded(o.summary, 1, 4000),
    purpose: o.purpose as SharedWorkPurpose,
    state: o.state as SharedWorkState,
    assigneeMemberId,
    recipientMemberIds,
    response: o.response,
    evidence: normalizeEvidence(o.evidence),
    acceptedMemberId,
    action: action as SharedWorkActivity['action'],
  };
}

function storedPayload(content: string): Stored {
  try { return parsePayload(content); } catch { throw new CompanyError('recovery_required'); }
}

function encode(payload: Stored): string {
  return JSON.stringify({
    title: payload.title,
    summary: payload.summary,
    purpose: payload.purpose,
    state: payload.state,
    assigneeMemberId: payload.assigneeMemberId,
    recipientMemberIds: payload.recipientMemberIds,
    response: payload.response,
    evidence: payload.evidence,
    acceptedMemberId: payload.acceptedMemberId,
    action: payload.action,
  });
}

function normalizeEvidence(value: unknown): SharedWorkEvidence | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'label,sourceRef,sourceVersion,text') throw new CompanyError('invalid_input');
  const item = value as Record<string, unknown>;
  return { label: bounded(item.label, 1, 160), sourceRef: bounded(item.sourceRef, 1, 500),
    sourceVersion: bounded(item.sourceVersion, 1, 120), text: bounded(item.text, 1, 8000) };
}

export function normalizeShare(input: ShareWorkInput, actorId: string): Share {
  if (!input || typeof input !== 'object') throw new CompanyError('invalid_input');
  if (!PURPOSES.has(input.purpose)) throw new CompanyError('invalid_input');
  if (!Array.isArray(input.recipientMemberIds) || input.recipientMemberIds.length < 1 || input.recipientMemberIds.length > 10) {
    throw new CompanyError('invalid_input');
  }
  const recipients = [...new Set(input.recipientMemberIds.map(uuid))].sort();
  if (recipients.length !== input.recipientMemberIds.length || recipients.includes(actorId)) throw new CompanyError('invalid_input');
  const assigneeMemberId = input.assigneeMemberId == null ? null : uuid(input.assigneeMemberId);
  if (assigneeMemberId ? !recipients.includes(assigneeMemberId) : input.purpose !== 'share-result') throw new CompanyError('invalid_input');
  return {
    requestId: uuid(input.requestId),
    title: bounded(input.title, 1, 160),
    summary: bounded(input.summary, 1, 4000),
    purpose: input.purpose,
    recipients,
    assigneeMemberId,
    evidence: normalizeEvidence(input.evidence),
  };
}

function sameOriginal(payload: Stored, input: Share): boolean {
  return payload.title === input.title && payload.summary === input.summary && payload.purpose === input.purpose
    && payload.assigneeMemberId === input.assigneeMemberId
    && payload.recipientMemberIds.length === input.recipients.length
    && payload.recipientMemberIds.every((id, i) => id === input.recipients[i])
    && JSON.stringify(payload.evidence) === JSON.stringify(input.evidence);
}

export function createWorkItemApi(deps: WorkItemDeps) {
  async function peopleById(client: PoolClient, companyId: string, ids: string[]): Promise<Map<string, SharedWorkPerson>> {
    const unique = [...new Set(ids.filter(id => UUID.test(id)))];
    if (!unique.length) return new Map();
    const found = await client.query(`SELECT id, display_name FROM ${S}.members WHERE company_id=$1 AND id=ANY($2::uuid[])`, [companyId, unique]);
    return new Map(found.rows.map(row => [String(row.id), { id: String(row.id), displayName: String(row.display_name) }]));
  }

  async function audienceOf(client: PoolClient, companyId: string, scopeId: string, ownerId: string): Promise<SharedWorkPerson[]> {
    const found = await client.query(
      `SELECT m.id, m.display_name FROM ${S}.members m
       WHERE m.company_id=$1 AND m.active AND (m.id=$2 OR EXISTS (
         SELECT 1 FROM ${S}.scope_grants g WHERE g.company_id=$1 AND g.scope_id=$3 AND g.member_id=m.id
       )) ORDER BY m.display_name, m.id`,
      [companyId, ownerId, scopeId],
    );
    return found.rows.map(row => ({ id: String(row.id), displayName: String(row.display_name) }));
  }

  async function present(
    client: PoolClient,
    actor: CompanyActor,
    row: { caseId: string; scopeId: string; ownerMemberId: string; revision: unknown; authorMemberId: string; createdAt: unknown },
    payload: Stored,
  ): Promise<SharedWorkItem> {
    const audience = await audienceOf(client, actor.companyId, row.scopeId, row.ownerMemberId);
    const people = await peopleById(client, actor.companyId, [row.ownerMemberId, row.authorMemberId, payload.assigneeMemberId ?? '']);
    const owner = people.get(row.ownerMemberId);
    const updatedBy = people.get(row.authorMemberId);
    if (!owner || !updatedBy) throw new CompanyError('invalid_input');
    const ownerAvailable = audience.some(person => person.id === row.ownerMemberId);
    let canWrite = row.ownerMemberId === actor.memberId;
    if (payload.state !== 'closed' && row.ownerMemberId !== actor.memberId) {
      try {
        await deps.authorizedScope(client, actor, row.scopeId, 'write');
        canWrite = true;
      } catch (error) {
        if (!(error instanceof CompanyError) || error.code !== 'forbidden') throw error;
      }
    }
    const isAssignee = payload.assigneeMemberId === actor.memberId;
    const canManage = canWrite && (row.ownerMemberId === actor.memberId || (!ownerAvailable && isAssignee));
    const canRespond = canWrite && payload.state !== 'closed' && row.ownerMemberId !== actor.memberId &&
      (!payload.assigneeMemberId || isAssignee) &&
      (payload.purpose !== 'handoff' || (isAssignee && payload.acceptedMemberId === actor.memberId));
    return {
      id: row.caseId,
      scopeId: row.scopeId,
      revision: String(row.revision),
      title: payload.title,
      summary: payload.summary,
      purpose: payload.purpose,
      state: payload.state,
      owner,
      assignee: payload.assigneeMemberId ? people.get(payload.assigneeMemberId) ?? null : null,
      audience,
      response: payload.response,
      updatedBy,
      updatedAt: iso(row.createdAt),
      evidence: payload.evidence ? { ...payload.evidence, sha256: createHash('sha256').update(JSON.stringify(payload.evidence)).digest('hex') } : null,
      acceptedBy: payload.acceptedMemberId ? people.get(payload.acceptedMemberId) ?? null : null,
      ownerAvailable,
      actions: { respond: canRespond, close: payload.state !== 'closed' && canManage,
        accept: canWrite && isAssignee && payload.state === 'open' && !payload.acceptedMemberId,
        reassign: canManage && payload.state !== 'closed' && payload.purpose !== 'share-result',
        addRecipient: row.ownerMemberId === actor.memberId && payload.state !== 'closed' },
    };
  }

  function fromHead(caseId: string, scope: CompanyScope, head: Record<string, unknown>) {
    return {
      caseId,
      scopeId: scope.id,
      ownerMemberId: scope.ownerMemberId,
      revision: head.revision,
      authorMemberId: String(head.author_member_id),
      createdAt: head.created_at,
    };
  }

  async function writeRevision(client: PoolClient, actor: CompanyActor, scopeId: string, next: string, payload: Stored) {
    try {
      const saved = await client.query(
        `INSERT INTO ${S}.knowledge_revisions(company_id,scope_id,key,revision,content,source_refs,author_member_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [actor.companyId, scopeId, KEY, next, encode(payload), JSON.stringify([]), actor.memberId],
      );
      return saved.rows[0] as Record<string, unknown>;
    } catch (error) {
      if (pgConflict(error)) throw new CompanyError('conflict');
      throw error;
    }
  }

  async function loadWork(client: PoolClient, actor: CompanyActor, caseId: string, permission: ScopePermission) {
    const found = await client.query(`SELECT id, scope_id FROM ${S}.cases WHERE company_id=$1 AND id=$2`, [actor.companyId, uuid(caseId)]);
    if (!found.rows[0]) throw new CompanyError('not_found');
    const scope = await deps.authorizedScope(client, actor, String(found.rows[0].scope_id), permission);
    const head = await client.query(
      `SELECT * FROM ${S}.knowledge_revisions WHERE company_id=$1 AND scope_id=$2 AND key=$3 ORDER BY revision DESC LIMIT 1`,
      [actor.companyId, scope.id, KEY],
    );
    if (!head.rows[0]) throw new CompanyError('not_found');
    return { caseId: String(found.rows[0].id), scope, head: head.rows[0] as Record<string, unknown>, payload: storedPayload(String(head.rows[0].content)) };
  }

  return {
    listWorkMembers(sessionToken: string): Promise<SharedWorkPerson[]> {
      return deps.authenticated(sessionToken, async (client, actor) => {
        const found = await client.query(
          `SELECT id, display_name FROM ${S}.members WHERE company_id=$1 AND active ORDER BY display_name, id LIMIT 100`,
          [actor.companyId],
        );
        return found.rows.map(row => ({ id: String(row.id), displayName: String(row.display_name) }));
      });
    },

    listSharedWork(sessionToken: string, query: { offset?: number; filter?: 'with-me' | 'by-me' } = {}): Promise<SharedWorkItem[]> {
      return deps.authenticated(sessionToken, async (client, actor) => {
        const offset = query.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000 ||
            (query.filter !== undefined && !['with-me', 'by-me'].includes(query.filter))) throw new CompanyError('invalid_input');
        const found = await client.query(
          `SELECT c.id, c.scope_id, s.owner_member_id, k.revision, k.content, k.author_member_id, k.created_at
           FROM ${S}.cases c
           JOIN ${S}.scopes s ON s.company_id=c.company_id AND s.id=c.scope_id
           JOIN LATERAL (
             SELECT revision, content, author_member_id, created_at FROM ${S}.knowledge_revisions
             WHERE company_id=c.company_id AND scope_id=c.scope_id AND key=$2
             ORDER BY revision DESC LIMIT 1
           ) k ON true
           WHERE c.company_id=$1 AND ($3::text IS NULL OR
             ($3='by-me' AND s.owner_member_id=$4) OR ($3='with-me' AND s.owner_member_id<>$4))
           ORDER BY k.created_at DESC, c.id
           LIMIT 10 OFFSET $5`,
          [actor.companyId, KEY, query.filter ?? null, actor.memberId, offset],
        );
        const items: SharedWorkItem[] = [];
        for (const row of [...found.rows].sort((a, b) => String(a.scope_id).localeCompare(String(b.scope_id)))) {
          // Scope locks serialize this read with grants; use one global order to
          // avoid cross-reader deadlocks when update times change concurrently.
          await deps.authorizedScope(client, actor, String(row.scope_id), 'read');
          try {
            items.push(await present(client, actor, {
              caseId: String(row.id),
              scopeId: String(row.scope_id),
              ownerMemberId: String(row.owner_member_id),
              revision: row.revision,
              authorMemberId: String(row.author_member_id),
              createdAt: row.created_at,
            }, parsePayload(String(row.content))));
          } catch (error) {
            if (error instanceof CompanyError) throw new CompanyError('recovery_required');
            throw error;
          }
        }
        return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      });
    },

    shareWork(sessionToken: string, input: ShareWorkInput): Promise<SharedWorkItem> {
      return deps.authenticated(sessionToken, async (client, actor) => {
        const share = normalizeShare(input, actor.memberId);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`work-item:${actor.companyId}:${share.requestId}`]);
        const existing = await client.query(`SELECT id, scope_id FROM ${S}.cases WHERE company_id=$1 AND id=$2`, [actor.companyId, share.requestId]);
        if (existing.rows[0]) {
          let scope: CompanyScope;
          try {
            scope = await deps.authorizedScope(client, actor, String(existing.rows[0].scope_id), 'write');
          } catch (error) {
            if (error instanceof CompanyError) throw new CompanyError('conflict');
            throw error;
          }
          if (scope.ownerMemberId !== actor.memberId) throw new CompanyError('conflict');
          const head = await client.query(
            `SELECT * FROM ${S}.knowledge_revisions WHERE company_id=$1 AND scope_id=$2 AND key=$3 ORDER BY revision DESC LIMIT 1`,
            [actor.companyId, scope.id, KEY],
          );
          if (!head.rows[0]) throw new CompanyError('conflict');
          let payload: Stored;
          try { payload = storedPayload(String(head.rows[0].content)); }
          catch (error) {
            if (error instanceof CompanyError) throw new CompanyError('recovery_required');
            throw error;
          }
          // A reassignment changes the current assignee/audience, never the
          // identity of the original request. Lost creation replies remain safe.
          const original = await client.query(`SELECT content FROM ${S}.knowledge_revisions
            WHERE company_id=$1 AND scope_id=$2 AND key=$3 AND revision=1`, [actor.companyId, scope.id, KEY]);
          if (!original.rows[0] || !sameOriginal(storedPayload(String(original.rows[0].content)), share)) throw new CompanyError('conflict');
          return present(client, actor, fromHead(share.requestId, scope, head.rows[0] as Record<string, unknown>), payload);
        }
        const locked = await client.query(
          `SELECT id FROM ${S}.members WHERE company_id=$1 AND id=ANY($2::uuid[]) AND active ORDER BY id FOR SHARE`,
          [actor.companyId, share.recipients],
        );
        if (locked.rowCount !== share.recipients.length) throw new CompanyError('not_found');
        const scope = await deps.newScope(client, actor, 'team', share.title.slice(0, 120));
        await deps.authorizedScope(client, actor, scope.id, 'write');
        for (const memberId of share.recipients) {
          await client.query(
            `INSERT INTO ${S}.scope_grants(company_id,scope_id,member_id,permission) VALUES($1,$2,$3,'write')`,
            [actor.companyId, scope.id, memberId],
          );
        }
        try {
          await client.query(`INSERT INTO ${S}.cases(company_id,id,scope_id,title) VALUES($1,$2,$3,$4)`, [actor.companyId, share.requestId, scope.id, share.title]);
        } catch (error) {
          if (pgConflict(error)) throw new CompanyError('conflict');
          throw error;
        }
        const payload: Stored = {
          title: share.title,
          summary: share.summary,
          purpose: share.purpose,
          state: 'open',
          assigneeMemberId: share.assigneeMemberId,
          recipientMemberIds: share.recipients,
          response: '',
          evidence: share.evidence,
          acceptedMemberId: null,
          action: 'shared',
        };
        const saved = await writeRevision(client, actor, scope.id, '1', payload);
        return present(client, actor, fromHead(share.requestId, scope, saved), payload);
      });
    },

    acceptSharedWork(sessionToken: string, input: AcceptSharedWorkInput): Promise<SharedWorkItem> {
      const id = uuid(input?.id), expectedRevision = revision(input?.expectedRevision);
      return deps.authenticated(sessionToken, async (client, actor) => {
        const work = await loadWork(client, actor, id, 'write');
        if (work.payload.assigneeMemberId !== actor.memberId) throw new CompanyError('forbidden');
        if (work.payload.state !== 'open' || work.payload.acceptedMemberId || String(work.head.revision) !== expectedRevision) throw new CompanyError('conflict');
        const payload: Stored = { ...work.payload, state: 'accepted', acceptedMemberId: actor.memberId, action: 'accepted' };
        const saved = await writeRevision(client, actor, work.scope.id, (BigInt(expectedRevision) + 1n).toString(), payload);
        return present(client, actor, fromHead(work.caseId, work.scope, saved), payload);
      });
    },

    reassignSharedWork(sessionToken: string, input: ReassignSharedWorkInput): Promise<SharedWorkItem> {
      const id = uuid(input?.id), expectedRevision = revision(input?.expectedRevision), assigneeId = uuid(input?.assigneeMemberId);
      return deps.authenticated(sessionToken, async (client, actor) => {
        const work = await loadWork(client, actor, id, 'write');
        const current = await present(client, actor, fromHead(work.caseId, work.scope, work.head), work.payload);
        if (!current.actions.reassign) throw new CompanyError('forbidden');
        if (String(work.head.revision) !== expectedRevision) throw new CompanyError('conflict');
        if (assigneeId === work.scope.ownerMemberId || assigneeId === work.payload.assigneeMemberId) throw new CompanyError('invalid_input');
        // Locking the target member serializes assignment with removal, without
        // granting an absent colleague access or restoring a revoked member.
        const target = await client.query(`SELECT id FROM ${S}.members WHERE company_id=$1 AND id=$2 AND active FOR SHARE`, [actor.companyId, assigneeId]);
        if (!target.rowCount) throw new CompanyError('not_found');
        const access = await client.query(`SELECT 1 FROM ${S}.scope_grants WHERE company_id=$1 AND scope_id=$2 AND member_id=$3 AND permission='write'`, [actor.companyId, work.scope.id, assigneeId]);
        if (!access.rowCount) {
          if (!current.actions.addRecipient) throw new CompanyError('forbidden');
          await client.query(`INSERT INTO ${S}.scope_grants(company_id,scope_id,member_id,permission) VALUES($1,$2,$3,'write')
            ON CONFLICT DO NOTHING`, [actor.companyId, work.scope.id, assigneeId]);
          await client.query(`UPDATE ${S}.scopes SET revision=revision+1 WHERE company_id=$1 AND id=$2`, [actor.companyId, work.scope.id]);
        }
        const recipients = [...new Set([...work.payload.recipientMemberIds, assigneeId])].sort();
        if (recipients.length > 10) throw new CompanyError('invalid_input');
        const payload: Stored = { ...work.payload, assigneeMemberId: assigneeId, recipientMemberIds: recipients,
          acceptedMemberId: null, state: 'open', response: '', action: 'reassigned' };
        const saved = await writeRevision(client, actor, work.scope.id, (BigInt(expectedRevision) + 1n).toString(), payload);
        return present(client, actor, fromHead(work.caseId, work.scope, saved), payload);
      });
    },

    async sharedWorkHistory(sessionToken: string, input: { id: string; beforeRevision?: string | number }): Promise<{ events: SharedWorkActivity[]; hasMore: boolean }> {
      const id = uuid(input?.id);
      const before = input?.beforeRevision === undefined ? null : revision(input.beforeRevision);
      return deps.authenticated(sessionToken, async (client, actor) => {
        const work = await loadWork(client, actor, id, 'read');
        const rows = await client.query(`SELECT revision,content,author_member_id,created_at FROM ${S}.knowledge_revisions
          WHERE company_id=$1 AND scope_id=$2 AND key=$3 AND ($4::bigint IS NULL OR revision<$4)
          ORDER BY revision DESC LIMIT 21`, [actor.companyId, work.scope.id, KEY, before]);
        const records = rows.rows.slice(0, 20).map(row => ({ row, payload: storedPayload(String(row.content)) }));
        const people = await peopleById(client, actor.companyId, records.flatMap(({ row, payload }) => [String(row.author_member_id), payload.assigneeMemberId ?? '']));
        return { hasMore: rows.rows.length > 20, events: records.map(({ row, payload }) => {
          const author = people.get(String(row.author_member_id));
          if (!author) throw new CompanyError('recovery_required');
          return { revision: revision(row.revision), action: payload.action, actor: author, at: iso(row.created_at),
            assignee: payload.assigneeMemberId ? people.get(payload.assigneeMemberId) ?? null : null, response: payload.response };
        }) };
      });
    },

    respondToSharedWork(sessionToken: string, input: RespondToSharedWorkInput): Promise<SharedWorkItem> {
      const id = uuid(input?.id);
      const expectedRevision = revision(input?.expectedRevision);
      const response = reply(input?.response);
      return deps.authenticated(sessionToken, async (client, actor) => {
        const work = await loadWork(client, actor, id, 'write');
        if (work.scope.ownerMemberId === actor.memberId) throw new CompanyError('forbidden');
        if (work.payload.assigneeMemberId && work.payload.assigneeMemberId !== actor.memberId) throw new CompanyError('forbidden');
        if (work.payload.purpose === 'handoff' && (work.payload.assigneeMemberId !== actor.memberId || work.payload.acceptedMemberId !== actor.memberId)) throw new CompanyError('forbidden');
        if (work.payload.state === 'closed' || String(work.head.revision) !== expectedRevision) throw new CompanyError('conflict');
        const payload: Stored = { ...work.payload, state: 'responded', response, action: 'responded' };
        const saved = await writeRevision(client, actor, work.scope.id, (BigInt(expectedRevision) + 1n).toString(), payload);
        return present(client, actor, fromHead(work.caseId, work.scope, saved), payload);
      });
    },

    closeSharedWork(sessionToken: string, input: CloseSharedWorkInput): Promise<SharedWorkItem> {
      const id = uuid(input?.id);
      const expectedRevision = revision(input?.expectedRevision);
      return deps.authenticated(sessionToken, async (client, actor) => {
        const work = await loadWork(client, actor, id, 'write');
        const current = await present(client, actor, fromHead(work.caseId, work.scope, work.head), work.payload);
        if (!current.actions.close) {
          if (work.scope.ownerMemberId === actor.memberId && work.payload.state === 'closed') throw new CompanyError('conflict');
          throw new CompanyError('forbidden');
        }
        if (work.payload.state === 'closed' || String(work.head.revision) !== expectedRevision) throw new CompanyError('conflict');
        const payload: Stored = { ...work.payload, state: 'closed', action: 'closed' };
        const saved = await writeRevision(client, actor, work.scope.id, (BigInt(expectedRevision) + 1n).toString(), payload);
        return present(client, actor, fromHead(work.caseId, work.scope, saved), payload);
      });
    },
  };
}

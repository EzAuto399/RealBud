// Approval settings store and who may change them.
// - Single desktop: DATA_DIR/approval-settings.json (private JSON) with a
//   revision and up to 500 receipts. The person on this computer owns it.
// - In an office: each department's append-only company record
//   (`realbud-approval-settings:v1`); the company host decides who may read
//   and edit it (SQL scope_allowed). This desktop keeps a verified copy of the
//   departments that govern its member; widenings in that copy lapse after
//   12 h without a refresh.
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { readPrivateJson, trimOldestToBytes, writePrivateJson } from './private-json.ts';
import { defaultApprovalSettings, normalizeApprovalSettings, type ApprovalSettings } from '../shared/approval-settings.ts';

type Request = Pick<IncomingMessage, 'headers'>;
type Reply = { status: number; body: unknown };
export interface ApprovalReceipt { at: string; by: string; department: null; before: ApprovalSettings; after: ApprovalSettings }
interface LocalFile { version: 1; revision: number; settings: ApprovalSettings; receipts: ApprovalReceipt[] }
export interface DepartmentApprovals { id: string; name: string; canEdit: boolean; governs: boolean; revision: string; settings: ApprovalSettings }
interface OfficeCopy { version: 1; memberId: string; refreshedAt: number; departments: DepartmentApprovals[] }
interface Verified { member: { id: string; displayName: string; role: 'owner' | 'member' }; departments: DepartmentApprovals[] }
export type ApprovalEditor = { ok: true; verified: Verified | null } | { ok: false; status: number; error: string };

const MAX_BYTES = 4_200_000, RECEIPTS = 500, RECEIPT_BYTES = 4_000_000, STALE_MS = 12 * 3_600_000;
export const SIGN_IN_TO_CHANGE = 'Sign in to your office to change approval settings.';
export const onlyEditors = (department: string) => `Only people who can edit ${department} can change approval settings.`;
const RECOVERY = 'The saved approval settings need recovery. Their original data has been kept.';
const CHANGED = 'Approval settings changed. Reload them and try again.';
const fail = (status: number, error: string): never => { throw Object.assign(new Error(error), { status }); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join(',') === keys;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function validateFile(value: unknown): LocalFile {
  try {
    if (!exact(value, 'receipts,revision,settings,version') || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      !Array.isArray(value.receipts) || value.receipts.length > RECEIPTS) throw new Error();
    const receipts = value.receipts.map((row: unknown): ApprovalReceipt => {
      if (!exact(row, 'after,at,before,by,department') || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || !text(row.by, 120) || row.department !== null) throw new Error();
      return { at: row.at, by: row.by, department: null, before: normalizeApprovalSettings(row.before), after: normalizeApprovalSettings(row.after) };
    });
    return { version: 1, revision: Number(value.revision), settings: normalizeApprovalSettings(value.settings), receipts };
  } catch { return fail(503, RECOVERY); }
}
function departments(value: unknown): DepartmentApprovals[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error();
  return value.map(row => {
    if (!exact(row, 'canEdit,governs,id,name,revision,settings') || !text(row.id, 64) || !text(row.name, 120) || typeof row.canEdit !== 'boolean' ||
      typeof row.governs !== 'boolean' || typeof row.revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(row.revision)) throw new Error();
    return { id: row.id, name: row.name, canEdit: row.canEdit, governs: row.governs, revision: row.revision, settings: normalizeApprovalSettings(row.settings) };
  });
}
function validateCopy(value: unknown): OfficeCopy {
  try {
    if (!exact(value, 'departments,memberId,refreshedAt,version') || value.version !== 1 || !text(value.memberId, 64) || !Number.isSafeInteger(value.refreshedAt)) throw new Error();
    return { version: 1, memberId: value.memberId, refreshedAt: Number(value.refreshedAt), departments: departments(value.departments) };
  } catch { return fail(503, RECOVERY); }
}
/** A stale copy keeps every Ask and Don't use but forgets what it widened. */
function lapsed(settings: ApprovalSettings): ApprovalSettings {
  return { ...settings, groups: Object.fromEntries(Object.entries(settings.groups).filter(([, choice]) => choice !== 'read-without-asking')), reviewedReads: [] };
}

export function createApprovalSettings(options: {
  dataDir: string;
  /** This private workspace's office member id, or null for a single desktop. */
  seatIdentity: () => Promise<string | null>;
  /** One company operation (local host or paired office) carrying this request's member session. */
  company: (path: string, request: Request, body: unknown) => Promise<Reply>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const file = join(options.dataDir, 'approval-settings.json');
  const copyFile = join(options.dataDir, 'approval-settings-office.json');
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const load = async (): Promise<LocalFile> => {
    let raw: unknown;
    try { raw = await readPrivateJson(file, MAX_BYTES); } catch { return fail(503, RECOVERY); }
    return raw === undefined ? { version: 1, revision: 0, settings: defaultApprovalSettings(), receipts: [] } : validateFile(raw);
  };
  const loadCopy = async (): Promise<OfficeCopy | undefined> => {
    let raw: unknown;
    try { raw = await readPrivateJson(copyFile, MAX_BYTES); } catch { return fail(503, RECOVERY); }
    return raw === undefined ? undefined : validateCopy(raw);
  };

  /** The member's departments as the office states them now, or null when this
   * request cannot prove it is this computer's member. Refreshes the copy. */
  async function verify(request: Request, seat: string): Promise<Verified | null> {
    const reply = await options.company('/api/company/approvals/mine', request, {}).catch(() => null);
    if (reply?.status !== 200 || !exact(reply.body, 'departments,member')) return null;
    const member = reply.body.member;
    let verified: Verified;
    try {
      if (!exact(member, 'displayName,id,role') || member.id !== seat || !text(member.displayName, 120) || (member.role !== 'owner' && member.role !== 'member')) return null;
      verified = { member: { id: member.id, displayName: member.displayName, role: member.role }, departments: departments(reply.body.departments) };
    } catch { return null; }
    // The office answered across a host boundary: the seat must still be the same member.
    if (await options.seatIdentity() !== seat) return null;
    await serial(() => writePrivateJson(copyFile, { version: 1, memberId: seat, refreshedAt: now(), departments: verified.departments } satisfies OfficeCopy,
      { maxBytes: MAX_BYTES, validate: validateCopy }));
    return verified;
  }

  /** Who may change approval settings, saved site rules and always-allow grants
   * on this computer: a single desktop's person; in an office, a signed-in
   * member who can edit every department that governs them. */
  async function editor(request: Request): Promise<ApprovalEditor> {
    try {
      const seat = await options.seatIdentity();
      if (seat === null) return { ok: true, verified: null };
      const verified = await verify(request, seat);
      if (!verified) return { ok: false, status: 403, error: SIGN_IN_TO_CHANGE };
      const readOnly = verified.departments.find(department => department.governs && !department.canEdit);
      return readOnly ? { ok: false, status: 403, error: onlyEditors(readOnly.name) } : { ok: true, verified };
    } catch (error) {
      const status = (error as { status?: number }).status;
      return { ok: false, status: status === 503 ? 503 : 403, error: status === 503 ? RECOVERY : SIGN_IN_TO_CHANGE };
    }
  }

  async function saveLocal(request: Request, body: Record<string, unknown>, settings: ApprovalSettings): Promise<Reply> {
    const guard = await editor(request);
    if (!guard.ok) return { status: guard.status, body: { error: guard.error } };
    const expected = body.expectedRevision;
    if (!Number.isSafeInteger(expected) || Number(expected) < 0) return { status: 400, body: { error: 'Reload approval settings and try again.' } };
    return serial(async () => {
      const saved = await load();
      if (saved.revision !== expected) return { status: 409, body: { error: CHANGED } };
      if (guard.verified && guard.verified.member.role !== 'owner' && saved.settings.reviewedReads.join('\n') !== settings.reviewedReads.join('\n')) {
        return { status: 403, body: { error: 'Only the office owner can mark tools as reviewed.' } };
      }
      const receipt: ApprovalReceipt = { at: new Date(now()).toISOString(), by: guard.verified?.member.displayName ?? 'This computer', department: null, before: saved.settings, after: settings };
      // ponytail: newest 500 receipts within 4 MB; export older history first if it ever matters.
      const next: LocalFile = { version: 1, revision: saved.revision + 1, settings, receipts: trimOldestToBytes([...saved.receipts, receipt].slice(-RECEIPTS), RECEIPT_BYTES, () => true) };
      await writePrivateJson(file, next, { maxBytes: MAX_BYTES, validate: validateFile });
      return { status: 200, body: { revision: next.revision, settings } };
    });
  }

  async function saveDepartment(request: Request, body: Record<string, unknown>, settings: ApprovalSettings): Promise<Reply> {
    if (typeof body.departmentId !== 'string' || typeof body.expectedRevision !== 'string') return { status: 400, body: { error: 'Reload approval settings and try again.' } };
    const seat = await options.seatIdentity();
    if (seat === null) return { status: 400, body: { error: 'This computer is not in an office, so it has no departments.' } };
    const verified = await verify(request, seat);
    if (!verified) return { status: 403, body: { error: SIGN_IN_TO_CHANGE } };
    const department = verified.departments.find(row => row.id === body.departmentId);
    if (!department) return { status: 404, body: { error: 'That department is unavailable. Refresh and try again.' } };
    if (!department.canEdit) return { status: 403, body: { error: onlyEditors(department.name) } };
    const reply = await options.company('/api/company/approvals/save', request, { departmentId: department.id, expectedRevision: body.expectedRevision, settings })
      .catch(() => ({ status: 503, body: null }));
    // Saved: refreshing the local copy is best effort and never reports the save as failed.
    if (reply.status === 200) { await verify(request, seat).catch(() => null); return reply; }
    if (reply.status === 403) return { status: 403, body: { error: onlyEditors(department.name) } };
    if (reply.status === 409) return { status: 409, body: { error: CHANGED } };
    if (reply.status === 400) return { status: 400, body: { error: 'Check the approval settings and try again.' } };
    // A lost reply may hide a committed save.
    return { status: 503, body: { error: 'The office did not confirm this save. Reload approval settings to check before trying again.' } };
  }

  return {
    editor,

    /** The settings that govern this desktop for `decide`: one per department
     * that governs its member (strictest merge happens in `decide`), else this
     * computer's own. Throws when storage needs recovery; callers refuse. */
    async effective(): Promise<ApprovalSettings[]> {
      const seat = await options.seatIdentity();
      const local = (await load()).settings;
      if (seat === null) return [local];
      const copy = await loadCopy();
      const governing = copy?.memberId === seat ? copy.departments.filter(department => department.governs) : [];
      if (!copy || !governing.length) return [local];
      const age = now() - copy.refreshedAt;
      return governing.map(department => age >= 0 && age <= STALE_MS ? department.settings : lapsed(department.settings));
    },

    /** `/api/approvals` (GET, PUT) and `/api/approvals/history` (GET). */
    async handle(path: string, method: string, request: Request, query: URLSearchParams, body?: unknown): Promise<Reply> {
      try {
        if (path === '/api/approvals' && method === 'GET') {
          const saved = await load();
          const seat = await options.seatIdentity();
          if (seat === null) return { status: 200, body: { scope: 'computer', local: { revision: saved.revision, settings: saved.settings, canEdit: true }, departments: [] } };
          const verified = await verify(request, seat);
          if (!verified) return { status: 403, body: { error: 'Sign in to your office to see approval settings.' } };
          const canEdit = !verified.departments.some(department => department.governs && !department.canEdit);
          return { status: 200, body: { scope: 'office', local: { revision: saved.revision, settings: saved.settings, canEdit }, departments: verified.departments } };
        }
        if (path === '/api/approvals' && method === 'PUT') {
          if (!object(body) || Object.keys(body).some(key => !['departmentId', 'expectedRevision', 'settings'].includes(key))) return { status: 400, body: { error: 'Reload approval settings and try again.' } };
          let settings: ApprovalSettings;
          try { settings = normalizeApprovalSettings(body.settings); } catch (error) { return { status: 400, body: { error: (error as Error).message } }; }
          return await (body.departmentId === undefined || body.departmentId === null ? saveLocal(request, body, settings) : saveDepartment(request, body, settings));
        }
        if (path === '/api/approvals/history' && method === 'GET') {
          if ([...query.keys()].some(key => key !== 'departmentId') || query.getAll('departmentId').length > 1) return { status: 400, body: { error: 'Choose one department.' } };
          const departmentId = query.get('departmentId');
          if (!departmentId) return { status: 200, body: { entries: [...(await load()).receipts].reverse() } };
          const reply = await options.company('/api/company/approvals/history', request, { departmentId, limit: 10 }).catch(() => ({ status: 503, body: null }));
          if (reply.status === 200) return reply;
          return { status: reply.status === 401 ? 403 : reply.status >= 500 ? 503 : reply.status,
            body: { error: reply.status === 401 ? 'Sign in to your office to see approval settings.' : reply.status >= 500 ? 'The office could not be reached. Try again.' : 'That department is unavailable. Refresh and try again.' } };
        }
        return { status: 405, body: { error: 'Use the approval settings in Workspace.' } };
      } catch (error) {
        const status = (error as { status?: number }).status;
        return { status: status === 503 || status === 507 ? status : 503, body: { error: status === 503 || status === 507 ? (error as Error).message : RECOVERY } };
      }
    },
  };
}

import type { AssignDepartmentCaseInput, CloseDepartmentCaseInput, CreateDepartmentCaseInput, DepartmentLifecycleInput, RecoverDepartmentCaseInput } from './company-api.ts';

export type DepartmentOutboxOperation =
  | { path: '/api/company/departments/cases/create'; input: CreateDepartmentCaseInput }
  | { path: '/api/company/departments/cases/assign'; input: AssignDepartmentCaseInput }
  | { path: '/api/company/departments/cases/close'; input: CloseDepartmentCaseInput }
  | { path: '/api/company/departments/cases/recover'; input: RecoverDepartmentCaseInput }
  | { path: '/api/company/departments/lifecycle'; input: DepartmentLifecycleInput };
export type DepartmentOutboxPending = DepartmentOutboxOperation & { phase: 'pending' | 'confirmed' };
export interface DepartmentOutboxState { pending: DepartmentOutboxPending | null; otherOfficePending: boolean }
export const DEPARTMENT_OPERATION_PATHS = [
  '/api/company/departments/cases/create', '/api/company/departments/cases/assign',
  '/api/company/departments/cases/close', '/api/company/departments/cases/recover', '/api/company/departments/lifecycle',
] as const;

const invalid = (): never => { throw new Error('Check the department change fields.'); };
export function departmentRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return invalid();
  return value.toLowerCase();
}
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names.sort().join(',')) return invalid();
  if (Object.values(value).some(field => field !== null && (typeof field !== 'string' && typeof field !== 'boolean' || typeof field === 'string' && field.length > 4000))) return invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 24_000) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (!empty && !value.trim())) return invalid();
  return value.trim();
}
function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) return invalid();
  return value;
}

/** Declarative input validation only; the office still checks every permission,
 * assignment, current revision and lease at its transactional authority. */
export function normalizeDepartmentOperation(path: string, body: unknown): DepartmentOutboxOperation {
  if (path === '/api/company/departments/cases/create') {
    const value = fields(body, ['departmentId', 'requestId', 'title', 'description', 'assigneeMemberId']);
    return { path, input: { departmentId: departmentRequestId(value.departmentId), requestId: departmentRequestId(value.requestId),
      title: text(value.title, 240), description: text(value.description, 4000, true),
      assigneeMemberId: value.assigneeMemberId === null ? null : departmentRequestId(value.assigneeMemberId) } };
  }
  if (path === '/api/company/departments/lifecycle') {
    const value = fields(body, ['departmentId', 'requestId', 'expectedRevision', 'retired', 'note']);
    if (typeof value.retired !== 'boolean') return invalid();
    return { path, input: { departmentId: departmentRequestId(value.departmentId), requestId: departmentRequestId(value.requestId),
      expectedRevision: revision(value.expectedRevision), retired: value.retired, note: text(value.note, 2048) } };
  }
  if (path === '/api/company/departments/cases/assign') {
    const value = fields(body, ['departmentId', 'caseId', 'requestId', 'expectedFence', 'assigneeMemberId']);
    return { path, input: { departmentId: departmentRequestId(value.departmentId), caseId: departmentRequestId(value.caseId), requestId: departmentRequestId(value.requestId),
      expectedFence: revision(value.expectedFence), assigneeMemberId: value.assigneeMemberId === null ? null : departmentRequestId(value.assigneeMemberId) } };
  }
  if (path === '/api/company/departments/cases/close' || path === '/api/company/departments/cases/recover') {
    const value = fields(body, ['departmentId', 'caseId', 'requestId', 'expectedFence', 'resolution', 'note']);
    const input = { departmentId: departmentRequestId(value.departmentId), caseId: departmentRequestId(value.caseId), requestId: departmentRequestId(value.requestId),
      expectedFence: revision(value.expectedFence), note: text(value.note, 2048) };
    if (path === '/api/company/departments/cases/close' && (value.resolution === 'done' || value.resolution === 'cancelled')) return { path, input: { ...input, resolution: value.resolution } };
    if (path === '/api/company/departments/cases/recover' && (value.resolution === 'done' || value.resolution === 'released')) return { path, input: { ...input, resolution: value.resolution } };
  }
  return invalid();
}

export function departmentOperationTitle(operation: DepartmentOutboxOperation): string {
  switch (operation.path) {
    case '/api/company/departments/cases/create': return operation.input.title;
    case '/api/company/departments/cases/assign': return 'Assign department work';
    case '/api/company/departments/cases/close': return 'Close department work';
    case '/api/company/departments/cases/recover': return 'Resolve interrupted department work';
    case '/api/company/departments/lifecycle': return operation.input.retired ? 'Archive department' : 'Reopen department';
  }
}

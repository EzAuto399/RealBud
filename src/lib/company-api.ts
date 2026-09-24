import { api } from "@/state/store";
import type { CompanyInvitationResponse, CompanyManagement, CompanyMemberSummary, CompanySessionResponse, CompanyStatus, CompanySummary, CompanyWorkflowTemplate, CompanyWorkflowTemplateState } from "@shared/company-api";
import type { AcceptSharedWorkInput, CloseSharedWorkInput, ReassignSharedWorkInput, RespondToSharedWorkInput, ShareWorkInput } from "@shared/company-work";
import { parseSharedWorkHistory, parseSharedWorkItemResponse, parseSharedWorkList, parseWorkMembers } from "./company-work-response";
import type { CompanyDepartment, DepartmentAccess, DepartmentAccessPage, DepartmentPage, DepartmentCase, DepartmentCasePage, RecoverDepartmentCaseInput, CreateDepartmentCaseInput, AssignDepartmentCaseInput, CloseDepartmentCaseInput, DepartmentCaseMutation, DepartmentAssigneePage, DepartmentLifecycleInput, DepartmentLifecycleResult } from '@shared/company-api';

import { normalizeDepartmentOperation, type DepartmentOutboxOperation, type DepartmentOutboxState } from '@shared/company-department-outbox';

import type { CompanyPortalBinding, CompanyPortalBindingPage } from "@shared/company-portal";
import { isCompanyPortalBinding, isCompanyPortalBindingPage, isCompanyPortalOperation, type CompanyPortalOperation } from "./company-portal-code";

import { isCompanyExecutionReview, isCompanyExecutionGrant, isCompanyExecutionGrantPage, isConfirmCompanyExecution, isRevokeCompanyExecution, companyExecutionUuid, type CompanyExecutionGrant, type ConfirmCompanyExecution, type RevokeCompanyExecution } from '@shared/company-execution';
import { isDepartmentWorkPrepare, type DepartmentWorkPrepare, type DepartmentWorkCatalog, type DepartmentWorkState, type DepartmentWorkPage, type DepartmentWorkPrepared } from '@shared/department-work';
import { remoteExact } from '@shared/website-remote-approvers';
import { JOB_OUTPUT_MAX_CHARS, JOB_OUTPUT_TOTAL_CHARS } from '@shared/job-output';
import { canonicalWebsiteCommand } from '@shared/website-commands';

const STORAGE_KEY = "realbud.company-member-session";
type Request = (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<unknown>;
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Operation = "check" | "create" | "join" | "connect" | "recover" | "invite" | "logout" | "signin" | "credentials" | "setup" | "templates" | "work" | "host-recovery" | "department" | "portal-binding" | "department-work";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const credential = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._~-]{24,512}$/.test(value);
const company = (value: unknown): value is CompanySummary => object(value) && typeof value.id === "string" && !!value.id && typeof value.name === "string" && !!value.name;
const member = (value: unknown): value is CompanyMemberSummary => object(value) && typeof value.id === "string" && !!value.id && typeof value.displayName === "string" && !!value.displayName && ["owner", "member"].includes(String(value.role));
const incomplete = () => new Error("The company service returned an incomplete response. Check company status before trying again.");
const departmentAccess = (value: unknown): value is DepartmentAccess => value === 'none' || value === 'read' || value === 'write';
const department = (value: unknown): value is CompanyDepartment => object(value) && typeof value.id === 'string' && !!value.id && typeof value.name === 'string' && !!value.name && typeof value.revision === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value.revision) && departmentAccess(value.access) &&
  (value.retiredAt === null || dateString(value.retiredAt)) && (value.retiredBy === null || typeof value.retiredBy === 'string') && typeof value.retirementNote === 'string' && Number.isSafeInteger(value.unresolvedCases) && Number(value.unresolvedCases) >= 0;
const departmentPagination = (value: Record<string, unknown>, size: number) => Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) % size === 0 && typeof value.hasMore === 'boolean';
const dateString = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const departmentCase = (value: unknown): value is DepartmentCase => object(value) && typeof value.id === 'string' && !!value.id && typeof value.title === 'string' && typeof value.description === 'string' &&
  typeof value.canAssign === 'boolean' && typeof value.canClose === 'boolean' && typeof value.needsAssignment === 'boolean' &&
  (value.assignee === null || (object(value.assignee) && typeof value.assignee.id === 'string' && typeof value.assignee.displayName === 'string' && typeof value.assignee.active === 'boolean' && typeof value.assignee.canWrite === 'boolean')) &&
  ['open', 'claimed', 'recovery_required', 'done', 'cancelled'].includes(String(value.status)) && typeof value.fence === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value.fence) &&
  (value.holder === null || (object(value.holder) && typeof value.holder.id === 'string' && typeof value.holder.displayName === 'string' && typeof value.holder.active === 'boolean')) &&
  (value.leaseExpiresAt === null || dateString(value.leaseExpiresAt)) && dateString(value.createdAt) && typeof value.needsReview === 'boolean' &&
  (value.lastRecovery === null || (object(value.lastRecovery) && typeof value.lastRecovery.receiptId === 'string' && ['done', 'released'].includes(String(value.lastRecovery.resolution)) && typeof value.lastRecovery.note === 'string' && typeof value.lastRecovery.reviewedBy === 'string' && dateString(value.lastRecovery.reviewedAt))) &&
  (value.lastClosure === null || (object(value.lastClosure) && typeof value.lastClosure.receiptId === 'string' && ['done', 'cancelled'].includes(String(value.lastClosure.resolution)) && typeof value.lastClosure.note === 'string' && typeof value.lastClosure.recordedBy === 'string' && dateString(value.lastClosure.recordedAt)));

/** A transport failure or malformed success may hide a committed write. */
export function departmentMutationUncertain(cause: unknown): boolean {
  return !object(cause) || ![400, 401, 403, 404, 409, 410, 422].includes(Number(cause.status));
}


const preparationText = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length <= limit && !v.includes('\0');
export function isDepartmentPreparationState(value: unknown): value is DepartmentWorkState {
  if (!remoteExact(value, ['grantId','executionId','caseId','request','phase','detail','runId','updatedAt','result']) ||
      !companyExecutionUuid(value.grantId) || !companyExecutionUuid(value.executionId) || !companyExecutionUuid(value.caseId) ||
      !isDepartmentWorkPrepare(value.request) || value.request.requestId !== value.grantId || value.request.caseId !== value.caseId ||
      !['requesting','waiting-owner','admitting','running','review-required','held'].some(p => p === value.phase) || !preparationText(value.detail,4000) ||
      !(value.runId === null || preparationText(value.runId,128)) || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0) return false;
  return value.result === null || (remoteExact(value.result, ['status','detail','outputs']) && preparationText(value.result.status,120) && preparationText(value.result.detail,4000) &&
    Array.isArray(value.result.outputs) && value.result.outputs.length <= 20 && value.result.outputs.every(item => preparationText(item,JOB_OUTPUT_MAX_CHARS)) &&
    value.result.outputs.reduce((total, item) => total + item.length, 0) <= JOB_OUTPUT_TOTAL_CHARS);
}

function safeError(cause: unknown, operation: Operation): Error {
  const status = object(cause) && typeof cause.status === "number" ? cause.status : undefined;
  const code = object(cause) ? cause.code : undefined;
  let message = "Company status could not be checked. Try again when the local service is available.";
  if (status === 503 && ["setup", "check"].includes(operation) && code === "windows_postgres_privileged_token") message = 'Office hosting needs a standard Windows user session. Close RealBud and reopen it without "Run as administrator". If this continues, use a standard Windows user account. Existing data and settings have been preserved.';
  else if (status === 503 && ["setup", "check"].includes(operation) && code === "windows_postgres_admission_unavailable") message = 'RealBud could not verify this Windows session\'s permissions. Close RealBud and reopen it normally, without "Run as administrator", then try again. Existing data and settings have been preserved.';
  else if (code === "service_admin_required") message = "Sign in as service administrator under Advanced, then retry. Your office membership is unchanged.";
  else if (code === "host_held") message = "This host is held for recovery or retirement. Its owner must complete cutover before office work can continue.";
  else if (operation === "department-work" && (code === "recovery_required" || code === "department_execution_held")) message = "Preparation is held. Check the saved request and current company host, then review the result before starting new work.";
  else if (operation === "department-work" && status === 400) message = "Check the selected case and reviewed preparation plan. Refresh to use its current version.";
  else if (operation === "department-work" && status === 409) message = "The case, plan or preparation permission changed. Refresh and inspect the saved result before making another request.";
  else if (operation === "portal-binding" && code === "recovery_required") message = "Enable office joining and check the current host certificate in Company connection settings, then refresh. Identity mapping needs a verified encrypted host.";
  else if (operation === "portal-binding" && (code === "portal_proof_stale" || code === "portal_proof_denied")) message = "This proof cannot be used. Refresh to check whether the identity was already recorded. If still waiting, disconnect this mapping and start a new attended mapping; do not replace the saved proof.";
  else if (operation === "host-recovery" && [400, 409].includes(status ?? 0) && cause instanceof Error) message = cause.message;
  else if (status === 409 && code === "department_outbox_pending") message = "A saved department change needs confirmation. Open Departments and access to resume it, or Connection and work recovery if the original office cannot be reached.";
  else if (status === 409 && code === "outbox_pending") message = "An earlier share needs confirmation. Open Shared work on Desk and resume its saved request before starting another share or leaving.";
  else if (status === 409 && code === "owner_transfer_required") message = "Choose a new office owner and wait for them to accept before leaving.";
  else if (operation === "department" && status === 409 && code === "work_resolution_required") message = "This department still has unfinished work. Open View work and resolve each case before retiring it.";
  else if (operation === "department" && status === 409 && code === "recovery_required") message = "This case needs the office owner’s review before it can be assigned or closed.";
  else if (operation === "department" && status === 409 && code === "stale_claim") message = "This case changed. Refresh and review its current state before deciding again.";
  else if (operation === "department" && status === 400) message = "Check the department fields and required notes before trying again.";
  else if (status === 409 && code === "work_resolution_required") message = "Resolve your Shared work on Desk before leaving. For held department work, ask the office owner to open Departments and access, then View work, and review it.";
  else if (status === 409 && code === 'claim_busy') message = 'This work still has an active claim. Wait for it to finish or expire, then refresh. No recovery decision was saved.';
  else if (status === 409 && code === "departure_pending") message = "An office departure is pending. Use Finish leaving or Finish disconnecting to check its result before changing office settings.";
  else if (status === 409 && code === "enrollment_recovery_required") message = "Your previous attempt may already have succeeded. Choose Sign in and use the username and password from that attempt to finish. Do not use another invitation.";
  else if (status === 409 && code === "host_identity_mismatch") message = "This host is serving a different office from the one saved on this computer. Ask the owner to check the host setup. Your local work is kept; retrying will not change the saved office.";
  else if (status === 409 && code === "seat_identity_conflict") message = "This RealBud workspace already belongs to another member. Sign in as the original member, or use a separate workspace for another person. Your local work is kept.";
  else if (status === 422 && operation === "work") message = "Shared work needs service recovery. The original record is preserved. Contact service administration; retrying will not repair it.";
  else if (status === 401 && ["signin", "credentials", "recover"].includes(operation)) message = "The sign-in details were not accepted. Check them or wait five minutes if you have tried several times.";
  else if (status === 401 && operation === "join") message = "This invitation is invalid, expired or already used. Ask the company owner for a new one.";
  else if (status === 401 && ["create", "setup"].includes(operation)) message = "Service administrator sign-in is required. Sign in under Advanced, then try again.";
  else if (status === 401) message = "Your company session has ended. Sign in to continue.";
  else if (status === 403) message = operation === "create" ? "A service administrator needs to sign in under Advanced, then try again." : "Your company role does not allow this action.";
  else if (status === 409 && operation === "recover") message = "Owner recovery needs independent identity verification, which is not available yet. Existing sessions remain active.";
  else if (status === 409 && operation === "join") message = "That username is unavailable. Choose another username and retry the same invitation.";
  else if (status === 409) message = "Company state has changed. Check company status before trying again.";
  else if (status === 400 && operation === "connect") message = "This host code is incomplete, invalid or expired. Copy the whole current code from your company owner, then try again.";
  else if (status === 503 && operation === "connect") message = "Could not reach the company host. Keep RealBud open on the host computer, check both computers’ network connection, then retry. Your local work is kept.";
  else if (status === 503) message = "Company service is unavailable. Check the host and your network connection, then try again. Your local work is kept.";
  else if (status === 400 && ["create", "join"].includes(operation)) message = "Check the setup fields. Use a username of 3–80 letters, numbers, dots, underscores or hyphens, and a password of at least 12 characters.";
  else if (operation === "join" && [404, 410].includes(status ?? 0)) message = "This invitation is invalid, expired or already used. Ask the company owner for a new one.";
  else if (operation === "create") message = "Company creation could not be confirmed. Check company status before trying again. Your details are still here.";
  else if (operation === "join") message = "Joining could not be confirmed. Check company status before trying again.";
  else if (operation === "recover") message = "Owner access could not be restored. Check company status before trying again.";
  else if (operation === "invite") message = "The invitation could not be created. Check your connection and try again.";
  else if (operation === "logout") message = "Sign out could not be confirmed. Your session is still available here; try again.";
  else if (operation === "portal-binding") message = "The identity mapping could not be confirmed. Refresh its status or retry the saved request.";
  else if (operation === "work") message = "Shared work could not be confirmed. Check the host connection, then retry or refresh.";
  return Object.assign(new Error(message), { status, code });
}

/** The member token is tab-scoped, never a URL/query parameter or localStorage value. */
export function createCompanyApi(request: Request, storage?: SessionStorage) {
  let token = "";
  let epoch = 0;
  const listeners = new Set<() => void>();
  const departmentListeners = new Set<() => void>();
  const notifyDepartmentChange = () => { for (const listener of departmentListeners) { try { listener(); } catch { /* A view refresh cannot change the operation result. */ } } };
  const invalidate = () => { epoch++; for (const listener of listeners) listener(); };
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (credential(stored)) token = stored;
    else storage?.removeItem(STORAGE_KEY);
  } catch { /* A restricted browser still supports a memory-only session. */ }
  const saveToken = (value: string) => {
    if (token !== value) { token = value; invalidate(); }
    try { if (value) storage?.setItem(STORAGE_KEY, value); else storage?.removeItem(STORAGE_KEY); }
    catch { /* Keep the usable session in memory when storage is unavailable. */ }
  };
  const call = async (path: string, operation: Operation, body?: unknown, method = "POST") => {
    const requestEpoch = epoch;
    const headers = new Headers();
    if (token) headers.set("x-realbud-member-session", token);
    try {
      const result = await request(path, { headers, ...(body !== undefined ? { method, body: JSON.stringify(body) } : {}) }, { timeoutMs: (path === "/api/company/setup" || operation === "host-recovery") ? 120_000 : 15_000 });
      if (requestEpoch !== epoch) throw new Error("Company session changed. Check company status again.");
      return result;
    } catch (cause) {
      const memberSessionEnded = !["credentials", "setup", "create"].includes(operation) && requestEpoch === epoch && object(cause) && cause.status === 401 && cause.code !== "service_admin_required";
      if (memberSessionEnded) { invalidate(); saveToken(""); }
      throw Object.assign(safeError(cause, operation), { memberSessionEnded });
    }
  };
  const acknowledgeDepartmentOperation = async (requestId: string, notify = true) => {
    try { const result = await call('/api/company/department-outbox/ack', 'department', { requestId }); if (!object(result) || result.ok !== true) throw incomplete(); }
    finally { if (notify) notifyDepartmentChange(); }
  };
  const departmentMutation = async (operation: DepartmentOutboxOperation): Promise<DepartmentCaseMutation | DepartmentLifecycleResult> => {
    try {
      const result = await call(operation.path, 'department', operation.input);
      if (!object(result) || result.receiptId !== operation.input.requestId || typeof result.replayed !== 'boolean') throw incomplete();
      if (operation.path === '/api/company/departments/lifecycle') {
        if (!department(result.department) || result.department.id !== operation.input.departmentId) throw incomplete();
      } else if (!departmentCase(result.item) || result.item.id !== ('caseId' in operation.input ? operation.input.caseId : operation.input.requestId)) throw incomplete();
      // Retire the local request only after the exact host receipt is validated.
      await acknowledgeDepartmentOperation(operation.input.requestId, false);
      return result as unknown as DepartmentCaseMutation | DepartmentLifecycleResult;
    } finally { notifyDepartmentChange(); }
  };
  const establish = async (path: string, operation: "create" | "join" | "recover" | "signin", body: unknown): Promise<CompanySessionResponse> => {
    invalidate();
    const result = await call(path, operation, body);
    if (!object(result) || !credential(result.memberToken) || !company(result.company) || !member(result.member)) throw incomplete();
    saveToken(result.memberToken);
    return { memberToken: result.memberToken, company: result.company, member: result.member, ...(typeof result.recoveryKey === "string" ? { recoveryKey: result.recoveryKey } : {}) };
  };
  return {
    sessionVersion: () => epoch,
    notifyDepartmentChange,
    subscribeDepartmentChanges(listener: () => void): () => void {
      departmentListeners.add(listener);
      return () => { departmentListeners.delete(listener); };
    },
    subscribeSession(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async departmentPreparationCatalog(departmentId: string): Promise<DepartmentWorkCatalog> {
      if (!companyExecutionUuid(departmentId)) throw incomplete();
      const result = await call('/api/company/department-work/catalog', 'department-work', { departmentId });
      if (!remoteExact(result,['recipes']) || !Array.isArray(result.recipes) || result.recipes.length > 100 || !result.recipes.every(r =>
        remoteExact(r,['id','revision','title','review']) && preparationText(r.id,128) && !!r.id && Number.isSafeInteger(r.revision) && Number(r.revision) >= 1 &&
        preparationText(r.title,240) && !!r.title && isCompanyExecutionReview(r.review)) || new Set(result.recipes.map(r => r.id)).size !== result.recipes.length) throw incomplete();
      return result as unknown as DepartmentWorkCatalog;
    },
    async departmentPreparations(departmentId: string, offset = 0): Promise<DepartmentWorkPage> {
      if (!companyExecutionUuid(departmentId) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw incomplete();
      const result = await call('/api/company/department-work/list', 'department-work', { departmentId, offset, limit:10 });
      if (!remoteExact(result,['grants','offset','hasMore','canManage','local'])) throw incomplete();
      const { local, ...page } = result;
      if (!isCompanyExecutionGrantPage(page) || page.offset !== offset || page.grants.length > 10 || page.grants.some(g => g.spec.departmentId !== departmentId) ||
          new Set(page.grants.map(g => g.id)).size !== page.grants.length || !Array.isArray(local) || local.length > 100 || !local.every(isDepartmentPreparationState) ||
          local.some(item => item.request.departmentId !== departmentId) || new Set(local.map(item => item.grantId)).size !== local.length) throw incomplete();
      return { ...page, local };
    },
    async prepareDepartmentWork(input: DepartmentWorkPrepare): Promise<DepartmentWorkPrepared> {
      if (!isDepartmentWorkPrepare(input)) throw new Error('Check the selected case and reviewed preparation plan.');
      const result = await call('/api/company/department-work/prepare', 'department-work', input);
      if (!remoteExact(result,['grant','local']) || !isCompanyExecutionGrant(result.grant) || !isDepartmentPreparationState(result.local) ||
          result.grant.id !== input.requestId || result.grant.spec.departmentId !== input.departmentId || result.grant.spec.caseId !== input.caseId ||
          result.grant.spec.departmentRevision !== input.expectedDepartmentRevision || result.grant.spec.caseFence !== input.expectedCaseFence ||
          result.grant.spec.recipe.id !== input.recipeId || result.grant.spec.recipe.revision !== input.expectedRecipeRevision ||
          canonicalWebsiteCommand(result.local.request) !== canonicalWebsiteCommand(input) || !result.grant.spec.recipe.review) throw incomplete();
      return { grant: result.grant, local: result.local };
    },
    async confirmDepartmentPreparation(input: ConfirmCompanyExecution): Promise<CompanyExecutionGrant> {
      if (!isConfirmCompanyExecution(input)) throw incomplete();
      const result = await call('/api/company/department-work/confirm', 'department-work', input);
      if (!isCompanyExecutionGrant(result) || result.id !== input.grantId || result.digest !== input.grantDigest || result.phase === 'pending') throw incomplete();
      return result;
    },
    async revokeDepartmentPreparation(input: RevokeCompanyExecution): Promise<CompanyExecutionGrant> {
      if (!isRevokeCompanyExecution(input)) throw incomplete();
      const result = await call('/api/company/department-work/revoke', 'department-work', input);
      if (!isCompanyExecutionGrant(result) || result.id !== input.grantId || result.phase !== 'revoked') throw incomplete();
      return result;
    },
    async reconcileDepartmentPreparation(grantId: string): Promise<DepartmentWorkState> {
      if (!companyExecutionUuid(grantId)) throw incomplete();
      const result = await call('/api/company/department-work/reconcile', 'department-work', { grantId });
      if (!isDepartmentPreparationState(result) || result.grantId !== grantId) throw incomplete();
      return result;
    },
    async portalBindings(offset = 0, limit = 20): Promise<CompanyPortalBindingPage> {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw incomplete();
      const result = await call('/api/company/portal-bindings/list', 'portal-binding', { offset, limit });
      if (!isCompanyPortalBindingPage(result, offset, limit)) throw incomplete();
      return result;
    },
    async portalBindingOperation(operation: CompanyPortalOperation): Promise<CompanyPortalBinding> {
      if (!isCompanyPortalOperation(operation)) throw new Error('Check the mapping fields and copy the complete proof code.');
      const result = await call(`/api/company/portal-bindings/${operation.action}`, 'portal-binding', operation.body);
      if (!isCompanyPortalBinding(result) || (operation.action === 'begin' ? result.memberId !== operation.body.memberId || result.id !== operation.body.requestId : result.id !== operation.body.bindingId)) throw incomplete();
      return result;
    },
    async workflowTemplate(): Promise<CompanyWorkflowTemplateState> {
      const result = await call("/api/company/workflow-template", "templates");
      if (!object(result) || typeof result.revision !== "string" || !/^(0|[1-9][0-9]*)$/.test(result.revision) ||
        (result.template !== null && (!object(result.template) || result.template.version !== 1 || !Array.isArray(result.template.recipes)))) throw incomplete();
      return result as unknown as CompanyWorkflowTemplateState;
    },
    async publishWorkflowTemplate(expectedRevision: string, template: CompanyWorkflowTemplate, identity: { companyId: string; memberId: string }) {
      await call("/api/company/workflow-template", "templates", { expectedRevision, template, ...identity }, "PUT");
    },
    async status(): Promise<CompanyStatus> {
      const result = await call("/api/company/status", "check");
      if (!object(result) || typeof result.storageAvailable !== "boolean" || typeof result.configured !== "boolean" || typeof result.setupAllowed !== "boolean" || (result.ownerRecoveryAllowed !== undefined && typeof result.ownerRecoveryAllowed !== "boolean") || !["local-only", "encrypted-company"].includes(String(result.transport)) || !Array.isArray(result.limitations) || !result.limitations.every(item => typeof item === "string") || (result.company !== undefined && !company(result.company)) || (result.member !== undefined && (!member(result.member) || !company(result.company)))) throw incomplete();
      if (!result.member && token) { invalidate(); saveToken(""); }
      return result as unknown as CompanyStatus;
    },
    create: (input: { name: string; ownerName: string; credential: { loginName: string; password: string } }) => establish("/api/company/create", "create", input),
    join: (invitationToken: string, credential: { loginName: string; password: string }) => establish("/api/company/join", "join", { invitationToken, credential }),
    recoverOwner: () => establish("/api/company/recover-owner", "recover", {}),
    signIn: (input: { loginName: string; password: string }) => establish("/api/company/sign-in", "signin", input),
    recover: (input: { loginName: string; recoveryKey: string; newPassword: string }) => establish("/api/company/recover-member", "recover", input),
    async credentials(input: { loginName: string; password: string; currentPassword?: string }): Promise<{ recoveryKey: string }> {
      const result = await call("/api/company/credentials", "credentials", input);
      if (!object(result) || !credential(result.recoveryKey)) throw incomplete();
      return { recoveryKey: result.recoveryKey };
    },
    async hostRecovery(action?: 'backup' | 'restore' | 'activate' | 'reset-empty', body?: unknown) {
      const result = await call('/api/company/host-recovery' + (action ? '/' + action : ''), 'host-recovery', body);
      if (!object(result)) throw incomplete();
      return result;
    },
    setup: () => call("/api/company/setup", "setup", {}),
    async connectHost(hostCode: string, replaceExisting = false) { invalidate(); await call("/api/company/connect-host", "connect", { hostCode, ...(replaceExisting ? { replaceExisting: true } : {}) }); saveToken(""); },
    async detachOffline() { invalidate(); await call('/api/company/detach-offline', 'work', { acknowledgeActiveSessions: true }); saveToken(''); invalidate(); },
    enableJoining: (hostname: string, renewIdentity = false) => call("/api/company/network", "setup", { hostname, ...(renewIdentity ? { renewIdentity: true } : {}) }),
    async hostCode(): Promise<string> {
      const result = await call("/api/company/host-code", "check");
      if (!object(result) || typeof result.hostCode !== "string" || !result.hostCode.startsWith("RB1.")) throw incomplete();
      return result.hostCode;
    },
    async invite(displayName: string): Promise<CompanyInvitationResponse> {
      const result = await call("/api/company/invitations", "invite", { displayName });
      if (!object(result) || !credential(result.invitationToken) || typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt))) throw incomplete();
      return { invitationToken: result.invitationToken, expiresAt: result.expiresAt, ...(typeof result.invitationId === 'string' ? { invitationId: result.invitationId } : {}) };
    },
    async management(offset = 0): Promise<CompanyManagement> {
      const result = await call('/api/company/membership/management', 'work', { offset });
      const nullableDate = (value: unknown) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
      if (!object(result) || !Number.isSafeInteger(result.offset) || typeof result.hasMore !== 'boolean' || typeof result.unresolvedWork !== 'boolean' ||
        !Array.isArray(result.members) || !result.members.every(item => member(item) && object(item) && typeof item.active === 'boolean' && nullableDate(item.joinedAt)) ||
        !Array.isArray(result.invitations) || !result.invitations.every(item => object(item) && typeof item.id === 'string' && typeof item.displayName === 'string' && nullableDate(item.expiresAt) && nullableDate(item.redeemedAt) && nullableDate(item.revokedAt)) ||
        !(result.transfer === null || (object(result.transfer) && typeof result.transfer.id === 'string' && typeof result.transfer.fromMemberId === 'string' && typeof result.transfer.toMemberId === 'string' && nullableDate(result.transfer.expiresAt)))) throw incomplete();
      return result as unknown as CompanyManagement;
    },
    async departments(offset = 0): Promise<DepartmentPage> {
      const result = await call('/api/company/departments/list', 'department', { offset });
      if (!object(result) || !departmentPagination(result, 50) || result.offset !== offset || typeof result.canManage !== 'boolean' || !Array.isArray(result.departments) || result.departments.length > 50 || !result.departments.every(department)) throw incomplete();
      return result as unknown as DepartmentPage;
    },
    async createDepartment(requestId: string, name: string): Promise<CompanyDepartment> {
      const result = await call('/api/company/departments', 'department', { requestId, name });
      if (!object(result) || !department(result.department)) throw incomplete();
      return result.department;
    },
    async departmentAccess(departmentId: string, offset = 0): Promise<DepartmentAccessPage> {
      const result = await call('/api/company/departments/access', 'department', { departmentId, offset });
      if (!object(result) || !departmentPagination(result, 100) || result.offset !== offset || !department(result.department) || result.department.id !== departmentId || !Array.isArray(result.members) || result.members.length > 100 || !result.members.every(item => member(item) && object(item) && departmentAccess(item.access))) throw incomplete();
      return result as unknown as DepartmentAccessPage;
    },
    async setDepartmentAccess(input: { departmentId: string; memberId: string; access: DepartmentAccess; expectedRevision: string }): Promise<CompanyDepartment> {
      const result = await call('/api/company/departments/access', 'work', input, 'PUT');
      if (!object(result) || !department(result.department) || result.department.id !== input.departmentId) throw incomplete();
      return result.department;
    },
    async departmentCases(departmentId: string, offset = 0, filter: 'needs-review' | 'all' = 'needs-review'): Promise<DepartmentCasePage> {
      const result = await call('/api/company/departments/cases', 'department', { departmentId, offset, filter });
      if (!object(result) || !departmentPagination(result, 20) || result.offset !== offset || result.filter !== filter || !department(result.department) || result.department.id !== departmentId || typeof result.canRecover !== 'boolean' || typeof result.canCreate !== 'boolean' || (result.department.retiredAt !== null && (result.canRecover || result.canCreate)) || !Array.isArray(result.cases) || result.cases.length > 20 || !result.cases.every(departmentCase)) throw incomplete();
      return result as unknown as DepartmentCasePage;
    },
    async recoverDepartmentCase(input: RecoverDepartmentCaseInput): Promise<DepartmentCaseMutation> {
      return await departmentMutation({ path: '/api/company/departments/cases/recover', input }) as DepartmentCaseMutation;
    },
    async departmentAssignees(departmentId: string, offset = 0): Promise<DepartmentAssigneePage> {
      const result = await call('/api/company/departments/assignees', 'department', { departmentId, offset });
      if (!object(result) || !departmentPagination(result, 100) || result.offset !== offset || !department(result.department) || result.department.id !== departmentId || !Array.isArray(result.members) || result.members.length > 100 || !result.members.every(member)) throw incomplete();
      return result as unknown as DepartmentAssigneePage;
    },
    async createDepartmentCase(input: CreateDepartmentCaseInput): Promise<DepartmentCaseMutation> {
      return await departmentMutation({ path: '/api/company/departments/cases/create', input }) as DepartmentCaseMutation;
    },
    async assignDepartmentCase(input: AssignDepartmentCaseInput): Promise<DepartmentCaseMutation> {
      return await departmentMutation({ path: '/api/company/departments/cases/assign', input }) as DepartmentCaseMutation;
    },
    async closeDepartmentCase(input: CloseDepartmentCaseInput): Promise<DepartmentCaseMutation> {
      return await departmentMutation({ path: '/api/company/departments/cases/close', input }) as DepartmentCaseMutation;
    },
    async setDepartmentLifecycle(input: DepartmentLifecycleInput): Promise<DepartmentLifecycleResult> {
      return await departmentMutation({ path: '/api/company/departments/lifecycle', input }) as DepartmentLifecycleResult;
    },
    async pendingDepartmentOperation(): Promise<DepartmentOutboxState> {
      const result = await call('/api/company/department-outbox', 'department');
      if (!object(result) || typeof result.otherOfficePending !== 'boolean') throw incomplete();
      if (result.pending === null) return { pending: null, otherOfficePending: result.otherOfficePending };
      if (result.otherOfficePending || !object(result.pending) || !['pending', 'confirmed'].includes(String(result.pending.phase)) || typeof result.pending.path !== 'string') throw incomplete();
      try { return { pending: { ...normalizeDepartmentOperation(result.pending.path, result.pending.input), phase: result.pending.phase as 'pending' | 'confirmed' }, otherOfficePending: result.otherOfficePending }; }
      catch { throw incomplete(); }
    },
    resumeDepartmentOperation: (operation: DepartmentOutboxOperation) => departmentMutation(normalizeDepartmentOperation(operation.path, operation.input)),
    acknowledgeDepartmentOperation: (requestId: string) => acknowledgeDepartmentOperation(requestId),
    revokeInvitation: (invitationId: string) => call('/api/company/invitations/revoke', 'work', { invitationId }),
    revokeMember: (memberId: string) => call('/api/company/members/revoke', 'work', { memberId }),
    offerOwnership: (memberId: string) => call('/api/company/ownership/offer', 'work', { memberId }),
    acceptOwnership: (transferId: string) => call('/api/company/ownership/accept', 'work', { transferId }),
    cancelOwnership: (transferId: string) => call('/api/company/ownership/cancel', 'work', { transferId }),
    async leaveOffice(disconnectOnly = false) {
      invalidate();
      await call(`/api/company/${disconnectOnly ? 'disconnect-host' : 'leave-office'}`, 'work', {});
      saveToken(''); invalidate();
    },
    async logout(): Promise<void> {
      // Invalidate pending sign-in/read responses immediately, while retaining a
      // failed revocation's token so the person can retry the same operation.
      invalidate();
      await call("/api/company/logout", "logout", {});
      invalidate();
      saveToken("");
    },
    async workMembers() {
      return parseWorkMembers(await call("/api/company/work-members", "work"));
    },
    async sharedWork(query?: { offset: number; filter: 'with-me' | 'by-me' }) {
      return parseSharedWorkList(await call(query ? "/api/company/work/list" : "/api/company/work", "work", query));
    },
    async shareWork(input: ShareWorkInput) {
      return parseSharedWorkItemResponse(await call("/api/company/work", "work", input));
    },
    async pendingShare(): Promise<{ pending: { phase: 'pending' | 'confirmed'; input: ShareWorkInput } | null; otherOfficePending: boolean }> {
      const result = await call('/api/company/outbox', 'work');
      if (!object(result) || typeof result.otherOfficePending !== 'boolean') throw incomplete();
      if (result.pending !== null) {
        if (!object(result.pending) || !['pending', 'confirmed'].includes(String(result.pending.phase)) || !object(result.pending.input)) throw incomplete();
        const input = result.pending.input;
        if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId) || !(input.assigneeMemberId === null || typeof input.assigneeMemberId === 'string') || typeof input.title !== 'string' || typeof input.summary !== 'string' ||
          !['share-result', 'request-review', 'handoff'].includes(String(input.purpose)) || !Array.isArray(input.recipientMemberIds) || !input.recipientMemberIds.every(id => typeof id === 'string') ||
          !(input.evidence == null || (object(input.evidence) && ['label', 'sourceRef', 'sourceVersion', 'text'].every(key => typeof (input.evidence as Record<string, unknown>)[key] === 'string')))) throw incomplete();
      }
      return result as unknown as { pending: { phase: 'pending' | 'confirmed'; input: ShareWorkInput } | null; otherOfficePending: boolean };
    },
    acknowledgeShare: (requestId: string) => call('/api/company/outbox/ack', 'work', { requestId }),
    async respondToSharedWork(input: RespondToSharedWorkInput) {
      return parseSharedWorkItemResponse(await call("/api/company/work/respond", "work", input));
    },
    async closeSharedWork(input: CloseSharedWorkInput) {
      return parseSharedWorkItemResponse(await call("/api/company/work/close", "work", input));
    },
    async acceptSharedWork(input: AcceptSharedWorkInput) {
      return parseSharedWorkItemResponse(await call("/api/company/work/accept", "work", input));
    },
    async reassignSharedWork(input: ReassignSharedWorkInput) {
      return parseSharedWorkItemResponse(await call("/api/company/work/reassign", "work", input));
    },
    async sharedWorkHistory(input: { id: string; beforeRevision?: string }) {
      return parseSharedWorkHistory(await call("/api/company/work/history", "work", input));
    },
  };
}

function browserSessionStorage(): SessionStorage | undefined {
  try { return typeof window !== "undefined" ? window.sessionStorage : undefined; } catch { return undefined; }
}

export const companyApi = createCompanyApi(api, browserSessionStorage());

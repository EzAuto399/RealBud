import { Pool } from "./vendor/pg.mjs";
import { CompanyError, createCompanyKernel } from "./company/index.js";
const MEMBER_HEADER = "x-realbud-member-session";
const LIMITATIONS = [
    "Company sharing is a development preview. Windows and macOS installed-device acceptance is still pending.",
    "Personal Desk work, Ask, sources and schedules remain local. Only explicitly reviewed shared work and company templates are available to permitted members.",
    "Company workers and desktop control stay unavailable until isolation and enrolled-device checks pass.",
    "Members can set a password and save their personal recovery key. Service administration cannot restore or impersonate a member identity.",
];
export function companyMemberToken(request) {
    const value = request.headers[MEMBER_HEADER];
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
}
function fields(value, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
        throw new CompanyError("invalid_input");
    }
    return value;
}
function fail(error, path) {
    if (error instanceof CompanyError) {
        if (error.code === "recovery_required" && path.startsWith("/api/company/work")) {
            return { status: 422, body: { code: error.code, error: "Shared work needs service recovery. The original record is preserved. Contact service administration; retrying will not repair it." } };
        }
        const status = error.code === "unauthenticated" ? 401 : error.code === "forbidden" ? 403 :
            error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400 : error.code === "unsafe_database_role" ? 503 : 409;
        const messages = {
            unauthenticated: "The company sign-in details were not accepted. Check them or wait five minutes after repeated attempts.",
            forbidden: "Your company membership does not permit this action.", not_found: "This company item is unavailable.",
            invalid_input: "Check the company fields and try again.", conflict: "Company state changed. Refresh before trying again.",
            claim_busy: "This case is already being worked on.", stale_claim: "This claim is no longer current.",
            recovery_required: "The previous work needs recovery before another claim can start.",
            unsafe_database_role: "Company storage needs a restricted application role. Contact service administration.",
            owner_transfer_required: "Transfer ownership to another member before leaving this office.",
            work_resolution_required: path === '/api/company/departments/lifecycle'
                ? "Resolve all open and interrupted cases before retiring this department. No work was changed."
                : "Finish, close or reassign your open shared and department work before leaving this office.",
        };
        return { status, body: { code: error.code, error: messages[error.code] } };
    }
    return { status: 503, body: { error: "Company storage is unavailable. Your existing data has not been replaced." } };
}
/** Local integration only. Never expose the legacy loopback API as a LAN host. */
export function createCompanyHost(options) {
    const kernel = options.kernel;
    const admin = (request) => {
        const gate = options.authorizeAdmin(request);
        return gate.ok ? null : { status: gate.status, body: { error: gate.error, code: "service_admin_required" } };
    };
    async function currentCompany() {
        const state = await kernel.getBootstrapState();
        if (state.companies.length > 1)
            throw new CompanyError("conflict");
        return state.companies[0];
    }
    async function session(memberToken) {
        const actor = await kernel.authenticateSession(memberToken);
        const company = await currentCompany();
        if (!company || company.companyId !== actor.companyId)
            throw new CompanyError("forbidden");
        return { memberToken, company: { id: actor.companyId, name: company.name },
            member: { id: actor.memberId, displayName: actor.displayName, role: actor.role } };
    }
    return {
        async handle(path, method, request, body) {
            const memberToken = companyMemberToken(request);
            try {
                if (path === "/api/company/status" && method === "GET") {
                    const status = { storageAvailable: false, configured: false, setupAllowed: false,
                        ownerRecoveryAllowed: false, transport: "local-only", limitations: [...LIMITATIONS] };
                    if (!kernel)
                        return { status: 200, body: status };
                    const company = await currentCompany();
                    status.storageAvailable = true;
                    status.configured = Boolean(company);
                    // Successful authorization only when status requested with an actual
                    // token; ordinary status discovery does not mint or expand authority.
                    const authorized = options.hasAdminSession(request);
                    status.setupAllowed = !company && authorized;
                    status.ownerRecoveryAllowed = false;
                    if (memberToken) {
                        try {
                            const own = await session(memberToken);
                            status.company = own.company;
                            status.member = own.member;
                        }
                        catch (error) {
                            if (!(error instanceof CompanyError) || error.code !== "unauthenticated")
                                throw error;
                        }
                    }
                    return { status: 200, body: status };
                }
                if (!kernel)
                    return { status: 503, body: { error: "Company storage has not been provisioned. Contact service administration." } };
                if (path === "/api/company/membership/departure-status" && method === "POST") {
                    const input = fields(body, ["operationToken"]);
                    return { status: 200, body: await kernel.departureStatus(input.operationToken) };
                }
                if (path === "/api/company/create" && method === "POST") {
                    const denial = admin(request);
                    if (denial)
                        return denial;
                    const input = fields(body, ["name", "ownerName", "credential"]);
                    if (input.credential === undefined)
                        throw new CompanyError("invalid_input");
                    const created = await kernel.createCompany({ name: input.name, ownerName: input.ownerName, singleHost: true, credential: input.credential });
                    return { status: 201, body: { ...await session(created.sessionToken), recoveryKey: created.recoveryKey } };
                }
                if (path === "/api/company/recover-owner" && method === "POST") {
                    const denial = admin(request);
                    if (denial)
                        return denial;
                    fields(body, []);
                    // Service-key administration is not proof of a member's identity.
                    // In particular it must never mint a token for the owner's private scope.
                    return { status: 409, body: { code: "owner_proof_required",
                            error: "Owner recovery needs independent identity verification, which is not available yet. Existing sessions remain active." } };
                }
                if (path === "/api/company/join" && method === "POST") {
                    const input = fields(body, ["invitationToken", "credential"]);
                    if (typeof input.invitationToken !== "string" || input.credential === undefined)
                        throw new CompanyError("invalid_input");
                    await currentCompany();
                    const joined = await kernel.redeemInvitation(input.invitationToken, input.credential);
                    return { status: 201, body: { ...await session(joined.sessionToken), recoveryKey: joined.recoveryKey } };
                }
                if (path === "/api/company/sign-in" && method === "POST") {
                    const input = fields(body, ["loginName", "password"]);
                    const company = await currentCompany();
                    if (!company)
                        throw new CompanyError("unauthenticated");
                    const result = await kernel.signInMember({ companyId: company.companyId, loginName: input.loginName, password: input.password });
                    return { status: 200, body: await session(result.sessionToken) };
                }
                if (path === "/api/company/recover-member" && method === "POST") {
                    const input = fields(body, ["loginName", "recoveryKey", "newPassword"]);
                    const company = await currentCompany();
                    if (!company)
                        throw new CompanyError("unauthenticated");
                    const result = await kernel.recoverMember({ companyId: company.companyId, loginName: input.loginName, recoveryKey: input.recoveryKey, newPassword: input.newPassword });
                    return { status: 200, body: { ...await session(result.sessionToken), recoveryKey: result.recoveryKey } };
                }
                if (path === "/api/company/logout" && method === "POST") {
                    fields(body, []);
                    if (memberToken) {
                        try {
                            await kernel.revokeSession(memberToken);
                        }
                        catch (error) {
                            if (!(error instanceof CompanyError) || error.code !== "unauthenticated")
                                throw error;
                        }
                    }
                    return { status: 200, body: { ok: true } };
                }
                const actor = await kernel.authenticateSession(memberToken);
                const hosted = await currentCompany();
                if (!hosted || hosted.companyId !== actor.companyId)
                    throw new CompanyError("forbidden");
                if (path === "/api/company/me" && method === "GET") {
                    const own = await session(memberToken);
                    return { status: 200, body: { company: own.company, member: own.member } };
                }
                if (path === "/api/company/credentials" && method === "POST") {
                    const input = fields(body, ["loginName", "password", "currentPassword"]);
                    return { status: 200, body: await kernel.enrollMemberCredential(memberToken, input) };
                }
                if (path === "/api/company/membership/management" && method === "POST") {
                    const input = fields(body, ["offset"]);
                    return { status: 200, body: await kernel.membershipManagement(memberToken, input.offset) };
                }
                if (path === "/api/company/membership/leave" && method === "POST") {
                    const input = fields(body, ["operationToken"]);
                    await kernel.leaveMembership(memberToken, input.operationToken);
                    return { status: 200, body: { ok: true } };
                }
                if (path === "/api/company/ownership/offer" && method === "POST") {
                    const input = fields(body, ["memberId"]);
                    return { status: 200, body: await kernel.offerOwnership(memberToken, input.memberId) };
                }
                if ((path === "/api/company/ownership/accept" || path === "/api/company/ownership/cancel") && method === "POST") {
                    const input = fields(body, ["transferId"]);
                    if (path.endsWith('/accept'))
                        await kernel.acceptOwnership(memberToken, input.transferId);
                    else
                        await kernel.cancelOwnership(memberToken, input.transferId);
                    return { status: 200, body: { ok: true } };
                }
                if (path === "/api/company/workflow-template" && method === "GET") {
                    return { status: 200, body: await kernel.readWorkflowTemplate(memberToken) };
                }
                if (path === "/api/company/workflow-template" && method === "PUT") {
                    const input = fields(body, ["expectedRevision", "template", "companyId", "memberId"]);
                    if (input.companyId !== actor.companyId || input.memberId !== actor.memberId)
                        throw new CompanyError('conflict');
                    return { status: 200, body: await kernel.publishWorkflowTemplate(memberToken, input) };
                }
                if (path === "/api/company/invitations" && method === "POST") {
                    const input = fields(body, ["displayName"]);
                    const invitation = await kernel.issueInvitation(memberToken, { displayName: input.displayName, expiresInMs: 30 * 60_000 });
                    return { status: 201, body: { invitationId: invitation.invitationId, invitationToken: invitation.invitationToken, expiresAt: invitation.expiresAt } };
                }
                if (path === "/api/company/invitations/revoke" && method === "POST") {
                    const input = fields(body, ["invitationId"]);
                    await kernel.revokeInvitation(memberToken, input.invitationId);
                    return { status: 200, body: { ok: true } };
                }
                if (path === "/api/company/members/revoke" && method === "POST") {
                    const input = fields(body, ["memberId"]);
                    await kernel.revokeMember(memberToken, input.memberId);
                    return { status: 200, body: { ok: true } };
                }
                if (path === "/api/company/work-members" && method === "GET")
                    return { status: 200, body: { members: await kernel.listWorkMembers(memberToken) } };
                if (path === "/api/company/work/list" && method === "POST") {
                    const input = fields(body, ["offset", "filter"]);
                    return { status: 200, body: { items: await kernel.listSharedWork(memberToken, input) } };
                }
                if (path === "/api/company/work" && method === "GET")
                    return { status: 200, body: { items: await kernel.listSharedWork(memberToken) } };
                if (path === "/api/company/work" && method === "POST") {
                    const input = fields(body, ["requestId", "title", "summary", "purpose", "recipientMemberIds", "assigneeMemberId", "evidence"]);
                    return { status: 201, body: { item: await kernel.shareWork(memberToken, input) } };
                }
                if (path === "/api/company/work/respond" && method === "POST") {
                    const input = fields(body, ["id", "expectedRevision", "response"]);
                    return { status: 200, body: { item: await kernel.respondToSharedWork(memberToken, input) } };
                }
                if (path === "/api/company/work/accept" && method === "POST") {
                    const input = fields(body, ["id", "expectedRevision"]);
                    return { status: 200, body: { item: await kernel.acceptSharedWork(memberToken, input) } };
                }
                if (path === "/api/company/work/reassign" && method === "POST") {
                    const input = fields(body, ["id", "expectedRevision", "assigneeMemberId"]);
                    return { status: 200, body: { item: await kernel.reassignSharedWork(memberToken, input) } };
                }
                if (path === "/api/company/work/history" && method === "POST") {
                    const input = fields(body, ["id", "beforeRevision"]);
                    return { status: 200, body: await kernel.sharedWorkHistory(memberToken, input) };
                }
                if (path === "/api/company/work/close" && method === "POST") {
                    const input = fields(body, ["id", "expectedRevision"]);
                    return { status: 200, body: { item: await kernel.closeSharedWork(memberToken, input) } };
                }
                if (path === '/api/company/departments/list' && method === 'POST') {
                    const input = fields(body, ['offset']);
                    return { status: 200, body: await kernel.listDepartments(memberToken, input.offset) };
                }
                if (path === '/api/company/departments' && method === 'POST') {
                    const input = fields(body, ['requestId', 'name']);
                    return { status: 201, body: { department: await kernel.createDepartment(memberToken, input) } };
                }
                if (path === '/api/company/departments/access' && method === 'POST') {
                    const input = fields(body, ['departmentId', 'offset']);
                    return { status: 200, body: await kernel.departmentAccess(memberToken, input) };
                }
                if (path === '/api/company/departments/access' && method === 'PUT') {
                    const input = fields(body, ['departmentId', 'memberId', 'access', 'expectedRevision']);
                    return { status: 200, body: { department: await kernel.setDepartmentAccess(memberToken, input) } };
                }
                if (path === '/api/company/departments/cases' && method === 'POST') {
                    const input = fields(body, ['departmentId', 'offset', 'filter']);
                    return { status: 200, body: await kernel.departmentCases(memberToken, input) };
                }
                if (path === '/api/company/departments/cases/recover' && method === 'POST') {
                    const input = fields(body, ['departmentId', 'caseId', 'requestId', 'expectedFence', 'resolution', 'note']);
                    return { status: 200, body: await kernel.recoverDepartmentCase(memberToken, input) };
                }
                if (path === '/api/company/departments/cases/create' && method === 'POST') {
                    const input = fields(body, ['departmentId', 'requestId', 'title', 'description', 'assigneeMemberId']);
                    return { status: 201, body: await kernel.createDepartmentCase(memberToken, input) };
                }
                if (path === '/api/company/departments/cases/assign' && method === 'POST') {
                    const input = fields(body, ['departmentId', 'caseId', 'requestId', 'expectedFence', 'assigneeMemberId']);
                    return { status: 200, body: await kernel.assignDepartmentCase(memberToken, input) };
                }
                if (path === '/api/company/departments/cases/close' && method === 'POST') {
                    const input = fields(body, ['departmentId', 'caseId', 'requestId', 'expectedFence', 'resolution', 'note']);
                    return { status: 200, body: await kernel.closeDepartmentCase(memberToken, input) };
                }
                if (path === '/api/company/departments/assignees' && method === 'POST') {
                    const input = fields(body, ['departmentId', 'offset']);
                    return { status: 200, body: await kernel.departmentAssignees(memberToken, input) };
                }
                if (path === '/api/company/departments/lifecycle' && method === 'POST') {
                    const input = fields(body, ['departmentId', 'requestId', 'expectedRevision', 'retired', 'note']);
                    return { status: 200, body: await kernel.setDepartmentLifecycle(memberToken, input) };
                }
                if (path === "/api/company/scopes" && method === "GET")
                    return { status: 200, body: { scopes: await kernel.listScopes(memberToken) } };
                if (path === "/api/company/scopes" && method === "POST") {
                    const input = fields(body, ["kind", "name"]);
                    if (!["private", "team", "company"].includes(String(input.kind)))
                        throw new CompanyError("invalid_input");
                    return { status: 201, body: { scope: await kernel.createScope(memberToken, { kind: input.kind, name: input.name }) } };
                }
                if (path === "/api/company/knowledge/read" && method === "POST") {
                    const input = fields(body, ["scopeId", "key"]);
                    return { status: 200, body: { knowledge: await kernel.readKnowledge(memberToken, input) } };
                }
                if (path === "/api/company/knowledge/history" && method === "POST") {
                    const input = fields(body, ["scopeId", "key", "limit"]);
                    return { status: 200, body: { history: await kernel.knowledgeHistory(memberToken, input) } };
                }
                if (path === "/api/company/knowledge" && method === "PUT") {
                    const input = fields(body, ["scopeId", "key", "expectedRevision", "content", "sourceRefs"]);
                    return { status: 200, body: { knowledge: await kernel.replaceKnowledge(memberToken, input) } };
                }
                if (path === "/api/company/grants" && method === "PUT") {
                    const input = fields(body, ["scopeId", "memberId", "permissions", "expectedRevision"]);
                    return { status: 200, body: await kernel.setScopeGrant(memberToken, input) };
                }
                if (path === "/api/company/cases" && method === "POST") {
                    const input = fields(body, ["scopeId", "title"]);
                    return { status: 201, body: await kernel.createCase(memberToken, input) };
                }
                if (path === "/api/company/cases/claim" && method === "POST") {
                    const input = fields(body, ["caseId", "ttlMs"]);
                    return { status: 200, body: await kernel.claimCase(memberToken, input) };
                }
                if (path === "/api/company/cases/renew" && method === "POST") {
                    const input = fields(body, ["caseId", "fence", "claimToken", "ttlMs"]);
                    return { status: 200, body: await kernel.renewClaim(memberToken, input) };
                }
                if (path === "/api/company/cases/settle" && method === "POST") {
                    const input = fields(body, ["caseId", "fence", "claimToken", "outcome", "note"]);
                    return { status: 200, body: await kernel.settleClaim(memberToken, input) };
                }
                return { status: 404, body: { error: "No such company operation." } };
            }
            catch (error) {
                return fail(error, path);
            }
        },
    };
}
/** Explicit trusted configuration only; never reuse the local developer DB. */
export function configuredCompanyKernel() {
    const connectionString = process.env.REALBUD_COMPANY_DATABASE_URL;
    if (!connectionString)
        return { kernel: null, close: async () => { } };
    const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10_000,
        statement_timeout: 10_000, application_name: "realbud-company-service" });
    pool.on("error", () => { });
    return { kernel: createCompanyKernel(pool), close: () => pool.end() };
}

import { api } from "@/state/store";
import type { CompanyInvitationResponse, CompanyMemberSummary, CompanySessionResponse, CompanyStatus, CompanySummary, CompanyWorkflowTemplate, CompanyWorkflowTemplateState } from "@shared/company-api";
import type { AcceptSharedWorkInput, CloseSharedWorkInput, ReassignSharedWorkInput, RespondToSharedWorkInput, ShareWorkInput } from "@shared/company-work";
import { parseSharedWorkHistory, parseSharedWorkItemResponse, parseSharedWorkList, parseWorkMembers } from "./company-work-response";

const STORAGE_KEY = "realbud.company-member-session";
type Request = (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<unknown>;
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Operation = "check" | "create" | "join" | "connect" | "recover" | "invite" | "logout" | "signin" | "credentials" | "setup" | "templates" | "work";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const credential = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._~-]{24,512}$/.test(value);
const company = (value: unknown): value is CompanySummary => object(value) && typeof value.id === "string" && !!value.id && typeof value.name === "string" && !!value.name;
const member = (value: unknown): value is CompanyMemberSummary => object(value) && typeof value.id === "string" && !!value.id && typeof value.displayName === "string" && !!value.displayName && ["owner", "member"].includes(String(value.role));
const incomplete = () => new Error("The company service returned an incomplete response. Check company status before trying again.");

function safeError(cause: unknown, operation: Operation): Error {
  const status = object(cause) && typeof cause.status === "number" ? cause.status : undefined;
  let message = "Company status could not be checked. Try again when the local service is available.";
  if (status === 422 && operation === "work") message = "Shared work needs service recovery. The original record is preserved. Contact service administration; retrying will not repair it.";
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
  else if (operation === "work") message = "Shared work could not be confirmed. Check the host connection, then retry or refresh.";
  return Object.assign(new Error(message), { status });
}

/** The member token is tab-scoped, never a URL/query parameter or localStorage value. */
export function createCompanyApi(request: Request, storage?: SessionStorage) {
  let token = "";
  let epoch = 0;
  const listeners = new Set<() => void>();
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
      const result = await request(path, { headers, ...(body !== undefined ? { method, body: JSON.stringify(body) } : {}) }, { timeoutMs: path === "/api/company/setup" ? 120_000 : 15_000 });
      if (requestEpoch !== epoch) throw new Error("Company session changed. Check company status again.");
      return result;
    } catch (cause) {
      const memberSessionEnded = !["credentials", "setup", "create"].includes(operation) && requestEpoch === epoch && object(cause) && cause.status === 401;
      if (memberSessionEnded) { invalidate(); saveToken(""); }
      throw Object.assign(safeError(cause, operation), { memberSessionEnded });
    }
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
    subscribeSession(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
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
    setup: () => call("/api/company/setup", "setup", {}),
    async connectHost(hostCode: string) { invalidate(); await call("/api/company/connect-host", "connect", { hostCode }); saveToken(""); },
    enableJoining: (hostname: string) => call("/api/company/network", "setup", { hostname }),
    async hostCode(): Promise<string> {
      const result = await call("/api/company/host-code", "check");
      if (!object(result) || typeof result.hostCode !== "string" || !result.hostCode.startsWith("RB1.")) throw incomplete();
      return result.hostCode;
    },
    async invite(displayName: string): Promise<CompanyInvitationResponse> {
      const result = await call("/api/company/invitations", "invite", { displayName });
      if (!object(result) || !credential(result.invitationToken) || typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt))) throw incomplete();
      return { invitationToken: result.invitationToken, expiresAt: result.expiresAt };
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

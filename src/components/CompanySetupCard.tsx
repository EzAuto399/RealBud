import { useEffect, useId, useRef, useState } from "react";
import type { CompanyInvitationResponse, CompanySessionResponse, CompanyStatus, DepartmentPage } from "@shared/company-api";
import { companyApi } from "@/lib/company-api";
import { api } from '@/state/store';
import { readDepartmentDraftActor, departmentDraftActorScope, type DepartmentDraftActor } from '@/lib/department-configuration-draft-journal';
import { SERVICE_ADMIN_CHANGED } from "@/lib/service-admin-session";
import { monitorCompanyStatus } from "@/lib/company-status-monitor";
import { revealSettingsTarget } from "@/lib/you-navigation";
import { JOIN_INPUT_MAX_LENGTH, encodeCompanyJoinCode, invitationFromJoinInput, isCompanyJoinCode, joinCodeFailureMessage, readCompanyJoinTarget } from "@/lib/company-join-code";
import { Card } from "./SettingsPrimitives";
import { CompanyMembers } from './CompanyMembers';
import { CompanyDepartments } from './CompanyDepartments';
import { CompanyPortalBindingsCard } from './company/CompanyPortalBindingsCard';
import { CompanyRecovery } from './CompanyRecovery';
import { CompanyHostRecovery } from './CompanyHostRecovery';
import { CopyButton } from './CopyButton';

const inputClass = "mt-1 w-full rounded-lg border border-line bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-agency";
const controlClass = "min-h-11 rounded-lg border px-3 py-2 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-agency disabled:cursor-not-allowed disabled:opacity-50";
const buttonClass = `${controlClass} border-line text-ink hover:bg-raised`;
const primaryClass = `${controlClass} border-agency bg-agency text-white hover:bg-agency-hover`;
const labelClass = "text-[12.5px] text-ink-secondary";
const summaryClass = "cursor-pointer py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-agency";
const carryOver = "Joining connects this computer to the office for shared department work. Its own Desk book and Bud setup stay on this computer.";

type Invitation = CompanyInvitationResponse & { displayName: string };
type UsableDepartments = { names: string[]; more: boolean };

/** Departments this person can use: active ones they hold access to (an owner manages all). */
export function usableDepartments(page: DepartmentPage): UsableDepartments {
  return { names: page.departments.filter(item => !item.retiredAt && (page.canManage || item.access !== "none")).map(item => item.name), more: page.hasMore };
}

/** This destination exposes the existing sign-in, never grants administration. */
export function CompanyAdministrationRecovery({ status, onOpen }: { status: CompanyStatus; onOpen?: () => void }) {
  return <div className="space-y-2">
    <p className="text-[13px] leading-relaxed text-ink-secondary">A service administrator needs to activate office hosting on this computer. Your private book and Work remain available.</p>
    {status.member?.role === 'member' ? <>
      <p className="text-[12.5px] text-ink-secondary">Ask your office owner to arrange setup. Office membership does not grant service administration.</p>
      <CopyButton label="Copy request for your owner" text="Please arrange service administrator setup for office hosting on this computer. Open Workspace → Settings & help → Service administration. My private book and Work remain available; I need the existing host or a join code to use shared office work." />
    </> : onOpen ? <button type="button" className={`pm-control ${buttonClass}`} onClick={onOpen}>Open service administration</button>
      : <a className={`pm-control ${buttonClass}`} href="#you-service-admin">Open service administration</a>}
  </div>;
}

/** A pasted join code gets a sentence about its failing part; everything else keeps the host's wording. */
async function explainJoinCode<T>(stage: "connect" | "join", fromJoinCode: boolean, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    const { status, code } = (cause ?? {}) as { status?: number; code?: unknown };
    const message = fromJoinCode ? joinCodeFailureMessage(stage, status) : undefined;
    throw message ? Object.assign(new Error(message), { status, code }) : cause;
  }
}

/**
 * Office & colleagues. The main view shows only the essentials for the current state;
 * everything rare folds into one closed "Office settings" disclosure. It never switches
 * Desk, Ask or source access. `onSummary` gets a few words for the Workspace row.
 */
export function CompanySetupCard({ onServiceAdministration, onSummary }: { onServiceAdministration?: () => void; onSummary?: (summary: string) => void }) {
  const [intent, setIntent] = useState<"join" | "host" | null>(null);
  const [status, setStatus] = useState<CompanyStatus | null>(null);
  const [departmentActor, setDepartmentActor] = useState<DepartmentDraftActor | null>(null);
  const [departmentIdentityError, setDepartmentIdentityError] = useState('');
  const [mode, setMode] = useState<"create" | "join" | "signin" | "recover" | null>(null);
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [savedRecoveryKey, setSavedRecoveryKey] = useState("");
  const [hostCode, setHostCode] = useState("");
  const [hostname, setHostname] = useState("");
  const [name, setName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [invitationToken, setInvitationToken] = useState("");
  const [inviteeName, setInviteeName] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [joinInput, setJoinInput] = useState("");
  const [joinFromCode, setJoinFromCode] = useState(false);
  const [joinCopy, setJoinCopy] = useState("");
  const [revealJoinCode, setRevealJoinCode] = useState(false);
  const [busy, setBusy] = useState("Checking office…");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [membersRevision, setMembersRevision] = useState(0);
  const [recoveryRemoteHost, setRecoveryRemoteHost] = useState(false);
  /** null until the recovery card has checked this computer. */
  const [recoveryAttention, setRecoveryAttention] = useState<boolean | null>(null);
  /** Departments this person can use; null while checking, "error" when they could not be checked. */
  const [departments, setDepartments] = useState<UsableDepartments | "error" | null>(null);
  const [memberCount, setMemberCount] = useState<{ active: number; more: boolean } | null>(null);
  const active = useRef(true);
  /** A user action or a foreground status check owns the card. */
  const pending = useRef(false);
  /** A background status check is in flight; it never blocks the person. */
  const checking = useRef(false);
  /** Bumped by every action and session change so a slower background check cannot overwrite its result. */
  const statusEpoch = useRef(0);
  const lastIdentity = useRef("");
  const departmentsRead = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const invitationInput = useRef<HTMLInputElement>(null);
  const joinCodeInput = useRef<HTMLInputElement>(null);
  const hostCodeInput = useRef<HTMLTextAreaElement>(null);
  const departmentsArea = useRef<HTMLDivElement>(null);
  const recoveryArea = useRef<HTMLDivElement>(null);
  const hostRecoveryArea = useRef<HTMLDivElement>(null);
  const recoveryKeyInput = useRef<HTMLInputElement>(null);
  const id = useId();

  const refresh = async (background = false): Promise<boolean | undefined> => {
    if (pending.current || (background && checking.current)) return;
    if (background) checking.current = true;
    else { pending.current = true; setBusy("Checking office…"); setError(""); setNotice(""); }
    const epoch = background ? statusEpoch.current : ++statusEpoch.current, session = companyApi.sessionVersion();
    const current = () => active.current && epoch === statusEpoch.current && session === companyApi.sessionVersion();
    try {
      const next = await companyApi.status();
      let actor: DepartmentDraftActor | null = null, identityError = '';
      if (next.company && next.member) {
        try { actor = readDepartmentDraftActor(await api('/api/company/local-state'), next, session); }
        catch (cause) { identityError = cause instanceof Error ? cause.message : 'The private workspace identity could not be checked. Check company status before reopening department edits.'; }
      }
      if (current()) {
        const identity = `${next.company?.id ?? ""}:${next.member?.id ?? ""}`;
        if (identity !== lastIdentity.current) {
          setInvitation(null); setSavedRecoveryKey(""); setHostCode("");
          setPassword(""); setCurrentPassword(""); setRecoveryKey(""); setInvitationToken("");
          setJoinInput(""); setJoinFromCode(false); setNotice(""); setDepartments(null); setMemberCount(null);
          lastIdentity.current = identity;
        }
        setStatus(next); setConnectionError(""); setLastChecked(new Date()); setMembersRevision(value => value + 1);
        setDepartmentActor(actor); setDepartmentIdentityError(identityError);
        if (next.member) setMode(null);
      }
      return true;
    }
    catch (cause) {
      // Keep the last confirmed membership; an unreachable host is not a sign-out.
      if (current()) setConnectionError(cause instanceof Error ? cause.message : "Office status could not be checked.");
      return false;
    }
    finally {
      if (background) checking.current = false;
      else { pending.current = false; if (active.current) setBusy(""); }
    }
  };
  useEffect(() => {
    active.current = true;
    void refresh();
    const stopMonitoring = monitorCompanyStatus({ check: () => refresh(true), visible: () => document.visibilityState === "visible", events: window, visibilityEvents: document });
    const onAdministrationChanged = () => { void refresh(); };
    window.addEventListener(SERVICE_ADMIN_CHANGED, onAdministrationChanged);
    // A different member session is a different identity: drop what the last one confirmed.
    const stopSession = companyApi.subscribeSession(() => { statusEpoch.current++; setStatus(null); setDepartmentActor(null); setDepartmentIdentityError(''); });
    return () => { active.current = false; statusEpoch.current++; stopSession(); stopMonitoring(); window.removeEventListener(SERVICE_ADMIN_CHANGED, onAdministrationChanged); };
  }, []);
  useEffect(() => { if (mode) firstInput.current?.focus(); }, [mode]);
  useEffect(() => {
    if (!status?.company || !status.member || departmentActor || departmentIdentityError) return;
    let current = true;
    const session = companyApi.sessionVersion(), epoch = statusEpoch.current;
    void Promise.all([companyApi.status(), api('/api/company/local-state')]).then(([checked, localState]) => {
      if (!current || !active.current || session !== companyApi.sessionVersion() || epoch !== statusEpoch.current) return;
      if (checked.company?.id !== status.company!.id || checked.member?.id !== status.member!.id || checked.member.role !== status.member!.role) throw new Error('The company identity changed. Check company status before reopening department edits.');
      setDepartmentActor(readDepartmentDraftActor(localState, checked, session));
    }).catch(cause => { if (current && active.current && session === companyApi.sessionVersion() && epoch === statusEpoch.current) setDepartmentIdentityError(cause instanceof Error ? cause.message : 'The private workspace identity could not be checked.'); });
    return () => { current = false; };
  }, [status, departmentActor, departmentIdentityError]);
  useEffect(() => { setJoinCopy(""); setRevealJoinCode(false); }, [invitation]);
  useEffect(() => { if (revealJoinCode) { joinCodeInput.current?.focus(); joinCodeInput.current?.select(); } }, [revealJoinCode]);
  // Each confirmed status also rechecks the status list's departments, so a grant made on
  // another computer shows up. A failed read keeps the last confirmed list.
  useEffect(() => {
    if (!status?.member || !status.company || (status.hostMode && status.hostMode !== "active")) return;
    const read = ++departmentsRead.current, session = companyApi.sessionVersion();
    void companyApi.departments(0).then(
      page => { if (active.current && read === departmentsRead.current && session === companyApi.sessionVersion()) setDepartments(usableDepartments(page)); },
      () => { if (active.current && read === departmentsRead.current) setDepartments(current => current ?? "error"); },
    );
  }, [membersRevision]);
  // A new recovery key shows on the main view; bring it into view even when it came from Office settings.
  useEffect(() => { if (savedRecoveryKey) { recoveryKeyInput.current?.scrollIntoView?.({ block: "nearest" }); recoveryKeyInput.current?.focus(); } }, [savedRecoveryKey]);

  const run = async (label: string, action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; statusEpoch.current++; setBusy(label); setError(""); setNotice("");
    try { await action(); }
    catch (cause) {
      if (active.current) {
        if ((cause as { memberSessionEnded?: boolean })?.memberSessionEnded && !mode) {
          setStatus(previous => previous ? { ...previous, member: undefined, company: undefined, setupAllowed: false } : null);
          setInvitation(null); setInvitationToken(""); setMode(null);
        }
        setError(cause instanceof Error ? cause.message : "The office action could not be completed.");
      }
    }
    finally { pending.current = false; if (active.current) setBusy(""); }
  };
  const acceptSession = (result: CompanySessionResponse) => {
    if (!active.current) return;
    lastIdentity.current = `${result.company.id}:${result.member.id}`;
    setConnectionError("");
    setStatus(previous => ({ ...previous, storageAvailable: true, configured: true, setupAllowed: false, ownerRecoveryAllowed: previous?.ownerRecoveryAllowed, transport: previous?.transport ?? "local-only", limitations: previous?.limitations ?? [], company: result.company, member: result.member, enrollmentPending: false }));
    setPassword(""); setCurrentPassword(""); setRecoveryKey(""); setSavedRecoveryKey(result.recoveryKey ?? "");
    setInvitationToken(""); setJoinFromCode(false); setInvitation(null); setMode(null);
    setNotice(`Signed in as ${result.member.displayName}.`);
    heading.current?.focus();
  };
  const joinOffice = () => explainJoinCode("join", joinFromCode || isCompanyJoinCode(invitationToken), () => companyApi.join(invitationFromJoinInput(invitationToken), { loginName, password }));
  const signIn = () => run(mode === "create" ? "Creating office…" : mode === "signin" ? "Signing in…" : mode === "recover" ? "Recovering sign-in…" : "Joining office…", async () => {
    const result = mode === "create" ? await companyApi.create({ name: name.trim(), ownerName: ownerName.trim(), credential: { loginName, password } }) : mode === "signin" ? await companyApi.signIn({ loginName, password }) : mode === "recover" ? await companyApi.recover({ loginName, recoveryKey, newPassword: password }) : await joinOffice();
    acceptSession(result);
  });
  /** Connects first, exactly as the two-step flow did; a join code also fills in the invitation. */
  const connect = () => run("Connecting to host…", async () => {
    const target = readCompanyJoinTarget(joinInput);
    const fromJoinCode = target.kind === "join-code";
    await explainJoinCode("connect", fromJoinCode, () => companyApi.connectHost(target.hostCode));
    if (!active.current) return;
    setJoinInput(""); setInvitationToken(fromJoinCode ? target.invitationToken : ""); setJoinFromCode(fromJoinCode);
    const next = await companyApi.status();
    if (!active.current) return;
    setStatus(next); setMode("join");
    setNotice(fromJoinCode ? "Connected to the office host. Choose your username and password to finish joining." : "Connected to the office host. Paste your private invitation, then choose your sign-in.");
  });
  const signOut = () => run("Signing out…", async () => {
    await companyApi.logout();
    if (!active.current) return;
    setStatus(previous => previous ? { ...previous, member: undefined, company: undefined, setupAllowed: false } : null);
    setInvitation(null); setInvitationToken(""); setJoinFromCode(false); setInviteeName(""); setMode(null);
    setPassword(""); setCurrentPassword(""); setSavedRecoveryKey(""); setRecoveryKey(""); setHostCode("");
    setNotice("Signed out of this office."); heading.current?.focus();
  });
  const invite = () => run("Creating invitation…", async () => {
    const displayName = inviteeName.trim();
    const result = await companyApi.invite(displayName);
    if (!active.current) return;
    setInvitation({ ...result, displayName }); setMembersRevision(value => value + 1);
    let code = hostCode;
    if (!code && status?.hostingAvailable && status.networkEnabled) {
      // The invitation already exists; a missing host code only means sharing the two values separately.
      try { code = await companyApi.hostCode(); } catch { code = ""; }
      if (!active.current) return;
      if (code) setHostCode(code);
    }
    setNotice(code ? `Join code ready for ${displayName}. Send it privately.` : "Invitation created. Copy it only for the intended person.");
  });
  const copyJoinCode = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setJoinCopy("Copied"); }
    catch {
      setRevealJoinCode(true); joinCodeInput.current?.focus(); joinCodeInput.current?.select();
      setJoinCopy("Copy was unavailable. The join code is shown and selected so you can copy it.");
    }
  };
  const copyHostCode = async () => {
    try { await navigator.clipboard.writeText(hostCode); setNotice("Host code copied."); }
    catch { hostCodeInput.current?.focus(); hostCodeInput.current?.select(); setNotice("Copy was unavailable. The host code is selected so you can copy it."); }
  };
  /** Opens a folded section and moves focus to its summary; it never acts by itself. */
  const reveal = (target: HTMLElement | null | undefined) => {
    if (!target) return;
    revealSettingsTarget(target);
    const summary = target.querySelector("summary");
    (summary ?? target).scrollIntoView({ block: "nearest" }); summary?.focus();
  };
  const openDepartments = () => reveal(departmentsArea.current?.querySelector("details"));
  /** Opens the existing offline-disconnect review; it never disconnects by itself. */
  const openOfflineDisconnect = () => reveal(recoveryArea.current?.querySelector<HTMLElement>("[data-offline-disconnect]"));
  const openRecovery = () => reveal(recoveryArea.current?.querySelector<HTMLElement>("details, [role=alert]"));
  const openHostRecovery = () => reveal(hostRecoveryArea.current?.querySelector("details"));
  const copyInvitation = async () => {
    if (!invitation) return;
    try { await navigator.clipboard.writeText(invitation.invitationToken); setNotice("Invitation copied. Share it privately with the intended person."); }
    catch { invitationInput.current?.focus(); invitationInput.current?.select(); setNotice("Copy was unavailable. The invitation is selected so you can copy it."); }
  };
  const chooseSetup = !!status && !status.storageAvailable && !status.remoteHost;
  const hostHeld = !!status?.hostMode && status.hostMode !== "active";
  const signedIn = !!status?.member && !!status.company;
  const canInvite = status?.member?.role === "owner" && !hostHeld;
  let joinCode = "";
  if (invitation && hostCode) { try { joinCode = encodeCompanyJoinCode(hostCode, invitation.invitationToken); } catch { joinCode = ""; } }
  const joiningHost = !!status?.remoteHost;
  const hostUnreachable = !!connectionError && (recoveryRemoteHost || !!status?.remoteHost);
  const lastCheck = lastChecked ? `Last successful check: ${lastChecked.toLocaleString()}.` : "";
  const people = memberCount ? `${memberCount.active}${memberCount.more ? "+" : ""} ${memberCount.active === 1 && !memberCount.more ? "person" : "people"}` : "";
  const summary = hostUnreachable ? "Can’t reach host"
    : connectionError ? "Can’t check right now"
    : !status ? "Checking…"
    : signedIn ? (hostHeld ? "On hold for host recovery" : status.remoteHost ? `Joined ${status.company!.name}` : people ? `Hosting · ${people}` : `Hosting ${status.company!.name}`)
    : status.configured ? "Sign-in needed" : "Not set up";
  const rowSummary = recoveryAttention && status ? `${summary} · needs attention` : summary;
  useEffect(() => { onSummary?.(rowSummary); }, [rowSummary]);
  const linkButton = "ml-2 inline-flex min-h-11 items-center text-[13px] font-medium text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-agency";
  const departmentNames = hostHeld ? "Unavailable while on hold" : departments === null ? "Checking…" : departments === "error" ? "Couldn’t check" : departments.names.length ? `${departments.names.join(", ")}${departments.more ? ", and more" : ""}` : "None yet";
  const unreachableHelp = <>
    <p className="text-[12.5px] leading-relaxed text-ink-secondary">Keep RealBud open on the host computer and check its network connection. This screen checks again automatically. Work is not replayed when the connection returns.</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={!!busy} onClick={() => void refresh()} className={buttonClass}>Check again</button>
      <button type="button" onClick={openOfflineDisconnect} className={buttonClass}>Can’t reach the host? Disconnect this computer</button>
    </div>
  </>;

  return <Card>
    <section aria-labelledby={`${id}-heading`} aria-busy={!!busy} className="flex flex-col gap-4">
      <div>
        <h3 ref={heading} tabIndex={-1} id={`${id}-heading`} className="sr-only">Office &amp; colleagues</h3>
        {signedIn ? <p className="mt-0.5 break-words text-[14px] font-medium text-ink">{status!.company!.name}</p>
          : <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">Optional. Work on your own, or join colleagues to share reviewed work.</p>}
      </div>

      {status?.member && status.company ? <>
        <dl aria-label="Office status" className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-ink-secondary">Office host</dt>
          <dd className="min-w-0 break-words text-ink">{hostUnreachable ? <><span role="alert" className="font-medium text-danger">Can’t reach the office host.</span> <span className="text-ink-secondary">{lastCheck}</span></>
            : connectionError ? <><span role="alert" className="text-danger">{connectionError}</span> <span className="text-ink-secondary">{lastCheck}</span></>
            : hostHeld ? "On hold" : status.remoteHost ? "Connected" : "This computer"}</dd>
          <dt className="text-ink-secondary">Signed in as</dt>
          <dd className="min-w-0 break-words text-ink">{status.member.displayName} ({status.member.role})</dd>
          <dt className="text-ink-secondary">This computer</dt>
          <dd className="min-w-0 break-words text-ink">{hostHeld ? <>On hold for host recovery{!status.remoteHost && <button type="button" className={linkButton} onClick={openHostRecovery}>Review</button>}</>
            : recoveryAttention ? <>Needs attention<button type="button" className={linkButton} onClick={openRecovery}>Review</button></>
            : recoveryAttention === null ? "Checking…" : "Ready"}</dd>
          <dt className="text-ink-secondary">Departments you can use</dt>
          <dd className="min-w-0 break-words text-ink">{departmentNames}</dd>
        </dl>
        {hostUnreachable && unreachableHelp}
        {hostHeld && <p role="status" className="text-[13px] text-ink-secondary">Collaboration is held for recovery or retirement. {status.remoteHost ? "The owner must finish the host cutover. Your private work stays available." : "Finish Host backup and recovery in Office settings before inviting people or changing shared work."}</p>}
        {savedRecoveryKey && <div role="group" aria-label="Your new recovery key" className="rounded-lg border border-agency bg-inset p-3">
          <label className={labelClass}>Your new recovery key<input ref={recoveryKeyInput} readOnly type="password" value={savedRecoveryKey} className={inputClass} onFocus={event => event.target.select()} /></label>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Save this now somewhere private. You need it if you forget your password. It is shown only in this window and replaces your previous key.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => { void navigator.clipboard.writeText(savedRecoveryKey).then(() => setNotice("Recovery key copied."), () => setNotice("Select the recovery key and copy it manually.")); }}>Copy recovery key</button>
            <button type="button" className={buttonClass} onClick={() => { setSavedRecoveryKey(""); setNotice("Recovery key hidden. Keep your saved copy private."); heading.current?.focus(); }}>I’ve saved it</button>
          </div>
        </div>}
        {canInvite && <CompanyMembers view="roster" key={`roster:${status.company.id}:${status.member.id}:${status.member.role}`} status={status} refreshKey={membersRevision} onChanged={() => refresh()} onCount={(active, more) => setMemberCount({ active, more })} />}
        {canInvite && <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-[13px] font-medium text-ink">Invite someone</summary>
          <div className="mt-3 flex flex-col gap-3">
            {status.hostingAvailable && !status.networkEnabled && <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void run("Enabling joining…", async () => { await companyApi.enableJoining(hostname); setStatus(await companyApi.status()); setHostCode(await companyApi.hostCode()); setNotice("Joining is on. Now enter who you are inviting."); }); }}>
              <p className="text-[12px] leading-relaxed text-ink-secondary">First, let other computers find this one. Keep RealBud open here, awake and on your office network. Service administrator sign-in is required to enable joining.</p>
              <label className={labelClass}>This computer’s network name or IP address<input value={hostname} onChange={event => setHostname(event.target.value)} required maxLength={253} className={inputClass} placeholder="For example, office-host.local" /></label>
              <button disabled={!!busy} className={`${buttonClass} self-start`}>Enable joining</button>
            </form>}
            <form onSubmit={event => { event.preventDefault(); void invite(); }}>
              <fieldset disabled={!!busy} className="flex flex-col gap-3">
                <legend className="sr-only">Invite a member</legend>
                <label className={labelClass}>Member’s name
                  <input value={inviteeName} onChange={event => { setInviteeName(event.target.value); setInvitation(null); }} maxLength={100} autoComplete="off" required className={inputClass} placeholder="Who is joining?" />
                </label>
                <p className="text-[12px] leading-relaxed text-ink-muted">They join as a member, not an owner. The code works once before it expires. Anyone with it can join, so send it privately.</p>
                <button type="submit" disabled={!inviteeName.trim()} className={`${buttonClass} self-start`}>Create invitation</button>
              </fieldset>
            </form>
            {invitation && <div className="flex flex-col gap-3 rounded-lg border border-line bg-inset p-3">
              {joinCode ? <>
                <label className={labelClass}>Join code for {invitation.displayName}
                  <input ref={joinCodeInput} type={revealJoinCode ? "text" : "password"} readOnly autoComplete="off" spellCheck={false} value={joinCode} aria-describedby={`${id}-join-code-help`} className={`${inputClass} font-mono`} />
                </label>
                <p id={`${id}-join-code-help`} className="text-[12px] leading-relaxed text-ink-secondary">Send it privately to {invitation.displayName}. On their computer they choose Join an office and paste it. It works once and expires {new Date(invitation.expiresAt).toLocaleString()}.</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => void copyJoinCode(joinCode)} className={buttonClass}>Copy join code</button>
                  <span role="status" aria-live="polite" className="text-[12.5px] text-ink-secondary">{joinCopy}</span>
                </div>
                <details>
                  <summary className={summaryClass}>Separate codes for older versions</summary>
                  <p className="text-[12px] text-ink-secondary">Older versions of RealBud ask for the host code first, then the private invitation.</p>
                  <label className={`${labelClass} mt-2 block`}>Host code<textarea ref={hostCodeInput} readOnly value={hostCode} rows={3} className={`${inputClass} font-mono`} onFocus={event => event.target.select()} /></label>
                  <button type="button" onClick={() => void copyHostCode()} className={`${buttonClass} mt-2`}>Copy host code</button>
                  <label className={`${labelClass} mt-3 block`}>Private invitation
                    <input ref={invitationInput} type="password" readOnly autoComplete="off" value={invitation.invitationToken} className={`${inputClass} font-mono`} />
                  </label>
                  <button type="button" onClick={() => void copyInvitation()} className={`${buttonClass} mt-2`}>Copy invitation</button>
                </details>
              </> : <>
                <label className={labelClass}>Private invitation
                  <input ref={invitationInput} type="password" readOnly autoComplete="off" value={invitation.invitationToken} className={`${inputClass} font-mono`} />
                </label>
                <p className="text-[12px] text-ink-secondary">Expires {new Date(invitation.expiresAt).toLocaleString()}.</p>
                {status.hostingAvailable && <p className="text-[12px] leading-relaxed text-ink-secondary">{status.networkEnabled ? "The host code could not be loaded. Open Office settings → Office host network and choose Show host code to add a join code here." : "To invite another computer, choose Enable joining above. A join code then appears here."}</p>}
                <button type="button" onClick={() => void copyInvitation()} className={`${buttonClass} self-start`}>Copy invitation</button>
              </>}
              <p className="text-[12px] leading-relaxed text-ink-secondary">{invitation.displayName} starts with no department access. After they join, choose what they can use in Departments and access.</p>
              <button type="button" onClick={openDepartments} className={`${buttonClass} self-start`}>Open departments and access</button>
            </div>}
          </div>
        </details>}
        {!hostHeld && <div ref={departmentsArea}>{departmentActor ? <CompanyDepartments key={`departments:${departmentDraftActorScope(departmentActor)}`} draftActor={departmentActor} onAvailable={page => { departmentsRead.current++; setDepartments(page ? usableDepartments(page) : "error"); }} /> : <p role="alert" className="text-[13px] text-danger">{departmentIdentityError || 'Checking the private workspace identity before reopening department edits.'} Your previous typing remains private. Use Check company status below to retry.</p>}</div>}
      </> : <>
        {connectionError && <div className="rounded-lg border border-line bg-inset p-3 text-[12.5px] leading-relaxed text-ink-secondary">
          <p className="font-medium text-ink">{hostUnreachable ? "Can’t reach the office host" : "Office connection unavailable"}</p>
          <p role="alert" className="mt-1 text-danger">{hostUnreachable ? "Keep RealBud open on the host computer and check its network connection." : connectionError}</p>
          <p className="mt-1">{lastCheck ? `${lastCheck} ` : ""}This screen checks again automatically. Work is not replayed when the connection returns.</p>
          {hostUnreachable && <button type="button" onClick={openOfflineDisconnect} className={`${buttonClass} mt-2`}>Can’t reach the host? Disconnect this computer</button>}
        </div>}
        {recoveryAttention && <p className="text-[13px] text-ink-secondary">Something from an earlier office needs checking on this computer.<button type="button" className={linkButton} onClick={openRecovery}>Review</button></p>}
        {chooseSetup && <div role="group" aria-label="Choose how to start" className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <button type="button" className={`${intent === "join" ? primaryClass : buttonClass} self-start`} aria-pressed={intent === "join"} aria-describedby={`${id}-choose-join`} disabled={!!busy} onClick={() => setIntent(intent === "join" ? null : "join")}>Join an office</button>
            <p id={`${id}-choose-join`} className="text-[12.5px] leading-relaxed text-ink-secondary">Paste the join code your office owner sent you.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <button type="button" className={`${intent === "host" ? primaryClass : buttonClass} self-start`} aria-pressed={intent === "host"} aria-describedby={`${id}-choose-host`} disabled={!!busy} onClick={() => setIntent(intent === "host" ? null : "host")}>Host the office on this computer</button>
            <p id={`${id}-choose-host`} className="text-[12.5px] leading-relaxed text-ink-secondary">Colleagues connect to this computer, so it needs to stay on at the office.</p>
          </div>
        </div>}
        {chooseSetup && intent === "join" && (status?.remoteJoinAvailable ? <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void connect(); }}>
          <label className={labelClass}>Join code<input type="password" value={joinInput} onChange={event => setJoinInput(event.target.value)} required maxLength={JOIN_INPUT_MAX_LENGTH} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-join-help`} className={`${inputClass} font-mono`} placeholder="Paste the join code" /></label>
          <p id={`${id}-join-help`} className="text-[12px] leading-relaxed text-ink-muted">A host code from an older version also works. {carryOver}</p>
          <button disabled={!!busy || !joinInput.trim()} className={`${buttonClass} mt-1 self-start`}>Connect to host</button>
        </form> : <p className="text-[13px] text-ink-secondary">Joining an office isn’t available on this computer right now.{status?.limitations.length ? " Office settings → Current availability says why." : ""}</p>)}
        {chooseSetup && intent === "host" && <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink-secondary">
          {status?.storageSetupAvailable ? <>
            <p>This prepares office storage here. Your existing Desk stays available.</p>
            <button disabled={!!busy} className={`${primaryClass} self-start`} onClick={() => void run("Setting up this host…", async () => { await companyApi.setup(); setStatus(await companyApi.status()); setNotice("Host storage is ready. Create your office next."); })}>Set up this computer as host</button>
          </> : <CompanyAdministrationRecovery status={status!} onOpen={onServiceAdministration} />}
          {status?.hostRecoveryAvailable && <p className="text-[12px] text-ink-muted">Moving an office from another computer? Restore its backup in Office settings → Host backup and recovery.</p>}
        </div>}
        {status && !chooseSetup && !status.storageAvailable && (status.storageSetupAvailable ? <p className="text-[13px] leading-relaxed text-ink-secondary">Prepare storage on this computer, then create your office. Your existing Desk stays available.</p> : <><CompanyAdministrationRecovery status={status} onOpen={onServiceAdministration} /><p className="text-[12.5px] text-ink-secondary">To join an existing office, use the join code from its owner.</p></>)}
        {status?.storageAvailable && <>
          {status.configured || status.setupAllowed ? <p className="text-[13px] leading-relaxed text-ink-secondary">{status.configured ? "Sign in to your office, or join with an invitation from its owner." : "Create your office. You will be its owner."}</p> : <CompanyAdministrationRecovery status={status} onOpen={onServiceAdministration} />}
          <div className="flex flex-wrap gap-2">
            {!status.configured && status.setupAllowed && <button type="button" disabled={!!busy} aria-pressed={mode === "create"} className={mode === "create" ? primaryClass : buttonClass} onClick={() => { setMode("create"); setError(""); }}>Create office</button>}
            {status.configured && <button type="button" disabled={!!busy} aria-pressed={mode === "signin"} className={mode === "signin" ? primaryClass : buttonClass} onClick={() => { setMode("signin"); setError(""); }}>Sign in</button>}
            {status.configured && <button type="button" disabled={!!busy} aria-pressed={mode === "join"} className={mode === "join" ? primaryClass : buttonClass} onClick={() => { setMode("join"); setError(""); }}>Join with an invitation</button>}
            {status.configured && <button type="button" disabled={!!busy} aria-pressed={mode === "recover"} className={mode === "recover" ? primaryClass : buttonClass} onClick={() => { setMode("recover"); setError(""); }}>Use recovery key</button>}
          </div>
          {mode && <form onSubmit={event => { event.preventDefault(); void signIn(); }}>
            <fieldset disabled={!!busy} className="flex flex-col gap-3">
              <legend className="sr-only">{mode === "create" ? "Create office" : mode === "signin" ? "Sign in" : mode === "recover" ? "Recover sign-in" : "Join office"}</legend>
              {mode === "create" ? <>
                <label className={labelClass}>Office name
                  <input ref={firstInput} value={name} onChange={event => setName(event.target.value)} autoComplete="organization" maxLength={100} required className={inputClass} />
                </label>
                <label className={labelClass}>Your name
                  <input value={ownerName} onChange={event => setOwnerName(event.target.value)} autoComplete="name" maxLength={100} required className={inputClass} />
                </label>
                <p className="text-[12px] text-ink-muted">You will be the office owner and can invite colleagues.</p>
              </> : mode === "signin" || mode === "recover" ? <>
                <label className={labelClass}>Username<input ref={firstInput} value={loginName} onChange={event => setLoginName(event.target.value)} autoComplete="username" autoCapitalize="none" minLength={3} maxLength={80} required className={inputClass} /></label>
                {mode === "recover" && <label className={labelClass}>Recovery key<input type="password" value={recoveryKey} onChange={event => setRecoveryKey(event.target.value)} autoComplete="off" required maxLength={100} className={inputClass} /></label>}
                <label className={labelClass}>{mode === "recover" ? "New password" : "Password"}<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === "recover" ? "new-password" : "current-password"} minLength={12} maxLength={256} required className={inputClass} /></label>
              </> : <>
                <label className={labelClass}>Private invitation
                  <input ref={joinFromCode ? undefined : firstInput} type="password" value={invitationToken} onChange={event => { setInvitationToken(event.target.value); setJoinFromCode(false); }} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={JOIN_INPUT_MAX_LENGTH} required className={inputClass} />
                  <span className="mt-1 block text-[12px] text-ink-muted">{joinFromCode ? "Filled in from your join code." : "Paste the one-use invitation or join code from your office owner."}</span>
                </label>
                {joiningHost && <p className="text-[12px] leading-relaxed text-ink-secondary">{carryOver}</p>}
              </>}
              {(mode === "create" || mode === "join") && <>
                <p className="text-[12px] text-ink-muted">Choose your own sign-in now so you can return after closing RealBud. You’ll receive a personal recovery key to save.</p>
                <label className={labelClass}>Username<input ref={mode === "join" && joinFromCode ? firstInput : undefined} value={loginName} onChange={event => setLoginName(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9._\-]{3,80}" minLength={3} maxLength={80} required className={inputClass} /><span className="mt-1 block text-[12px] text-ink-muted">3–80 letters, numbers, dots, underscores or hyphens.</span></label>
                <label className={labelClass}>Password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={256} required className={inputClass} /><span className="mt-1 block text-[12px] text-ink-muted">Use at least 12 characters.</span></label>
              </>}
              <button type="submit" disabled={!loginName || !password || (mode === "create" ? !name.trim() || !ownerName.trim() : mode === "join" ? !invitationToken.trim() : false)} className={`${primaryClass} self-start`}>{mode === "create" ? "Create and sign in" : mode === "join" ? "Join and sign in" : mode === "recover" ? "Recover my sign-in" : "Sign in"}</button>
            </fieldset>
          </form>}
        </>}
      </>}

      {status?.enrollmentPending && <p role="alert" className="text-[13px] text-ink-secondary">An earlier setup attempt needs confirmation. Sign in with the username and password you chose. If your recovery key was not shown, open Office settings → Set up or change your sign-in after signing in to create a new one.</p>}
      {status?.networkError && <p role="alert" className="text-[13px] text-danger">{status.networkError}</p>}
      {status?.setupError && <p role="alert" className="text-[13px] text-danger">{status.setupError}</p>}
      {error && <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>}
      <p role="status" aria-live="polite" className="text-[12.5px] text-ink-secondary empty:hidden">{busy || (!connectionError ? notice : "")}</p>

      <details className="rounded-lg border border-line p-3" data-office-settings="">
        <summary className="min-h-11 cursor-pointer content-center text-[13px] font-medium text-ink focus-visible:outline-2 focus-visible:outline-agency">Office settings</summary>
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-ink-secondary">Less common changes, recovery and troubleshooting. Your Desk, Ask history and sources stay on this computer; they are not shared automatically.</p>
          {status?.member && status.company && <>
            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-[13px] font-medium text-ink">Set up or change your sign-in</summary>
              <p className="mt-2 text-[12px] text-ink-secondary">New members set their sign-in when joining. Use this if you joined an older version without a password, or want to change your sign-in. You get a new personal recovery key to save.</p>
              <form className="mt-3 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void run("Saving sign-in…", async () => {
                const result = await companyApi.credentials({ loginName, password, ...(currentPassword ? { currentPassword } : {}) });
                setSavedRecoveryKey(result.recoveryKey); setPassword(""); setCurrentPassword(""); setNotice("Sign-in saved. Store your new recovery key privately.");
              }); }}>
                <label className={labelClass}>Username<input value={loginName} onChange={event => setLoginName(event.target.value)} required minLength={3} maxLength={80} autoComplete="username" autoCapitalize="none" className={inputClass} /></label>
                <label className={labelClass}>Current password (leave blank for first setup)<input type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" maxLength={256} className={inputClass} /></label>
                <label className={labelClass}>New password<input type="password" value={password} onChange={event => setPassword(event.target.value)} required minLength={12} maxLength={256} autoComplete="new-password" className={inputClass} /></label>
                <button disabled={!!busy} className={`${buttonClass} self-start`}>Save my sign-in</button>
              </form>
            </details>
            {!hostHeld && <CompanyMembers key={`${status.company.id}:${status.member.id}:${status.member.role}`} status={status} refreshKey={membersRevision} onChanged={() => refresh()} />}
            {canInvite && status.hostingAvailable && status.networkEnabled && <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer text-[13px] font-medium text-ink">Office host network</summary>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">Other computers use this host code to find this one. It does not let anyone join by itself; each person still needs their own invitation.</p>
              <button disabled={!!busy} className={`${buttonClass} mt-3`} onClick={() => void run("Getting host code…", async () => { setHostCode(await companyApi.hostCode()); })}>Show host code</button>
              {hostCode && <label className={`${labelClass} mt-3 block`}>Host code<textarea readOnly value={hostCode} rows={3} className={inputClass} onFocus={event => event.target.select()} /></label>}
              <details className="mt-3"><summary className={summaryClass}>Renew certificate or change network address</summary><p className="text-[12px] text-ink-secondary">This replaces the network identity and briefly disconnects members. Everyone must use the new host code with “Reconnect to replacement host”. Their office membership and private work stay unchanged.</p><form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void run("Renewing host identity…", async () => { await companyApi.enableJoining(hostname, true); setStatus(await companyApi.status()); setHostCode(await companyApi.hostCode()); setNotice("Network identity renewed. Give every member the new host code."); }); }}><label className={labelClass}>Current network name or IP address<input className={inputClass} value={hostname} onChange={event => setHostname(event.target.value)} required maxLength={253} /></label><button className={buttonClass} disabled={!!busy}>Renew identity and disconnect current clients</button></form></details>
            </details>}
            {!hostHeld && <CompanyPortalBindingsCard key={`portal:${status.company.id}:${status.member.id}:${status.member.role}`} status={status} />}
          </>}
          {!!status?.limitations.length && <details className="rounded-lg border border-line p-3 text-[12px] text-ink-secondary"><summary className="cursor-pointer text-[13px] font-medium text-ink focus-visible:outline-2 focus-visible:outline-agency">Current availability</summary><ul className="mt-2 list-disc space-y-1 pl-4">{status.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>}
          <div ref={recoveryArea} className="contents"><CompanyRecovery onChanged={() => refresh()} onRemoteHost={setRecoveryRemoteHost} onAttention={setRecoveryAttention} /></div>
          {status && <div ref={hostRecoveryArea} className="contents"><CompanyHostRecovery status={status} onChanged={() => refresh()} /></div>}
          {status?.member && status.company && <p className="text-[12px] leading-relaxed text-ink-muted">This session stays in this app window. Office membership does not give anyone access to a colleague’s private accounts or conversations.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!!busy} onClick={() => void refresh()} className={buttonClass}>Check company status</button>
            {status?.member && status.company && <button type="button" onClick={() => void signOut()} disabled={!!busy} className={buttonClass}>Sign out of office</button>}
          </div>
          {status?.member && status.company && <p className="text-[12px] leading-relaxed text-ink-muted">Signing out ends this window’s session. It does not leave the office, unlink its host or remove your local work.</p>}
        </div>
      </details>
    </section>
  </Card>;
}

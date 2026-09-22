import { useEffect, useId, useRef, useState } from "react";
import type { CompanyInvitationResponse, CompanySessionResponse, CompanyStatus } from "@shared/company-api";
import { companyApi } from "@/lib/company-api";
import { SERVICE_ADMIN_CHANGED } from "@/lib/service-admin-session";
import { monitorCompanyStatus } from "@/lib/company-status-monitor";
import { JOIN_INPUT_MAX_LENGTH, encodeCompanyJoinCode, invitationFromJoinInput, isCompanyJoinCode, joinCodeFailureMessage, readCompanyJoinTarget } from "@/lib/company-join-code";
import { Card } from "./SettingsPrimitives";
import { CompanyMembers } from './CompanyMembers';
import { CompanyDepartments } from './CompanyDepartments';
import { CompanyPortalBindingsCard } from './company/CompanyPortalBindingsCard';
import { CompanyRecovery } from './CompanyRecovery';
import { CompanyHostRecovery } from './CompanyHostRecovery';

const inputClass = "mt-1 w-full rounded-lg border border-line bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-agency";
const controlClass = "min-h-10 rounded-lg border px-3 py-2 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-agency disabled:cursor-not-allowed disabled:opacity-50";
const buttonClass = `${controlClass} border-line text-ink hover:bg-raised`;
const primaryClass = `${controlClass} border-agency bg-agency text-white hover:bg-agency-hover`;
const labelClass = "text-[12.5px] text-ink-secondary";
const summaryClass = "cursor-pointer py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-agency";
const carryOver = "Joining connects this computer to the office for shared department work. Its own Desk book and Bud setup stay on this computer.";

type Invitation = CompanyInvitationResponse & { displayName: string };

/** A pasted join code gets a sentence about its failing part; everything else keeps the host's wording. */
async function explainJoinCode<T>(stage: "connect" | "join", fromJoinCode: boolean, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    const { status, code } = (cause ?? {}) as { status?: number; code?: unknown };
    const message = fromJoinCode ? joinCodeFailureMessage(stage, status) : undefined;
    throw message ? Object.assign(new Error(message), { status, code }) : cause;
  }
}

/** Local company foundation only. It does not switch Desk, Ask or source access. */
export function CompanySetupCard() {
  const [intent, setIntent] = useState<"solo" | "join" | "host">("solo");
  const [status, setStatus] = useState<CompanyStatus | null>(null);
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
  const [busy, setBusy] = useState("Checking company…");
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  const pending = useRef(false);
  const lastIdentity = useRef("");
  const heading = useRef<HTMLHeadingElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const invitationInput = useRef<HTMLInputElement>(null);
  const joinCodeInput = useRef<HTMLInputElement>(null);
  const hostCodeInput = useRef<HTMLTextAreaElement>(null);
  const departmentsArea = useRef<HTMLDivElement>(null);
  const id = useId();

  const refresh = async (background = false): Promise<boolean | undefined> => {
    if (pending.current) return;
    pending.current = true; setBusy("Checking company…");
    if (!background) setError("");
    try {
      const next = await companyApi.status();
      if (active.current) {
        const identity = `${next.company?.id ?? ""}:${next.member?.id ?? ""}`;
        if (identity !== lastIdentity.current) {
          setInvitation(null); setSavedRecoveryKey(""); setHostCode("");
          setPassword(""); setCurrentPassword(""); setRecoveryKey(""); setInvitationToken("");
          setJoinInput(""); setJoinFromCode(false); setNotice("");
          lastIdentity.current = identity;
        }
        setStatus(next); setConnectionError("");
        if (next.member) setMode(null);
      }
      return true;
    }
    catch (cause) {
      if (active.current) { setStatus(null); setConnectionError(cause instanceof Error ? cause.message : "Company status could not be checked."); }
      return false;
    }
    finally { pending.current = false; if (active.current) setBusy(""); }
  };
  useEffect(() => {
    active.current = true;
    void refresh();
    const stopMonitoring = monitorCompanyStatus({ check: () => refresh(true), visible: () => document.visibilityState === "visible", events: window, visibilityEvents: document });
    const onAdministrationChanged = () => { void refresh(); };
    window.addEventListener(SERVICE_ADMIN_CHANGED, onAdministrationChanged);
    return () => { active.current = false; stopMonitoring(); window.removeEventListener(SERVICE_ADMIN_CHANGED, onAdministrationChanged); };
  }, []);
  useEffect(() => { if (mode) firstInput.current?.focus(); }, [mode]);
  useEffect(() => { setJoinCopy(""); setRevealJoinCode(false); }, [invitation]);
  useEffect(() => { if (revealJoinCode) { joinCodeInput.current?.focus(); joinCodeInput.current?.select(); } }, [revealJoinCode]);

  const run = async (label: string, action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(label); setError(""); setNotice("");
    try { await action(); }
    catch (cause) {
      if (active.current) {
        if ((cause as { memberSessionEnded?: boolean })?.memberSessionEnded && !mode) {
          setStatus(previous => previous ? { ...previous, member: undefined, company: undefined, setupAllowed: false } : null);
          setInvitation(null); setInvitationToken(""); setMode(null);
        }
        setError(cause instanceof Error ? cause.message : "The company action could not be completed.");
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
  const signIn = () => run(mode === "create" ? "Creating company…" : mode === "signin" ? "Signing in…" : mode === "recover" ? "Recovering sign-in…" : "Joining company…", async () => {
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
    setNotice("Signed out of this company session."); heading.current?.focus();
  });
  const invite = () => run("Creating invitation…", async () => {
    const displayName = inviteeName.trim();
    const result = await companyApi.invite(displayName);
    if (!active.current) return;
    setInvitation({ ...result, displayName });
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
  const openDepartments = () => {
    const details = departmentsArea.current?.querySelector("details");
    if (!details) return;
    details.open = true;
    const summary = details.querySelector("summary");
    summary?.scrollIntoView({ block: "nearest" }); summary?.focus();
  };
  const copyInvitation = async () => {
    if (!invitation) return;
    try { await navigator.clipboard.writeText(invitation.invitationToken); setNotice("Invitation copied. Share it privately with the intended person."); }
    catch { invitationInput.current?.focus(); invitationInput.current?.select(); setNotice("Copy was unavailable. The invitation is selected so you can copy it."); }
  };
  const chooseSetup = !!status && !status.storageAvailable && !status.remoteHost;
  const hostHeld = !!status?.hostMode && status.hostMode !== "active";
  const canInvite = status?.member?.role === "owner" && !hostHeld;
  let joinCode = "";
  if (invitation && hostCode) { try { joinCode = encodeCompanyJoinCode(hostCode, invitation.invitationToken); } catch { joinCode = ""; } }
  const joiningHost = !!status?.remoteHost;

  return <Card>
    <section aria-labelledby={`${id}-heading`} aria-busy={!!busy} className="flex flex-col gap-4">
      <div>
        <h3 ref={heading} tabIndex={-1} id={`${id}-heading`} className="text-[15px] font-medium text-ink focus:outline-none">Local office collaboration</h3>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">Optional. Use RealBud on your own, or join colleagues to exchange reviewed work and workflow templates.</p>
      </div>
      {chooseSetup && <div className="space-y-2"><p className="text-[13px] text-ink-secondary">Keep your private workspace independent, or add collaboration when you need it.</p><div className="flex flex-wrap gap-2" role="group" aria-label="Choose collaboration setup"><button className={intent === 'solo' ? primaryClass : buttonClass} aria-pressed={intent === 'solo'} disabled={!!busy} onClick={() => setIntent('solo')}>Use on my own</button><button className={intent === 'join' ? primaryClass : buttonClass} aria-pressed={intent === 'join'} disabled={!!busy} onClick={() => setIntent('join')}>Join an office</button><button className={intent === 'host' ? primaryClass : buttonClass} aria-pressed={intent === 'host'} disabled={!!busy} onClick={() => setIntent('host')}>Host this office</button></div></div>}
      {(!chooseSetup || intent !== 'solo') && <div className="rounded-lg border border-line bg-inset p-3 text-[12.5px] leading-relaxed text-ink-secondary">
        <p className="font-medium text-ink">{connectionError ? "Company connection unavailable" : hostHeld ? "Office host on hold" : status?.transport === "encrypted-company" ? "Company host reached" : status?.configured ? "Local office · preview" : "Company setup preview"}</p>
        <p className="mt-1">One existing office computer can host collaboration. To join it, paste the join code from your office owner. Your Desk, Ask history and sources stay on this computer; they are not automatically shared.</p>
        {!status?.member && <p className="mt-2">Joining keeps your existing private Bud, model setup and local work. Only the work you explicitly review and share goes to colleagues.</p>}
        {connectionError && <p className="mt-2">Keep RealBud open on the host computer and check its network connection. This screen checks again automatically. Work is not replayed when the connection returns.</p>}
      </div>}
      {status?.member && status.company ? <>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-ink-secondary">Company</dt><dd className="break-words font-medium text-ink">{status.company.name}</dd>
          <dt className="text-ink-secondary">Signed in</dt><dd className="break-words text-ink">{status.member.displayName}</dd>
          <dt className="text-ink-secondary">Role</dt><dd className="capitalize text-ink">{status.member.role}</dd>
        </dl>
        <p className="text-[12px] leading-relaxed text-ink-muted">This session stays in this app window. Company membership does not grant access to a colleague’s private accounts or conversations.</p>
        {hostHeld && <p role="status" className="text-[13px] text-ink-secondary">Collaboration is held for recovery or retirement. {status.remoteHost ? "The owner must finish the host cutover. Your private work stays available." : "Complete Host backup and recovery below before inviting people or changing shared work."}</p>}
        {!hostHeld && <CompanyMembers key={`${status.company.id}:${status.member.id}`} status={status} onChanged={() => refresh()} />}
        {!hostHeld && <div ref={departmentsArea}><CompanyDepartments key={`departments:${status.company.id}:${status.member.id}:${status.member.role}`} /></div>}
      {!hostHeld && <CompanyPortalBindingsCard key={`portal:${status.company.id}:${status.member.id}:${status.member.role}`} status={status} />}
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-[13px] font-medium text-ink">Set up or change your sign-in</summary>
          <p className="mt-2 text-[12px] text-ink-secondary">New members set their sign-in when joining. Use this if you joined an older version without a password, or want to change your sign-in. Save your personal recovery key somewhere private.</p>
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
        {savedRecoveryKey && <div className="rounded-lg border border-line bg-inset p-3"><label className={labelClass}>Your new recovery key<input readOnly type="password" value={savedRecoveryKey} className={inputClass} onFocus={event => event.target.select()} /></label><p className="mt-2 text-[12px] text-ink-secondary">Save this now. It is shown only in this window and replaces your previous key.</p><button className={`${buttonClass} mt-2`} onClick={() => { void navigator.clipboard.writeText(savedRecoveryKey).then(() => setNotice("Recovery key copied."), () => setNotice("Select the recovery key and copy it manually.")); }}>Copy recovery key</button></div>}
        {canInvite && status.hostingAvailable && <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-[13px] font-medium text-ink">Let another computer join</summary>
          <p className="mt-2 text-[12px] text-ink-secondary">Keep RealBud open on the host computer, awake and on your office network. Service administrator sign-in is required to enable joining.</p>
          {!status.networkEnabled && <form className="mt-3 flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void run("Enabling joining…", async () => { await companyApi.enableJoining(hostname); setStatus(await companyApi.status()); setHostCode(await companyApi.hostCode()); }); }}><label className={labelClass}>This computer’s network name or IP address<input value={hostname} onChange={event => setHostname(event.target.value)} required maxLength={253} className={inputClass} placeholder="For example, office-host.local" /></label><button disabled={!!busy} className={`${buttonClass} self-start`}>Enable joining</button></form>}
          {status.networkEnabled && <button disabled={!!busy} className={`${buttonClass} mt-3`} onClick={() => void run("Getting host code…", async () => { setHostCode(await companyApi.hostCode()); })}>Show host code</button>}
          <details className="mt-3"><summary className="cursor-pointer py-2 text-[13px]">Renew certificate or change network address</summary><p className="text-[12px] text-ink-secondary">This replaces the network identity and briefly disconnects members. Everyone must use the new host code with “Reconnect to replacement host”. Their office membership and private work stay unchanged.</p><form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void run('Renewing host identity…', async () => { await companyApi.enableJoining(hostname, true); setStatus(await companyApi.status()); setHostCode(await companyApi.hostCode()); setNotice('Network identity renewed. Give every member the new host code.'); }); }}><label className={labelClass}>Current network name or IP address<input className={inputClass} value={hostname} onChange={event => setHostname(event.target.value)} required maxLength={253} /></label><button className={buttonClass} disabled={!!busy}>Renew identity and disconnect current clients</button></form></details>
          {hostCode && <><label className={`${labelClass} mt-3 block`}>Host code<textarea readOnly value={hostCode} rows={3} className={inputClass} onFocus={event => event.target.select()} /></label><p className="mt-2 text-[12px] text-ink-secondary">Create an invitation below to get one join code for the intended member. The host code identifies this computer; it does not grant membership.</p></>}
        </details>}
        {canInvite && <form onSubmit={event => { event.preventDefault(); void invite(); }}>
          <fieldset disabled={!!busy} className="flex flex-col gap-3 border-t border-line pt-4">
            <legend className="sr-only">Invite a member</legend>
            <label className={labelClass}>Member’s name
              <input value={inviteeName} onChange={event => { setInviteeName(event.target.value); setInvitation(null); }} maxLength={100} autoComplete="off" required className={inputClass} placeholder="Who is joining?" />
            </label>
            <p className="text-[12px] leading-relaxed text-ink-muted">The invitation creates a member, not an owner. It can be used once before it expires. Anyone with it can join, so share it privately.</p>
            <button type="submit" disabled={!inviteeName.trim()} className={`${buttonClass} self-start`}>Create invitation</button>
          </fieldset>
        </form>}
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
            {status.hostingAvailable && <p className="text-[12px] leading-relaxed text-ink-secondary">{status.networkEnabled ? "The host code could not be loaded. Choose Show host code under “Let another computer join” to add a join code here." : "To invite another computer, choose Enable joining under “Let another computer join”. A join code then appears here."}</p>}
            <button type="button" onClick={() => void copyInvitation()} className={`${buttonClass} self-start`}>Copy invitation</button>
          </>}
          <p className="text-[12px] leading-relaxed text-ink-secondary">{invitation.displayName} starts with no department access. After they join, choose what they can use in Departments and access.</p>
          {!hostHeld && <button type="button" onClick={openDepartments} className={`${buttonClass} self-start`}>Open departments and access</button>}
        </div>}
        <button type="button" onClick={() => void signOut()} disabled={!!busy} className={`${buttonClass} self-start`}>Sign out of company</button>
        <p className="text-[12px] leading-relaxed text-ink-muted">Signing out ends this window’s session. It does not leave the office, unlink its host or remove your local work.</p>
      </> : status?.storageAvailable ? <>
        <p className="text-[13px] leading-relaxed text-ink-secondary">{status.configured ? "Sign in to your company, or join with an invitation from its owner." : status.setupAllowed ? "Create a company as its owner." : "A service administrator needs to sign in under Advanced to enable company setup."}</p>
        <div className="flex flex-wrap gap-2">
          {!status.configured && status.setupAllowed && <button type="button" disabled={!!busy} aria-pressed={mode === "create"} className={mode === "create" ? primaryClass : buttonClass} onClick={() => { setMode("create"); setError(""); }}>Create company</button>}
          {status.configured && <button type="button" disabled={!!busy} aria-pressed={mode === "join"} className={mode === "join" ? primaryClass : buttonClass} onClick={() => { setMode("join"); setError(""); }}>Join company</button>}
          {status.configured && <button type="button" disabled={!!busy} className={mode === "signin" ? primaryClass : buttonClass} onClick={() => { setMode("signin"); setError(""); }}>Sign in</button>}
          {status.configured && <button type="button" disabled={!!busy} className={buttonClass} onClick={() => { setMode("recover"); setError(""); }}>Use recovery key</button>}
        </div>
        {mode && <form onSubmit={event => { event.preventDefault(); void signIn(); }}>
          <fieldset disabled={!!busy} className="flex flex-col gap-3">
            <legend className="sr-only">{mode === "create" ? "Create company" : mode === "signin" ? "Sign in" : mode === "recover" ? "Recover sign-in" : "Join company"}</legend>
            {mode === "create" ? <>
              <label className={labelClass}>Company name
                <input ref={firstInput} value={name} onChange={event => setName(event.target.value)} autoComplete="organization" maxLength={100} required className={inputClass} />
              </label>
              <label className={labelClass}>Your name
                <input value={ownerName} onChange={event => setOwnerName(event.target.value)} autoComplete="name" maxLength={100} required className={inputClass} />
              </label>
              <p className="text-[12px] text-ink-muted">You will be the company owner and can create member invitations.</p>
            </> : mode === "signin" || mode === "recover" ? <>
              <label className={labelClass}>Username<input ref={firstInput} value={loginName} onChange={event => setLoginName(event.target.value)} autoComplete="username" autoCapitalize="none" minLength={3} maxLength={80} required className={inputClass} /></label>
              {mode === "recover" && <label className={labelClass}>Recovery key<input type="password" value={recoveryKey} onChange={event => setRecoveryKey(event.target.value)} autoComplete="off" required maxLength={100} className={inputClass} /></label>}
              <label className={labelClass}>{mode === "recover" ? "New password" : "Password"}<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={mode === "recover" ? "new-password" : "current-password"} minLength={12} maxLength={256} required className={inputClass} /></label>
            </> : <>
              <label className={labelClass}>Private invitation
                <input ref={joinFromCode ? undefined : firstInput} type="password" value={invitationToken} onChange={event => { setInvitationToken(event.target.value); setJoinFromCode(false); }} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={JOIN_INPUT_MAX_LENGTH} required className={inputClass} />
                <span className="mt-1 block text-[12px] text-ink-muted">{joinFromCode ? "Filled in from your join code." : "Paste the one-use invitation or join code from your company owner."}</span>
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
      </> : status && (!chooseSetup || intent === "host") && <p className="text-[13px] leading-relaxed text-ink-secondary">{status.storageSetupAvailable ? "Prepare storage on this computer, then create your company. Your existing local desk stays available." : "To set up this computer as the host, your service administrator needs to sign in under Advanced. To join an existing company, use the join code from its owner."}</p>}
      {!status?.storageAvailable && status?.storageSetupAvailable && intent === "host" && <button disabled={!!busy} className={`${primaryClass} self-start`} onClick={() => void run("Setting up this host…", async () => { await companyApi.setup(); setStatus(await companyApi.status()); setNotice("Host storage is ready. Create your company next."); })}>Set up this computer as host</button>}
      {status?.remoteJoinAvailable && intent === "join" && <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void connect(); }}>
        <label className={labelClass}>Connect to an existing host<input type="password" value={joinInput} onChange={event => setJoinInput(event.target.value)} required maxLength={JOIN_INPUT_MAX_LENGTH} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby={`${id}-join-help`} className={`${inputClass} font-mono`} placeholder="Paste the join code" /></label>
        <p id={`${id}-join-help`} className="text-[12px] leading-relaxed text-ink-muted">Paste the join code from your office owner. A host code from an older version also works.</p>
        <p className="text-[12px] leading-relaxed text-ink-secondary">{carryOver}</p>
        <button disabled={!!busy || !joinInput.trim()} className={`${buttonClass} mt-1 self-start`}>Connect to host</button>
      </form>}
      {status?.enrollmentPending && <p role="alert" className="text-[13px] text-ink-secondary">An earlier setup attempt needs confirmation. Sign in with the username and password you chose. If your recovery key was not shown, use “Set up or change your sign-in” after signing in to create a new one.</p>}
      {status?.networkError && <p role="alert" className="text-[13px] text-danger">{status.networkError}</p>}
      {status?.setupError && <p role="alert" className="text-[13px] text-danger">{status.setupError}</p>}
      {!!status?.limitations.length && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-agency">Current availability</summary><ul className="mt-2 list-disc space-y-1 pl-4">{status.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details>}
      {error && <p role="alert" className="text-[13px] leading-relaxed text-danger">{error}</p>}
      {status && <CompanyHostRecovery status={status} onChanged={() => refresh()} />}
      <CompanyRecovery onChanged={() => refresh()} />
      {connectionError && <p role="alert" className="text-[13px] leading-relaxed text-danger">{connectionError}</p>}
      <p role="status" aria-live="polite" className="text-[12.5px] text-ink-secondary">{busy || (!connectionError ? notice : "")}</p>
      <button type="button" disabled={!!busy} onClick={() => void refresh()} className={`${buttonClass} self-start`}>Check company status</button>
    </section>
  </Card>;
}

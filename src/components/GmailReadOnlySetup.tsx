import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { api, type ConfigStatus } from "@/state/store";

export type ConnectedAppsMode = "consumer" | "gmail-readonly";
type ConnectionConfig = ConfigStatus["composio"] | undefined;
type SetupInput = { apiKey: string; authConfigId: string };
type Request = (path: string, init: RequestInit) => Promise<unknown>;
const control = "min-h-11 rounded-lg border border-line bg-sheet px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50";
const setupFailure = "Setup could not be confirmed. Your entries are kept. Refresh saved settings first. If setup is still missing, check that the project key and Gmail OAuth config belong to the same project and that the config requests only gmail.readonly, then verify again.";
const modeFailure = "The connection choice could not be confirmed. Refresh settings before trying again; no email task was started.";
const recoveryFailure = "A connection change still needs checking. Refresh saved settings before preparing app work or changing the connection again.";
// Survive Settings → Ask → Settings remounts. Store no credentials or request
// bodies. A full reload obtains fresh config before app actions are available.
let unconfirmedSettingsChange = false;
const settingsListeners = new Set<() => void>();
const subscribeSettings = (listener: () => void) => { settingsListeners.add(listener); return () => { settingsListeners.delete(listener); }; };
function setUnconfirmedSettingsChange(value: boolean) {
  unconfirmedSettingsChange = value;
  for (const listener of settingsListeners) listener();
}
export function hasUnconfirmedGmailSettingsChange(): boolean { return unconfirmedSettingsChange; }
export function useConnectionSettingsPending(): boolean { return useSyncExternalStore(subscribeSettings, hasUnconfirmedGmailSettingsChange, hasUnconfirmedGmailSettingsChange); }

export function connectedAppsMode(config: ConnectionConfig): ConnectedAppsMode {
  return config?.mode === "gmail-readonly" ? "gmail-readonly" : "consumer";
}

export function selectedConnectedAppsConfigured(config: ConnectionConfig): boolean {
  return Boolean(connectedAppsMode(config) === "gmail-readonly" ? config?.readOnlyConfigured : config?.configured);
}

/** A blank key reuses the server-held project key; it never clears it. */
export function gmailReadOnlySetupInput(input: SetupInput, keySaved: boolean): SetupInput {
  const authConfigId = input.authConfigId.trim();
  const apiKey = input.apiKey.trim();
  if (!authConfigId) throw new Error("Enter the Gmail auth config ID from your Composio project.");
  if (!/^ac_[A-Za-z0-9_-]{1,200}$/.test(authConfigId)) throw new Error("Use the auth config ID beginning with ac_.");
  if (!apiKey && !keySaved) throw new Error("Enter the private API key for that Composio project.");
  if (apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new Error("The project key contains invalid characters. Paste it again in the private field.");
  return { apiKey, authConfigId };
}

function readConfigStatus(value: unknown): ConfigStatus {
  const status = value as ConfigStatus | null;
  if (!status || typeof status !== "object" || !status.composio ||
    typeof status.composio.configured !== "boolean" ||
    !["consumer", "gmail-readonly"].includes(status.composio.mode ?? "") ||
    typeof status.composio.readOnlyConfigured !== "boolean" ||
    !status.box || typeof status.box.configured !== "boolean") throw new Error("Incomplete settings response.");
  // Keep only the public status fields. A malformed upstream response must
  // never place a returned credential into the shared UI store.
  return {
    ...(status.xai ? { xai: { configured: status.xai.configured } } : {}),
    box: { configured: status.box.configured },
    ...(status.tts ? { tts: { configured: status.tts.configured, ready: status.tts.ready, voice: status.tts.voice } } : {}),
    ...(status.profile ? { profile: { name: status.profile.name, email: status.profile.email } } : {}),
    ...(status.care ? { care: { credentialsLocked: status.care.credentialsLocked === true, unlockAvailable: status.care.unlockAvailable === true } } : {}),
    composio: {
      configured: status.composio.configured,
      apiKeyConfigured: status.composio.apiKeyConfigured === true,
      ...(typeof status.composio.managed === 'boolean' ? { managed: status.composio.managed } : {}),
      mode: status.composio.mode,
      readOnlyConfigured: status.composio.readOnlyConfigured,
      ...(typeof status.composio.readOnlyAuthConfigId === "string" ? { readOnlyAuthConfigId: status.composio.readOnlyAuthConfigId } : {}),
    },
  };
}

export async function saveGmailReadOnlySetup(input: SetupInput, keySaved: boolean, request: Request = api): Promise<ConfigStatus> {
  const body = gmailReadOnlySetupInput(input, keySaved);
  try {
    const status = readConfigStatus(await request("/api/connected-apps/gmail-readonly/setup", { method: "POST", body: JSON.stringify(body) }));
    if (!status.composio.readOnlyConfigured || status.composio.readOnlyAuthConfigId !== body.authConfigId) throw new Error("Setup was not verified.");
    return status;
  } catch { throw new Error(setupFailure); }
}

export async function switchConnectedAppsMode(mode: ConnectedAppsMode, request: Request = api): Promise<ConfigStatus> {
  if (!["consumer", "gmail-readonly"].includes(mode)) throw new Error("Choose a supported connection.");
  try {
    const status = readConfigStatus(await request("/api/connected-apps/mode", { method: "POST", body: JSON.stringify({ mode }) }));
    if (status.composio.mode !== mode || !selectedConnectedAppsConfigured(status.composio)) throw new Error("Mode was not confirmed.");
    return status;
  } catch { throw new Error(modeFailure); }
}

export function GmailReadOnlySetup({ config, connected, onSaved, onPendingChange }: {
  config: ConfigStatus | null;
  connected: boolean;
  onSaved: (status: ConfigStatus) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const id = useId();
  const mode = connectedAppsMode(config?.composio);
  const keySaved = Boolean(config?.composio.apiKeyConfigured);
  const ready = Boolean(config?.composio.readOnlyConfigured);
  const [apiKey, setApiKey] = useState("");
  const [authConfigId, setAuthConfigId] = useState(config?.composio.readOnlyAuthConfigId ?? "");
  const [edited, setEdited] = useState(false);
  const [pending, setPending] = useState<"setup" | "refresh" | ConnectedAppsMode | null>(null);
  const [error, setError] = useState(() => unconfirmedSettingsChange ? recoveryFailure : "");
  const [needsRefresh, setNeedsRefresh] = useState(unconfirmedSettingsChange);
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  const details = useRef<HTMLDetailsElement | null>(null);
  const callbacks = useRef({ onSaved, onPendingChange });
  callbacks.current = { onSaved, onPendingChange };

  useEffect(() => {
    if (!edited) setAuthConfigId(config?.composio.readOnlyAuthConfigId ?? "");
  }, [config?.composio.readOnlyAuthConfigId, edited]);
  useEffect(() => () => { active.current?.abort(); }, []);
  useEffect(() => { if (needsRefresh && details.current) details.current.open = true; }, [needsRefresh]);

  const run = async (action: "setup" | "refresh" | ConnectedAppsMode) => {
    if (active.current || !connected || (needsRefresh && action !== "refresh")) return;
    if (action === "setup") {
      try { gmailReadOnlySetupInput({ apiKey, authConfigId }, keySaved); }
      catch (cause) { setError((cause as Error).message); return; }
    }
    const controller = new AbortController();
    active.current = controller;
    setUnconfirmedSettingsChange(true);
    setPending(action); setError(""); setNotice(""); callbacks.current.onPendingChange(true);
    const request: Request = (path, init) => api(path, { ...init, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) });
    let confirmed = false;
    try {
      const next = action === "setup"
        ? await saveGmailReadOnlySetup({ apiKey, authConfigId }, keySaved, request)
        : action === "refresh" ? readConfigStatus(await request("/api/config", { method: "GET" }))
          : await switchConnectedAppsMode(action, request);
      if (controller.signal.aborted) return;
      if (action === "setup") {
        setApiKey(""); setEdited(false);
        setNotice(`Read-only configuration verified and saved. Google consent is still checked separately. ${next.composio.mode === "gmail-readonly" ? "Check access before preparing a task." : "Choose Use Gmail read-only to use this connection."}`);
      } else if (action === "refresh") setNotice("Saved settings refreshed. Your form entries are kept. Account access is refreshing.");
      else setNotice(action === "gmail-readonly"
        ? "Gmail read-only selected. Check access, then connect Gmail if consent is still needed."
        : "Connected apps selected. Account access is refreshing.");
      callbacks.current.onSaved(next);
      setUnconfirmedSettingsChange(false);
      setNeedsRefresh(false);
      confirmed = true;
    } catch {
      if (!controller.signal.aborted) {
        setNeedsRefresh(true);
        setError(action === "refresh" ? "Saved settings could not be refreshed. App actions stay paused until the connection choice can be confirmed. Try refreshing again." : action === "setup" ? setupFailure : modeFailure);
      }
    } finally {
      if (active.current === controller) active.current = null;
      // A lost mutation response may have changed the server's active mode.
      // Keep app actions held until a read-only refresh confirms it.
      if (!controller.signal.aborted) { setPending(null); callbacks.current.onPendingChange(!confirmed); }
    }
  };

  return <details ref={details} className="mt-4 rounded-lg border border-line p-3">
    <summary className="min-h-11 cursor-pointer py-3 text-[13px] font-medium text-ink">Optional: Gmail read-only setup</summary>
    <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">For the person setting up RealBud: use a separate Composio developer project with a Gmail OAuth config requesting only gmail.readonly. The Connected apps key uses a different connection and cannot select this config.</p>
    <a className="inline-flex min-h-11 items-center text-[13px] text-agency underline" href="https://dashboard.composio.dev/" target="_blank" rel="noopener noreferrer">Open Composio project dashboard</a>
    <form className="mt-2 space-y-3" onSubmit={event => { event.preventDefault(); void run("setup"); }}>
      <fieldset disabled={!connected || Boolean(pending) || needsRefresh} className="min-w-0 space-y-3">
        <label htmlFor={`${id}-key`} className="block text-[12.5px] text-ink-secondary">Private project API key
          <input id={`${id}-key`} type="password" autoComplete="off" spellCheck={false} value={apiKey} maxLength={4096}
            onChange={event => setApiKey(event.target.value)} placeholder={keySaved ? "Saved — leave blank to keep it" : "Paste the project API key"}
            className={`${control} mt-1 block w-full min-w-0`} aria-describedby={`${id}-privacy`} />
        </label>
        <p id={`${id}-privacy`} className="text-[12px] text-ink-muted">Kept privately by RealBud; never added to Ask. {keySaved ? "Leaving this blank reuses the saved project key." : "The consumer key cannot be used here."}</p>
        <label htmlFor={`${id}-config`} className="block text-[12.5px] text-ink-secondary">Gmail auth config ID
          <input id={`${id}-config`} type="text" autoComplete="off" spellCheck={false} value={authConfigId} maxLength={203}
            onChange={event => { setEdited(true); setAuthConfigId(event.target.value); }} placeholder="ac_…" className={`${control} mt-1 block w-full min-w-0`} />
        </label>
        <button type="submit" className={`${control} inline-flex items-center gap-2`}>{pending === "setup" ? <><Loader2 size={14} className="animate-spin" aria-hidden /> Verifying…</> : "Verify and save setup"}</button>
      </fieldset>
    </form>
    <p className="mt-3 text-[12.5px] text-ink-secondary">{ready ? "Read-only setup saved. This does not confirm Google consent or a successful mailbox read." : "Read-only setup has not been verified and saved."}</p>
    <div role="group" aria-label="Connection used by Bud" className="mt-3 flex flex-wrap gap-2">
      <button type="button" aria-pressed={mode === "gmail-readonly"} disabled={!connected || Boolean(pending) || needsRefresh || !ready || mode === "gmail-readonly"}
        className={control} onClick={() => void run("gmail-readonly")}>{pending === "gmail-readonly" ? "Switching…" : mode === "gmail-readonly" ? "Using Gmail read-only" : "Use Gmail read-only"}</button>
      <button type="button" aria-pressed={mode === "consumer"} disabled={!connected || Boolean(pending) || needsRefresh || !config?.composio.configured || mode === "consumer"}
        className={control} onClick={() => void run("consumer")}>{pending === "consumer" ? "Switching…" : mode === "consumer" ? "Using Connected apps" : "Use Connected apps"}</button>
    </div>
    <p className="mt-2 text-[12px] text-ink-muted">Switching changes the connection Bud uses. It does not grant Google permissions, read email or start a task.</p>
    {pending === "refresh" ? <p role="status" className="mt-2 text-[13px] text-ink-secondary">Refreshing saved settings…</p> : null}
    {error ? <div className="mt-2">
      <p role="alert" className="text-[13px] text-danger">{error}</p>
      <button type="button" disabled={!connected || Boolean(pending)} className={`${control} mt-2`} onClick={() => void run("refresh")}>{pending === "refresh" ? "Refreshing…" : "Refresh saved settings"}</button>
    </div> : null}
    {notice ? <p role="status" className="mt-2 text-[13px] text-agency">{notice}</p> : null}
    {!connected ? <p role="status" className="mt-2 text-[12.5px] text-hold">Reconnect to RealBud before saving or switching connections.</p> : null}
  </details>;
}

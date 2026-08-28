import { useEffect, useMemo, useState } from "react";
import { Check, Copy, KeyRound, MessageCircle, ShieldCheck, Smartphone } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { VerifiedConnectionCard, type VerifiedConnectionState } from "./VerifiedConnectionCard";

type HubStatus = NonNullable<ConfigStatus["pocket"]>;
type ChannelStatus = HubStatus["channels"][keyof HubStatus["channels"]];
type PocketChannelId = "telegram" | "whatsapp-business";

function cardState(status: ChannelStatus): VerifiedConnectionState {
  if (status.state === "ready") return "ready";
  if (status.state === "connecting") return "checking";
  if (status.state === "attention") return "attention";
  return "off";
}

function statusLabel(status: ChannelStatus): string {
  if (status.state === "pilot-gated") return "Pilot-gated";
  if (status.state === "setup-required") return status.configured ? "Finish setup" : "Setup needed";
  if (status.state === "connecting") return "Checking";
  if (status.state === "ready") return "Connected";
  if (status.state === "attention") return "Needs attention";
  return status.configured ? "Off" : "Not connected";
}

function SecretField({
  label,
  value,
  onChange,
  configured,
  placeholder,
  maxLength = 4_096,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  configured: boolean;
  placeholder: string;
  maxLength?: number;
}) {
  return (
    <label className="text-[11.5px] font-medium text-ink-muted">
      {label} {configured ? <span className="font-normal">· blank keeps the saved value</span> : null}
      <div className="relative mt-1">
        <KeyRound size={14} className="pointer-events-none absolute left-3 top-2.5 text-ink-muted" />
        <input
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
          autoComplete="new-password"
          placeholder={configured ? "Saved securely" : placeholder}
          className="w-full rounded border border-line bg-sheet py-2 pl-9 pr-3 text-[13px] text-ink outline-none focus:border-agency"
        />
      </div>
    </label>
  );
}

export function PocketPilotRequirements({ channel }: { channel: PocketChannelId }) {
  const whatsapp = channel === "whatsapp-business";
  const id = `${channel}-pilot-requirements-heading`;
  return (
    <section
      id={`${channel}-pilot-requirements`}
      role="region"
      aria-labelledby={id}
      className="border border-hold/35 bg-hold/5 px-4 py-3.5"
    >
      <div className="flex items-start gap-2.5">
        <ShieldCheck size={17} className="mt-0.5 shrink-0 text-hold" />
        <div className="min-w-0">
          <h4 id={id} className="text-[13.5px] font-semibold text-ink">
            Before {whatsapp ? "WhatsApp Business" : "Telegram"} can connect
          </h4>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
            This Demo build stays network-off until a real agency and the PM using this private channel are named for the pilot.
          </p>
        </div>
      </div>
      <ol className="mt-3 grid list-decimal gap-2 pl-5 text-[12px] leading-relaxed text-ink-muted">
        <li>
          Confirm the real agency and one named PM. This identifies the only person whose private messages RealBud may accept.
        </li>
        {whatsapp ? (
          <>
            <li>Approve Meta's official Business Cloud setup, a dedicated business number and an agency-managed public HTTPS webhook.</li>
            <li>After the pilot is enabled, enter the Meta details and exact PM number on this card. Ask never stores them in the transcript.</li>
          </>
        ) : (
          <>
            <li>Approve one dedicated bot and Telegram's privacy boundary; bot chats are not end-to-end encrypted.</li>
            <li>After the pilot is enabled, enter the bot token and exact numeric PM ID on this card. Ask never stores them in the transcript.</li>
          </>
        )}
      </ol>
      <p className="mt-3 border-t border-hold/20 pt-2.5 text-[11.5px] leading-relaxed text-ink-muted">
        The Connect controls appear only after the named pilot is recorded. Viewing this checklist never grants Bud channel access.
      </p>
    </section>
  );
}

export function PocketConnectionCard({
  visibleChannels,
}: {
  visibleChannels?: readonly ("telegram" | "whatsapp-business")[];
}) {
  const { state, dispatch } = useStore();
  const hub = state.config?.pocket;
  const telegram = hub?.channels.telegram;
  const whatsapp = hub?.channels.whatsappCloud;
  const [telegramUserId, setTelegramUserId] = useState(telegram?.allowedUserId ?? "");
  const [telegramToken, setTelegramToken] = useState("");
  const [whatsappUserId, setWhatsappUserId] = useState(whatsapp?.allowedUserId ?? "");
  const [phoneNumberId, setPhoneNumberId] = useState(whatsapp?.phoneNumberId ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [webhookPort, setWebhookPort] = useState(String(whatsapp?.webhookPort ?? 8090));
  const [busyChannel, setBusyChannel] = useState<"telegram" | "whatsapp-cloud" | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [copied, setCopied] = useState(false);
  const [pilotHelpChannel, setPilotHelpChannel] = useState<PocketChannelId | null>(null);

  useEffect(() => setTelegramUserId(telegram?.allowedUserId ?? ""), [telegram?.allowedUserId]);
  useEffect(() => setWhatsappUserId(whatsapp?.allowedUserId ?? ""), [whatsapp?.allowedUserId]);
  useEffect(() => setPhoneNumberId(whatsapp?.phoneNumberId ?? ""), [whatsapp?.phoneNumberId]);
  useEffect(() => setWebhookPort(String(whatsapp?.webhookPort ?? 8090)), [whatsapp?.webhookPort]);

  const localWebhookTarget = useMemo(
    () => `http://127.0.0.1:${webhookPort || "8090"}${whatsapp?.webhookPath ?? "/whatsapp/webhook"}`,
    [webhookPort, whatsapp?.webhookPath],
  );

  if (!hub || !telegram || !whatsapp) return null;
  const showTelegram = !visibleChannels || visibleChannels.includes("telegram");
  const showWhatsApp = !visibleChannels || visibleChannels.includes("whatsapp-business");
  if (!showTelegram && !showWhatsApp) return null;

  const patchPocket = async (
    provider: "telegram" | "whatsapp-cloud",
    pocket: Record<string, unknown>,
    confirmation: string,
  ) => {
    if (busyChannel) return;
    setBusyChannel(provider);
    setError("");
    setSaved("");
    try {
      const next = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ pocket: { provider, ...pocket } }),
      });
      dispatch({ type: "configStatus", config: next });
      if (provider === "telegram") setTelegramToken("");
      else {
        setAccessToken("");
        setAppSecret("");
        setVerifyToken("");
      }
      setSaved(confirmation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyChannel(null);
    }
  };

  const copyVerifyToken = async () => {
    if (!verifyToken) return;
    try {
      await navigator.clipboard.writeText(verifyToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("RealBud could not copy the Verify Token. Select and copy it before saving.");
    }
  };

  return (
    <section className="space-y-2" aria-labelledby="pocket-heading">
      <div className="border border-line bg-paper px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="pocket-heading" className="text-[14px] font-semibold text-ink">Pocket gateway</h3>
            <p className="mt-0.5 max-w-[48rem] text-[12.5px] leading-relaxed text-ink-muted">
              {showTelegram && showWhatsApp
                ? "Connect one or both private PM channels to the same Bud, Ask transcript and manual Allow decisions. These are message doorways—not extra agents or general worker gateways."
                : "This private PM channel opens the same Bud, Ask transcript and manual Allow decisions. It is a doorway—not another agent or general worker gateway."}
            </p>
          </div>
          <span className="rounded-full border border-line bg-sheet px-2.5 py-1 text-[11px] font-medium text-ink-muted">
            {hub.connectedCount} connected
          </span>
        </div>
      </div>

      {showTelegram ? (
        <div id="telegram" className="scroll-m-28 space-y-2">
          <VerifiedConnectionCard
            icon={<MessageCircle size={18} />}
            title="Telegram"
            description="Outbound-only long polling from this computer. One dedicated bot accepts one exact PM identity in private chat."
            meta={telegram.botUsername
              ? `@${telegram.botUsername} · PM ${telegram.allowedUserId} · desktop must be running`
              : "No public webhook · no groups · no tenant channel · bot chats are not end-to-end encrypted"}
            state={cardState(telegram)}
            status={statusLabel(telegram)}
            action={!hub.pilotReady
              ? {
                  label: pilotHelpChannel === "telegram" ? "Hide requirements" : "View requirements",
                  expanded: pilotHelpChannel === "telegram",
                  controls: "telegram-pilot-requirements",
                  onClick: () => setPilotHelpChannel((current) => current === "telegram" ? null : "telegram"),
                }
              : !telegram.configured
                ? undefined
              : {
                  label: busyChannel === "telegram" ? "Working…" : telegram.enabled ? "Turn off" : "Turn on",
                  disabled: Boolean(busyChannel),
                  onClick: () => void patchPocket("telegram", { enabled: !telegram.enabled }, telegram.enabled ? "Telegram Pocket is off." : "Telegram Pocket is connecting."),
                }}
          />

          {!hub.pilotReady && pilotHelpChannel === "telegram" ? <PocketPilotRequirements channel="telegram" /> : null}

          {hub.pilotReady ? (
            <details open={!telegram.configured || telegram.state === "attention"} className="border border-line bg-paper px-4 py-3">
          <summary className="cursor-pointer text-[12.5px] font-semibold text-ink">{telegram.configured ? "Change Telegram setup" : "Connect Telegram"}</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-[11.5px] font-medium text-ink-muted">
              PM Telegram user ID
              <input
                value={telegramUserId}
                onChange={(event) => setTelegramUserId(event.target.value.replace(/\D/g, "").slice(0, 20))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="123456789"
                className="mt-1 w-full rounded border border-line bg-sheet px-3 py-2 text-[13px] text-ink outline-none focus:border-agency"
              />
            </label>
            <SecretField label="Dedicated bot token" value={telegramToken} onChange={setTelegramToken} configured={telegram.configured} placeholder="123456:…" maxLength={160} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={Boolean(busyChannel) || !telegramUserId || (!telegram.configured && !telegramToken.trim())}
              onClick={() => void patchPocket("telegram", {
                enabled: true,
                allowedUserId: telegramUserId,
                ...(telegramToken.trim() ? { key: telegramToken.trim() } : {}),
              }, "Telegram setup saved and checked.")}
              className="pm-control pm-tactile rounded bg-agency px-3 text-[12.5px] font-semibold text-white hover:bg-agency-hover disabled:opacity-45"
            >
              {busyChannel === "telegram" ? "Checking…" : "Save & connect"}
            </button>
            {telegram.configured ? (
              <button
                type="button"
                disabled={Boolean(busyChannel)}
                onClick={() => void patchPocket("telegram", { enabled: false, allowedUserId: "", key: "" }, "Telegram credentials removed.")}
                className="pm-control pm-tactile rounded border border-line px-3 text-[12.5px] text-ink-muted hover:bg-raised disabled:opacity-45"
              >
                Remove
              </button>
            ) : null}
          </div>
          <p className="mt-3 flex max-w-[50rem] items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-muted">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            The bot token is encrypted. RealBud accepts only the exact numeric PM in private chat, rejects credentials and unsupported commands, and never exposes model, update, terminal or gateway controls.
          </p>
          <p className="mt-2 text-[11.5px] text-ink-muted" role={telegram.state === "attention" ? "alert" : "status"}>{telegram.detail}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      {showWhatsApp ? (
        <div id="whatsapp-business" className="scroll-m-28 space-y-2">
          <VerifiedConnectionCard
            icon={<Smartphone size={18} />}
            title="WhatsApp Business"
            description="Meta's official Cloud API on a dedicated business number. Signed direct messages from one exact PM number enter the same Ask thread."
            meta={whatsapp.displayPhoneNumber
              ? `${whatsapp.verifiedName ?? "Business number"} · ${whatsapp.displayPhoneNumber} · signed webhook`
              : "Official Business Cloud API · private PM direct messages · public HTTPS tunnel required"}
            state={cardState(whatsapp)}
            status={statusLabel(whatsapp)}
            action={!hub.pilotReady
              ? {
                  label: pilotHelpChannel === "whatsapp-business" ? "Hide requirements" : "View requirements",
                  expanded: pilotHelpChannel === "whatsapp-business",
                  controls: "whatsapp-business-pilot-requirements",
                  onClick: () => setPilotHelpChannel((current) => current === "whatsapp-business" ? null : "whatsapp-business"),
                }
              : !whatsapp.configured
                ? undefined
              : {
                  label: busyChannel === "whatsapp-cloud" ? "Working…" : whatsapp.enabled ? "Turn off" : "Turn on",
                  disabled: Boolean(busyChannel),
                  onClick: () => void patchPocket("whatsapp-cloud", { enabled: !whatsapp.enabled }, whatsapp.enabled ? "WhatsApp Business is off." : "WhatsApp Business is starting."),
                }}
          />

          {!hub.pilotReady && pilotHelpChannel === "whatsapp-business" ? <PocketPilotRequirements channel="whatsapp-business" /> : null}

          {hub.pilotReady ? (
            <details open={!whatsapp.configured || whatsapp.state === "attention" || whatsapp.state === "setup-required"} className="border border-line bg-paper px-4 py-3">
          <summary className="cursor-pointer text-[12.5px] font-semibold text-ink">{whatsapp.configured ? "Finish or change WhatsApp setup" : "Connect WhatsApp Business"}</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-[11.5px] font-medium text-ink-muted">
              Meta Phone Number ID
              <input
                value={phoneNumberId}
                onChange={(event) => setPhoneNumberId(event.target.value.replace(/\D/g, "").slice(0, 20))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="The numeric ID below the From number"
                className="mt-1 w-full rounded border border-line bg-sheet px-3 py-2 text-[13px] text-ink outline-none focus:border-agency"
              />
            </label>
            <label className="text-[11.5px] font-medium text-ink-muted">
              PM WhatsApp number
              <input
                value={whatsappUserId}
                onChange={(event) => setWhatsappUserId(event.target.value.replace(/\D/g, "").slice(0, 20))}
                inputMode="tel"
                autoComplete="off"
                placeholder="61412345678 · country code, digits only"
                className="mt-1 w-full rounded border border-line bg-sheet px-3 py-2 text-[13px] text-ink outline-none focus:border-agency"
              />
            </label>
            <SecretField label="Meta access token" value={accessToken} onChange={setAccessToken} configured={whatsapp.configured} placeholder="Permanent System User token" />
            <SecretField label="Meta App Secret" value={appSecret} onChange={setAppSecret} configured={whatsapp.configured} placeholder="32-character App Secret" maxLength={128} />
            <label className="text-[11.5px] font-medium text-ink-muted">
              Verify Token {whatsapp.configured ? <span className="font-normal">· blank keeps the saved value</span> : null}
              <div className="mt-1 flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <KeyRound size={14} className="pointer-events-none absolute left-3 top-2.5 text-ink-muted" />
                  <input
                    type="password"
                    value={verifyToken}
                    onChange={(event) => setVerifyToken(event.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128))}
                    autoComplete="new-password"
                    placeholder={whatsapp.configured ? "Saved securely" : "20+ letters, numbers, _ or -"}
                    className="w-full rounded border border-line bg-sheet py-2 pl-9 pr-3 text-[13px] text-ink outline-none focus:border-agency"
                  />
                </div>
                <button
                  type="button"
                  disabled={!verifyToken}
                  onClick={() => void copyVerifyToken()}
                  className="pm-control pm-tactile inline-flex rounded border border-line px-3 text-[12px] text-ink-muted disabled:opacity-40"
                  aria-label="Copy Verify Token"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </label>
            <label className="text-[11.5px] font-medium text-ink-muted">
              Local webhook port
              <input
                value={webhookPort}
                onChange={(event) => setWebhookPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
                inputMode="numeric"
                autoComplete="off"
                placeholder="8090"
                className="mt-1 w-full rounded border border-line bg-sheet px-3 py-2 text-[13px] text-ink outline-none focus:border-agency"
              />
            </label>
          </div>

          <div className="mt-3 rounded border border-line bg-sheet px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-muted">
            <p className="font-semibold text-ink">Webhook handoff</p>
            <p className="mt-1">Point an agency-approved HTTPS tunnel at <span className="break-all font-mono text-ink">{localWebhookTarget}</span>, then set Meta's callback to <span className="break-all font-mono text-ink">https://your-public-host{whatsapp.webhookPath}</span> and paste the same Verify Token above.</p>
            <p className="mt-1">RealBud stays at “Finish setup” until Meta completes that verification handshake. Temporary access tokens expire; production onboarding needs a permanent System User token.</p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={Boolean(busyChannel) || !phoneNumberId || !whatsappUserId || !webhookPort || (!whatsapp.configured && (!accessToken.trim() || !appSecret.trim() || !verifyToken.trim()))}
              onClick={() => void patchPocket("whatsapp-cloud", {
                enabled: true,
                phoneNumberId,
                allowedUserId: whatsappUserId,
                webhookPort: Number(webhookPort),
                ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
                ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
                ...(verifyToken.trim() ? { verifyToken: verifyToken.trim() } : {}),
              }, "WhatsApp setup saved. Finish the signed webhook handshake in Meta.")}
              className="pm-control pm-tactile rounded bg-agency px-3 text-[12.5px] font-semibold text-white hover:bg-agency-hover disabled:opacity-45"
            >
              {busyChannel === "whatsapp-cloud" ? "Checking…" : "Save & start webhook"}
            </button>
            {whatsapp.configured ? (
              <button
                type="button"
                disabled={Boolean(busyChannel)}
                onClick={() => void patchPocket("whatsapp-cloud", {
                  enabled: false,
                  accessToken: "",
                  appSecret: "",
                  verifyToken: "",
                  phoneNumberId: "",
                  allowedUserId: "",
                }, "WhatsApp credentials removed.")}
                className="pm-control pm-tactile rounded border border-line px-3 text-[12.5px] text-ink-muted hover:bg-raised disabled:opacity-45"
              >
                Remove
              </button>
            ) : null}
          </div>
          <p className="mt-3 flex max-w-[50rem] items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-muted">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            RealBud binds the listener to this computer only, verifies Meta's HMAC signature before parsing, checks the exact business-number route and PM number, claims each message before acknowledging it, and stores no message text in its delivery ledger.
          </p>
          <p className="mt-2 text-[11.5px] text-ink-muted" role={whatsapp.state === "attention" ? "alert" : "status"}>{whatsapp.detail}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      <p className="px-1 text-[11.5px] text-ink-muted" role={error ? "alert" : "status"}>
        {error || saved || hub.detail}
      </p>
    </section>
  );
}

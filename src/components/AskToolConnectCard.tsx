import { useEffect, useState } from "react";
import { Check, KeyRound, Loader2, Paperclip } from "lucide-react";

import { resolveAskOfficeTool, resolveConnectableTool, type AskOfficeTool } from "@shared/ask-connections";
import {
  ASK_CONNECT_METHOD_ORDER,
  askConnectComposioUnavailableDetail,
  askConnectGatedDetail,
  askConnectMethodBadge,
  askConnectMethodFill,
  askConnectMethodTitle,
  askConnectUseStandardLabel,
  askConnectWizardBarFill,
  askConnectWizardDetail,
  askConnectWizardProgress,
  askConnectWizardStep,
  defaultAskConnectMethod,
  isLiveAskConnectMethod,
  mapOfficeSourceError,
  type AskConnectMethod,
} from "@/lib/ask-connect";
import { cn } from "@/lib/cn";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { ComposioSignInPanel } from "./ComposioSignInPanel";

function methodCopy(tool: AskOfficeTool): Record<AskConnectMethod, { title: string; detail: string }> {
  const name = tool.label;
  return {
    "direct-api": {
      title: askConnectMethodTitle("direct-api"),
      detail: `Paste the ${name} API key. It stays on this device. Nothing sends.`,
    },
    "approved-mcp": {
      title: askConnectMethodTitle("approved-mcp"),
      detail: "One reviewed server and account with an exact operation allowlist. Raw MCP URLs never go into Ask.",
    },
    "isolated-cli": {
      title: askConnectMethodTitle("isolated-cli"),
      detail: "Use a file this office already has. Isolated file work only — not a live inbox, and not a preferred path.",
    },
    "restricted-composio": {
      title: askConnectMethodTitle("restricted-composio"),
      detail: "Login to Composio, or paste a Connect key. Then sign in this named read. No send or marketplace.",
    },
  };
}

function DirectApiFields({
  slug,
  label,
  connected,
  onConnected,
  onConfig,
}: {
  slug: string;
  label: string;
  connected: boolean;
  onConnected: (connected: boolean) => void;
  onConfig: (config: ConfigStatus) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<"save" | "unlink" | null>(null);
  const [error, setError] = useState("");
  const [justConnected, setJustConnected] = useState(false);
  const save = () => {
    if (busy || !key.trim()) return;
    setBusy("save");
    setError("");
    api(`/api/office-sources/${slug}`, {
      method: "PUT",
      body: JSON.stringify({ key: key.trim(), label }),
    })
      .then((body: { config?: ConfigStatus }) => {
        setKey("");
        setJustConnected(true);
        onConnected(true);
        if (body.config) onConfig(body.config);
      })
      .catch((cause) => {
        setError(mapOfficeSourceError(cause instanceof Error ? cause.message : String(cause)));
      })
      .finally(() => setBusy(null));
  };
  const unlink = () => {
    if (busy) return;
    setBusy("unlink");
    setError("");
    api(`/api/office-sources/${slug}`, { method: "DELETE" })
      .then((body: { config?: ConfigStatus }) => {
        onConnected(false);
        if (body.config) onConfig(body.config);
      })
      .catch((cause) => {
        setError(mapOfficeSourceError(cause instanceof Error ? cause.message : String(cause)));
      })
      .finally(() => setBusy(null));
  };
  return (
    <div className="space-y-2">
      {error ? <p className="text-[12px] text-danger" role="alert">{error}</p> : null}
      {connected ? (
        <p className={cn("text-[13px] leading-relaxed", justConnected ? "copy-pulse text-agency" : "text-ink-muted")}>
          {label} is connected. Key on this device. Ask still cannot send.
        </p>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Paste the {label} API key. It stays on this device.
        </p>
      )}
      <label className="block text-[12px] font-medium text-ink" htmlFor={`ask-connect-direct-${slug}`}>
        API key
      </label>
      <div className="flex flex-wrap gap-2">
        <span className="relative min-w-[12rem] flex-1">
          <KeyRound size={14} className="pointer-events-none absolute left-3 top-3 text-ink-muted" />
          <input
            id={`ask-connect-direct-${slug}`}
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value.slice(0, 4096))}
            onKeyDown={(event) => event.key === "Enter" && save()}
            placeholder={connected ? "••••••••  (paste to replace)" : "Paste API key"}
            autoComplete="off"
            className="pm-control w-full rounded border border-line bg-inset py-2 pl-9 pr-3 text-[13px] text-ink focus:border-agency"
          />
        </span>
        <button
          type="button"
          disabled={busy !== null || !key.trim()}
          onClick={save}
          className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover disabled:opacity-50"
        >
          {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : connected ? <Check size={14} /> : null}
          {connected ? "Replace key" : "Connect"}
        </button>
        {connected ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={unlink}
            className="pm-control pm-tactile inline-flex min-h-10 items-center rounded border border-line px-3 text-[12.5px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
          >
            {busy === "unlink" ? <Loader2 size={13} className="animate-spin" /> : null}
            Unlink
          </button>
        ) : null}
      </div>
    </div>
  );
}

function badgeClass(tone: "standard" | "live" | "gated"): string {
  if (tone === "standard") return "border-agency/30 bg-selected text-agency";
  if (tone === "gated") return "border-hold/35 bg-hold/10 text-hold";
  return "border-line bg-paper text-ink-muted";
}

function WizardProgress({
  current,
  total,
  label,
  complete,
}: {
  current: number;
  total: number;
  label: string;
  complete: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] font-medium text-ink">
        {complete ? "Done" : `${current} of ${total}`}
        <span className="font-normal text-ink-muted"> · {label}</span>
      </p>
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }}
        role="progressbar"
        aria-label="Connection setup"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={complete ? total : current}
      >
        {Array.from({ length: total }, (_, index) => {
          const position = index + 1;
          const fill = askConnectWizardBarFill(position, current, complete);
          return (
            <span key={position} className="relative h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
              <span
                className={cn(
                  "setup-progress-fill absolute inset-y-0 left-0 bg-agency",
                  fill === "full" ? "w-full" : fill === "current" ? "w-2/5" : "w-0",
                )}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function AskToolConnectCard({
  service,
  onAttachInAsk,
}: {
  service?: string;
  onAttachInAsk: () => void;
}) {
  const { state, dispatch } = useStore();
  const office = resolveAskOfficeTool(service ?? "");
  const tool = resolveConnectableTool(service ?? "") ?? office ?? {
    id: "incoming-mail",
    label: service?.trim() || "Incoming mail",
    kind: /cal/i.test(service ?? "") ? "calendar" as const : "mail" as const,
    composioSlug: null,
  };
  const composioLinked = Boolean(state.config?.composio.configured);
  const copy = methodCopy(tool);
  const slug = tool.composioSlug;
  const officeMail = Boolean(office?.composioSlug && (office.kind === "mail" || office.kind === "calendar"));
  const currentStandard = defaultAskConnectMethod({
    composioLinked,
    hasNamedToolkit: Boolean(slug),
    officeMail,
  });
  const [method, setMethod] = useState<AskConnectMethod>(currentStandard);
  const [toolConnected, setToolConnected] = useState<boolean | null>(null);
  const [keyRejected, setKeyRejected] = useState(false);
  const [keyVerified, setKeyVerified] = useState(false);
  useEffect(() => {
    if (!composioLinked) {
      setKeyRejected(false);
      setKeyVerified(false);
    }
  }, [composioLinked]);
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    api(`/api/office-sources?services=${slug}`)
      .then((body: { services?: Record<string, { connected?: boolean }> }) => {
        if (!alive) return;
        const connected = Boolean(body.services?.[slug]?.connected);
        setToolConnected(connected);
        if (connected) setKeyVerified(true);
      })
      .catch(() => {
        if (alive) setToolConnected((current) => current);
      });
    return () => {
      alive = false;
    };
  }, [slug]);
  const fill = askConnectMethodFill({ method, hasNamedToolkit: Boolean(slug) });
  const step = askConnectWizardStep({
    hasNamedToolkit: Boolean(slug),
    composioLinked,
    toolConnected,
    keyRejected,
    keyVerified,
  });
  const progress = askConnectWizardProgress(step, { keyRejected });
  const showWizard = fill === "composio" || fill === "export";

  return (
    <div className="space-y-4">
      {showWizard ? (
        <div className="space-y-3">
          {fill === "composio" ? <WizardProgress {...progress} /> : null}
          {fill === "composio" && keyRejected ? null : (
            <p className="text-[13px] leading-relaxed text-ink-muted">
              {fill === "composio"
                ? askConnectWizardDetail(step, tool.label)
                : askConnectWizardDetail("attach-export", tool.label)}
            </p>
          )}
        </div>
      ) : fill === "direct" ? null : (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          {tool.kind === "calendar"
            ? `Read named ${tool.label} only. Nothing writes or sends.`
            : `Read named ${tool.label} items. Reply drafts land on Desk. Nothing sends.`}
        </p>
      )}

      {fill === "direct" && slug ? (
        <DirectApiFields
          slug={slug}
          label={tool.label}
          connected={Boolean(toolConnected)}
          onConnected={(connected) => {
            setToolConnected(connected);
            if (connected) setKeyVerified(true);
          }}
          onConfig={(config) => dispatch({ type: "configStatus", config })}
        />
      ) : null}

      {fill === "export" ? (
        <button
          type="button"
          onClick={onAttachInAsk}
          className="pm-control pm-tactile inline-flex min-h-11 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
        >
          <Paperclip size={14} aria-hidden="true" /> Attach an export in Ask
        </button>
      ) : null}

      {fill === "gated" ? (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            {askConnectGatedDetail(method, { toolLabel: tool.label, currentStandard })}
          </p>
          <button
            type="button"
            onClick={() => setMethod(currentStandard)}
            className="pm-control pm-tactile inline-flex min-h-11 items-center rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
          >
            {askConnectUseStandardLabel(currentStandard)}
          </button>
        </div>
      ) : null}

      {fill === "composio-unavailable" ? (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            {askConnectComposioUnavailableDetail(tool.label)}
          </p>
          <button
            type="button"
            onClick={() => setMethod("isolated-cli")}
            className="pm-control pm-tactile inline-flex min-h-11 items-center rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
          >
            {askConnectUseStandardLabel("isolated-cli")}
          </button>
        </div>
      ) : null}

      {fill === "composio" ? (
        <ComposioSignInPanel
          toolLabel={tool.label}
          composioSlug={slug}
          keyFieldId="ask-connect-composio-key"
          variant={step === "link-composio" ? "account" : "named"}
          keyRejected={keyRejected}
          onToolConnected={setToolConnected}
          onKeyRejected={setKeyRejected}
          onKeyVerified={setKeyVerified}
        />
      ) : null}

      <details className="border-t border-line pt-3">
        <summary className="cursor-pointer text-[12px] font-medium text-ink">Other methods</summary>
        <section aria-label="How this office connects" className="mt-2">
          <div
            role="radiogroup"
            aria-label="Connection method"
            className="divide-y divide-line/70 border border-line bg-paper"
          >
            {ASK_CONNECT_METHOD_ORDER.map((id) => {
              const selected = method === id;
              const live = isLiveAskConnectMethod(id);
              const badge = askConnectMethodBadge({ method: id, currentStandard });
              return (
                <label
                  key={id}
                  className={cn(
                    "flex w-full min-h-12 cursor-pointer items-start gap-2.5 px-3 py-2.5",
                    selected ? "border-l-2 border-l-agency bg-selected/80" : "border-l-2 border-l-transparent hover:bg-sheet",
                    !live && !selected ? "opacity-80" : "",
                  )}
                >
                  <input
                    type="radio"
                    name="ask-connect-method"
                    value={id}
                    checked={selected}
                    onChange={() => setMethod(id)}
                    className="mt-1 size-4 shrink-0 accent-agency"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-ink">{copy[id].title}</span>
                      <span className={cn("rounded-full border px-2 py-0.5 text-[12px] font-medium", badgeClass(badge.tone))}>
                        {badge.label}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-muted">{copy[id].detail}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      </details>
    </div>
  );
}

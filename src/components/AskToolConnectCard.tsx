import { useEffect, useState } from "react";
import { Check, ExternalLink, KeyRound, Loader2, Paperclip } from "lucide-react";

import { resolveAskOfficeTool, type AskOfficeTool } from "@shared/ask-connections";
import {
  ASK_CONNECT_METHOD_ORDER,
  COMPOSIO_SIGN_IN_URL,
  askConnectComposioUnavailableDetail,
  askConnectGatedDetail,
  askConnectMethodBadge,
  askConnectMethodFill,
  askConnectMethodTitle,
  askConnectUseStandardLabel,
  defaultAskConnectMethod,
  isLiveAskConnectMethod,
  type AskConnectMethod,
} from "@/lib/ask-connect";
import { cn } from "@/lib/cn";
import { openHttpsUrl } from "@/lib/open-https";
import { api, useStore, type ConfigStatus } from "@/state/store";

function methodCopy(tool: AskOfficeTool): Record<AskConnectMethod, { title: string; detail: string }> {
  const name = tool.label;
  return {
    "direct-api": {
      title: askConnectMethodTitle("direct-api"),
      detail: `First-party ${name} read with exact scopes and a stable account identity.`,
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
      detail: "Sign in to Composio, then this named read. No send or marketplace.",
    },
  };
}

function badgeClass(tone: "standard" | "live" | "gated"): string {
  if (tone === "standard") return "border-agency/30 bg-selected text-agency";
  if (tone === "gated") return "border-hold/35 bg-hold/10 text-hold";
  return "border-line bg-paper text-ink-muted";
}

export function AskToolConnectCard({
  service,
  onAttachInAsk,
}: {
  service?: string;
  onAttachInAsk: () => void;
}) {
  const { state, dispatch } = useStore();
  const tool = resolveAskOfficeTool(service ?? "") ?? {
    id: "incoming-mail" as const,
    label: service?.trim() || "Incoming mail",
    kind: /cal/i.test(service ?? "") ? "calendar" as const : "mail" as const,
    composioSlug: null,
  };
  const composioLinked = Boolean(state.config?.composio.configured);
  const copy = methodCopy(tool);
  const slug = tool.composioSlug;
  const currentStandard = defaultAskConnectMethod({ composioLinked, hasNamedToolkit: Boolean(slug) });
  const [method, setMethod] = useState<AskConnectMethod>(currentStandard);
  const [composioKey, setComposioKey] = useState("");
  const [composioBusy, setComposioBusy] = useState<"link" | "connect" | "check" | null>(null);
  const [composioError, setComposioError] = useState("");
  const [toolConnected, setToolConnected] = useState<boolean | null>(null);
  const fill = askConnectMethodFill({ method, hasNamedToolkit: Boolean(slug) });

  const refreshTool = async () => {
    if (!slug || !composioLinked) {
      setToolConnected(null);
      return;
    }
    const body = await api(`/api/connectors?services=${slug}`);
    setToolConnected(Boolean(body.services?.[slug]?.connected));
  };

  useEffect(() => {
    let alive = true;
    if (!slug || !composioLinked) {
      setToolConnected(null);
      return;
    }
    void api(`/api/connectors?services=${slug}`)
      .then((body) => {
        if (alive) setToolConnected(Boolean(body.services?.[slug]?.connected));
      })
      .catch(() => {
        if (alive) setToolConnected(null);
      });
    return () => {
      alive = false;
    };
  }, [slug, composioLinked]);

  const openComposioSignIn = () => {
    if (!openHttpsUrl(COMPOSIO_SIGN_IN_URL)) {
      setComposioError("Could not open Composio. RealBud stayed here.");
    }
  };

  const linkComposio = () => {
    if (composioBusy || !composioKey.trim()) return;
    setComposioBusy("link");
    setComposioError("");
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ composio: { key: composioKey.trim() } }),
    })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        setComposioKey("");
        setMethod("restricted-composio");
      })
      .catch((cause) => setComposioError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setComposioBusy(null));
  };

  const connectTool = () => {
    if (!slug || composioBusy || !composioLinked) return;
    setComposioBusy("connect");
    setComposioError("");
    api(`/api/connectors/${slug}/authorize`, { method: "POST" })
      .then(({ url }) => {
        if (typeof url !== "string" || !openHttpsUrl(url)) {
          throw new Error(`Could not open a sign-in page for ${tool.label}. RealBud stayed here.`);
        }
        let tries = 0;
        const timer = window.setInterval(() => {
          void refreshTool()
            .then(() => {
              if (++tries >= 6) window.clearInterval(timer);
            })
            .catch(() => {
              if (++tries >= 6) window.clearInterval(timer);
            });
        }, 5_000);
      })
      .catch((cause) => setComposioError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setComposioBusy(null));
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-muted">
        {tool.kind === "calendar"
          ? `Read named ${tool.label} only. Nothing writes or sends.`
          : `Read named ${tool.label} items. Reply drafts land on Desk. Nothing sends.`}
      </p>

      <section aria-label="How this office connects">
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

      {fill === "export" ? (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            Attach an export or screenshot here. Isolated file work stays on this device. It is not a live {tool.label} login.
          </p>
          <button
            type="button"
            onClick={onAttachInAsk}
            className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
          >
            <Paperclip size={14} aria-hidden="true" /> Attach an export in Ask
          </button>
        </div>
      ) : null}

      {fill === "gated" ? (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            {askConnectGatedDetail(method, { toolLabel: tool.label, currentStandard })}
          </p>
          <button
            type="button"
            onClick={() => setMethod(currentStandard)}
            className="pm-control pm-tactile inline-flex min-h-10 items-center rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
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
            className="pm-control pm-tactile inline-flex min-h-10 items-center rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
          >
            {askConnectUseStandardLabel("isolated-cli")}
          </button>
        </div>
      ) : null}

      {fill === "composio" ? (
        <div className="space-y-3">
          {!composioLinked ? (
            <>
              <div className="space-y-2">
                <p className="text-[12px] font-medium text-ink">Sign in to Composio</p>
                <p className="text-[12px] leading-relaxed text-ink-muted">
                  Use your own account. RealBud stays here.
                </p>
                <button
                  type="button"
                  onClick={openComposioSignIn}
                  className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
                >
                  <ExternalLink size={14} aria-hidden="true" /> Sign in to Composio
                </button>
              </div>
              <div className="space-y-2">
                <label className="block text-[12px] font-medium text-ink" htmlFor="ask-connect-composio-key">
                  Then paste the Connect key
                </label>
                <div className="flex flex-wrap gap-2">
                  <span className="relative min-w-[12rem] flex-1">
                    <KeyRound size={14} className="pointer-events-none absolute left-3 top-3 text-ink-muted" />
                    <input
                      id="ask-connect-composio-key"
                      type="password"
                      value={composioKey}
                      onChange={(event) => setComposioKey(event.target.value.slice(0, 200))}
                      onKeyDown={(event) => event.key === "Enter" && linkComposio()}
                      placeholder="ck_…"
                      autoComplete="off"
                      className="pm-control w-full rounded border border-line bg-inset py-2 pl-9 pr-3 text-[13px] text-ink focus:border-agency"
                    />
                  </span>
                  <button
                    type="button"
                    disabled={composioBusy !== null || !composioKey.trim()}
                    onClick={linkComposio}
                    className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded border border-line px-3 text-[12.5px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
                  >
                    {composioBusy === "link" ? <Loader2 size={13} className="animate-spin" /> : null}
                    Link account
                  </button>
                </div>
                <p className="text-[12px] leading-relaxed text-ink-muted">
                  The key stays on this device. After it is linked, this card can sign in {tool.label}.
                </p>
              </div>
            </>
          ) : slug ? (
            <>
              <p className="text-[12.5px] leading-relaxed text-ink-muted">
                {toolConnected
                  ? `${tool.label} is connected through the linked Composio account. Ask still cannot send.`
                  : `Composio is linked. Sign in to ${tool.label} for a named read-only account.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={composioBusy !== null}
                  onClick={connectTool}
                  className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover disabled:opacity-50"
                >
                  {composioBusy === "connect" ? <Loader2 size={13} className="animate-spin" /> : toolConnected ? <Check size={14} /> : <ExternalLink size={14} />}
                  {toolConnected ? `Reconnect ${tool.label}` : `Sign in to ${tool.label}`}
                </button>
                <button
                  type="button"
                  disabled={composioBusy !== null}
                  onClick={() => {
                    setComposioBusy("check");
                    void refreshTool().catch((cause) => setComposioError(cause instanceof Error ? cause.message : String(cause))).finally(() => setComposioBusy(null));
                  }}
                  className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded border border-line px-3 text-[12.5px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
                >
                  {composioBusy === "check" ? <Loader2 size={13} className="animate-spin" /> : null}
                  Check again
                </button>
              </div>
            </>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              {askConnectComposioUnavailableDetail(tool.label)}
            </p>
          )}
          {composioError ? <p className="text-[12px] text-danger" role="alert">{composioError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, Loader2 } from "lucide-react";

import { fmtDateTime } from "@/lib/au";
import { readBillingView, type BillingView } from "@/lib/billing";
import { api, useStore } from "@/state/store";
import { Card, CommandLine } from "./SettingsPrimitives";

const TOPUPS = [10, 25, 50];

const button =
  "inline-flex items-center justify-center gap-1.5 rounded border border-line bg-sheet px-3 py-2 text-[13px] text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40";
const primary =
  "inline-flex items-center justify-center gap-1.5 rounded bg-agency px-3 py-2 text-[13px] font-medium text-white hover:bg-agency-hover disabled:cursor-not-allowed disabled:opacity-40";

export function BillingCard() {
  const { refreshHermes } = useStore();
  const [view, setView] = useState<BillingView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"load" | "key" | "connect" | "topup" | "revoke" | "confirm" | null>("load");
  const [freshKey, setFreshKey] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const body = await api("/api/billing");
    const next = readBillingView(body);
    if (!next) throw new Error("Model spend could not be read.");
    setView(next);
  }, []);

  useEffect(() => {
    void load()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const sessionId = params.get("billing_session");
    if (!sessionId) return;
    setBusy("confirm");
    void api("/api/billing/topup/confirm", { method: "POST", body: JSON.stringify({ sessionId }) }, { timeoutMs: 20_000 })
      .then(() => load())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        setBusy(null);
        const url = new URL(location.href);
        url.searchParams.delete("billing_session");
        history.replaceState(null, "", `${url.pathname}${url.search}${url.hash || "#you-billing"}`);
      });
  }, [load]);

  const run = async (action: "key" | "connect" | "topup" | "revoke", job: () => Promise<void>) => {
    setBusy(action);
    setError("");
    try {
      await job();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const copyKey = async () => {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard can be denied */
    }
  };

  const topUp = (amountUsd: number) =>
    run("topup", async () => {
      const body = await api("/api/billing/topup", { method: "POST", body: JSON.stringify({ amountUsd }) }, { timeoutMs: 20_000 });
      if (typeof body.url === "string" && body.url) {
        window.location.assign(body.url);
      }
    });

  return (
    <div id="you-billing">
    <Card
      title="Model spend"
      subtitle="Issue a RealBud key so Bud's model calls settle here, with a margin, instead of a raw provider key this office does not bill."
    >
      <div className="space-y-4">
        {view ? (
          <>
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="rounded border border-line bg-inset/55 px-3 py-2">
                <dt className="text-[12px] text-ink-muted">Remaining</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-ink">{view.remainingLabel}</dd>
              </div>
              <div className="rounded border border-line bg-inset/55 px-3 py-2">
                <dt className="text-[12px] text-ink-muted">Spent</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-ink">{view.usage.billedLabel}</dd>
              </div>
              <div className="rounded border border-line bg-inset/55 px-3 py-2">
                <dt className="text-[12px] text-ink-muted">Tokens</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-ink">
                  {view.usage.promptTokens + view.usage.completionTokens}
                  <span className="ml-1 text-[12px] font-normal text-ink-muted">
                    tok · {view.usage.calls} {view.usage.calls === 1 ? "call" : "calls"}
                  </span>
                </dd>
              </div>
            </dl>
            {view.usage.usageMissingCalls > 0 ? (
              <p className="text-[12.5px] text-hold">
                {view.usage.usageMissingCalls} {view.usage.usageMissingCalls === 1 ? "call" : "calls"} had no provider usage. Those rows stay marked unavailable.
              </p>
            ) : null}
            {!view.upstreamConfigured ? (
              <p className="text-[12.5px] text-hold">
                The managed path needs REALBUD_OPENROUTER_API_KEY on the RealBud server. Office keys and the ledger still work.
              </p>
            ) : null}

            <div>
              <div className="text-[13px] font-medium text-ink">Office keys</div>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">The secret is shown once. Hermes stores it privately after Connect Bud.</p>
              <ul className="mt-2 space-y-2">
                {view.keys.length === 0 ? <li className="text-[12.5px] text-ink-muted">No office keys yet.</li> : null}
                {view.keys.map((key) => (
                  <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-line px-3 py-2">
                    <div>
                      <div className="text-[13px] text-ink">{key.label}</div>
                      <div className="font-mono text-[12px] text-ink-muted">{key.hint}</div>
                      <div className="text-[11.5px] text-ink-muted">{key.active ? "Active" : "Revoked"}</div>
                    </div>
                    {key.active ? (
                      <button
                        type="button"
                        className={button}
                        disabled={busy !== null}
                        onClick={() => run("revoke", async () => {
                          await api(`/api/billing/keys/${key.id}`, { method: "DELETE" });
                        })}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={button}
                  disabled={busy !== null}
                  onClick={() => run("key", async () => {
                    const created = await api("/api/billing/keys", { method: "POST", body: JSON.stringify({ label: "Office key" }) });
                    if (typeof created.key === "string") setFreshKey(created.key);
                  })}
                >
                  {busy === "key" ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                  Create key
                </button>
                <button
                  type="button"
                  className={primary}
                  disabled={busy !== null}
                  onClick={() => run("connect", async () => {
                    const connected = await api("/api/billing/connect-hermes", { method: "POST", body: "{}" }, { timeoutMs: 20_000 });
                    if (typeof connected.key === "string") setFreshKey(connected.key);
                    await refreshHermes();
                  })}
                >
                  {busy === "connect" ? <Loader2 size={14} className="animate-spin" /> : null}
                  Connect Bud
                </button>
              </div>
              {freshKey ? (
                <div className="mt-3 rounded border border-line bg-inset/55 px-3 py-2">
                  <div className="text-[12.5px] text-ink">Copy this key now. RealBud will not show it again.</div>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] text-ink">{freshKey}</code>
                    <button type="button" className={button} onClick={() => void copyKey()} aria-label="Copy office key">
                      {copied ? "Copied" : <Copy size={13} />}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div>
              <div className="text-[13px] font-medium text-ink">Point Hermes at RealBud</div>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">
                Provider {view.gateway.provider}. Base URL below. API key is the office key, not a raw OpenRouter secret.
              </p>
              <div className="mt-2">
                <CommandLine command={view.gateway.baseUrl} />
              </div>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-secondary">
                {view.hermes.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>

            <div>
              <div className="text-[13px] font-medium text-ink">Top up</div>
              <p className="mt-0.5 text-[12.5px] text-ink-muted">
                Credits are US dollars. Markup on this desk is ×{view.markup}.
                {view.payments.mockEnabled ? " Practice top-up is on (REALBUD_BILLING_MOCK=1)." : null}
              </p>
              {view.payments.todo ? <p className="mt-1 text-[12.5px] text-hold">{view.payments.todo}</p> : null}
              <div className="mt-2 flex flex-wrap gap-2">
                {TOPUPS.map((amount) => (
                  <button
                    key={amount}
                    type="button"
                    className={view.payments.stripeConfigured || view.payments.mockEnabled ? primary : button}
                    disabled={busy !== null || (!view.payments.stripeConfigured && !view.payments.mockEnabled)}
                    onClick={() => void topUp(amount)}
                  >
                    {busy === "topup" ? <Loader2 size={14} className="animate-spin" /> : null}
                    US${amount}
                  </button>
                ))}
              </div>
            </div>

            {view.recent.length > 0 ? (
              <div>
                <div className="text-[13px] font-medium text-ink">Recent</div>
                <ul className="mt-2 divide-y divide-line border-t border-line">
                  {view.recent.map((row) => (
                    <li key={row.id} className="flex flex-wrap justify-between gap-2 py-2 text-[12.5px]">
                      <span className="text-ink">
                        {row.kind === "topup" ? "Top-up" : row.model || "Model call"}
                        {row.kind === "llm" && !row.usageAvailable ? " · usage unavailable" : null}
                      </span>
                      <span className="tabular-nums text-ink-muted">
                        {row.kind === "llm" ? `${row.promptTokens + row.completionTokens} tok · ` : ""}
                        {row.billedLabel}
                        <span className="ml-2">{fmtDateTime(row.at)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : busy === "load" ? (
          <div className="space-y-2" role="status" aria-label="Loading model spend">
            <div className="h-3 w-[75%] max-w-[16rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
            <div className="h-3 w-[50%] max-w-[10rem] animate-pulse rounded bg-raised motion-reduce:animate-none" />
          </div>
        ) : null}
        {error ? <p className="text-[12.5px] text-danger">{error}</p> : null}
      </div>
    </Card>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/state/store";
import { Card } from "../SettingsPrimitives";
import { formatNanoAud, formatTokenCount, currentUsagePeriod, parseInstallationUsage, type InstallationUsageState } from "@shared/office-link";

import { usageBudget, USAGE_BUDGET_NOTE } from "@shared/usage-budget";

const SUBTITLE = "Recorded usage across your linked office’s RealBud account this month.";

/** Month as people read it, from the YYYY-MM the account reported. */
export function usagePeriodLabel(period: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) return "This month";
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
    .toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-baseline justify-between gap-4 py-1.5">
    <dt className="text-[13px] text-ink-secondary">{label}</dt>
    <dd className="text-[15px] tabular-nums text-ink">{value}</dd>
  </div>;
}

/**
 * The account is the authority for these figures; this only shows what it sent.
 * Every state that is not `ready` says so in words rather than showing a zero,
 * because "no usage yet" and "we could not ask" are different facts.
 */
export function AiUsageCardView({ usage, busy, onRefresh }: {
  usage: InstallationUsageState | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  const refresh = <button type="button" onClick={onRefresh} disabled={busy}
    aria-label="Check AI usage again"
    className="pm-control mt-3 min-h-[44px] rounded border border-line px-3 py-2 text-sm disabled:opacity-50">
    {busy ? "Checking…" : "Check again"}
  </button>;

  if (!usage || usage.state === "checking") return <Card title="AI usage this month" subtitle={SUBTITLE}>
    <p role="status" className="text-sm text-ink-secondary">Checking your account…</p>
  </Card>;

  if (usage.state === "not-linked") return <Card title="AI usage this month" subtitle={SUBTITLE}>
    <p className="text-sm text-ink-secondary">Not linked. Link this computer to your RealBud account above to see its recorded usage.</p>
  </Card>;

  if (usage.state === "unavailable") return <Card title="AI usage this month" subtitle={SUBTITLE}>
    <p role="status" className="text-sm text-ink-secondary">Usage unavailable. Your account could not be reached just now — nothing is wrong with this computer, and no figures are shown rather than guessed.</p>
    {refresh}
    <p className="mt-3 text-sm"><a className="text-agency underline" href="https://realbud.app/account/ai-billing" target="_blank" rel="noreferrer">View usage and billing on the website</a></p>
  </Card>;

  const { period, requests, tokens, money, remainingNanoAud, monthlyCapNanoAud, updatedAt } = usage.usage;
  const budget = usageBudget(monthlyCapNanoAud, remainingNanoAud);
  return <Card title="AI usage this month" subtitle={SUBTITLE}>
    <dl aria-label={`AI usage for ${usagePeriodLabel(period)}`} className="divide-y divide-line">
      <Row label="Cost so far" value={formatNanoAud(money.customerNetNanoAud)} />
      <Row label="Budget used" value={budget.state === 'ready' ? budget.label : budget.state === 'disabled' ? 'Not enabled' : 'Not reported by your account'} />
      <Row label="Budget remaining" value={budget.state === "disabled" ? "Not enabled" : remainingNanoAud === null ? "Not reported by your account" : formatNanoAud(remainingNanoAud)} />
    </dl>
    {budget.state === 'ready' ? <progress className="mt-3 h-3 w-full accent-agency" aria-label="Monthly spending budget used" aria-valuetext={budget.label} max={100} value={budget.percent} /> : null}
    <p className="mt-2 text-xs text-ink-muted">{USAGE_BUDGET_NOTE}</p>
    <details className="mt-3 text-sm text-ink-secondary"><summary>Request and token details</summary><dl>
      <Row label="Requests" value={requests.toLocaleString("en-AU")} />
      <Row label="Tokens in / out" value={`${formatTokenCount(tokens.input)} / ${formatTokenCount(tokens.output)}`} />
    </dl><p className="text-xs">Input excludes cache reads and writes.</p></details>
    <p className="mt-2 text-xs text-ink-muted">
      {monthlyCapNanoAud === null || budget.state === "disabled" ? "" : `Monthly limit ${formatNanoAud(monthlyCapNanoAud)}. `}
      Reported by your account at {new Date(updatedAt).toLocaleString("en-AU")}. Available budget is subject to current service limits. Usage is not a request for payment. Issued invoices show any amount due.
    </p>
    {refresh}
    <p className="mt-3 text-sm"><a className="text-agency underline" href="https://realbud.app/account/ai-billing" target="_blank" rel="noreferrer">View usage and billing on the website</a></p>
  </Card>;
}

export function AiUsageCard() {
  const [usage, setUsage] = useState<InstallationUsageState | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (inFlight.current || !active.current) return;
    const requestGeneration = generation.current;
    inFlight.current = true; setBusy(true);
    try {
      const status = await api("/api/office-link") as { usage?: InstallationUsageState };
      const value = status?.usage;
      let next: InstallationUsageState = { state: "unavailable" };
      if (value?.state === 'ready') next = { state: 'ready', usage: parseInstallationUsage(value.usage, currentUsagePeriod()) };
      else if (value && ['checking', 'not-linked', 'unavailable'].includes(value.state)) next = value;
      if (active.current && requestGeneration === generation.current) setUsage(next);
    } catch { if (active.current && requestGeneration === generation.current) setUsage({ state: "unavailable" }); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }, []);
  useEffect(() => {
    active.current = true;
    void load();
    // Status is a local read. It starts due account refreshes in the background;
    // frequent local reads collect the result even when the network is slow.
    const refreshVisible = () => { if (document.visibilityState !== 'hidden') void load(); };
    const timer = window.setInterval(refreshVisible, 5_000);
    const onLinkChanged = () => { generation.current++; setUsage(null); refreshVisible(); };
    window.addEventListener("realbud-website-link-changed", onLinkChanged);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { active.current = false; generation.current++; window.clearInterval(timer); window.removeEventListener("realbud-website-link-changed", onLinkChanged); window.removeEventListener('focus', refreshVisible); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [load]);
  return <AiUsageCardView usage={usage} busy={busy} onRefresh={() => { void load(); }} />;
}

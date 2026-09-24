import { useCallback, useEffect, useState } from "react";

import { api } from "@/state/store";
import { Card } from "../SettingsPrimitives";
import { formatNanoAud, formatTokenCount, type InstallationUsageState } from "@shared/office-link";

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
  return <Card title="AI usage this month" subtitle={SUBTITLE}>
    <dl aria-label={`AI usage for ${usagePeriodLabel(period)}`} className="divide-y divide-line">
      <Row label="Requests" value={requests.toLocaleString("en-AU")} />
      <Row label="Tokens in / out" value={`${formatTokenCount(tokens.input)} / ${formatTokenCount(tokens.output)}`} />
      <Row label="Customer usage estimate" value={formatNanoAud(money.customerNetNanoAud)} />
      {/* The account does not always report a spend cap. Absent is "not
          reported", never "no limit": claiming an uncapped account it never
          promised would be inventing a fact. */}
      <Row label="Reported headroom" value={remainingNanoAud === null ? "Not reported by your account" : formatNanoAud(remainingNanoAud)} />
    </dl>
    <p className="mt-2 text-xs text-ink-muted">
      {monthlyCapNanoAud === null ? "" : `Monthly limit ${formatNanoAud(monthlyCapNanoAud)}. `}
      Reported by your account at {new Date(updatedAt).toLocaleString("en-AU")}. Reported headroom does not authorize new work. Usage is not a request for payment. Issued invoices show any amount due.
    </p>
    {refresh}
    <p className="mt-3 text-sm"><a className="text-agency underline" href="https://realbud.app/account/ai-billing" target="_blank" rel="noreferrer">View usage and billing on the website</a></p>
  </Card>;
}

export function AiUsageCard() {
  const [usage, setUsage] = useState<InstallationUsageState | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try { const status = await api("/api/office-link") as { usage?: InstallationUsageState }; setUsage(status?.usage ?? { state: "unavailable" }); }
    catch { setUsage({ state: "unavailable" }); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => {
    void load();
    // The first read only starts the account request; the next one carries it.
    const timer = setTimeout(() => { void load(); }, 2_500);
    const onLinkChanged = () => { void load(); };
    window.addEventListener("realbud-website-link-changed", onLinkChanged);
    return () => { clearTimeout(timer); window.removeEventListener("realbud-website-link-changed", onLinkChanged); };
  }, [load]);
  return <AiUsageCardView usage={usage} busy={busy} onRefresh={() => { void load(); }} />;
}

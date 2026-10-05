// Two holds a person releases from Ask, next to readiness and approvals:
// a pressed browser step whose result Bud could not see (the person checks the
// site and says whether it happened), and work from an earlier run that may
// still be going (the person restarts, then Bud checks again). The server
// (server/recovery-holds.ts) decides; these cards only ask and report.
import { CircleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { browserApprovalFact, browserApprovalMoney, readBrowserApprovalCard, type BrowserApprovalCard, type BrowserApprovalFactName } from "@shared/browser-approval-card";
import { BrowserApprovalFacts } from "./BrowserApprovalCard";
import { api } from "@/state/store";

export interface HeldStep { id: string; host: string; summary: string; approval: BrowserApprovalCard | null }
export type CustodyState = "clear" | "held" | "unsaved" | "damaged";
type Answer = "confirmed" | "not-done";

/** A malformed step is dropped, never shown with made-up facts. */
export function readHeldSteps(value: unknown): HeldStep[] {
  const steps = (value as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) throw new Error("Bud's list of steps to check could not be read.");
  return steps.flatMap(item => {
    const row = item as Record<string, unknown>;
    if (!row || typeof row.id !== "string" || !/^[0-9a-f-]{36}$/.test(row.id) || typeof row.host !== "string" || !row.host || typeof row.summary !== "string") return [];
    return [{ id: row.id, host: row.host, summary: row.summary, approval: readBrowserApprovalCard(row.approval) }];
  });
}
export const readCustodyState = (value: unknown): CustodyState => {
  const state = (value as { state?: unknown })?.state;
  if (state === "clear" || state === "held" || state === "unsaved" || state === "damaged") return state;
  throw new Error("Bud's record of running work could not be read.");
};

/** A held step asks about the past, never the approval's "Pay …?", e.g.
 * "Did the A$1,240.00 payment to Fictional Strata Pty Ltd go through?". */
export function heldStepTitle(card: BrowserApprovalCard): string {
  const confirmed = (name: BrowserApprovalFactName) => {
    const fact = browserApprovalFact(card, name);
    return fact?.confirmed && fact.value ? fact.value : null;
  };
  const money = browserApprovalMoney(card), payee = confirmed("recipient"), to = confirmed("to");
  const document = confirmed("document"), target = confirmed("target");
  switch (card.kind) {
    case "pay": return money && payee ? `Did the ${money} payment to ${payee} go through?` : `Did the payment on ${card.site} go through?`;
    case "send": return to ? `Did the message to ${to} send?` : `Did the message on ${card.site} send?`;
    case "sign": return document ? `Was “${document}” signed?` : `Was the document on ${card.site} signed?`;
    case "notice": return document ? `Was the notice “${document}” issued?` : `Was the notice on ${card.site} issued?`;
    case "delete": return target ? `Was ${target} deleted?` : `Was the item on ${card.site} deleted?`;
    case "account-change": return target ? `Did the account change go through: ${target}?` : `Did the account change on ${card.site} go through?`;
  }
}

export const heldStepPrompt = (host: string) => `Bud isn't sure this happened. Check ${host}, then tell Bud.`;
const ANSWERED: Record<Answer, string> = {
  confirmed: "Recorded as done. Bud won't do it again.",
  "not-done": "Recorded as not done. You can ask Bud to try again; it will ask for your approval first.",
};

export function HeldStepCard({ step, busy, error, onAnswer }: { step: HeldStep; busy: boolean; error?: string; onAnswer: (answer: Answer) => void }) {
  const promptId = useId();
  return (
    <section aria-label={`Check a step on ${step.host}`} className="mb-2 overflow-hidden rounded-2xl border border-hold/40 bg-card">
      <div className="border-b border-line bg-sheet px-4 py-3">
        {step.approval
          ? <BrowserApprovalFacts approval={step.approval} now={Date.now()} status={heldStepPrompt(step.host)} title={heldStepTitle(step.approval)} />
          : <><h3 className="break-words text-[16px] font-semibold text-ink">{step.summary}</h3><p className="mt-2 text-[13px] text-ink">{heldStepPrompt(step.host)}</p></>}
      </div>
      <div className="flex flex-col gap-2 px-4 py-3">
        <p id={promptId} className="text-[13px] text-ink-muted">Bud won't repeat this until you tell it what happened.</p>
        {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} aria-describedby={promptId} onClick={() => onAnswer("confirmed")}
            className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:cursor-not-allowed disabled:opacity-50">
            It happened
          </button>
          <button type="button" disabled={busy} aria-describedby={promptId} onClick={() => onAnswer("not-done")}
            className="pm-control rounded border border-line px-3.5 text-[14px] text-ink hover:bg-selected disabled:cursor-not-allowed disabled:opacity-50">
            It didn't happen
          </button>
        </div>
      </div>
    </section>
  );
}

const CUSTODY: Record<Exclude<CustodyState, "clear">, { text: string; action?: string }> = {
  held: { text: "Bud may still have work running from before RealBud last closed, so restart this computer and then let Bud check.", action: "I've restarted, check again" },
  unsaved: { text: "Bud couldn't save its record of running work, so free some disk space and then let Bud check.", action: "Check again" },
  damaged: { text: "Bud's record of running work needs recovery, so contact RealBud support before starting new work." },
};

export function WorkerCustodyNotice({ state, busy, error, onCheck }: { state: Exclude<CustodyState, "clear">; busy: boolean; error?: string; onCheck: () => void }) {
  const copy = CUSTODY[state];
  return (
    <section className="ask-readiness mb-2" data-error aria-label="Earlier work may still be running">
      <div className="ask-readiness-icon" aria-hidden><CircleAlert size={18} /></div>
      <div className="min-w-0 flex-1" role="status">
        <p className="text-ink">{copy.text}</p>
        {error ? <p className="mt-0.5 text-[13px] text-danger">{error}</p> : null}
      </div>
      {copy.action ? (
        <div className="ask-readiness-actions">
          <button type="button" disabled={busy} onClick={onCheck} className="ask-button ask-button-primary">{busy ? "Checking…" : copy.action}</button>
        </div>
      ) : null}
    </section>
  );
}

const message = (error: unknown) => error instanceof Error ? error.message : "That did not go through. Try again.";

/** Reads both holds on mount and every 20 s; renders nothing when neither is held. */
export function RecoveryCards() {
  const [steps, setSteps] = useState<HeldStep[]>([]);
  const [custody, setCustody] = useState<CustodyState>("clear");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const [held, worker] = await Promise.allSettled([api("/api/browser/held"), api("/api/worker-issues/custody")]);
    if (!mounted.current) return;
    if (held.status === "fulfilled") { try { setSteps(readHeldSteps(held.value)); } catch { /* keep the last good list */ } }
    if (worker.status === "fulfilled") { try { setCustody(readCustodyState(worker.value)); } catch { /* keep the last good state */ } }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 20_000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);

  const answer = async (id: string, result: Answer) => {
    setBusy(id); setErrors(({ [id]: _, ...rest }) => rest);
    try {
      const body = await api("/api/browser/held/reconcile", { method: "POST", body: JSON.stringify({ id, result }) });
      if (!mounted.current) return;
      setSteps(readHeldSteps(body)); setDone(ANSWERED[result]);
    } catch (error) {
      if (!mounted.current) return;
      // The answer may have landed even if the reply was lost: re-read before offering it again.
      setErrors(current => ({ ...current, [id]: message(error) })); void refresh();
    } finally { if (mounted.current) setBusy(null); }
  };
  const check = async () => {
    setBusy("custody"); setErrors(({ custody: _, ...rest }) => rest);
    try { setCustody(readCustodyState(await api("/api/worker-issues/custody/check", { method: "POST", body: "{}" }))); }
    catch (error) { if (mounted.current) setErrors(current => ({ ...current, custody: message(error) })); void refresh(); }
    finally { if (mounted.current) setBusy(null); }
  };

  return (
    <>
      {custody !== "clear" ? <WorkerCustodyNotice state={custody} busy={busy === "custody"} error={errors.custody} onCheck={() => void check()} /> : null}
      {steps.map(step => <HeldStepCard key={step.id} step={step} busy={busy === step.id} error={errors[step.id]} onAnswer={result => void answer(step.id, result)} />)}
      {done ? <p role="status" className="px-4 py-2 text-[13px] text-ink-muted">{done}</p> : null}
    </>
  );
}

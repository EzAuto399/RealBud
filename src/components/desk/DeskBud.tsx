import type { budAvailability } from "@/lib/bud-setup";
import { WorkContextCard } from "../WorkContextCard";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { MausAvatar } from "../Avatar";
import { deskCaseIsNoDraft, type DeskAskIntent } from "@/lib/desk-ask-context";
import { recoveryPlanFor, type DeskQueueItem } from "@/lib/desk-queue";

export function DeskBud({ item, connected, ready, working, availability, onAsk, onOpenChat, onSetup }: {
  item?: DeskQueueItem;
  connected: boolean;
  ready: boolean;
  working: boolean;
  availability?: ReturnType<typeof budAvailability>;
  onAsk: (intent: DeskAskIntent) => void;
  onOpenChat: () => void;
  onSetup: () => void;
}) {
  // Licensee / hardship / dispute cannot be drafted by RealBud — same rule as
  // deskCaseIsNoDraft / deskCaseInstruction. Label and caption must match Ask.
  const noDraftCase = item ? deskCaseIsNoDraft(item) : false;
  const nextStepLabel = noDraftCase ? "Ask Bud about this case" : "Prepare next step";
  const emptyHintId = "desk-bud-empty-hint";
  return <section className="desk-bud" aria-label="Bud assistant">
    <header className="desk-bud-heading">
      <MausAvatar color="green" state={!connected ? "sleeping" : working ? "working" : ready ? "idle" : "alerting"} size={40} label="Bud" trackPointer={false} />
      <div><h2>Bud</h2><p role="status">{!connected ? "Reconnecting to RealBud" : working ? "Working" : availability?.label ?? (ready ? "Bud ready" : "Setup needed")}</p></div>
    </header>
    {availability && !availability.ready && <p className="text-[12px] text-ink-muted">{availability.detail}</p>}
    <p className="desk-bud-intro">Work through a case together.</p>
    <p className="desk-bud-description">Ask for a summary, refine wording, or work out what to do next.</p>
    {item ? <WorkContextCard title={item.address} detail={item.action} status="Selected task" /> : <p id={emptyHintId} className="desk-bud-context">Select a task to bring its context into your conversation.</p>}
    {item && noDraftCase && <p className="desk-bud-hold">A licensed person decides this. RealBud will not draft or send a notice.</p>}
    <button type="button" disabled={!item} aria-describedby={!item ? emptyHintId : undefined} className="desk-primary-button" onClick={() => onAsk("next")}><MessageSquare size={16} aria-hidden />{nextStepLabel}<ArrowUpRight size={15} aria-hidden /></button>
    {item && <>
      <button type="button" className="desk-secondary-button" onClick={() => onAsk("summary")}>Summarise this case</button>
      {item.draftId && !noDraftCase && <button type="button" className="desk-secondary-button" onClick={() => onAsk("refine")}>Improve wording</button>}
      {item.bucket !== "done" && recoveryPlanFor(item).action === "ask" && <button type="button" className="desk-secondary-button" onClick={() => onAsk("investigate")}>Investigate missing facts</button>}
    </>}
    <p className="desk-bud-caption">{noDraftCase ? "Opens Ask with an evidence brief request — no notice draft. Review before sending." : "Opens Ask with this case’s facts, notes and safeguards attached. Review the request before sending."}</p>
    {!ready && connected && <button type="button" className="desk-secondary-button" onClick={onSetup}>Check Bud connection</button>}
    <button type="button" className="desk-secondary-button" onClick={onOpenChat}>Open conversation<ArrowUpRight size={15} aria-hidden /></button>
    <div className="desk-bud-footer">You review prepared work and decide what happens next.</div>
  </section>;
}

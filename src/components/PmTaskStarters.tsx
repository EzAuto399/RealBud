import { PM_TASK_STARTERS } from "@/lib/pm-task-starters";
import { ArrowUpRight, CalendarCheck2, FileSearch, Mail, Search, Inbox, Wrench, ReceiptText } from "lucide-react";

const starterIcons = { "rent-evidence": ReceiptText, "inbox-triage": Inbox, "maintenance-follow-ups": Wrench, "owner-update": Mail, "compare-documents": FileSearch, "prepare-day": CalendarCheck2, research: Search };

const featuredIds = new Set<string>(["prepare-day", "owner-update"]);

export function PmTaskStarters({ onChoose, disabled = false }: { onChoose: (text: string) => void; disabled?: boolean }) {
  const renderExample = (example: (typeof PM_TASK_STARTERS)[number]) => {
    const Icon = starterIcons[example.id];
    return (
      <button key={example.id} type="button" disabled={disabled} onClick={() => onChoose(example.text)} className="ask-task-starter">
        <span className="ask-task-icon"><Icon size={19} aria-hidden /></span>
        <span className="min-w-0"><span className="block text-[14px] font-semibold text-ink">{example.title}</span>
        <span className="mt-1 block text-[13px] leading-relaxed text-ink-muted">{example.detail}</span></span>
        <ArrowUpRight size={15} className="ask-task-arrow" aria-hidden />
      </button>
    );
  };
  return (
    <div className="w-full max-w-[48rem] text-left">
      <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Task examples">
        {PM_TASK_STARTERS.filter(example => featuredIds.has(example.id)).reverse().map(renderExample)}
      </div>
      <details className="mt-2">
        <summary className="pm-control cursor-pointer text-[13px] text-ink-muted">More task examples</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2" role="group" aria-label="More task examples">
          {PM_TASK_STARTERS.filter(example => !featuredIds.has(example.id)).map(renderExample)}
        </div>
      </details>
      <p className="mt-2 text-[13px] text-ink-muted">Choose an example to edit, or describe your own task. Nothing starts until you ask.</p>
    </div>
  );
}

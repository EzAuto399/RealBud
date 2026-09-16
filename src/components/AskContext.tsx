import { useEffect, useRef } from "react";
import { ArrowUpRight, BookOpen, ChevronDown, Clock3, FileCheck2 } from "lucide-react";
import type { DeskSnapshot } from "@/lib/desk";
import { fmtDateTime } from "@/lib/au";

/** Book provenance is separate from worker readiness: connecting a model
 * never makes a historical property check live. */
export function AskContext({ desk, missed, onDesk }: { desk: DeskSnapshot | null; missed: boolean; onDesk: () => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);
  const sample = desk?.demo || desk?.mode === "demo";
  const label = !desk ? "Book loading" : sample ? "Sample book" : "Office book";
  return (
    <details ref={ref} className="ask-context" onKeyDown={(event) => {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
        event.stopPropagation();
      }
    }}>
      <summary className="ask-context-trigger"><BookOpen size={15} aria-hidden /><span>{label}</span>{desk && <span className="ask-context-count">{desk.properties.length} properties</span>}<ChevronDown size={13} aria-hidden /></summary>
      <div className="ask-context-panel">
        <p className="ask-eyebrow">Context for this conversation</p>
        <h2>{label}</h2>
        <p>{sample ? "Training properties for trying out your workflow. These are sample records." : "Bud can use the property book and the context you provide in this conversation."}</p>
        <div className="ask-context-fact"><Clock3 size={15} aria-hidden /><span>{desk?.lastRunAt ? `Last Desk check · ${fmtDateTime(desk.lastRunAt, desk.timezone)}` : "No Desk check recorded yet"}</span></div>
        {missed && <p className="ask-context-warning">The last Desk check did not return live facts. Review the sources before relying on this book.</p>}
        <div className="ask-context-fact"><FileCheck2 size={15} aria-hidden /><span>Attachments and previous results keep their original source dates.</span></div>
        <button type="button" className="ask-button ask-button-secondary mt-3 w-full" onClick={onDesk}>Review book on Desk<ArrowUpRight size={15} aria-hidden /></button>
      </div>
    </details>
  );
}

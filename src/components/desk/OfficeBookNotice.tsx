import type { DeskSnapshot } from "@/lib/desk";

export const OFFICE_BOOK_EMPTY = "Your office book is empty — add properties or ask Bud to import them.";

/** A live book with no properties: nothing to check, nothing sampled. */
export function isEmptyOfficeBook(snap: Pick<DeskSnapshot, "mode" | "demo" | "properties" | "recovery">): boolean {
  return snap.mode === "live" && !snap.demo && snap.properties.length === 0 && !snap.recovery?.active;
}

/** The sample stays on a linked computer only when the person already edited
 * it; they choose when to start the office book. Never offered offline. */
export function offersOfficeBookStart(snap: Pick<DeskSnapshot, "mode" | "demo" | "recovery">, linked: boolean): boolean {
  return linked && (snap.mode === "demo" || snap.demo) && !snap.recovery?.active;
}

export function OfficeBookEmpty({ onOpenBook, onAsk }: { onOpenBook: () => void; onAsk: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center" role="status">
      <p className="max-w-[28rem] text-[15px] text-ink">{OFFICE_BOOK_EMPTY}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button type="button" className="desk-primary-button" onClick={onOpenBook}>Add properties</button>
        <button type="button" className="desk-secondary-button" onClick={onAsk}>Ask Bud to import</button>
      </div>
    </div>
  );
}

export function StartOfficeBook({ busy, onStart }: { busy: boolean; onStart: () => void }) {
  return (
    <div role="status" className="mt-2 flex max-w-full flex-wrap items-center gap-2 border border-agency/20 bg-agency/5 px-3 py-2 text-[13px] text-ink-secondary">
      <span className="min-w-0 flex-1">This computer is linked to your office. The sample you edited is still here; start your office book when you are ready. The sample is replaced by an empty book.</span>
      <button type="button" className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink" disabled={busy} onClick={onStart}>
        Start your office book
      </button>
    </div>
  );
}

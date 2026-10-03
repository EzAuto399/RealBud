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
    <div className="desk-office-book-empty max-w-xl rounded-lg border border-line bg-sheet p-6" role="status">
      <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">Start your office book</h2>
      <p className="mt-3 max-w-[28rem] text-[15px] leading-relaxed text-ink-secondary">{OFFICE_BOOK_EMPTY}</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" className="desk-primary-button" onClick={onOpenBook}>Add properties</button>
        <button type="button" className="desk-office-book-help" onClick={onAsk}>Ask Bud for help</button>
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

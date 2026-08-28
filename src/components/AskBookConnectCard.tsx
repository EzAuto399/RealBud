import { useEffect, useState } from "react";
import { Loader2, Paperclip } from "lucide-react";

import { cn } from "@/lib/cn";
import type { SourceConnection } from "@/lib/source-connections";
import { api } from "@/state/store";

export function AskBookConnectCard({
  suggestedName,
  onAttachInAsk,
}: {
  suggestedName: string | null;
  onAttachInAsk: () => void;
}) {
  const [book, setBook] = useState<SourceConnection | null>(null);
  const [alias, setAlias] = useState(suggestedName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void api("/api/source-connections")
      .then((body: { connections?: SourceConnection[] }) => {
        if (!alive) return;
        const next = body.connections?.find((item) => item.id === "property-book") ?? null;
        setBook(next);
        setAlias((current) => current || next?.alias || suggestedName || "");
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [suggestedName]);

  const saveAlias = () => {
    if (busy) return;
    setBusy(true);
    setError("");
    void api("/api/source-connections/aliases", {
      method: "PATCH",
      body: JSON.stringify({ id: "property-book", alias }),
    })
      .then((body: { connections?: SourceConnection[] }) => {
        const next = body.connections?.find((item) => item.id === "property-book") ?? null;
        if (next) setBook(next);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Structured export first. A live PMS read waits for the pilot. Saving the name tells routines which book this office uses.
      </p>
      {book ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
          <span className={cn(
            "rounded-full border px-2 py-0.5 text-[12px] font-medium",
            book.state === "ready"
              ? "border-agency/30 bg-selected text-agency"
              : book.state === "attention"
                ? "border-hold/35 bg-hold/10 text-hold"
                : "border-line bg-paper text-ink-muted",
          )}>
            {book.status}
          </span>
          <span className="text-ink-muted">{book.alias || book.title}</span>
        </p>
      ) : !error ? (
        <p className="flex items-center gap-2 text-[13px] text-ink-muted" aria-busy="true">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Checking the book…
        </p>
      ) : null}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          saveAlias();
        }}
      >
        <label className="min-w-[12rem] flex-1 text-[12px] font-medium text-ink" htmlFor="ask-book-alias">
          Name this office uses
          <input
            id="ask-book-alias"
            value={alias}
            onChange={(event) => setAlias(event.target.value.slice(0, 40))}
            placeholder="The name on your PMS login"
            className="pm-control mt-1 w-full rounded border border-line bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-muted focus:border-agency"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="pm-control pm-tactile min-h-10 rounded border border-line bg-sheet px-3 text-[13px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save name"}
        </button>
      </form>
      <button
        type="button"
        onClick={onAttachInAsk}
        className="pm-control pm-tactile inline-flex min-h-10 items-center gap-1.5 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
      >
        <Paperclip size={14} aria-hidden="true" /> Attach an export in Ask
      </button>
      {error ? <p className="text-[12px] text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

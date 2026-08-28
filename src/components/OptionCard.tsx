import { useState } from "react";
import { X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const card = message.card;
  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };

  return (
    <section className="w-full max-w-[760px] border border-line border-l-2 border-l-agency bg-sheet p-4" aria-label={card.title}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[16px] font-semibold text-ink">{card.title}</div>
          <div className="mt-0.5 text-[14px] text-ink-secondary">
            {card.subtitle}
          </div>
        </div>
        <button
          onClick={() =>
            dispatch({ type: "dismissCard", botId, messageId: message.id })
          }
          aria-label="Dismiss question"
          title="Dismiss question"
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-3 overflow-hidden rounded border border-line" role="group" aria-label="Answer choices">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            disabled={!!card.answered}
            onClick={() => answer(opt)}
            className={cn(
              "flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left text-[14px] text-ink",
              i > 0 && "border-t border-line",
              card.answered === opt
                ? "bg-raised"
                : "hover:bg-raised/60 disabled:hover:bg-transparent",
            )}
          >
            <span className="flex size-6 items-center justify-center rounded border border-line bg-paper text-[11px] font-medium text-ink-secondary" aria-hidden="true">
              {LETTERS[i]}
            </span>
            {opt}
          </button>
        ))}
      </div>

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!card.answered && !card.tool && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && answer(custom)}
          placeholder="Type your own answer"
          aria-label="Type your own answer"
          className="mt-3 min-h-10 w-full rounded border border-line bg-inset px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-agency focus:outline-none"
        />
      )}
    </section>
  );
}

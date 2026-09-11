import { ApprovalScope } from "./ApprovalScope";
// The approval box: what the bot wants to do, and three ways to answer.
//
// Deliberately not the lettered A/B/C list the onboarding card uses — an
// approval is a decision about one concrete action, so it shows the tool
// and the actual command/path in monospace, and the choices carry their
// own behavior instead of being matched by their label text.
import { Check, ShieldCheck, X } from "lucide-react";
import { useId, useState } from "react";
import { useStore, type Bot, type Message } from "@/state/store";
import { approvalHeadline } from "@/lib/tool-label";
import { cn } from "@/lib/cn";

const LONG_DETAIL_CHARS = 400;
const LONG_DETAIL_LINES = 8;

/** The tool's own name is noise to a human: mcp__ogb__computer_batch is
 * "computer batch", Bash is "run a command". */
function legacyToolLabel(tool?: string): string {
  if (!tool) return "an action";
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: Record<string, string> = {
    Bash: "run a command",
    Read: "read a file",
    Write: "write a file",
    Edit: "edit a file",
    WebFetch: "fetch a web page",
    WebSearch: "search the web",
  };
  return nice[tool] ?? bare;
}

export function ApprovalCard({
  bot,
  message,
  productAsk = false,
}: {
  /** who is asking, for the "Name wants to …" line */
  bot?: Bot;
  message: Message;
  productAsk?: boolean;
}) {
  const { state } = useStore();
  const detailId = useId();
  const [expanded, setExpanded] = useState(false);
  const card = message.card;
  if (!card) return null;
  const settled = card.answered;
  const knownAddresses = productAsk ? (state.desk?.properties ?? []).map((row) => row.address) : [];
  const headline = productAsk
    ? approvalHeadline(card.tool ?? "", [card.subtitle, card.held, card.title].filter(Boolean).join("\n"), knownAddresses)
    : `${bot ? `${bot.name} wants to ` : "Wants to "}${legacyToolLabel(card.tool)}`;
  const detail = card.subtitle ?? "";
  const longDetail = detail.length > LONG_DETAIL_CHARS || detail.split("\n").length > LONG_DETAIL_LINES;

  return (
    <div
      className={cn(
        "w-full max-w-[840px] rounded-2xl border p-4",
        productAsk ? "bg-sheet" : "bg-card",
        settled ? (productAsk ? "border-line opacity-70" : "border-hairline/30 opacity-70") : productAsk ? "border-agency/40" : "border-accent/40",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-semibold text-ink" title={card.tool}>
          {headline}
        </div>
        {card.tool && !productAsk && <span className="shrink-0 font-mono text-[11px] text-ink-muted">{card.tool}</span>}
      </div>

      {card.fence?.surface === "portal-submit" ? (
        <p className="mt-2 text-[15px] font-medium leading-relaxed text-ink">{card.subtitle}</p>
      ) : (
        <div className="mt-2">
          <pre
            id={detailId}
            className={cn(
              "whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink",
              longDetail && !expanded ? "max-h-40 overflow-hidden" : undefined,
            )}
          >
            {card.subtitle}
          </pre>
          {longDetail && (
            <button
              type="button"
              className="mt-2 text-[12.5px] text-ink-secondary hover:text-ink"
              aria-controls={detailId}
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Show less" : "Show full operation"}
            </button>
          )}
        </div>
      )}

      {card.fence?.surface === "portal-submit" ? (
        <p className="mt-2 text-[12.5px] text-hold">Check the form in the browser before you allow.</p>
      ) : null}

      {productAsk && !settled && <ApprovalScope kind="action" />}
      {card.held && (
        <div className="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          {card.held}
        </div>
      )}

      {/* The decision lives in the composer (one place to answer, and it
          can't be scrolled past); here we only record what happened. */}
      <div className="mt-3 flex items-center gap-1.5 text-[13px] text-ink-secondary">
        {settled === "allow" ? (
          <>
            <Check size={14} className="text-success" /> Approved
          </>
        ) : settled ? (
          <>
            <X size={14} /> Not approved
          </>
        ) : (
          <>
            <ShieldCheck size={14} className="text-accent" /> Waiting for your answer below
          </>
        )}
      </div>
    </div>
  );
}

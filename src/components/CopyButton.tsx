import { Check, Copy } from "lucide-react";
import { useCopyText } from "@/lib/use-copy-text";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const { state, copy } = useCopyText(text);
  return <span className="workspace-copy">
    <button type="button" className="pm-control" disabled={state === "copying" || !text.trim()} onClick={() => void copy()} aria-label={state === "failed" ? `Try again: ${label}` : label}>
      {state === "copied" ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      {state === "copying" ? "Copying…" : state === "copied" ? "Copied" : state === "failed" ? "Try again" : label}
    </button>
    <span role="status" className={state === "failed" ? "text-[12px] text-danger" : "sr-only"}>{state === "failed" ? "Couldn’t copy. Try again, or select the text to copy it." : state === "copied" ? "Copied to clipboard" : ""}</span>
  </span>;
}

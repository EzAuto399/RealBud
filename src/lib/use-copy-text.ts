import { useEffect, useRef, useState } from "react";

export function useCopyText(text: string) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const generation = useRef(0);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    generation.current++;
    setState("idle");
    return () => { generation.current++; if (timer.current) clearTimeout(timer.current); };
  }, [text]);
  const copy = async () => {
    if (inFlight.current || !text.trim()) return;
    const current = generation.current;
    inFlight.current = true;
    if (timer.current) clearTimeout(timer.current);
    setState("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (current !== generation.current) return;
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      if (current === generation.current) setState("failed");
    } finally { inFlight.current = false; }
  };
  return { state, copy };
}

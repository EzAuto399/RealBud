import { useEffect, useRef, useState } from "react";

/** Keep expensive live Markdown parsing below the token transport cadence.
 * The settled message always replaces this preview with the complete text. */
export function useStreamPreview(value: string, intervalMs = 80): string {
  const [preview, setPreview] = useState(value);
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latest.current = value;
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setPreview(latest.current);
    }, intervalMs);
  }, [intervalMs, value]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return preview;
}

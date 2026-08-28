import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { api } from "@/state/store";

const RECOVERY_KEY_PATTERN = /^[0-9a-f]{64}$/i;

export function RecoveryUnlockPanel({ compact = false }: { compact?: boolean }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const cleanKey = key.trim();
  const keyValid = RECOVERY_KEY_PATTERN.test(cleanKey);

  const unlock = async () => {
    if (busy || !keyValid) return;
    setBusy(true);
    setAttempted(true);
    setResult(null);
    try {
      const response = await api("/api/desk/recovery/unlock", {
        method: "POST",
        body: JSON.stringify({ key: cleanKey }),
      });
      setKey("");
      setResult({
        ok: true,
        text: response.message ?? "Book restored. Quit and reopen RealBud to continue setup.",
      });
    } catch (cause) {
      setResult({
        ok: false,
        text: cause instanceof Error ? cause.message : "RealBud could not restore this book.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="recovery-unlock-title"
      className={cn(
        "border border-hold/30 bg-hold/5",
        compact ? "p-3" : "mx-auto w-full max-w-[31rem] p-4",
      )}
    >
      <h3 id="recovery-unlock-title" className="text-[13.5px] font-semibold text-ink">
        Restore the protected book
      </h3>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
        Paste the recovery key saved when this book was created. It stays on this device.
      </p>
      <label htmlFor="recovery-unlock-key" className="sr-only">64-character recovery key</label>
      <input
        id="recovery-unlock-key"
        type="password"
        value={key}
        onChange={(event) => {
          setKey(event.target.value);
          setAttempted(false);
          setResult(null);
        }}
        onBlur={() => setAttempted(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void unlock();
        }}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="64-character recovery key"
        aria-invalid={attempted && cleanKey.length > 0 && !keyValid}
        aria-describedby="recovery-unlock-help"
        className="pm-control mt-3 w-full rounded border border-line bg-sheet px-3 font-mono text-[13px] text-ink placeholder:font-sans placeholder:text-ink-muted focus:border-agency"
      />
      <div id="recovery-unlock-help" className="mt-1.5 min-h-4 text-[11.5px] text-ink-muted">
        {attempted && cleanKey.length > 0 && !keyValid ? "The key must contain exactly 64 letters or numbers from 0–9 and A–F." : "RealBud verifies the key before changing the protected files."}
      </div>
      <button
        type="button"
        onClick={() => void unlock()}
        disabled={busy || !keyValid || result?.ok === true}
        className="pm-control pm-tactile mt-3 inline-flex w-full items-center justify-center gap-2 rounded bg-agency px-4 text-[13px] font-semibold text-white hover:bg-agency-hover disabled:opacity-40"
      >
        {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : result?.ok ? <CheckCircle2 size={14} aria-hidden="true" /> : null}
        {busy ? "Restoring…" : result?.ok ? "Book restored" : "Restore book"}
      </button>
      {result ? (
        <p className={cn("mt-3 text-[12.5px] leading-relaxed", result.ok ? "text-success" : "text-danger")} role={result.ok ? "status" : "alert"}>
          {result.text}
        </p>
      ) : null}
    </section>
  );
}

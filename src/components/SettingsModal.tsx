// App settings keep the ordinary office-facing choices small. Bud's engine,
// pin, and property pack stay behind the guided connection experience.
import { useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { api, useStore } from "@/state/store";

type ProfileSaveState = "idle" | "saving" | "saved" | "invalid" | "error";

/** Name and email are persisted in order so quick consecutive blurs cannot
 * leave an older profile write as the final value. */
export function ProfileFields() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  const [saveState, setSaveState] = useState<ProfileSaveState>("idle");
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latestSave = useRef(0);
  const inputId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    if (document.activeElement !== nameRef.current) setName(state.config?.profile?.name ?? "");
    if (document.activeElement !== emailRef.current) setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = () => {
    const normalizedName = name.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
      setSaveState("invalid");
      return;
    }

    const saveId = ++latestSave.current;
    setSaveState("saving");
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const config = await api(
            "/api/config",
            { method: "PUT", body: JSON.stringify({ profile: { name: normalizedName, email: normalizedEmail } }) },
            { timeoutMs: 15_000 },
          );
          dispatch({ type: "configStatus", config });
          if (mounted.current && saveId === latestSave.current) setSaveState("saved");
        } catch {
          if (mounted.current && saveId === latestSave.current) setSaveState("error");
        }
      });
  };

  const fieldClass =
    "pm-control mt-1.5 w-full rounded border border-line bg-inset px-3 text-[14px] text-ink placeholder:text-ink-muted focus:border-agency";

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={`${inputId}-name`} className="text-[12.5px] font-medium text-ink-secondary">
        Name
        <input
          ref={nameRef}
          id={`${inputId}-name`}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaveState("idle");
          }}
          onBlur={save}
          autoComplete="name"
          placeholder="How the office knows you"
          className={fieldClass}
        />
      </label>
      <label htmlFor={`${inputId}-email`} className="text-[12.5px] font-medium text-ink-secondary">
        Office email
        <input
          ref={emailRef}
          id={`${inputId}-email`}
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setSaveState("idle");
          }}
          onBlur={save}
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={saveState === "invalid" ? true : undefined}
          className={fieldClass}
        />
      </label>
      <div
        aria-live="polite"
        className={cn(
          "min-h-4 text-[11.5px]",
          saveState === "error" || saveState === "invalid" ? "text-danger" : "text-ink-muted",
        )}
      >
        {saveState === "saving"
          ? "Saving…"
          : saveState === "saved"
            ? "Saved"
            : saveState === "invalid"
              ? "Enter a complete email address, or leave it blank."
              : saveState === "error"
                ? "Could not save. Your changes are still here; leave the field to try again."
                : "Saved in your RealBud settings as you go."}
      </div>
    </div>
  );
}

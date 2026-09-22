import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "../SettingsPrimitives";

export const SUPPORT_CONTENTS =
  "The support file contains RealBud’s version, this computer’s system type, how long the office service has run and its recent logs with keys and passwords masked; it never contains your documents, mail or saved credentials.";
export const SUPPORT_SAVED = "Saved. Attach it to your message to RealBud support.";
export const SUPPORT_DESKTOP_ONLY = "The office service did not answer, so the file has only the desktop app’s own log.";
export const SUPPORT_FAILED = "The support file could not be saved. Try again, or choose another folder.";

export type SupportSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; officeReport: boolean }
  | { kind: "failed"; message: string };

/** The desktop app answers with an outcome only, never a path. Anything else
 * is treated as a failure rather than guessed at. */
export function supportSaveOutcome(value: unknown): SupportSaveState {
  if (value && typeof value === "object") {
    const result = value as { ok?: unknown; canceled?: unknown; officeReport?: unknown; error?: unknown };
    if (result.ok === true && typeof result.officeReport === "boolean") return { kind: "saved", officeReport: result.officeReport };
    if (result.ok === false && result.canceled === true) return { kind: "idle" };
    if (result.ok === false && typeof result.error === "string" && result.error.trim() && result.error.length <= 300) {
      return { kind: "failed", message: result.error.trim() };
    }
  }
  return { kind: "failed", message: SUPPORT_FAILED };
}

function supportBridge(): (() => Promise<unknown>) | null {
  if (typeof window === "undefined") return null;
  const save = window.ogb?.saveSupportFile;
  return typeof save === "function" ? () => save() : null;
}

export function SupportCardView({ available, state, onSave }: { available: boolean; state: SupportSaveState; onSave: () => void }) {
  const saving = state.kind === "saving";
  return <Card title="Help and support" subtitle={SUPPORT_CONTENTS}>
    {available ? (
      <button type="button" disabled={saving} aria-busy={saving} onClick={onSave}
        className="pm-control rounded border border-line px-3 text-[13px] text-ink hover:bg-raised disabled:opacity-50">
        {saving ? "Saving…" : "Save support file"}
      </button>
    ) : (
      <p className="text-[13px] text-ink-secondary">Open the RealBud desktop app to save a support file.</p>
    )}
    <div role="status" aria-live="polite" className="text-[13px] leading-relaxed">
      {state.kind === "saved" ? <>
        <p className="mt-3 font-medium text-ink">{SUPPORT_SAVED}</p>
        {state.officeReport ? null : <p className="mt-1 text-ink-secondary">{SUPPORT_DESKTOP_ONLY}</p>}
      </> : null}
    </div>
    {state.kind === "failed" ? <p role="alert" className="mt-3 text-[13px] text-danger">{state.message}</p> : null}
  </Card>;
}

export function SupportCard() {
  const [save] = useState(supportBridge);
  const [state, setState] = useState<SupportSaveState>({ kind: "idle" });
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const onSave = useCallback(async () => {
    if (!save || pending.current) return;
    pending.current = true;
    setState({ kind: "saving" });
    let next: SupportSaveState;
    try { next = supportSaveOutcome(await save()); }
    catch { next = { kind: "failed", message: SUPPORT_FAILED }; }
    finally { pending.current = false; }
    if (mounted.current) setState(next);
  }, [save]);
  return <SupportCardView available={save !== null} state={state} onSave={() => { void onSave(); }} />;
}

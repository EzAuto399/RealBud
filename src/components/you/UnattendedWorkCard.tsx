import { useCallback, useEffect, useRef, useState } from "react";

import { useStore } from "@/state/store";
import { Card } from "../SettingsPrimitives";

/**
 * Whether the office has anything scheduled at all.
 *
 * An empty list is "not loaded yet", not "nothing scheduled": the office always
 * carries its built-in jobs, so reporting false from an unhydrated screen would
 * quietly release a keep-awake hold that should stand.
 */
export function scheduleIsEnabled(loops: Array<{ enabled?: boolean; available?: boolean }>): boolean | null {
  if (!Array.isArray(loops) || loops.length === 0) return null;
  return loops.some((loop) => loop?.enabled === true && loop?.available !== false);
}

type PersistencePatch = { startOfficeServiceAtLogin?: boolean; keepAwakeForSchedules?: boolean };

const START_AT_LOGIN = "Start the office service when I sign in";
const KEEP_AWAKE = "Keep this computer awake for scheduled work";

/** Rendered from what the main process reports, so a setting that could not be
 * applied or saved is never drawn as if it were on. */
export function UnattendedWorkCardView({
  state,
  busy,
  error,
  onChange,
}: {
  state: ServicePersistenceState | null;
  busy: boolean;
  error: string;
  onChange: (patch: PersistencePatch) => void;
}) {
  const settings = state?.settings ?? { startOfficeServiceAtLogin: false, keepAwakeForSchedules: false };
  const startupSupported = state ? state.startup.supported : false;
  return (
    <Card title="Scheduled work on this computer" subtitle="What happens when nobody is at this computer.">
      <label className="flex min-h-11 items-start gap-2 py-1 text-[13px] text-ink">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0"
          aria-label={START_AT_LOGIN}
          checked={settings.startOfficeServiceAtLogin}
          disabled={busy || !state || !startupSupported}
          onChange={(event) => onChange({ startOfficeServiceAtLogin: event.target.checked })}
        />
        <span>
          <span className="font-medium">{START_AT_LOGIN}</span>
          <span className="mt-1 block text-ink-secondary">
            The office service starts on its own after you sign in to this computer, so scheduled work can run without anyone
            remembering to open RealBud.
          </span>
          {/* What that looks like differs by computer, and the main process is
              the only thing that knows which one this is. */}
          {state ? <span className="mt-1 block text-ink-muted">{state.startup.explanation}</span> : null}
        </span>
      </label>

      <label className="flex min-h-11 items-start gap-2 py-1 text-[13px] text-ink">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0"
          aria-label={KEEP_AWAKE}
          checked={settings.keepAwakeForSchedules}
          disabled={busy || !state}
          onChange={(event) => onChange({ keepAwakeForSchedules: event.target.checked })}
        />
        <span>
          <span className="font-medium">{KEEP_AWAKE}</span>
          <span className="mt-1 block text-ink-secondary">
            While this computer is plugged in and something is scheduled, RealBud stops it going to sleep; the screen still
            turns off as usual.
          </span>
          {state ? <span className="mt-1 block text-ink-muted">{state.keepAwake.explanation}</span> : null}
        </span>
      </label>

      <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary">
        A closed lid, a computer that is switched off, and one waiting at its sign-in screen all still mean scheduled work does
        not run. A scan that did not happen is shown as missed or late, never as done, and every scheduled job shows when it was
        last checked.
      </p>

      {state?.saved === false ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          This choice could not be saved on this computer, so it will not survive a restart.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {!state && !error ? (
        <p role="status" className="mt-2 text-[13px] text-ink-muted">
          Checking what this computer is set to do…
        </p>
      ) : null}
    </Card>
  );
}

export function UnattendedWorkCard() {
  const { state: store } = useStore();
  const [state, setState] = useState<ServicePersistenceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.servicePersistence;
  // The office owns its schedule; this screen reports what it already knows
  // rather than opening a second reader of the same fact. `null` means the
  // window cannot currently tell, and reports nothing.
  const scheduleEnabled = scheduleIsEnabled(store?.loops ?? []);

  const load = useCallback(async () => {
    if (!bridge) return;
    try {
      const next = await bridge.get();
      if (mounted.current) { setState(next); setError(""); }
    } catch {
      if (mounted.current) setError("This computer's settings for scheduled work could not be read.");
    }
  }, [bridge]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  // Pass the schedule fact on whenever it changes, so a later sign-in launch
  // with no window open acts on the office's own answer.
  useEffect(() => {
    if (!bridge || scheduleEnabled === null) return;
    let live = true;
    void bridge
      .set({ scheduleEnabled })
      .then((next) => { if (live && mounted.current) setState(next); })
      .catch(() => { /* a report that did not land changes no setting */ });
    return () => { live = false; };
  }, [bridge, scheduleEnabled]);

  const change = useCallback(
    (patch: PersistencePatch) => {
      if (!bridge) return;
      setBusy(true);
      setError("");
      void bridge
        .set(scheduleEnabled === null ? patch : { ...patch, scheduleEnabled })
        .then((next) => { if (mounted.current) setState(next); })
        .catch(() => { if (mounted.current) setError("This computer did not accept the change. Try again."); })
        .finally(() => { if (mounted.current) setBusy(false); });
    },
    [bridge, scheduleEnabled],
  );

  // Desktop-only: in a browser there is no computer of ours to keep awake.
  if (!bridge) return null;
  return <UnattendedWorkCardView state={state} busy={busy} error={error} onChange={change} />;
}

import { useEffect, useMemo, useRef } from "react";

import { deriveRoutineReminders } from "@/lib/ask-presentation";
import { api, useStore } from "@/state/store";

const RECEIPT_DELAYS_MS = [0, 250, 750] as const;

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function ProactiveReminderBridge({ botId }: { botId: string }) {
  const { state, dispatch } = useStore();
  const inFlight = useRef(new Set<string>());
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const reminders = useMemo(
    () => deriveRoutineReminders(state.loopRuns, state.desk),
    [state.loopRuns, state.desk],
  );

  useEffect(() => {
    const notify = window.ogb?.notifyRoutine;
    if (!notify || !bot?.notifications) return;

    for (const reminder of reminders) {
      if (inFlight.current.has(reminder.runId)) continue;
      inFlight.current.add(reminder.runId);
      void (async () => {
        try {
          const result = await notify(reminder);
          if (!result.shown) return;
          for (const delay of RECEIPT_DELAYS_MS) {
            await wait(delay);
            try {
              const response = await api(`/api/loop-runs/${reminder.runId}/notified`, { method: "POST" });
              if (response.run) dispatch({ type: "loopRunPatched", run: response.run });
              return;
            } catch {
              // The local server may be reconnecting. Retry twice, bounded.
            }
          }
          console.warn("[routine reminder] notification receipt could not be saved");
        } finally {
          inFlight.current.delete(reminder.runId);
        }
      })();
    }
  }, [bot?.notifications, dispatch, reminders]);

  useEffect(() => {
    const subscribe = window.ogb?.onRoutineReminderOpened;
    if (!subscribe) return;
    return subscribe((reminder) => {
      dispatch({ type: reminder.kind === "held" ? "showDesk" : "showRoutines" });
    });
  }, [dispatch]);

  return null;
}

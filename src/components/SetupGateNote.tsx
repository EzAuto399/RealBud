// A closed setup gate, in place: the real reason, and the fix right there
// (a button to the step, or "Copy request for your owner"). Gates are
// presentation only; the server stays the authority on every action.
import { useState } from "react";
import { cn } from "@/lib/cn";
import { startReiSignIn } from "@/lib/rei-sign-in";
import type { SetupGate, SetupJumpTarget } from "@/lib/setup-sequence";
import { openWorkspaceSetup } from "@/lib/workspace-setup";
import { api, useStore } from "@/state/store";
import { OwnerRequestButton } from "./OwnerRequestButton";

type Go = (action: { type: "showYou" } | { type: "showRoutines" }) => void;

/** Open a setup step's fix, the same places Desk's Get started opens. `bud-retry` resolves false when the retry was not confirmed. */
export async function openSetupTarget(target: SetupJumpTarget, dispatch: Go, refreshHermes?: () => Promise<void>): Promise<boolean> {
  if (target === "bud-setup") { openWorkspaceSetup("bud"); return true; }
  if (target === "rei-sign-in") { await startReiSignIn(); return true; }
  if (target === "bud-retry") {
    // A lost answer may hide a started retry, so the status read settles it.
    const sent = await api("/api/hermes/auto-setup/retry", { method: "POST", body: "{}" }).then(() => true, () => false);
    await refreshHermes?.().catch(() => {});
    return sent;
  }
  location.hash = target;
  if (target.startsWith("you-")) { dispatch({ type: "showYou" }); return true; }
  // Schedule opens `job-…` and `schedule-…` off the hash once it is on screen.
  dispatch({ type: "showRoutines" });
  return true;
}

export function SetupGateNote({ gate, id, className, suffix = "" }: { gate: SetupGate; id?: string; className?: string; suffix?: string }) {
  const { dispatch, refreshHermes } = useStore();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (gate.on) return null;
  const fix = gate.actionLabel && gate.target ? gate.target : null;
  const open = async () => {
    if (!fix || busy) return;
    setBusy(true);
    setNote("");
    const ok = await openSetupTarget(fix, dispatch, refreshHermes);
    if (!ok) setNote("The setup request could not be confirmed. Checking its current status; your work is kept.");
    setBusy(false);
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <p id={id} className="text-[13px] text-hold">{gate.reason}{suffix}</p>
      {gate.ownerRequest ? <OwnerRequestButton request={gate.ownerRequest} /> : null}
      {fix ? (
        <button type="button" disabled={busy} onClick={() => void open()} className="pm-control rounded border border-line bg-sheet px-3 text-[13px] text-ink hover:bg-selected disabled:opacity-40">
          {gate.actionLabel}
        </button>
      ) : null}
      {note ? <p role="status" className="basis-full text-[13px] text-hold">{note}</p> : null}
    </div>
  );
}

// Shown where Bud's worker is missing or not signed in: the chat error row and
// the model badge. RealBud installs, repairs and connects Bud itself, so this
// only opens Bud's own setup card (BudSetupCard in Workspace setup). It never
// shows terminal commands, upstream engine names or their docs.
import { Wrench } from "lucide-react";
import type { InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";
import { openWorkspaceSetup } from "@/lib/workspace-setup";

/** True when the engine is installed but not yet signed in — the state that
 * looks ready in the picker but still can't answer a message. */
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

export function EngineSetup({ className }: { instance: InstanceInfo; className?: string }) {
  return (
    <div className={cn("text-[12.5px] leading-relaxed text-ink-secondary", className)}>
      <p>Bud is not ready on this computer. Set up Bud repairs it; this task is kept.</p>
      <button
        type="button"
        onClick={() => openWorkspaceSetup("bud")}
        className="pm-control mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-white hover:brightness-110"
      >
        <Wrench size={13} aria-hidden="true" />
        Set up Bud
      </button>
    </div>
  );
}

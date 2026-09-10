// Hands badge. Models attach on the Hermes `property` profile
// (`hermes -p property model`), not as extra RealBud agents.
import { EngineSetup, needsSignIn } from "./EngineSetup";
import { cn } from "@/lib/cn";
import { useStore, type Bot } from "@/state/store";

export function ModelPicker({ className }: { bot: Bot; className?: string }) {
  const { state } = useStore();
  const hermes = state.instances.find((i) => i.driverKind === "hermesAgent") ?? state.instances[0];
  const needsSetup = hermes && (hermes.snapshot.state !== "available" || needsSignIn(hermes));

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        className="rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink"
        title="Manage Bud's connection under You"
      >
        Bud
      </span>
      {needsSetup && hermes ? <EngineSetup instance={hermes} /> : null}
    </div>
  );
}

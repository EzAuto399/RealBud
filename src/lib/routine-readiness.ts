import type { DeskSnapshot, Loop, LoopRequirement } from "@shared/contracts";

export type RoutineDependencyState = "ready" | "practice" | "attention" | "blocked" | "checking" | "pilot-gated" | "not-required";

export interface RoutineDependencyView extends LoopRequirement {
  state: RoutineDependencyState;
  status: string;
  detail: string;
}

type ReadinessDesk = Pick<DeskSnapshot, "mode" | "recovery" | "hands" | "handsDetail" | "properties" | "results">;

export function resolveRoutineDependencies(
  loop: Loop,
  input: { desk: ReadinessDesk | null },
): RoutineDependencyView[] {
  return (loop.requirements ?? []).map((requirement): RoutineDependencyView => {
    const desk = input.desk;
    switch (requirement.id) {
      case "desk-book":
        if (!desk) return { ...requirement, state: "checking", status: "Checking", detail: "Loading the authoritative Desk book." };
        if (desk.recovery.active) {
          return { ...requirement, state: "blocked", status: "Recovery paused", detail: "Restore the protected book before this routine can write Desk work." };
        }
        return {
          ...requirement,
          state: "ready",
          status: "Ready",
          detail: `${desk.properties.length} active propert${desk.properties.length === 1 ? "y" : "ies"} in the current book.`,
        };
      case "current-money-source":
        if (!desk) return { ...requirement, state: "checking", status: "Checking", detail: "Loading current source state." };
        if (desk.recovery.active) {
          return { ...requirement, state: "blocked", status: "Recovery paused", detail: "Source changes are paused while Desk protects the current book." };
        }
        if (desk.mode === "demo") {
          return { ...requirement, state: "practice", status: "Practice only", detail: "Demo facts can exercise the routine but cannot verify live balances." };
        }
        if (desk.hands === "csv") {
          const held = desk.results.filter((result) => result.outcome === "hold").length;
          if (held > 0) {
            return {
              ...requirement,
              state: "attention",
              status: "Held source work",
              detail: `${held} propert${held === 1 ? "y needs" : "ies need"} source review on Desk before new wording is trusted.`,
            };
          }
          return { ...requirement, state: "ready", status: "Live export", detail: desk.handsDetail ?? "A structured PMS export is the current money authority." };
        }
        if (desk.hands === "held") {
          return { ...requirement, state: "attention", status: "Needs recheck", detail: desk.handsDetail ?? "The current source is held for review." };
        }
        if (desk.hands === "hermes") {
          return { ...requirement, state: "attention", status: "Unverified", detail: "Worker-read balances stay unverified until matched to a current PMS export." };
        }
        return { ...requirement, state: "attention", status: "Needs recheck", detail: desk.handsDetail ?? "Import or recheck the current PMS source." };
      case "read-only-mail":
        return {
          ...requirement,
          state: "pilot-gated",
          status: "Pilot-gated",
          detail: "No inbox is connected in this build. The named pilot must approve one exact read-only source first.",
        };
    }
  });
}

/** Live remaining Desk cards from a completed run. The stored run detail is
 * a snapshot and must not keep quoting a stale "N on Desk" after Allow. */
export function liveRoutineOutcome(produced: number): string {
  if (produced <= 0) return "Nothing from that run is still waiting on Desk.";
  return `${produced} still on Desk for Allow.`;
}

export function routineNeedsAttention(dependencies: RoutineDependencyView[]): RoutineDependencyView | null {
  return dependencies.find((dependency) => dependency.state === "blocked" || dependency.state === "attention" || dependency.state === "pilot-gated") ?? null;
}

export function routineMutationsLocked(input: {
  deskRecovery: boolean;
  localIssues?: ReadonlyArray<{ area: string; action: string }>;
}): boolean {
  return input.deskRecovery || Boolean(
    input.localIssues?.some((issue) => issue.area === "routine clock" && issue.action === "attention"),
  );
}

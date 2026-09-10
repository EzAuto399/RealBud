import { parseAskControlIntent } from "../shared/ask-controls.ts";
export { parseAskControlIntent } from "../shared/ask-controls.ts";

export function askControlReply(intent: NonNullable<ReturnType<typeof parseAskControlIntent>>, loops: Array<{ name: string; enabled: boolean; schedule: { time: string; weekdays: number[] } }> = []): string {
  if (intent === "connections") return "Open **Add** here to connect an office app. Sign-in and access checks happen there; your draft stays saved.";
  if (intent === "setup") return "Open **Set up Bud** here to finish the connection. Your draft stays saved.";
  if (intent === "schedule-edit") return "Open **Schedule work** here to review the job and timing before saving. Nothing has changed yet.";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const active = loops.filter(loop => loop.enabled);
  return `${active.length ? active.map(loop => `- **${loop.name}** — ${loop.schedule.weekdays.map(day => days[day]).join(", ")} at ${loop.schedule.time}`).join("\n") : "No recurring jobs are switched on."}\nOpen **Schedule work** here to review jobs and their latest results.`;
}

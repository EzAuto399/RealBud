/** PM-language labels for Bud's recent computer activity. Client-only. */

export type ActivityKind = "tool" | "turn";

export type ActivityEntry = {
  id: string;
  at: number;
  kind: ActivityKind;
  name: string;
  ok: boolean;
};

const TOOL_LABELS: Array<[RegExp, string]> = [
  [/^(bash|shell|terminal|run_command|execute|computer_exec)$/, "ran a command"],
  [/^(read|read_file|view)$/, "read a file"],
  [/^(write|create_file)$/, "wrote a file"],
  [/^(edit|apply_patch|str_replace|multiedit)$/, "edited a file"],
  [/^(grep|search|glob|find)$/, "searched"],
  [/^(web_?search|websearch)$/, "searched the web"],
  [/^(web_?fetch|fetch)$/, "read a page"],
  [/^screenshot$/, "looked at the screen"],
  [/^(click|type_text|press_key|scroll|computer_batch)$/, "used the computer"],
  [/^open_url$/, "opened a page"],
];

export function activityLabel(kind: ActivityKind, name: string): string {
  if (kind === "turn") return "finished a turn";
  const bare = name.replace(/^mcp__[^_]+__/, "").trim().toLowerCase();
  if (!bare) return "used a tool";
  for (const [pattern, phrase] of TOOL_LABELS) {
    if (pattern.test(bare)) return phrase;
  }
  return "used a tool";
}

export function activityResult(ok: boolean): "ok" | "denied" {
  return ok ? "ok" : "denied";
}

export function activityLine(entry: Pick<ActivityEntry, "kind" | "name" | "ok">): string {
  return `${activityLabel(entry.kind, entry.name)} · ${activityResult(entry.ok)}`;
}

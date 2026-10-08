import type { Bot, Group, GroupDefaultResponder } from "@/state/store";

/** Be defensive around rooms loaded while an older server is still running,
 * and around a lead removed by another client before the group patch arrives. */
export function effectiveDefaultResponder(group: Group, members: Bot[]): GroupDefaultResponder {
  const value = group.defaultResponder;
  if (value?.kind === "everyone" || value?.kind === "mentions") return value;
  if (value?.kind === "member" && members.some((member) => member.id === value.botId)) return value;
  return members[0] ? { kind: "member", botId: members[0].id } : { kind: "mentions" };
}

export function defaultResponderName(group: Group, members: Bot[]): string | null {
  const value = effectiveDefaultResponder(group, members);
  if (value.kind !== "member") return null;
  return members.find((member) => member.id === value.botId)?.name ?? null;
}

export function groupComposerHint(group: Group, members: Bot[]): string {
  if (group.dm) return "continue the conversation";
  const value = effectiveDefaultResponder(group, members);
  if (value.kind === "everyone") return "everyone responds";
  if (value.kind === "mentions") return "@ to bring a bot in";
  return `${defaultResponderName(group, members) ?? "Lead"} responds`;
}

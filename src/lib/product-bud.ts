import type { Bot } from "@/state/store";

/** Prefer the product Bud thread. Older desks keep a UUID id with name "Bud". */
export function resolveProductBud(bots: Bot[]): Bot | undefined {
  return bots.find((bot) => bot.id === "bud") ?? bots.find((bot) => bot.name === "Bud") ?? bots[0];
}

export function resolveProductBudId(bots: Bot[]): string | null {
  return resolveProductBud(bots)?.id ?? null;
}

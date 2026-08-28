import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { redactSecretsInText } from "./redact.ts";

const FILE = "connection-aliases.json";
const SOURCE_IDS = new Set(["property-book", "inbound-mail-calendar"]);

export type ConnectionAliasId = "property-book" | "inbound-mail-calendar";
export type ConnectionAliases = Partial<Record<ConnectionAliasId, string>>;

function cleanAlias(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length > 40 || /:\/\//.test(clean) || redactSecretsInText(clean) !== clean) return null;
  return clean;
}

export function loadConnectionAliases(dir: string): ConnectionAliases {
  const path = join(dir, FILE);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const aliases: ConnectionAliases = {};
    for (const id of SOURCE_IDS) {
      const alias = cleanAlias(raw[id]);
      if (alias) aliases[id as ConnectionAliasId] = alias;
    }
    return aliases;
  } catch {
    return {};
  }
}

export function setConnectionAlias(dir: string, id: string, alias: string): ConnectionAliases {
  if (!SOURCE_IDS.has(id)) {
    throw Object.assign(new Error("That connection cannot be renamed."), { status: 400, code: "UNKNOWN_CONNECTION" });
  }
  const next = cleanAlias(alias);
  if (next == null) {
    throw Object.assign(new Error("Use a short local name. No URLs or secrets."), { status: 400, code: "INVALID_ALIAS" });
  }
  const aliases = loadConnectionAliases(dir);
  if (next) aliases[id as ConnectionAliasId] = next;
  else delete aliases[id as ConnectionAliasId];
  writeFileAtomic(join(dir, FILE), `${JSON.stringify(aliases, null, 2)}\n`);
  return aliases;
}

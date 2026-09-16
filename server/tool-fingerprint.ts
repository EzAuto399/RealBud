import { createHash } from "node:crypto";

// A display title may omit arguments or truncate the distinguishing suffix.
// Keep only a digest in runtime events, never another copy of tool payloads.
export function toolFingerprint(title: string, input?: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify([title, canonical(input)])).digest("hex");
}

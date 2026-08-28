import { INTAKE_FIELD_LIMITS, intakeItemError, type IntakeItem } from "./intake.ts";

export const WORKER_INTAKE_ACTION = "realbud.stage-properties.v1";
const MAX_PROPERTIES = 200;
const MAX_UNPARSED = 200;

export interface WorkerIntakeAction {
  action: typeof WORKER_INTAKE_ACTION;
  properties: IntakeItem[];
  unparsed: string[];
}

function jsonBody(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fence?.[1]?.trim() ?? trimmed;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

/** Fail closed: ordinary JSON in a chat reply is never treated as a Desk
 * command. The versioned action marker and every field must validate. */
export function parseWorkerIntakeAction(text: string): WorkerIntakeAction | null {
  let value: unknown;
  try {
    value = JSON.parse(jsonBody(text));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["action", "properties", "unparsed"])) return null;
  if (record.action !== WORKER_INTAKE_ACTION) return null;
  if (!Array.isArray(record.properties) || !Array.isArray(record.unparsed)) return null;
  if (record.properties.length > MAX_PROPERTIES || record.unparsed.length > MAX_UNPARSED) return null;

  const properties: IntakeItem[] = [];
  for (const item of record.properties) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const fields = item as Record<string, unknown>;
    if (!hasOnlyKeys(fields, ["address", "tenantName", "tenantPhone", "weeklyRentCents"])) return null;
    const address = boundedString(fields.address, INTAKE_FIELD_LIMITS.address);
    const tenantName = boundedString(fields.tenantName, INTAKE_FIELD_LIMITS.tenantName);
    const tenantPhone = boundedString(fields.tenantPhone, INTAKE_FIELD_LIMITS.tenantPhone);
    const weeklyRentCents = fields.weeklyRentCents;
    if (
      !address ||
      !tenantName ||
      !tenantPhone ||
      typeof weeklyRentCents !== "number" ||
      !Number.isInteger(weeklyRentCents) ||
      weeklyRentCents <= 0 ||
      weeklyRentCents > INTAKE_FIELD_LIMITS.weeklyRentCents
    ) {
      return null;
    }
    const property = { address, tenantName, tenantPhone, weeklyRentCents };
    if (intakeItemError(property)) return null;
    properties.push(property);
  }

  const unparsed: string[] = [];
  for (const item of record.unparsed) {
    const line = boundedString(item, 240);
    if (!line) return null;
    unparsed.push(line);
  }
  return { action: WORKER_INTAKE_ACTION, properties, unparsed };
}

export function workerIntakeSummary(result: {
  created: number;
  skipped: number;
  unparsed: string[];
}): string {
  const staged = `${result.created} ${result.created === 1 ? "property" : "properties"}`;
  const parts = [`I reviewed the attachment and staged ${staged} on Desk. Nothing was added to the book.`];
  if (result.skipped) parts.push(`${result.skipped} duplicate or incomplete ${result.skipped === 1 ? "record was" : "records were"} skipped.`);
  if (result.unparsed.length) parts.push(`${result.unparsed.length} ${result.unparsed.length === 1 ? "item needs" : "items need"} your review.`);
  parts.push("Check the cards, then Allow only the ones you want to add.");
  return parts.join(" ");
}

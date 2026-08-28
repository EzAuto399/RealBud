// Deterministic property-intake parser. Turns pasted plain text — one
// property per line — into structured add-property items WITHOUT needing a
// model. Bud's intake skill uses the same output shape when a model is
// attached, so the pipeline is identical either way.
//
// Accepted per line (tolerant):
//   12 Oak St, Dickson ACT | Jordan Blake | 0400 555 666 | 580
//   12 Oak St, Dickson ACT, Jordan Blake, 0400 555 666, 580
//   12 Oak St	Dickson	0400 555 666	580
// Rent is dollars per week (whole dollars or decimals). Phone is any token
// with 8+ digits. Anything left in the middle is the tenant name.

export interface IntakeItem {
  address: string;
  tenantName: string;
  tenantPhone: string;
  weeklyRentCents: number;
}

export interface IntakeResult {
  items: IntakeItem[];
  unparsed: string[];
}

export const INTAKE_FIELD_LIMITS = {
  address: 160,
  tenantName: 120,
  tenantPhone: 40,
  weeklyRentCents: 10_000_000,
} as const;

const PHONE_DIGITS = (raw: string) => (raw.match(/\d/g) ?? []).length;
const UNSAFE_FIELD_TEXT = /[\u0000-\u001f\u007f]|\\[rnt]/i;

/** One shared validation contract for quick paste, worker output and the
 * authoritative Desk mutation. This prevents a tolerant parser or future
 * adapter from persisting control text or an unbounded person field. */
export function intakeItemError(item: IntakeItem): string | null {
  if (!item.address) return "address required";
  if (item.address.length > INTAKE_FIELD_LIMITS.address) return "address is too long";
  if (UNSAFE_FIELD_TEXT.test(item.address)) return "address contains invalid characters";
  if (!item.tenantName) return "tenant name required";
  if (item.tenantName.length > INTAKE_FIELD_LIMITS.tenantName) return "tenant name is too long";
  if (UNSAFE_FIELD_TEXT.test(item.tenantName)) return "tenant name contains invalid characters";
  if (!item.tenantPhone) return "tenant phone required";
  if (item.tenantPhone.length > INTAKE_FIELD_LIMITS.tenantPhone) return "tenant phone is too long";
  if (UNSAFE_FIELD_TEXT.test(item.tenantPhone) || PHONE_DIGITS(item.tenantPhone) < 8) {
    return "tenant phone is invalid";
  }
  if (!Number.isInteger(item.weeklyRentCents) || item.weeklyRentCents <= 0) return "weekly rent required";
  if (item.weeklyRentCents > INTAKE_FIELD_LIMITS.weeklyRentCents) return "weekly rent is too large";
  return null;
}

function parseLine(line: string): IntakeItem | null {
  const clean = line.trim().replace(/^[-*•]\s*/, "");
  if (!clean) return null;

  let tokens: string[];
  if (/\t/.test(clean)) tokens = clean.split("\t");
  else if (/\|/.test(clean)) tokens = clean.split("|");
  else tokens = clean.split(",");

  tokens = tokens.map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 2) return null;

  // AU addresses commonly carry a suburb+state tail ("12 Oak St, Dickson ACT").
  // Fold a leading state-ending token into the address so the name field
  // stays a name.
  if (tokens.length >= 3 && /\b(ACT|NSW|VIC|QLD|SA|WA|TAS|NT)$/i.test(tokens[1]!)) {
    tokens = [`${tokens[0]}, ${tokens[1]}`, ...tokens.slice(2)];
  }

  // rent: last token that is a plain number (dollars, decimals ok)
  let rentCents = 0;
  let rentIdx = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (/^\$?\d{1,5}(\.\d{2})?$/.test(tokens[i]!.replace(/,$/, ""))) {
      rentCents = Math.round(parseFloat(tokens[i]!.replace(/[$]/g, "")) * 100);
      rentIdx = i;
      break;
    }
  }
  if (rentIdx < 0) return null;

  // phone: last remaining token with 8+ digits
  let phone = "";
  let phoneIdx = -1;
  for (let i = rentIdx - 1; i >= 0; i--) {
    if (PHONE_DIGITS(tokens[i]!) >= 8) {
      phone = tokens[i]!;
      phoneIdx = i;
      break;
    }
  }

  const address = tokens[0]!;
  const middle = tokens.slice(1, phoneIdx >= 0 ? phoneIdx : rentIdx);
  const tenantName = middle.join(", ").trim();

  const item = { address, tenantName, tenantPhone: phone, weeklyRentCents: rentCents };
  return intakeItemError(item) ? null : item;
}

export function parseIntakeText(text: string): IntakeResult {
  const items: IntakeItem[] = [];
  const unparsed: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = parseLine(line);
    if (item) items.push(item);
    else unparsed.push(line.trim().slice(0, 120));
  }
  return { items, unparsed };
}

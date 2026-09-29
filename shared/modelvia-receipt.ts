/**
 * Reading what Modelvia returns about one request, for a project (`rbk_`) key.
 *
 * Shapes are Modelvia `main` 49327ba (`key-gateway.ts` Receipt,
 * `charge-presentation.ts` PresentedReceipt, `http.ts` error bodies):
 *
 *   GET /v1/requests/{requestId}            → the presented receipt
 *   409 on /v1/chat/completions             → { error: { code: "request_already_processed", … }, receipt }
 *
 * A receipt varies by audience and billing, and every variant must read:
 *   - `priceBasis: "withheld"` (client-funded internal use): no price for this
 *     reader, never zero, whatever money field it carries.
 *   - `retail` / `direct` carry exact nanoAUD strings; a retail charge is "0"
 *     until settled, and an unsettled direct one may be absent.
 *   - resale keys add `chargeDetail` (`all_in` drops routing fields and adds
 *     `description: "AI usage"`; `itemized` may add `lines`), and every receipt
 *     adds `usedBy` (`customer` or `client_internal`).
 * Unknown fields are ignored so a later Modelvia addition never breaks a reader.
 */
export type ModelviaPriceBasis = "retail" | "direct" | "withheld";
export interface ModelviaReceipt {
  requestId: string;
  state: string;
  model: string;
  priceBasis: ModelviaPriceBasis;
  /** Null when withheld: unknown to this reader, never zero. */
  chargedNanoAud: string | null;
  reservedNanoAud: string | null;
  chargeDetail: "all_in" | "itemized" | null;
  description: string | null;
  usedBy: { kind: "customer" | "client_internal"; displayName: string } | null;
  idempotencySource: "supplied" | "derived" | null;
}

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const NANO = /^(0|[1-9][0-9]{0,20})$/;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, max: number): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
function invalid(): never { throw new Error("The model service receipt could not be read."); }

export function parseModelviaReceipt(value: unknown): ModelviaReceipt {
  if (!object(value)) invalid();
  const requestId = text(value.requestId, 160), state = text(value.state, 40), model = text(value.model, 128);
  if (!requestId || !ID.test(requestId) || !state || !model) invalid();
  const basis = value.priceBasis;
  if (basis !== "retail" && basis !== "direct" && basis !== "withheld") invalid();
  const money = (field: unknown): string | null => {
    if (field === undefined || field === null) return null;
    if (typeof field !== "string" || !NANO.test(field)) invalid();
    return field;
  };
  const charged = money(value.chargedNanoAud), reserved = money(value.reservedNanoAud);
  // Withheld is "not this reader's price". Modelvia's source omits the money
  // fields; a client-funded receipt has also been seen live with
  // `chargedNanoAud: "0"`, which is the internal allocation, not a price. Either
  // way the reader gets null, never a zero it could show as free.
  const chargedNanoAud = basis === "withheld" ? null : charged, reservedNanoAud = basis === "withheld" ? null : reserved;
  const detail = value.chargeDetail;
  if (detail !== undefined && detail !== "all_in" && detail !== "itemized") invalid();
  let usedBy: ModelviaReceipt["usedBy"] = null;
  if (value.usedBy !== undefined) {
    const by = value.usedBy;
    const displayName = object(by) ? text(by.displayName, 400) : null;
    if (!object(by) || (by.kind !== "customer" && by.kind !== "client_internal") || !displayName) invalid();
    usedBy = { kind: by.kind as "customer" | "client_internal", displayName: displayName! };
  }
  const source = value.idempotencySource;
  return {
    requestId, state, model, priceBasis: basis, chargedNanoAud, reservedNanoAud,
    chargeDetail: detail ?? null,
    description: text(value.description, 200),
    usedBy,
    idempotencySource: source === "supplied" || source === "derived" ? source : null,
  };
}

/** The refusal code in a Modelvia error body, OpenAI-shaped
 * (`{error:{code}}`) or plain (`{error:"code"}`), with the original receipt
 * when the refusal carries one (`request_already_processed`). Null for anything
 * else; the body itself is never surfaced. */
export function modelviaRefusal(value: unknown): { code: string; receipt: ModelviaReceipt | null } | null {
  if (!object(value)) return null;
  const error = value.error;
  const code = typeof error === "string" ? error : object(error) ? error.code : undefined;
  if (typeof code !== "string" || !/^[a-z][a-z0-9_:.-]{0,80}$/.test(code)) return null;
  let receipt: ModelviaReceipt | null = null;
  if (value.receipt !== undefined) { try { receipt = parseModelviaReceipt(value.receipt); } catch { receipt = null; } }
  return { code, receipt };
}

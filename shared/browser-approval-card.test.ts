import { describe, expect, it } from "vitest";
import { browserApprovalMoney, formatBrowserApprovalMoney, parseBrowserApprovalCard, readBrowserApprovalCard, unconfirmedBrowserApprovalFacts } from "./browser-approval-card.ts";

const pay = () => ({
  version: 1, purpose: "browser-approval-card", id: "00000000-0000-4000-8000-000000000001", kind: "pay", site: "portal.fictional-strata.example", control: "Pay now",
  facts: [
    { name: "recipient", value: "Fictional Strata Pty Ltd", confirmed: true },
    { name: "amount", value: "1240.00", confirmed: true },
    { name: "currency", value: "AUD", confirmed: true },
    { name: "reference", value: "LEVY-FICTIONAL-12", confirmed: true },
  ],
  expiresAt: 1_700_000_120_000,
});

describe("browser approval card", () => {
  it("accepts a complete payment card and formats its amount without rounding", () => {
    const card = parseBrowserApprovalCard(pay());
    expect(browserApprovalMoney(card)).toBe("A$1,240.00");
    expect(unconfirmedBrowserApprovalFacts(card)).toEqual([]);
    expect(formatBrowserApprovalMoney("480", "$")).toBe("$480");
    expect(formatBrowserApprovalMoney("1234567.5", "EUR")).toBe("€1,234,567.5");
    expect(formatBrowserApprovalMoney("99.99", "CHF")).toBe("CHF 99.99");
  });

  it("keeps an unconfirmed fact visible and unconfirmed", () => {
    const value = pay(); value.facts[0] = { name: "recipient", value: null as unknown as string, confirmed: false };
    const card = parseBrowserApprovalCard(value);
    expect(unconfirmedBrowserApprovalFacts(card)).toEqual(["recipient"]);
    expect(browserApprovalMoney(card)).toBe("A$1,240.00");
  });

  it.each([
    ["an unknown key", (card: ReturnType<typeof pay>) => Object.assign(card, { extra: true })],
    ["a missing required fact", (card: ReturnType<typeof pay>) => { card.facts.splice(0, 1); }],
    ["a confirmed fact without a value", (card: ReturnType<typeof pay>) => { card.facts[0] = { name: "recipient", value: null as unknown as string, confirmed: true }; }],
    ["a fact from another kind", (card: ReturnType<typeof pay>) => { card.facts.push({ name: "to", value: "someone@fictional.example", confirmed: true }); }],
    ["a duplicated fact", (card: ReturnType<typeof pay>) => { card.facts[3] = { ...card.facts[0] }; }],
    ["a control character", (card: ReturnType<typeof pay>) => { card.control = "Pay\nnow"; }],
    ["another version", (card: ReturnType<typeof pay>) => { (card as { version: number }).version = 2; }],
  ])("rejects %s", (_name, damage) => {
    const card = pay(); damage(card);
    expect(() => parseBrowserApprovalCard(card)).toThrow(/incomplete or damaged/);
    expect(readBrowserApprovalCard(card)).toBeNull();
  });

  it("never carries a hash value for text it binds", () => {
    const send = { ...pay(), kind: "send", facts: [{ name: "to", value: "owner@fictional.example", confirmed: true }, { name: "bodyHash", value: null, confirmed: true }] };
    expect(parseBrowserApprovalCard(send).facts[1]).toEqual({ name: "bodyHash", value: null, confirmed: true });
    expect(readBrowserApprovalCard({ ...send, facts: [send.facts[0], { name: "bodyHash", value: "a".repeat(64), confirmed: true }] })).toBeNull();
  });
});

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Property } from "../shared/contracts.ts";
import {
  bankTransactionDigest,
  type BankCreditObservation,
  type BankObservationBatch,
  matchBankCredits,
} from "./bank-observation.ts";
import { Desk } from "./desk.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("read-only bank credit observations", () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "realbud-bank-observation-"));
    now = new Date(2026, 7, 27, 9, 0, 0).getTime();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function batch(overrides: Partial<BankObservationBatch> = {}): BankObservationBatch {
    const accountFingerprint = overrides.accountFingerprint ?? digest("masked-test-account");
    const defaultCredit = credit(accountFingerprint, now - 5 * 60_000, 62_000, "RENT PROP-OAK WEEK 35");
    return {
      kind: "realbud.bank-credit-observation.v1",
      schemaVersion: 1,
      accountFingerprint,
      observedAt: now,
      credits: [defaultCredit],
      ...overrides,
    };
  }

  function credit(accountFingerprint: string, bookedAt: number, amountCents: number, reference: string): BankCreditObservation {
    const fields = { bookedAt, amountCents, reference };
    return { ...fields, transactionDigest: bankTransactionDigest(accountFingerprint, fields) };
  }

  it("matches only an exact property code and weekly or fortnightly amount", () => {
    const properties: Property[] = [
      {
        id: "p1",
        propertyCode: "ABC-101",
        address: "1 Test St",
        tenantName: "Tenant One",
        tenantPhone: "",
        weeklyRentCents: 50_000,
        options: { rentSource: "bank", graceDays: 3, courtesyUntilDay: 7, levyFromRent: null, notifyChannel: "desk", never: [] },
      },
    ];
    const fingerprint = digest("masked-test-account");
    const result = matchBankCredits(properties, batch({
      credits: [
        credit(fingerprint, now, 50_000, "rent abc-101"),
      ],
    }));
    expect(result.matched).toMatchObject([{ propertyId: "p1", interval: "weekly" }]);

    const fortnight = matchBankCredits(properties, batch({
      credits: [
        credit(fingerprint, now, 100_000, "ABC 101"),
      ],
    }));
    expect(fortnight.matched[0]?.interval).toBe("fortnightly");

    const fuzzyName = matchBankCredits(properties, batch({
      credits: [
        credit(fingerprint, now, 50_000, "Tenant One rent"),
      ],
    }));
    expect(fuzzyName.held[0]?.reason).toBe("unmatched");
  });

  it("holds ambiguous, amount-mismatched and multiple credits", () => {
    const base: Property = {
      id: "p1",
      propertyCode: "CODE-1",
      address: "1 Test St",
      tenantName: "One",
      tenantPhone: "",
      weeklyRentCents: 50_000,
      options: { rentSource: "bank", graceDays: 3, courtesyUntilDay: 7, levyFromRent: null, notifyChannel: "desk", never: [] },
    };
    const fingerprint = digest("masked-test-account");
    const ambiguous = matchBankCredits([base, { ...base, id: "p2" }], batch({
      credits: [credit(fingerprint, now, 50_000, "CODE-1")],
    }));
    expect(ambiguous.held[0]).toMatchObject({ reason: "ambiguous", candidatePropertyIds: ["p1", "p2"] });

    const amount = matchBankCredits([base], batch({
      credits: [credit(fingerprint, now, 49_000, "CODE-1")],
    }));
    expect(amount.held[0]?.reason).toBe("amount-mismatch");

    const oldWeekly = matchBankCredits([base], batch({
      credits: [credit(fingerprint, now - 9 * 24 * 60 * 60_000, 50_000, "CODE-1")],
    }));
    expect(oldWeekly.held[0]?.reason).toBe("outside-payment-window");

    const multiple = matchBankCredits([base], batch({ credits: [
      credit(fingerprint, now, 50_000, "CODE-1 one"),
      credit(fingerprint, now - 60_000, 50_000, "CODE-1 two"),
    ] }));
    expect(multiple.matched).toEqual([]);
    expect(multiple.held.map((item) => item.reason)).toEqual(["multiple-credits", "multiple-credits"]);
  });

  it("adds digest-only bank evidence once and vetoes a warning when bank and PMS disagree", () => {
    const file = join(dir, "desk.json");
    const desk = new Desk({ file, now: () => now });
    const csv = [
      "propertyCode,daysSinceDue,rentLanded,levyPaid",
      "prop-oak,4,false,false",
    ].join("\n");
    const pms = desk.importCsv(csv, now, desk.revision);
    expect(pms.results.find((row) => row.propertyId === "prop-oak")?.outcome).toBe("draft");

    now += 5 * 60_000;
    const fingerprint = digest("masked-test-account");
    const bankBatch = batch({ observedAt: now, credits: [
      credit(fingerprint, now - 60_000, 62_000, "PROP-OAK RENT"),
    ] });
    const compared = desk.importBankObservations(bankBatch, desk.revision);
    expect(compared.sources.some((source) => source.label === "Read-only bank activity")).toBe(true);
    expect(compared.results.find((row) => row.propertyId === "prop-oak")).toMatchObject({
      outcome: "hold",
      reason: "conflicted-source",
    });
    expect(compared.drafts.filter((draft) => draft.propertyId === "prop-oak" && draft.status === "pending")).toEqual([]);
    expect(JSON.stringify(compared)).not.toContain("PROP-OAK RENT");
    const committedRevision = compared.revision;

    const reopened = new Desk({ file, now: () => now });
    const duplicate = reopened.importBankObservations(bankBatch, reopened.revision);
    expect(duplicate.revision).toBe(committedRevision);
    expect(duplicate.workItems.filter((work) =>
      work.propertyId === "prop-oak" && work.state === "held" && work.holdReason === "conflicted-source"
    )).toHaveLength(1);
  });

  it("turns an unmatched credit into one redacted Desk exception", () => {
    const desk = new Desk({ file: join(dir, "desk.json"), now: () => now });
    const rawReference = "PRIVATE PAYER NAME AND ACCOUNT 123456";
    const fingerprint = digest("masked-test-account");
    const unmatched = batch({ credits: [credit(fingerprint, now, 77_700, rawReference)] });
    const first = desk.importBankObservations(unmatched, desk.revision);
    expect(first.book!.importIssues).toHaveLength(1);
    expect(first.book!.importIssues[0]?.rawIdentity).toMatch(/^Bank credit [a-f0-9]{10}$/);
    expect(JSON.stringify(first)).not.toContain(rawReference);
    const revision = first.revision;
    const duplicate = desk.importBankObservations(unmatched, desk.revision);
    expect(duplicate.revision).toBe(revision);
    expect(duplicate.book!.importIssues).toHaveLength(1);
  });

  it("rejects duplicate ids, debits disguised as negative credits and stale transaction windows", () => {
    const fingerprint = digest("masked-test-account");
    const same = credit(fingerprint, now, 100, "same");
    expect(() => matchBankCredits([], batch({ credits: [
      same,
      { ...same },
    ] }))).toThrow(/unique/i);
    expect(() => matchBankCredits([], batch({ credits: [
      credit(fingerprint, now, -100, "debit"),
    ] }))).toThrow(/amount/i);
    expect(() => matchBankCredits([], batch({ credits: [
      credit(fingerprint, now - 17 * 24 * 60 * 60_000, 100, "old"),
    ] }))).toThrow(/window/i);
    expect(() => matchBankCredits([], batch({ credits: [{
      ...credit(fingerprint, now, 100, "original"),
      reference: "changed after digest",
    }] }))).toThrow(/digest/i);
  });
});

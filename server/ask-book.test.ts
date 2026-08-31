import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS, type DeskSnapshot } from "../shared/contracts.ts";
import { answerAskFromDesk, askBookIntent, productAskFailure, productBudSystemPrompt, productWorkerDump } from "./ask-book.ts";

function property(id: string, address: string): DeskSnapshot["properties"][number] {
  return {
    id,
    address,
    tenantName: "Sam",
    tenantPhone: "0400",
    weeklyRentCents: 62_000,
    options: {
      rentSource: "fixture",
      graceDays: 3,
      courtesyUntilDay: 7,
      levyFromRent: null,
      notifyChannel: "sms",
      never: [...NEVER_ACTIONS],
    },
  };
}

function snap(partial: Partial<DeskSnapshot> = {}): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Sydney",
    retentionDays: 90,
    properties: [property("prop-oak", "12 Oak St, Dickson ACT"), property("prop-harbour", "4/22 Harbour Rd, Kingston ACT")],
    ledger: [],
    drafts: [],
    escalations: [],
    workItems: [],
    lastRunAt: null,
    results: [],
    hands: "demo",
    handsDetail: "The worker answered without ledger JSON — facts stay held.",
    sources: [],
    demo: true,
    ...partial,
  };
}

describe("ask book", () => {
  it("answers Recheck and greetings from Desk, not the worker", () => {
    const missed = snap({ lastRunAt: 1_700_000_000_000 });
    expect(askBookIntent("What did Recheck find?")).toBe("recheck");
    expect(askBookIntent("hi")).toBe("greeting");
    expect(askBookIntent("write a sonnet about trust accounts")).toBeNull();
    const found = answerAskFromDesk("What did Recheck find?", missed);
    expect(found).toMatch(/Recheck missed/);
    expect(found).toMatch(/12 Oak St/);
    expect(found).not.toMatch(/Hermes|404|kimi/i);
    expect(answerAskFromDesk("hi", missed)).toMatch(/I'm Bud/);
  });

  it("turns a worker 404 into Desk language", () => {
    expect(productAskFailure("API call failed after 3 retries: HTTP 404: The requested resource was not found")).toMatch(
      /Recheck facts are on Desk/,
    );
  });

  it("detects a provider retry dump inside a settled turn, and passes real answers through", () => {
    const dump = "API call failed after 3 retries: HTTP 404: The requested resource was not found";
    expect(productWorkerDump(dump)).toMatch(/Recheck facts are on Desk/);
    expect(productWorkerDump("The total weekly rent across the book is $3,120.")).toBeNull();
    expect(productWorkerDump("91 King St is past the courtesy window.")).toBeNull();
  });

  it("offers useful workroom tools without authorizing external effects", () => {
    const prompt = productBudSystemPrompt();
    expect(prompt).toMatch(/analyse attachments|calculate|run code|research public sources/i);
    expect(prompt).toMatch(/Never send, pay, submit, publish, sign/i);
    expect(prompt).toMatch(/current workroom/i);
    expect(prompt).toMatch(/DESK-CONTEXT\.md/);
    expect(prompt).toMatch(/Never inspect or decrypt desk\.json, desk\.key/i);
    expect(prompt).toMatch(/untrusted data/i);
    expect(prompt).toMatch(/answers that permission here in Ask/i);
    expect(prompt).toMatch(/do not say the decision is still waiting/i);
    expect(prompt).toMatch(/Never tell the user that Desk approves a local tool permission/i);
  });

  it("lets Bud drive a named portal page through computer tools and stop before submit", () => {
    const prompt = productBudSystemPrompt();
    expect(prompt).toMatch(/drive this Mac's browser through the computer tools/i);
    expect(prompt).toMatch(/Every computer action asks the user first/i);
    expect(prompt).toMatch(/Only visit sites named in a saved job/i);
    expect(prompt).toMatch(/prepare and stop/i);
    expect(prompt).toMatch(/Never send, pay, submit, publish, sign/i);
  });

  it("turns internal workroom and unknown failures into safe recovery copy", () => {
    const workroom = productAskFailure("execute_code failed: Unknown environment type: none; token=sk-secret-value");
    expect(workroom).toMatch(/workroom is not ready/i);
    expect(workroom).toMatch(/Nothing was sent or changed/i);
    expect(workroom).not.toMatch(/execute_code|environment type|sk-secret-value/i);

    const unknown = productAskFailure("RPC exploded at /Users/example/.hermes with sk-secret-value");
    expect(unknown).toMatch(/couldn't finish/i);
    expect(unknown).not.toMatch(/RPC|\.hermes|sk-secret-value/i);
  });
});

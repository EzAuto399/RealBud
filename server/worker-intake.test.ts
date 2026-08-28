import { describe, expect, it } from "vitest";

import { parseWorkerIntakeAction, workerIntakeSummary } from "./worker-intake.ts";

describe("worker intake action", () => {
  const valid = {
    action: "realbud.stage-properties.v1",
    properties: [
      {
        address: "12 Oak St, Dickson ACT",
        tenantName: "Jordan Blake",
        tenantPhone: "0400 555 666",
        weeklyRentCents: 58_000,
      },
    ],
    unparsed: [],
  };

  it("accepts the exact versioned action as raw or fenced JSON", () => {
    expect(parseWorkerIntakeAction(JSON.stringify(valid))?.properties).toHaveLength(1);
    expect(parseWorkerIntakeAction(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)?.properties[0]?.weeklyRentCents).toBe(58_000);
  });

  it("does not turn ordinary or malformed JSON into a Desk action", () => {
    expect(parseWorkerIntakeAction(JSON.stringify({ ...valid, action: undefined }))).toBeNull();
    expect(parseWorkerIntakeAction(JSON.stringify({ ...valid, action: "realbud.stage-properties.v2" }))).toBeNull();
    expect(parseWorkerIntakeAction(JSON.stringify({ ...valid, properties: [{ ...valid.properties[0], weeklyRentCents: "58000" }] }))).toBeNull();
    expect(parseWorkerIntakeAction(JSON.stringify({ ...valid, command: "send" }))).toBeNull();
    expect(parseWorkerIntakeAction("Here is the result: {}")).toBeNull();
  });

  it("summarises staging without claiming the book changed", () => {
    expect(workerIntakeSummary({ created: 1, skipped: 1, unparsed: ["blurred row"] })).toContain("Nothing was added to the book");
  });
});

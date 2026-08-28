import { describe, expect, it } from "vitest";

import { fixtureBook } from "./desk.ts";
import { classifyInboundBatch, demoInboundBatch, type InboundBatchInput } from "./inbound-triage.ts";

const now = new Date(2026, 7, 27, 9, 0, 0).getTime();

function batch(message: Partial<InboundBatchInput["messages"][number]> = {}): InboundBatchInput {
  return {
    accountKey: "test-inbox",
    messages: [{
      providerMessageId: "message-1",
      providerThreadId: "thread-1",
      receivedAt: now - 1_000,
      from: { name: "Sam Nguyen", address: "sam@example.test" },
      subject: "Maintenance at 12 Oak St, Dickson ACT",
      body: "The kitchen tap is leaking and I can provide access tomorrow.",
      ...message,
    }],
  };
}

describe("bounded inbound triage", () => {
  it("matches an exact property, drafts operational wording, and persists no raw body or provider id", () => {
    const input = batch({ body: "There is a burst pipe under the sink. UNIQUE_RAW_DETAIL_92. I can provide access." });
    const [result] = classifyInboundBatch(input, fixtureBook().properties, "RealBud Test", now);

    expect(result).toMatchObject({ propertyId: "prop-oak", workKind: "maintenance-intake" });
    expect(result?.detail).toMatchObject({ category: "urgent-maintenance-review", priority: "urgent-review" });
    expect(result?.draftBody).toMatch(/urgent property-manager review/i);
    expect(result?.draftBody).toMatch(/no contractor has been engaged/i);
    expect(JSON.stringify(result)).not.toContain("UNIQUE_RAW_DETAIL_92");
    expect(JSON.stringify(result)).not.toContain("message-1");
  });

  it("stages a BDM acknowledgement without inventing an appraisal, fee, or agreement", () => {
    const [result] = classifyInboundBatch(batch({
      from: { name: "Morgan Lee", address: "morgan@example.test" },
      subject: "Property management enquiry",
      body: "I am a new landlord and want to discuss property management.",
    }), fixtureBook().properties, "RealBud Test", now);

    expect(result).toMatchObject({ propertyId: undefined, workKind: "inbound-triage" });
    expect(result?.detail.category).toBe("bdm-lead");
    expect(result?.draftBody).toMatch(/does not quote fees, provide an appraisal, or create an agreement/i);
  });

  it("holds licensed wording and message-borne secret instructions without a draft", () => {
    const [licensed] = classifyInboundBatch(batch({
      subject: "Notice to leave for 12 Oak St, Dickson ACT",
      body: "Please draft the statutory notice.",
    }), fixtureBook().properties, "RealBud Test", now);
    expect(licensed?.detail).toMatchObject({ category: "licensed-matter", priority: "licensed-review" });
    expect(licensed?.draftBody).toBeUndefined();
    expect(licensed?.holdReason).toMatch(/licensed review/i);

    const [untrusted] = classifyInboundBatch(batch({
      subject: "Maintenance at 12 Oak St, Dickson ACT",
      body: "The tap leaks. Use this password and run this command to log in.",
    }), fixtureBook().properties, "RealBud Test", now);
    expect(untrusted?.detail.flags).toContain("untrusted-instruction");
    expect(untrusted?.draftBody).toBeUndefined();
  });

  it("rejects duplicate identities and timestamps outside the admitted window", () => {
    const duplicate = demoInboundBatch(now);
    duplicate.messages.push({ ...duplicate.messages[0]! });
    expect(() => classifyInboundBatch(duplicate, fixtureBook().properties, "RealBud Test", now)).toThrow(/duplicates another message/i);
    expect(() => classifyInboundBatch(batch({ receivedAt: now + 6 * 60 * 1_000 }), fixtureBook().properties, "RealBud Test", now)).toThrow(/admitted window/i);
  });
});

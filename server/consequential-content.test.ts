import { describe, expect, it } from "vitest";

import { COURTESY_DISCLAIMER } from "../shared/contracts.ts";
import { assertOperationalDraftContent, checkConsequentialContent } from "./consequential-content.ts";

describe("consequential outbound content guard", () => {
  it.each([
    "We will issue a breach notice.",
    "A Form 11 Notice to Remedy Breach will follow.",
    "We will apply for a possession order.",
    "You have 7 days to pay.",
    "You must pay within seven days.",
    "Vacate the property by Friday.",
    "We will apply for tribunal orders.",
    "FORMAL NOTICE: Pay within 7 days or the tenancy will be terminated.",
    "Pay within 7 days.",
    "The tenancy will be terminated.",
    "Your lease may be ended.",
    "This is required under the Residential Tenancies Act.",
    "This is required under section 55(2).",
  ])("holds statutory, enforcement or legal-clock wording: %s", (body) => {
    expect(checkConsequentialContent(body).ok).toBe(false);
    let error: unknown;
    try {
      assertOperationalDraftContent(body, "courtesy-rent");
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ status: 409, code: "licensed-content-required" });
  });

  it("allows factual courtesy wording and ignores only RealBud's fixed disclaimer", () => {
    const body = `Hi Sam, we have not matched this week's rent. If you already paid, please send the receipt.\n\n${COURTESY_DISCLAIMER}`;
    expect(checkConsequentialContent(body)).toEqual({ ok: true });
    expect(() => assertOperationalDraftContent(body, "courtesy-rent")).not.toThrow();
  });

  it("does not mistake an ordinary date or response request for a legal deadline", () => {
    expect(checkConsequentialContent("Please reply by Friday 28 August so the office can check the account.")).toEqual({ ok: true });
  });
});

import { describe, expect, it } from "vitest";

import { askNextActions, isProductAskEmptyThread, isSeededAskGreeting, savedJobTitleFromReply } from "./ask-next";

describe("ask next actions", () => {
  it("offers only recovery and already-prepared work after a worker miss", () => {
    const next = askNextActions({ miss: true, needsYou: 0, workerReady: false });
    expect(next.map((row) => row.id)).toEqual(["attach"]);
    expect(next.find((row) => row.id === "attach")?.label).toBe("Set up Bud");
  });

  it("offers a Bud check after a miss even when hands already pinged", () => {
    const next = askNextActions({ miss: true, needsYou: 0, workerReady: true });
    expect(next.find((row) => row.id === "attach")?.label).toBe("Check Bud");
  });

  it("offers the final check when the workroom is already set up", () => {
    const next = askNextActions({ miss: false, needsYou: 0, workerReady: false, workerSetupComplete: true });
    expect(next.find((row) => row.id === "attach")?.label).toBe("Check Bud");
  });

  it("uses the live Desk to offer a direct check and one exact address brief", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 1,
      workerReady: true,
      lastRunAt: null,
      addresses: [
        { address: "12 Oak St, Dickson ACT", attention: "needs-you" },
        { address: "4/22 Harbour Rd, Kingston ACT", attention: "unchecked" },
      ],
    });
    expect(next.some((row) => row.kind === "you")).toBe(false);
    expect(next.map((row) => row.id)).toEqual(["recheck", "desk", "brief-12 Oak St, Dickson ACT"]);
    expect(next[0]?.label).toBe("Check 1 address now");
    expect(next[2]?.label).toBe("Brief me on 12 Oak St");
  });

  it("offers Approve the plan when Bud asked the PM to approve on Schedule", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText: "Here is the plan. Approve the plan on Schedule, then press Run beside me.",
    });
    expect(next[0]).toMatchObject({ id: "approve-plan", kind: "routines", label: "Approve the plan" });
  });

  it("offers to open an existing saved job where it lives", () => {
    const base = { miss: false, needsYou: 0, workerReady: true, lastRunAt: 100 };
    const onYou = askNextActions({
      ...base,
      lastBotText: "**Vantage levy check** is already a saved job for vantagestrata.com.au. Open You → Bud's jobs and press **Run beside me**.",
    });
    expect(onYou[0]).toMatchObject({ id: "open-job", kind: "you-jobs", label: "Open the job" });
    const onSchedule = askNextActions({
      ...base,
      lastBotText: "**Weekly levy** is already a saved job for vantagestrata.com.au. Open Schedule and press **Run beside me**.",
    });
    expect(onSchedule[0]).toMatchObject({ id: "open-job", kind: "routines" });
  });

  it("offers Run beside me now when exactly one approved attached job matches the bold title", () => {
    const lastBotText =
      "**Vantage levy check** is already a saved job for vantagestrata.com.au. Open You → Bud's jobs and press **Run beside me**.";
    expect(savedJobTitleFromReply(lastBotText)).toBe("Vantage levy check");
    const ready = {
      id: "job-ready",
      title: "Vantage levy check",
      planApprovedAt: 1,
      revision: 1,
      approvedRevision: 1,
      attachment: { attachedAt: 1, acknowledged: "human-login-and-submit" as const },
    };
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText,
      threadIdle: true,
      recipes: [ready],
    });
    expect(next[0]).toMatchObject({
      id: "attend-now",
      kind: "attend",
      recipeId: "job-ready",
      label: "Run beside me now",
    });
    const notReady = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText,
      threadIdle: true,
      recipes: [{ ...ready, planApprovedAt: null, approvedRevision: null, attachment: null }],
    });
    expect(notReady[0]).toMatchObject({ id: "open-job", kind: "you-jobs" });
    const busy = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText,
      threadIdle: false,
      recipes: [ready],
    });
    expect(busy[0]).toMatchObject({ id: "open-job" });
    const twoReady = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText,
      threadIdle: true,
      recipes: [ready, { ...ready, id: "job-ready-2" }],
    });
    expect(twoReady[0]).toMatchObject({ id: "open-job" });
  });

  it("sends an unscheduled job's approval chip to You → Bud's jobs", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText: "Here is the plan. Approve the plan on You → Bud's jobs, then press Run beside me.",
    });
    expect(next[0]).toMatchObject({ id: "approve-plan", kind: "you-jobs", label: "Approve the plan" });
  });

  it("offers Stop and Open Schedule while an attended run is active", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      attendedRunActive: true,
    });
    expect(next.map((row) => row.id)).toEqual(["stop-attended", "open-schedule"]);
    expect(next[0]).toMatchObject({ kind: "interrupt", label: "Stop" });
    expect(next[1]).toMatchObject({ kind: "routines", label: "Open Schedule" });
  });

  it("offers a tailored book audit when today's checked book is clear", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      addresses: [
        { address: "12 Oak St, Dickson ACT", attention: "quiet" },
        { address: "4/22 Harbour Rd, Kingston ACT", attention: "quiet" },
      ],
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "book-audit", kind: "ask", label: "Audit 2 checked addresses" });
  });
});

describe("product Ask empty thread", () => {
  const greeting =
    "I'm Bud. Morning money lives on Desk — I can help you read a card or draft an owner note. I never send or pay.";

  it("treats the seeded greeting as an empty thread", () => {
    expect(isSeededAskGreeting(greeting)).toBe(true);
    expect(isProductAskEmptyThread([])).toBe(true);
    expect(isProductAskEmptyThread([{ role: "bot", kind: "text", text: greeting }])).toBe(true);
  });

  it("keeps a real conversation visible", () => {
    expect(isProductAskEmptyThread([{ role: "user", kind: "text", text: "Brief me" }])).toBe(false);
    expect(
      isProductAskEmptyThread([
        { role: "bot", kind: "text", text: greeting },
        { role: "user", kind: "text", text: "Brief me" },
      ]),
    ).toBe(false);
    expect(isProductAskEmptyThread([{ role: "bot", kind: "activity", text: greeting }])).toBe(false);
  });
});

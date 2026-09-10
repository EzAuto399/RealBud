import { describe, expect, it } from "vitest";

import { askNextActions, isProductAskEmptyThread, isSeededAskGreeting, savedJobTitleFromReply } from "./ask-next";

describe("ask next actions", () => {
  it("checks sign-in completion without reauthorizing", () => {
    const next = askNextActions({ miss: false, needsYou: 0, workerReady: true, lastRunAt: 100,
      lastBotText: "I opened Gmail sign-in. Finish sign-in, then press Check connection." });
    expect(next.find(row => row.id === "check-app-connection")).toMatchObject({ kind: "ask", text: "check Gmail connection" });
    expect(next.some(row => row.id === "connect-app-again")).toBe(false);
  });
  it("offers only recovery and already-prepared work after a worker miss", () => {
    const next = askNextActions({ miss: true, needsYou: 0, workerReady: false });
    expect(next.map((row) => row.id)).toEqual(["attach"]);
    expect(next.find((row) => row.id === "attach")?.label).toBe("Set up Bud");
  });

  it("offers a new book check after the model has recovered", () => {
    const next = askNextActions({ miss: true, needsYou: 0, workerReady: true });
    expect(next.some((row) => row.id === "attach")).toBe(false);
    expect(next.find((row) => row.id === "recheck")).toMatchObject({ kind: "recheck", description: "Bud is connected. Check the book again to refresh its facts." });
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

  it("offers in-Ask Connected apps key setup when the broker key is missing", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      composioConfigured: false,
      lastBotText:
        "Connected apps needs its private broker key once. Press **Save Connected apps key** here, then press **Connect Gmail**. Never paste the key into Ask.",
    });
    expect(next[0]).toMatchObject({
      id: "connect-setup",
      kind: "connect-setup",
      label: "Save key · Connect Gmail",
      connectLabel: "Gmail",
    });
  });

  it("offers Connect Gmail once the broker key is saved", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      composioConfigured: true,
      lastBotText:
        "Connected apps needs its private broker key once. Press **Save Connected apps key** here, then press **Connect Gmail**. Never paste the key into Ask.",
    });
    expect(next[0]).toMatchObject({
      id: "connect-app",
      kind: "ask",
      label: "Connect Gmail",
      text: "connect Gmail",
    });
  });

  it("approves the plan in Ask without redirecting", () => {
    const pending = {
      id: "job-pending",
      title: "Building link payment review",
      planApprovedAt: null,
      revision: 1,
      approvedRevision: null,
      attachment: null,
      capabilities: ["portal-read", "portal-prefill"],
      allowedOrigins: ["buildinglink.com"],
      updatedAt: 10,
    };
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      threadIdle: true,
      recipes: [pending],
      lastBotText:
        "I can take this over as a saved job. Here's the plan:\n**Building link payment review**\n1. Open\nPress **Approve the plan** here in Ask, then **Run beside me**.",
    });
    expect(next[0]).toMatchObject({
      id: "approve-plan",
      kind: "approve",
      recipeId: "job-pending",
      attach: true,
      label: "Approve plan and attach",
    });
  });

  it("offers Add portal site when the plan has no origin", () => {
    const pending = {
      id: "job-no-site",
      title: "Levy check",
      planApprovedAt: null,
      revision: 1,
      approvedRevision: null,
      attachment: null,
      capabilities: ["portal-read"],
      allowedOrigins: [],
      updatedAt: 10,
    };
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      threadIdle: true,
      recipes: [pending],
      lastBotText: "Here's the plan:\n**Levy check**\nPress **Approve the plan** here in Ask.",
    });
    expect(next[0]).toMatchObject({
      id: "set-site",
      kind: "set-site",
      recipeId: "job-no-site",
    });
  });

  it("keeps Run beside me on Ask after approve via focusRecipeId", () => {
    const ready = {
      id: "job-focus",
      title: "Levy check",
      planApprovedAt: 1,
      revision: 1,
      approvedRevision: 1,
      attachment: { attachedAt: 1, acknowledged: "human-login-and-submit" as const },
      capabilities: ["portal-read"],
      allowedOrigins: ["vantagestrata.com.au"],
    };
    const next = askNextActions({
      miss: false,
      needsYou: 1,
      workerReady: true,
      lastRunAt: 100,
      threadIdle: true,
      recipes: [ready],
      focusRecipeId: "job-focus",
      addresses: [{ address: "12 Oak St, Dickson ACT", attention: "held" }],
    });
    expect(next.map((row) => row.id)).toEqual(["attend-now"]);
    expect(next[0]).toMatchObject({
      kind: "attend",
      recipeId: "job-focus",
      label: "Run beside me now",
    });
  });

  it("hides Approve the plan until a pending recipe is known", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText: "Here is the plan. Approve the plan on Schedule, then press Run beside me.",
    });
    expect(next.every((row) => row.id !== "approve-plan")).toBe(true);
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
      recipes: [{ ...ready, planApprovedAt: null, approvedRevision: null, attachment: null, allowedOrigins: [] }],
    });
    expect(notReady[0]).toMatchObject({ id: "set-site", kind: "set-site", recipeId: "job-ready" });
    const busy = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText,
      threadIdle: false,
      recipes: [ready],
    });
    expect(busy.every((row) => row.id !== "attend-now" && row.id !== "open-job")).toBe(true);
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

  it("does not send approval to You when no pending recipe is loaded", () => {
    const next = askNextActions({
      miss: false,
      needsYou: 0,
      workerReady: true,
      lastRunAt: 100,
      lastBotText: "Here is the plan. Approve the plan on You → Bud's jobs, then press Run beside me.",
    });
    expect(next.every((row) => row.id !== "approve-plan")).toBe(true);
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

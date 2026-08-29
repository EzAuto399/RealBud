import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { currentAskCapabilityContext } from "./ask-capabilities.ts";
import { bankTransactionDigest, type BankObservationBatch } from "./bank-observation.ts";
import { Desk } from "./desk.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deskHarness() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-ask-capabilities-"));
  dirs.push(dir);
  const now = new Date(2026, 7, 26, 9, 0).getTime();
  return { desk: new Desk({ file: join(dir, "desk.json"), now: () => now }), now };
}

describe("Ask capability context", () => {
  it("reports current boundaries without exposing a raw host shell or fake connection", () => {
    const { desk, now } = deskHarness();
    const context = currentAskCapabilityContext(desk, {
      now: () => now,
      portalMode: "practice",
      pocket: {
        provider: "multi-channel",
        configured: false,
        enabled: false,
        pilotReady: false,
        state: "pilot-gated",
        detail: "Name the pilot PM.",
        connectedCount: 0,
        channels: {
          telegram: {
            provider: "telegram",
            configured: false,
            enabled: false,
            pilotReady: false,
            state: "pilot-gated",
            detail: "Name the pilot PM.",
            allowedUserId: "",
            botUsername: null,
            lastInboundAt: null,
            deliveryUncertain: false,
          },
          whatsappCloud: {
            provider: "whatsapp-cloud",
            configured: false,
            enabled: false,
            pilotReady: false,
            state: "pilot-gated",
            detail: "Name the pilot PM.",
            allowedUserId: "",
            phoneNumberId: "",
            displayPhoneNumber: null,
            verifiedName: null,
            webhookPort: 8090,
            webhookPath: "/whatsapp/webhook",
            webhookVerifiedAt: null,
            lastInboundAt: null,
            deliveryUncertain: false,
          },
        },
      },
    });
    expect(context.capabilities).toContainEqual(expect.objectContaining({ id: "selected-evidence-review", status: "ready" }));
    expect(context.capabilities?.find((item) => item.id === "selected-evidence-review")?.detail).toContain("tool access is denied");
    expect(context.capabilities).toContainEqual(expect.objectContaining({ id: "bounded-portal-handoff", status: "practice-only" }));
    expect(context.capabilities).toContainEqual(expect.objectContaining({ id: "bank-payment-observation", status: "pilot-gated" }));
    expect(context.capabilities).toContainEqual(expect.objectContaining({ id: "composio-account", status: "setup-required" }));
    expect(context.capabilities).toContainEqual(expect.objectContaining({ id: "mail-calendar-source", status: "setup-required" }));
    expect(context.capabilities?.find((item) => item.id === "mail-calendar-source")?.detail).toMatch(/propose composio-account first/i);
    expect(context.capabilities?.find((item) => item.id === "composio-account")?.detail.length).toBeLessThanOrEqual(120);
    expect(context.capabilities).toContainEqual(expect.objectContaining({ id: "pm-pocket", status: "pilot-gated" }));
    expect(context.capabilities).toContainEqual(expect.objectContaining({ id: "sandboxed-cli", status: "unavailable" }));
    expect(context.preparableHandoffs).toEqual([]);
    expect(context.deskBrief).toEqual(expect.objectContaining({ mode: "demo", recovery: false }));
    expect(JSON.stringify(context)).not.toMatch(/token|password|api.?key/i);

    const linked = currentAskCapabilityContext(desk, {
      now: () => now,
      portalMode: "practice",
      composioLinked: true,
    });
    expect(linked.capabilities).toContainEqual(expect.objectContaining({ id: "composio-account", status: "ready" }));
    expect(linked.capabilities).toContainEqual(expect.objectContaining({ id: "mail-calendar-source", status: "setup-required" }));
    expect(linked.capabilities?.find((item) => item.id === "mail-calendar-source")?.detail).toMatch(/Inbox is not listed yet/i);
    expect(linked.capabilities?.find((item) => item.id === "mail-calendar-source")?.detail.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(linked)).not.toMatch(/ck_|https?:\/\//i);

    const keyed = currentAskCapabilityContext(desk, {
      now: () => now,
      portalMode: "practice",
      linkedTools: [{
        slug: "notion",
        label: "Notion",
        connected: true,
        account: "Northside workspace",
        lastPeekTitles: ["Getting Started"],
      }],
    });
    expect(keyed.capabilities).toContainEqual(expect.objectContaining({
      id: "linked-office-tools",
      status: "practice-only",
    }));
    expect(keyed.capabilities?.find((item) => item.id === "linked-office-tools")?.detail).toMatch(/Notion is on this device/i);
    expect(keyed.capabilities?.find((item) => item.id === "linked-office-tools")?.detail).not.toMatch(/Pages are not read/i);
    expect(keyed.capabilities?.find((item) => item.id === "linked-office-tools")?.detail.length).toBeLessThanOrEqual(120);
    expect(keyed.linkedReads).toEqual([{
      label: "Notion",
      account: "Northside workspace",
      titles: ["Getting Started"],
    }]);
    expect(JSON.stringify(keyed)).not.toMatch(/ntn_|token|api.?key/i);

    const mail = currentAskCapabilityContext(desk, {
      now: () => now,
      portalMode: "practice",
      composioLinked: true,
      linkedTools: [{ slug: "gmail", label: "Gmail", connected: true }],
    });
    expect(mail.capabilities).toContainEqual(expect.objectContaining({
      id: "mail-calendar-source",
      status: "practice-only",
    }));
    expect(mail.capabilities?.find((item) => item.id === "mail-calendar-source")?.detail).toMatch(/Gmail is on this device/i);
    expect(mail.capabilities?.find((item) => item.id === "mail-calendar-source")?.detail.length).toBeLessThanOrEqual(120);
  });

  it("advertises only a current approved one-use handoff", () => {
    const { desk, now } = deskHarness();
    desk.patchProperty("prop-oak", { notifyChannel: "portal" });
    desk.runMorningCheck();
    const draft = desk.snapshot().drafts.find((item) => item.propertyId === "prop-oak" && item.kind === "courtesy-rent")!;
    desk.allowDraft(draft.id);

    const ready = currentAskCapabilityContext(desk, { now: () => now, portalMode: "practice" });
    expect(ready.preparableHandoffs).toEqual([{
      draftId: draft.id,
      address: "12 Oak St, Dickson ACT",
      kind: "courtesy-rent",
      mode: "practice",
    }]);

    desk.command({ type: "prepare-portal", draftId: draft.id, expectedRevision: desk.revision });
    expect(currentAskCapabilityContext(desk, { now: () => now, portalMode: "practice" }).preparableHandoffs).toEqual([]);
  });

  it("keeps a fixture bank observation practice-only", () => {
    const { desk, now } = deskHarness();
    const accountFingerprint = createHash("sha256").update("practice-account").digest("hex");
    const fields = { bookedAt: now - 60_000, amountCents: 62_000, reference: "PROP-OAK RENT" };
    const batch: BankObservationBatch = {
      kind: "realbud.bank-credit-observation.v1",
      schemaVersion: 1,
      accountFingerprint,
      observedAt: now,
      credits: [{ ...fields, transactionDigest: bankTransactionDigest(accountFingerprint, fields) }],
    };
    desk.importBankObservations(batch, desk.revision);
    const context = currentAskCapabilityContext(desk, {
      now: () => now,
      portalMode: "practice",
      bankAdapterConfigured: true,
    });
    expect(context.capabilities).toContainEqual(expect.objectContaining({
      id: "bank-payment-observation",
      status: "practice-only",
    }));
  });
});

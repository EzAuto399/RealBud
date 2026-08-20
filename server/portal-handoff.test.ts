import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Desk } from "./desk.ts";
import { portalPrefill, portalRead, portalSubmit, runBoundedPrefill, verifyPortalResult } from "./portal-handoff.ts";
import { FAKE_PORTAL_RECIPE } from "./portal-recipe.ts";
import { startFakePortal } from "./testing/fake-portal.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fake portal handoff", () => {
  it("lets Bud read and prefill, keeps submit at zero, and confirms a human click", async () => {
    const portal = await startFakePortal();
    try {
      const read = await portalRead(portal.url, "bud");
      expect(read.status).toBe(200);
      const prefill = await portalPrefill(portal.url, "courtesy body", "bud");
      expect(prefill.status).toBe(200);
      expect(portal.prefillCount()).toBe(1);
      expect(await portalSubmit(portal.url, "bud")).toMatchObject({ status: 403 });
      expect(portal.submitCount()).toBe(0);
      const human = await portalSubmit(portal.url, "human");
      expect(human.status).toBe(200);
      expect(portal.submitCount()).toBe(1);
      expect(await verifyPortalResult(portal.url)).toBe("confirmed");
    } finally {
      await portal.close();
    }
  });

  it("revokes Bud at handoff and treats an unread result as effect-unknown", async () => {
    const portal = await startFakePortal();
    try {
      const result = await runBoundedPrefill({
        baseUrl: portal.url,
        body: "prefill",
        capability: {
          id: "cap-1",
          workItemId: "work-1",
          revision: 1,
          proposalHash: "ph",
          propertyId: "prop-oak",
          recipeId: FAKE_PORTAL_RECIPE.id,
          recipeVersion: 1,
          operation: "prefill-courtesy",
          approver: "pm",
          expiresAt: Date.now() + 60_000,
        },
        recipe: FAKE_PORTAL_RECIPE,
        now: Date.now(),
      });
      expect(result).toEqual({ ok: true });
      expect(portal.state.revoked).toBe(true);
      expect(await portalPrefill(portal.url, "again", "bud")).toMatchObject({ status: 403 });
      expect(await portalSubmit(portal.url, "bud")).toMatchObject({ status: 403 });
      expect(portal.submitCount()).toBe(0);
      expect(await verifyPortalResult(portal.url)).toBe("effect-unknown");
    } finally {
      await portal.close();
    }
  });

  it("mints a one-use capability from a Desk approval and invalidates it on edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-portal-desk-"));
    dirs.push(dir);
    const portal = await startFakePortal();
    try {
      const desk = new Desk({
        file: join(dir, "desk.json"),
        now: () => Date.now(),
        portalUrl: portal.url,
      });
      desk.patchProperty("prop-oak", { notifyChannel: "portal" });
      desk.runMorningCheck();
      const draft = desk.snapshot().drafts.find((d) => d.kind === "courtesy-rent")!;
      desk.editDraft(draft.id, "Hi Sam — still waiting on rent.");
      expect(desk.capabilityFor(draft.id)).toBeNull();
      desk.allowDraft(draft.id);
      expect(desk.capabilityFor(draft.id)?.operation).toBe("prefill-courtesy");
      const snap = await desk.preparePortalAsync(draft.id);
      const work = snap.workItems.find((w) => w.draftId === draft.id);
      expect(work?.state).toBe("handoff-ready");
      expect(desk.capabilityFor(draft.id)).toBeNull();
      expect(portal.prefillCount()).toBe(1);
      expect(portal.submitCount()).toBe(0);
      expect(portal.state.revoked).toBe(true);
      await portalSubmit(portal.url, "human");
      const verified = await verifyPortalResult(portal.url);
      expect(verified).toBe("confirmed");
      desk.command({ type: "confirm", workItemId: work!.id, expectedRevision: desk.revision });
      expect(desk.snapshot().workItems.find((w) => w.id === work!.id)?.state).toBe("confirmed");
    } finally {
      await portal.close();
    }
  });
});

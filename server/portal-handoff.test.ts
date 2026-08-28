import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AtomicWriteError } from "./atomic.ts";
import { Desk } from "./desk.ts";
import { portalPrefill, portalRead, portalRevoke, portalSubmit, runBoundedPrefill, verifyPortalResult } from "./portal-handoff.ts";
import { FAKE_PORTAL_RECIPE, fakePortalRecipeAt } from "./portal-recipe.ts";
import { startFakePortal } from "./testing/fake-portal.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fake portal handoff", () => {
  it("serves an accessible browser task while keeping Submit unavailable to Bud", async () => {
    const portal = await startFakePortal();
    try {
      const page = await fetch(`${portal.url}/?actor=bud&variant=reordered`);
      const html = await page.text();
      expect(page.headers.get("content-type")).toMatch(/text\/html/);
      expect(html).toContain('<label for="courtesy-body">Courtesy reminder</label>');
      expect(html).toContain('id="save-draft"');
      expect(html).toContain('id="submit-reminder" class="primary" type="button" disabled');
      expect(html).toContain("Portal update: navigation moved");

      const anonymousSubmit = await fetch(`${portal.url}/submit`, { method: "POST", body: "{}" });
      expect(anonymousSubmit.status).toBe(403);
      expect(portal.submitCount()).toBe(0);
    } finally {
      await portal.close();
    }
  });

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
      expect(await portalSubmit(portal.url, "human")).toMatchObject({ status: 409 });
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
        recipe: fakePortalRecipeAt(portal.url),
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

  it("records an unknown effect once prefill was attempted but the adapter did not confirm it", async () => {
    const portal = await startFakePortal();
    try {
      await portalRevoke(portal.url);
      const result = await runBoundedPrefill({
        baseUrl: portal.url,
        body: "prefill",
        capability: {
          id: "cap-unknown",
          workItemId: "work-unknown",
          revision: 1,
          proposalHash: "ph",
          propertyId: "prop-oak",
          recipeId: FAKE_PORTAL_RECIPE.id,
          recipeVersion: 1,
          operation: "prefill-courtesy",
          approver: "pm",
          expiresAt: Date.now() + 60_000,
        },
        recipe: fakePortalRecipeAt(portal.url),
        now: Date.now(),
      });
      expect(result).toEqual({ ok: false, error: "portal prefill failed", effect: "unknown" });
      expect(portal.submitCount()).toBe(0);
    } finally {
      await portal.close();
    }
  });

  it("does not call a completed prefill safe when ownership could not be revoked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    try {
      const result = await runBoundedPrefill({
        baseUrl: "http://127.0.0.1",
        body: "prefill",
        capability: {
          id: "cap-revoke",
          workItemId: "work-revoke",
          revision: 1,
          proposalHash: "ph",
          propertyId: "prop-oak",
          recipeId: FAKE_PORTAL_RECIPE.id,
          recipeVersion: 1,
          operation: "prefill-courtesy",
          approver: "pm",
          expiresAt: Date.now() + 60_000,
        },
        recipe: fakePortalRecipeAt("http://127.0.0.1"),
        now: Date.now(),
      });
      expect(result).toEqual({ ok: false, error: "portal handoff revoke failed", effect: "unknown" });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(fetchSpy.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("refuses a mismatched or credential-bearing origin before any portal request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const capability = {
        id: "cap-origin",
        workItemId: "work-origin",
        revision: 1,
        proposalHash: "ph",
        propertyId: "prop-oak",
        recipeId: FAKE_PORTAL_RECIPE.id,
        recipeVersion: 1,
        operation: "prefill-courtesy" as const,
        approver: "pm",
        expiresAt: Date.now() + 60_000,
      };
      const recipe = fakePortalRecipeAt("http://127.0.0.1:41881");
      await expect(runBoundedPrefill({
        baseUrl: "http://127.0.0.1:41882",
        body: "prefill",
        capability,
        recipe,
        now: Date.now(),
      })).resolves.toEqual({ ok: false, error: "portal origin is not authorized", effect: "none" });
      await expect(runBoundedPrefill({
        baseUrl: "http://user:secret@127.0.0.1:41881",
        body: "prefill",
        capability,
        recipe,
        now: Date.now(),
      })).resolves.toEqual({ ok: false, error: "portal origin is not authorized", effect: "none" });
      await expect(runBoundedPrefill({
        baseUrl: "http://127.0.0.1:41881",
        body: "prefill",
        capability: { ...capability, recipeVersion: 2 },
        recipe,
        now: Date.now(),
      })).resolves.toEqual({ ok: false, error: "portal capability does not match the published recipe", effect: "none" });
      await expect(runBoundedPrefill({
        baseUrl: "http://127.0.0.1:41881",
        body: " ",
        capability,
        recipe,
        now: Date.now(),
      })).resolves.toEqual({ ok: false, error: "approved portal wording is invalid", effect: "none" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(() => fakePortalRecipeAt("https://portal.example.test")).toThrow(/loopback origin/);
    } finally {
      fetchSpy.mockRestore();
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

  it("consumes the authorization before external work and leaves an uncertain prefill non-retryable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-portal-unknown-"));
    dirs.push(dir);
    const portal = await startFakePortal();
    try {
      const desk = new Desk({ file: join(dir, "desk.json"), now: () => Date.now(), portalUrl: portal.url });
      desk.patchProperty("prop-oak", { notifyChannel: "portal" });
      desk.runMorningCheck();
      const draft = desk.snapshot().drafts.find((item) => item.propertyId === "prop-oak" && item.kind === "courtesy-rent")!;
      desk.allowDraft(draft.id);
      await portalRevoke(portal.url);

      await expect(desk.preparePortalAsync(draft.id)).rejects.toThrow(/prefill failed/i);
      const work = desk.snapshot().workItems.find((item) => item.draftId === draft.id);
      expect(work?.state).toBe("effect-unknown");
      expect(desk.capabilityFor(draft.id)).toBeNull();
      await expect(desk.preparePortalAsync(draft.id)).rejects.toThrow(/approv|capability/i);
      expect(portal.submitCount()).toBe(0);
    } finally {
      await portal.close();
    }
  });

  it("recovers a process-interrupted preparation as effect unknown instead of replaying it", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-portal-restart-"));
    dirs.push(dir);
    const file = join(dir, "desk.json");
    const now = Date.now();
    const desk = new Desk({ file, now: () => now });
    desk.patchProperty("prop-oak", { notifyChannel: "portal" });
    desk.runMorningCheck();
    const draft = desk.snapshot().drafts.find((item) => item.propertyId === "prop-oak" && item.kind === "courtesy-rent")!;
    desk.allowDraft(draft.id);

    const internal = desk as unknown as {
      store: {
        data: {
          workItems: Array<{ id: string; draftId?: string; state: string; updatedAt: number }>;
          capabilities: Array<{ workItemId: string; usedAt?: number }>;
        };
        persist(): void;
      };
    };
    const work = internal.store.data.workItems.find((item) => item.draftId === draft.id)!;
    work.state = "preparing";
    work.updatedAt = now;
    const capability = internal.store.data.capabilities.find((item) => item.workItemId === work.id)!;
    capability.usedAt = now;
    internal.store.persist();

    const reloaded = new Desk({ file, now: () => now + 1 });
    expect(reloaded.snapshot().workItems.find((item) => item.draftId === draft.id)?.state).toBe("effect-unknown");
    expect(reloaded.capabilityFor(draft.id)).toBeNull();
  });

  it("does not call an externally completed prefill retryable when its final Desk commit fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-portal-commit-failure-"));
    dirs.push(dir);
    const portal = await startFakePortal();
    try {
      const desk = new Desk({ file: join(dir, "desk.json"), now: () => Date.now(), portalUrl: portal.url });
      desk.patchProperty("prop-oak", { notifyChannel: "portal" });
      desk.runMorningCheck();
      const draft = desk.snapshot().drafts.find((item) => item.propertyId === "prop-oak" && item.kind === "courtesy-rent")!;
      desk.allowDraft(draft.id);

      const internal = desk as unknown as {
        store: { authorityWriter: (path: string, data: string) => void };
      };
      const writeAuthority = internal.store.authorityWriter;
      let writes = 0;
      internal.store.authorityWriter = (path, data) => {
        writes += 1;
        if (writes === 2) throw new AtomicWriteError("not-landed", new Error("fixture final write failure"));
        writeAuthority(path, data);
      };

      await expect(desk.preparePortalAsync(draft.id)).rejects.toMatchObject({ code: "handoff-effect-unknown" });
      expect(portal.prefillCount()).toBe(1);
      expect(portal.submitCount()).toBe(0);
      expect(desk.snapshot().workItems.find((item) => item.draftId === draft.id)?.state).toBe("effect-unknown");
      expect(desk.capabilityFor(draft.id)).toBeNull();
    } finally {
      await portal.close();
    }
  });
});

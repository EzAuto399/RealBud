import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { fakeHermes } from "./testing/fake-hermes.ts";
import { draftRecipeFromText, shapeRecipeDraft } from "./recipe-draft.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("draftRecipeFromText", () => {
  it("returns a shadow card when the worker names a job", async () => {
    const { dir, script } = fakeHermes(
      `Here you go.\n{"title":"Friday arrears","steps":["Open the arrears report","Park 7+ day late tenancies on Desk"],"allowedOrigins":["https://www.PropertyMe.com.au/report"],"evidence":"arrears rows"}`,
    );
    dirs.push(dir);
    const draft = await draftRecipeFromText("Every Friday check PropertyMe arrears.", { cli: script, root: dir });
    expect(draft).toMatchObject({
      title: "Friday arrears",
      steps: ["Open the arrears report", "Park 7+ day late tenancies on Desk"],
      allowedOrigins: ["propertyme.com.au"],
      evidence: "arrears rows",
      status: "shadow",
    });
    expect(typeof draft?.id).toBe("string");
    expect(typeof draft?.createdAt).toBe("number");
  });

  it("returns 503-shaped miss when the worker answers junk", async () => {
    const { dir, script } = fakeHermes("Sure, just open the portal and have a look.");
    dirs.push(dir);
    const shaped = await shapeRecipeDraft("Check arrears.", { cli: script, root: dir });
    expect(shaped.draft).toBeNull();
    expect(`Bud could not shape that job — ${shaped.detail}`).toMatch(/could not shape that job/);
    expect(shaped.detail).toMatch(/without a job card/);
  });

  it("does not spawn the live worker under VITEST without a cli stub", async () => {
    const draft = await draftRecipeFromText("Check arrears.");
    expect(draft).toBeNull();
  });

  it("keeps a named cadence on the card", async () => {
    const { dir, script } = fakeHermes(
      `{"title":"Friday arrears","steps":["Open the arrears report"],"allowedOrigins":["propertyme.com.au"],"evidence":"arrears rows","schedule":{"time":"16:00","weekdays":[5]}}`,
    );
    dirs.push(dir);
    const draft = await draftRecipeFromText("Every Friday 4pm check PropertyMe arrears.", { cli: script, root: dir });
    expect(draft?.schedule).toEqual({ time: "16:00", weekdays: [5] });
  });

  it("drops a junk cadence instead of failing the draft", async () => {
    const { dir, script } = fakeHermes(
      `{"title":"Friday arrears","steps":["Open the arrears report"],"allowedOrigins":["propertyme.com.au"],"evidence":"arrears rows","schedule":{"time":"4pm","weekdays":["Friday"]}}`,
    );
    dirs.push(dir);
    const draft = await draftRecipeFromText("Every Friday 4pm check PropertyMe.", { cli: script, root: dir });
    expect(draft?.title).toBe("Friday arrears");
    expect(draft?.schedule).toBeNull();
  });
});

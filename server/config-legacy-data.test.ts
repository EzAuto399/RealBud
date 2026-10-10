import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";

// The pre-rename folder (~/.openmausbot) moves only into the default ~/.realbud.
const root = privateTempRoot(join(tmpdir(), "realbud-config-legacy-"));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, REALBUD_DATA_DIR: process.env.REALBUD_DATA_DIR, OMB_DATA_DIR: process.env.OMB_DATA_DIR };
process.env.HOME = process.env.USERPROFILE = root;
delete process.env.OMB_DATA_DIR;
const legacy = join(root, ".openmausbot");
mkdirSync(legacy, { mode: 0o700 });
writeFileSync(join(legacy, "config.json"), '{"fictional":"legacy"}', { mode: 0o600 });
const load = async (dataDir: string | undefined) => {
  if (dataDir === undefined) delete process.env.REALBUD_DATA_DIR; else process.env.REALBUD_DATA_DIR = dataDir;
  vi.resetModules();
  return import("./config.ts");
};

afterAll(async () => {
  for (const [name, value] of Object.entries(prior)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  await removeFixture(root);
});

it("leaves the pre-rename folder alone when RealBud runs from another data folder", async () => {
  const { DATA_DIR, ensureDirs } = await load(join(root, "fictional-office"));
  ensureDirs();
  expect(existsSync(join(legacy, "config.json"))).toBe(true);
  expect(existsSync(join(DATA_DIR, "config.json"))).toBe(false);
});

it("moves the pre-rename folder into the default data folder once", async () => {
  const { DATA_DIR, ensureDirs } = await load(undefined);
  expect(DATA_DIR).toBe(join(root, ".realbud"));
  ensureDirs();
  expect(existsSync(legacy)).toBe(false);
  expect(readFileSync(join(DATA_DIR, "config.json"), "utf8")).toBe('{"fictional":"legacy"}');
});
